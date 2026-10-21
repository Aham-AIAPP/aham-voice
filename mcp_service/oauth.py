"""Small first-party OAuth authorization server with PKCE and hashed tokens.

No upstream passwords or Voice sessions are persisted. Grants identify the
Voice user; every tool invocation re-checks that user's current access rights.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from urllib.parse import urlencode, urlsplit


class Denied(Exception):
    def __init__(self,code,status=400):self.code,self.status=code,status


def digest(value):return hashlib.sha256(value.encode()).hexdigest()
def random():return secrets.token_urlsafe(32)
def challenge(value):return base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest()).rstrip(b'=').decode()


class OAuth:
    def __init__(self,path,issuer,login):
        self.path,self.issuer,self.login=str(path),issuer,login
        self.resource=issuer+'/mcp'
        with self.db() as c:
            c.executescript('''
            create table if not exists clients(id text primary key,data text not null,created real);
            create table if not exists flows(id text primary key,data text not null,csrf text,cookie text,expires real);
            create table if not exists codes(hash text primary key,data text not null,expires real);
            create table if not exists grants(id text primary key,user_id text,client_id text,scopes text,created real,expires real,revoked integer default 0);
            create table if not exists tokens(hash text primary key,grant_id text,kind text,expires real,used integer default 0);
            ''')

    @contextmanager
    def db(self):
        c=sqlite3.connect(self.path,timeout=15);c.row_factory=sqlite3.Row
        try:
            c.execute('BEGIN IMMEDIATE');yield c;c.commit()
        except Exception:c.rollback();raise
        finally:c.close()

    def register(self,p):
        uris=p.get('redirect_uris')
        if not isinstance(uris,list) or not 1<=len(uris)<=5:raise Denied('invalid_redirect_uri')
        for uri in uris:
            if not isinstance(uri,str) or len(uri)>2000:raise Denied('invalid_redirect_uri')
            u=urlsplit(uri)
            if not u.hostname or u.username or u.password or u.fragment or not (u.scheme=='https' or u.scheme=='http' and u.hostname in ('127.0.0.1','localhost','::1')):
                raise Denied('invalid_redirect_uri')
        if p.get('token_endpoint_auth_method','none')!='none':raise Denied('invalid_client_metadata')
        client={'client_id':random(),'client_name':str(p.get('client_name','MCP 客户端'))[:100],
                'redirect_uris':uris,'token_endpoint_auth_method':'none',
                'grant_types':['authorization_code','refresh_token'],'response_types':['code']}
        with self.db() as c:c.execute('insert into clients values(?,?,?)',(client['client_id'],json.dumps(client),time.time()))
        return client

    def begin(self,p):
        with self.db() as c:
            row=c.execute('select data from clients where id=?',(p.get('client_id'),)).fetchone()
            if not row:raise Denied('invalid_client')
            client=json.loads(row[0])
            if p.get('redirect_uri') not in client['redirect_uris']:raise Denied('invalid_redirect_uri')
            if p.get('resource')!=self.resource:raise Denied('invalid_target')
            if p.get('response_type')!='code' or p.get('code_challenge_method')!='S256' or not re.fullmatch(r'[A-Za-z0-9_-]{43}',p.get('code_challenge','')):raise Denied('invalid_request')
            scopes=p.get('scope','voice:read').split()
            if 'voice:read' not in scopes or set(scopes)-{'voice:read','voice:manage'}:raise Denied('invalid_scope')
            if len(p.get('state',''))>2000:raise Denied('invalid_request')
            flow,csrf,cookie=random(),random(),random()
            data={k:p.get(k,'') for k in ('client_id','redirect_uri','state','code_challenge')}
            data['scopes']=sorted(set(scopes));data['client_name']=client['client_name']
            c.execute('delete from flows where expires<?',(time.time(),));c.execute('delete from codes where expires<?',(time.time(),))
            c.execute('insert into flows values(?,?,?,?,?)',(digest(flow),json.dumps(data),digest(csrf),digest(cookie),time.time()+600))
        return flow,csrf,cookie,data

    async def consent(self,p,cookie):
        with self.db() as c:
            row=c.execute('select * from flows where id=?',(digest(p.get('flow','')),)).fetchone()
            if not row or row['expires']<time.time() or not hmac.compare_digest(row['csrf'],digest(p.get('csrf',''))) or not hmac.compare_digest(row['cookie'],digest(cookie)):
                raise Denied('invalid_consent',403)
            data=json.loads(row['data'])
        if p.get('confirm')!='yes':raise Denied('consent_required',403)
        user=await self.login(p.get('username',''),p.get('password',''))
        if not user or user.get('role')=='admin' or user.get('must_change_password'):
            raise Denied('business_user_required',403)
        code=random();data['user_id']=user['id']
        with self.db() as c:
            removed=c.execute('delete from flows where id=? and expires>?',(digest(p['flow']),time.time())).rowcount
            if not removed:raise Denied('invalid_consent',403)
            c.execute('insert into codes values(?,?,?)',(digest(code),json.dumps(data),time.time()+120))
        sep='&' if '?' in data['redirect_uri'] else '?'
        return data['redirect_uri']+sep+urlencode({'code':code,'state':data['state'],'iss':self.issuer})

    def issue(self,c,g):
        access,refresh=random(),random();now=time.time()
        c.execute('insert into tokens values(?,?,?,?,0)',(digest(access),g['id'],'access',min(now+3600,g['expires'])))
        c.execute('insert into tokens values(?,?,?,?,0)',(digest(refresh),g['id'],'refresh',g['expires']))
        return {'access_token':access,'refresh_token':refresh,'token_type':'Bearer','expires_in':int(min(3600,g['expires']-now)),
                'scope':g['scopes'],'resource':self.resource}

    def token(self,p):
        if p.get('resource')!=self.resource:raise Denied('invalid_target')
        if p.get('grant_type')=='authorization_code':
            with self.db() as c:
                row=c.execute('select * from codes where hash=?',(digest(p.get('code','')),)).fetchone()
                if not row or row['expires']<time.time():raise Denied('invalid_grant')
                d=json.loads(row['data']);verifier=p.get('code_verifier','')
                if d['client_id']!=p.get('client_id') or d['redirect_uri']!=p.get('redirect_uri') or not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}',verifier) or not hmac.compare_digest(d['code_challenge'],challenge(verifier)):
                    raise Denied('invalid_grant')
                c.execute('delete from codes where hash=?',(row['hash'],))
                g={'id':random(),'user_id':d['user_id'],'client_id':d['client_id'],'scopes':' '.join(d['scopes']),'created':time.time(),'expires':time.time()+30*86400}
                c.execute('insert into grants(id,user_id,client_id,scopes,created,expires) values(:id,:user_id,:client_id,:scopes,:created,:expires)',g)
                return self.issue(c,g)
        if p.get('grant_type')=='refresh_token':
            reuse=False;result=None
            with self.db() as c:
                r=c.execute("select * from tokens where hash=? and kind='refresh'",(digest(p.get('refresh_token','')),)).fetchone()
                g=c.execute('select * from grants where id=?',(r['grant_id'],)).fetchone() if r else None
                if not r or not g or g['revoked'] or r['expires']<time.time() or g['client_id']!=p.get('client_id'):raise Denied('invalid_grant')
                if r['used']:
                    c.execute('update grants set revoked=1 where id=?',(g['id'],));reuse=True
                else:
                    if p.get('scope') and set(p['scope'].split())!=set(g['scopes'].split()):raise Denied('invalid_scope')
                    c.execute('update tokens set used=1 where hash=?',(r['hash'],));result=self.issue(c,g)
            if reuse:raise Denied('invalid_grant')
            return result
        raise Denied('unsupported_grant_type')

    def resolve(self,token):
        with self.db() as c:
            r=c.execute("select g.*,t.expires token_expires from tokens t join grants g on g.id=t.grant_id where t.hash=? and t.kind='access' and t.used=0 and g.revoked=0 and t.expires>? and g.expires>?",(digest(token),time.time(),time.time())).fetchone()
            if not r:raise Denied('invalid_token',401)
            return dict(r)

    def revoke(self,p):
        with self.db() as c:
            c.execute('update grants set revoked=1 where client_id=? and id in (select grant_id from tokens where hash=?)',(p.get('client_id'),digest(p.get('token',''))))
