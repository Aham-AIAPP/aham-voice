import asyncio
import json
from urllib.parse import parse_qs,urlsplit

import pytest
from starlette.testclient import TestClient
from mcp_service.oauth import OAuth,Denied,challenge
from mcp_service.server import create_app

ISSUER='https://ai.orchisky.cn/voice'

@pytest.fixture
def auth(tmp_path):
    async def login(username,password):
        if (username,password)!=('alice','test-password'):raise Denied('invalid_credentials',401)
        return {'id':'alice-id','role':'member'}
    return OAuth(tmp_path/'auth.sqlite',ISSUER,login)

def begin(auth,scope='voice:read'):
    c=auth.register({'redirect_uris':['http://127.0.0.1:9000/callback'],'client_name':'Test'})
    p={'client_id':c['client_id'],'redirect_uri':c['redirect_uris'][0],'response_type':'code','resource':auth.resource,'code_challenge_method':'S256','code_challenge':challenge('a'*43),'state':'state','scope':scope}
    flow,csrf,cookie,_=auth.begin(p)
    return c,p,{'flow':flow,'csrf':csrf,'username':'alice','password':'test-password','confirm':'yes'},cookie

def exchange(auth):
    c,p,form,cookie=begin(auth)
    url=asyncio.run(auth.consent(form,cookie));q=parse_qs(urlsplit(url).query)
    assert q['state']==['state'] and q['iss']==[ISSUER]
    req={'client_id':c['client_id'],'redirect_uri':p['redirect_uri'],'code':q['code'][0],'grant_type':'authorization_code','code_verifier':'a'*43,'resource':auth.resource}
    return auth.token(req),req

def test_code_single_use_and_pkce(auth):
    _,p,form,cookie=begin(auth)
    code=parse_qs(urlsplit(asyncio.run(auth.consent(form,cookie))).query)['code'][0]
    req={'client_id':p['client_id'],'redirect_uri':p['redirect_uri'],'code':code,'grant_type':'authorization_code','code_verifier':'wrong'*10,'resource':auth.resource}
    with pytest.raises(Denied):auth.token(req)
    req['code_verifier']='a'*43;t=auth.token(req)
    assert auth.resolve(t['access_token'])['user_id']=='alice-id'
    with pytest.raises(Denied):auth.token(req)

def test_target_client_csrf_and_redirect(auth):
    c,p,form,cookie=begin(auth)
    for change in [{'resource':'https://wrong/mcp'},{'redirect_uri':'https://evil.example/cb'},{'code_challenge_method':'plain'},{'scope':'voice:read admin'}]:
        with pytest.raises(Denied):auth.begin({**p,**change})
    with pytest.raises(Denied):asyncio.run(auth.consent(form,'wrong'))
    with pytest.raises(Denied):asyncio.run(auth.consent({**form,'csrf':'wrong'},cookie))
    with pytest.raises(Denied):auth.register({'redirect_uris':['http://evil.example/cb']})

def test_refresh_rotation_reuse_revokes_family(auth):
    t,req=exchange(auth)
    p={'client_id':req['client_id'],'grant_type':'refresh_token','refresh_token':t['refresh_token'],'resource':auth.resource}
    new=auth.token(p);assert auth.resolve(new['access_token'])['user_id']=='alice-id'
    with pytest.raises(Denied):auth.token(p)
    with pytest.raises(Denied):auth.resolve(new['access_token'])
    with pytest.raises(Denied):auth.resolve(t['access_token'])

def test_revoke_and_hashed_storage(auth):
    t,req=exchange(auth)
    assert t['access_token'].encode() not in open(auth.path,'rb').read()
    auth.revoke({'client_id':'different','token':t['access_token']})
    auth.resolve(t['access_token'])
    auth.revoke({'client_id':req['client_id'],'token':t['refresh_token']})
    with pytest.raises(Denied):auth.resolve(t['access_token'])

def test_http_discovery_mcp_boundary_and_scopes(auth):
    class Backend:
        async def query(self,g,a,args):
            json.dumps(args)  # Exercise the real bridge's JSON serialization.
            if a in ('sync','retry') and 'voice:manage' not in g['scopes']:raise ValueError('需要管理授权')
            return {'authenticated':True,'name':'Test Alice','action':a}
    with TestClient(create_app(auth,Backend()),base_url='https://ai.orchisky.cn') as client:
        assert client.get('/voice/health',headers={'Host':'evil.example'}).status_code==403
        assert client.get('/voice/health',headers={'Origin':'https://evil.example'}).status_code==403
        assert client.post('/voice/oauth/consent',data={}).status_code==403
        meta=client.get('/.well-known/oauth-authorization-server/voice').json();assert meta['issuer']==ISSUER
        resource=client.get('/.well-known/oauth-protected-resource/voice/mcp').json();assert resource['resource']==auth.resource
        headers={'Accept':'application/json, text/event-stream'}
        rpc=lambda method,params={}:dict(jsonrpc='2.0',id=1,method=method,params=params)
        assert client.post('/voice/mcp',headers=headers,json=rpc('tools/list')).status_code==401
        token,_=exchange(auth);headers['Authorization']='Bearer '+token['access_token']
        r=client.post('/voice/mcp',headers=headers,json=rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'test','version':'1'}}))
        assert r.status_code==200,r.text
        tools=client.post('/voice/mcp',headers=headers,json=rpc('tools/list')).json()['result']['tools'];assert len(tools)==9
        r=client.post('/voice/mcp',headers=headers,json=rpc('tools/call',{'name':'voice_connection_status','arguments':{}})).json()
        assert 'Test Alice' in json.dumps(r)
        r=client.post('/voice/mcp',headers=headers,json=rpc('tools/call',{'name':'voice_sync_now','arguments':{}})).json()
        assert r['result']['isError'] is True
