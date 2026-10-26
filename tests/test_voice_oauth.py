import asyncio
import json
from urllib.parse import parse_qs,urlsplit

import pytest
from starlette.testclient import TestClient
from mcp_service.oauth import OAuth,Denied,challenge
from mcp_service.server import create_app,consent_cookie_name,page_policy

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
            if a in ('sync','retry','update_hotwords') and 'voice:manage' not in g['scopes']:raise ValueError('需要管理授权')
            return {'authenticated':True,'name':'Test Alice','action':a}
    with TestClient(create_app(auth,Backend()),base_url='https://ai.orchisky.cn') as client:
        assert client.get('/voice/health',headers={'Host':'evil.example'}).status_code==403
        assert client.get('/voice/health',headers={'Origin':'https://new-client.example'}).status_code==200
        assert client.post('/voice/oauth/consent',data={'csrf':'wrong'}).status_code==403
        meta=client.get('/.well-known/oauth-authorization-server/voice').json();assert meta['issuer']==ISSUER
        resource=client.get('/.well-known/oauth-protected-resource/voice/mcp').json();assert resource['resource']==auth.resource
        headers={'Accept':'application/json, text/event-stream'}
        rpc=lambda method,params={}:dict(jsonrpc='2.0',id=1,method=method,params=params)
        assert client.post('/voice/mcp',headers=headers,json=rpc('tools/list')).status_code==401
        token,_=exchange(auth);headers['Authorization']='Bearer '+token['access_token']
        r=client.post('/voice/mcp',headers=headers,json=rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'test','version':'1'}}))
        assert r.status_code==200,r.text
        tools=client.post('/voice/mcp',headers=headers,json=rpc('tools/list')).json()['result']['tools'];assert len(tools)==11
        summary_tool=next(t for t in tools if t['name']=='voice_get_summary')
        assert summary_tool['annotations']['readOnlyHint'] is True
        assert 'evidence' in summary_tool['description'] and '待确认' in summary_tool['description']
        assert 'recording_id' in summary_tool['inputSchema']['required']
        r=client.post('/voice/mcp',headers=headers,json=rpc('tools/call',{'name':'voice_connection_status','arguments':{}})).json()
        assert 'Test Alice' in json.dumps(r)
        r=client.post('/voice/mcp',headers=headers,json=rpc('tools/call',{'name':'voice_sync_now','arguments':{}})).json()
        assert r['result']['isError'] is True


@pytest.mark.parametrize('origin',['https://claude.ai','https://new-client.example','null'])
def test_any_origin_oauth_and_authenticated_mcp(auth,origin):
    class Backend:
        async def query(self,g,a,args):return {'action':a,'arguments':args}
    with TestClient(create_app(auth,Backend()),base_url='https://ai.orchisky.cn') as client:
        for path in ['/.well-known/oauth-authorization-server/voice','/.well-known/oauth-protected-resource/voice/mcp','/voice/oauth/register','/voice/oauth/token','/voice/mcp']:
            r=client.options(path,headers={'Origin':origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,mcp-protocol-version'})
            assert r.status_code==200 and r.headers['access-control-allow-origin'] in ('*',origin)
        r=client.get('/.well-known/oauth-authorization-server/voice',headers={'Origin':origin})
        assert r.status_code==200 and r.headers['access-control-allow-origin'] in ('*',origin)
        r=client.post('/voice/oauth/register',headers={'Origin':origin},json={'redirect_uris':['https://client.example/callback'],'client_name':'Claude compatibility test'})
        assert r.status_code==201
        c=r.json();verifier='c'*43
        p={'client_id':c['client_id'],'redirect_uri':c['redirect_uris'][0],'response_type':'code','resource':auth.resource,'code_challenge_method':'S256','code_challenge':challenge(verifier),'state':'claude-test','scope':'voice:read voice:manage'}
        r=client.get('/voice/oauth/authorize',params=p,headers={'Origin':origin});assert r.status_code==200
        import re
        fields={k:re.search('name="'+k+'" value="([^"]+)"',r.text).group(1) for k in ['flow','csrf']}
        fields.update(username='alice',password='test-password',confirm='yes')
        assert client.post('/voice/oauth/consent',data={**fields,'csrf':'wrong'},headers={'Origin':origin}).status_code==403
        assert client.post('/voice/oauth/consent',data={**fields,'password':'wrong'},headers={'Origin':origin}).status_code==401
        r=client.post('/voice/oauth/consent',data=fields,headers={'Origin':origin},follow_redirects=False)
        assert r.status_code==303
        code=parse_qs(urlsplit(r.headers['location']).query)['code'][0]
        r=client.post('/voice/oauth/token',headers={'Origin':origin},data={'grant_type':'authorization_code','code':code,'code_verifier':verifier,'client_id':c['client_id'],'redirect_uri':c['redirect_uris'][0],'resource':auth.resource})
        assert r.status_code==200 and r.headers['access-control-allow-origin'] in ('*',origin)
        token=r.json()['access_token']
        headers={'Origin':origin,'Accept':'application/json, text/event-stream'}
        request={'jsonrpc':'2.0','id':1,'method':'tools/list'}
        r=client.post('/voice/mcp',headers=headers,json=request)
        assert r.status_code==401 and r.headers['access-control-allow-origin'] in ('*',origin)
        assert 'www-authenticate' in r.headers['access-control-expose-headers'].lower()
        headers['Authorization']='Bearer '+token
        r=client.post('/voice/mcp',headers=headers,json=request)
        assert r.status_code==200 and len(r.json()['result']['tools'])==11
        request.update(method='tools/call',params={'name':'voice_update_hotwords','arguments':{'entries':[{'word':'金蝶','aliases':['金碟'],'weight':9}]}})
        r=client.post('/voice/mcp',headers=headers,json=request).json()['result']
        assert not r.get('isError') and '金碟' in json.dumps(r,ensure_ascii=False)


def test_unknown_origins_need_auth_and_host_stays_restricted(auth):
    with TestClient(create_app(auth,None),base_url='https://ai.orchisky.cn') as client:
        for origin in ['https://new-client.example','http://localhost:8080','null']:
            r=client.get('/.well-known/oauth-authorization-server/voice',headers={'Origin':origin})
            assert r.status_code==200 and r.headers['access-control-allow-origin']=='*'
            r=client.post('/voice/mcp',headers={'Origin':origin,'Accept':'application/json, text/event-stream'},json={'jsonrpc':'2.0','id':1,'method':'tools/list'})
            assert r.status_code==401
            r=client.post('/voice/oauth/consent',data={'csrf':'wrong'},headers={'Origin':origin})
            assert r.status_code==403
        assert client.get('/voice/health',headers={'Host':'evil.example'}).status_code==403
        r=client.get('/voice/health',headers=[('Origin','https://claude.ai'),('Origin','https://new-client.example')]);assert r.status_code==400


def test_management_scope_requires_explicit_consent(auth):
    for opted_in in (False,True):
        c,p,form,cookie=begin(auth)
        if opted_in:form['allow_manage']='yes'
        redirect=asyncio.run(auth.consent(form,cookie))
        code=parse_qs(urlsplit(redirect).query)['code'][0]
        token=auth.token({'client_id':c['client_id'],'redirect_uri':p['redirect_uri'],'code':code,'grant_type':'authorization_code','code_verifier':'a'*43,'resource':auth.resource})
        assert ('voice:manage' in token['scope'].split())==opted_in
        assert ('voice:manage' in auth.resolve(token['access_token'])['scopes'].split())==opted_in


def test_duplicate_consent_creates_only_one_code(auth):
    c,p,form,cookie=begin(auth)
    asyncio.run(auth.consent(form,cookie))
    with pytest.raises(Denied) as exc:asyncio.run(auth.consent(form,cookie))
    assert exc.value.code=='consent_already_submitted'
    with auth.db() as db:assert db.execute('select count(*) from codes').fetchone()[0]==1
    with pytest.raises(Denied) as exc:asyncio.run(auth.consent(form,'wrong'))
    assert exc.value.code=='invalid_consent'


def test_browser_callback_csp_separate_tabs_and_friendly_repeat(auth):
    import re
    c=auth.register({'redirect_uris':['https://claude.ai/api/mcp/auth_callback'],'client_name':'Claude'})
    p={'client_id':c['client_id'],'redirect_uri':c['redirect_uris'][0],'response_type':'code','resource':auth.resource,'code_challenge_method':'S256','code_challenge':challenge('z'*43),'state':'test','scope':'voice:read'}
    with TestClient(create_app(auth,None),base_url='https://ai.orchisky.cn') as client:
        forms=[]
        for _ in range(2):
            response=client.get('/voice/oauth/authorize',params=p)
            fields={k:re.search('name="'+k+'" value="([^"]+)"',response.text).group(1) for k in ['flow','csrf']}
            nonce=re.search('<script nonce="([^"]+)"',response.text).group(1)
            assert len(response.headers.get_list('content-security-policy'))==1
            assert "form-action 'self' https://claude.ai;" in response.headers['content-security-policy']
            assert "script-src 'nonce-"+nonce+"'" in response.headers['content-security-policy']
            assert consent_cookie_name(fields['flow']) in client.cookies
            forms.append({**fields,'username':'alice','password':'test-password','confirm':'yes'})
        for form in forms:
            response=client.post('/voice/oauth/consent',data=form,follow_redirects=False)
            assert response.status_code==303
            assert response.headers['location'].startswith('https://claude.ai/api/mcp/auth_callback?')
            assert "form-action 'self' https://claude.ai;" in response.headers['content-security-policy']
            duplicate=client.post('/voice/oauth/consent',data=form)
            assert duplicate.status_code==409 and '这次授权已提交' in duplicate.text
        assert 'http://127.0.0.1:9000' in page_policy('http://127.0.0.1:9000/callback')
        with pytest.raises(Denied):page_policy('https://evil.example;script-src/callback')
