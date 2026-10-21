import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_root=tempfile.TemporaryDirectory()
os.environ['RECORDING_AI_HOME']=_root.name
from backend.app import main as m, voice_integration as v, voice_worker as worker
from fastapi import HTTPException
from fastapi.testclient import TestClient


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();m.BASE=Path(self.tmp.name);m.APP_DATA=m.BASE/'app-data';m.APP_DATA.mkdir()
        m.DB_PATH=m.APP_DATA/'test.sqlite';m.RECORDINGS=m.APP_DATA/'recordings';m.RECORDINGS.mkdir()
        m.ensure_schema();v.ensure_schema()
        (m.BASE/'private').mkdir()
        (m.BASE/'private/voice-integration.json').write_text(json.dumps({'dws_profile':'profile','owner_id':'alice','pilot_uuid':'pilot','public_issuer':'https://example.com/voice'}))
        (m.BASE/'private/mcp-bridge-key').write_bytes(b'k'*32)
        with m.db() as c:
            for uid in ('alice','bob'):
                c.execute("insert into users(id,username,name,email,dept,role,last_active_at,must_change_password) values(?,?,?,?,?,'member',?,0)",(uid,uid,uid,uid+'@example.com','Test',m.now()))
        self.user=v.owner('alice');self.sid,_=v.add_source({'taskUuid':'pilot','title':'Original','startTime':1700000000000})
        audio=m.BASE/'input.ogg';audio.write_bytes(b'audio')
        v.source_update(self.sid,audio_path=str(audio),audio_sha256=v.sha256(audio))
        with patch.object(m,'probe_duration',return_value=60):self.rid=v.import_source(v.get_source(self.sid),self.user)
        with m.db() as c:
            self.jid=c.execute('select id from voice_jobs').fetchone()[0]
            c.execute('update voice_jobs set recording_id=? where id=?',(self.rid,self.jid))

    def tearDown(self):self.tmp.cleanup()

    def test_idempotent_import_and_scan(self):
        self.assertFalse(v.add_source({'taskUuid':'pilot','title':'New'})[1])
        self.assertEqual(self.rid,v.import_source(v.get_source(self.sid),self.user))
        self.assertEqual(self.jid,v.enqueue(self.rid,'alice'))
        with m.db() as c:self.assertEqual(c.execute('select count(*) from recordings').fetchone()[0],1)

    def test_title_conflict_preserves_manual_title(self):
        v.source_update(self.sid,generated_title='Generated')
        with m.db() as c:c.execute('update recordings set title=? where id=?',('Manual',self.rid))
        with self.assertRaises(v.TitleConflict):v.apply_title(v.get_source(self.sid),self.user)
        with patch.object(v,'dws') as cmd:
            with self.assertRaises(v.TitleConflict):v.writeback(v.get_source(self.sid),self.user)
            cmd.assert_not_called()

    def test_unknown_write_result_readback_avoids_duplicate(self):
        v.source_update(self.sid,generated_title='Generated')
        with m.db() as c:c.execute('update recordings set title=? where id=?',('Generated',self.rid))
        with patch.object(v,'basic',return_value={'title':'Generated'}),patch.object(v,'dws') as cmd:
            v.writeback(v.get_source(self.sid),self.user);cmd.assert_not_called()
        self.assertEqual(v.get_source(self.sid)['remote_applied_title'],'Generated')

    def test_dingtalk_date_prefix_is_verified_after_cli_error(self):
        v.source_update(self.sid,generated_title='2023-11-15｜测试会议主题')
        with m.db() as c:c.execute('update recordings set title=? where id=?',('2023-11-15｜测试会议主题',self.rid))
        source=v.get_source(self.sid);theme,expected=v.remote_title_values(source)
        actual=next(t for t in expected if t!=theme)
        with patch.object(v,'basic',side_effect=[{'title':'Original'},{'title':actual}]),patch.object(v,'dws',side_effect=RuntimeError('verification failed')):
            v.writeback(source,self.user)
        self.assertEqual(v.get_source(self.sid)['remote_applied_title'],actual)

    def test_resume_summary_does_not_repeat_asr(self):
        with m.db() as c:
            c.execute("update recordings set asr_status='done',summary_status='done' where id=?",(self.rid,))
            c.execute("update voice_jobs set stage='summary',status='running'")
        v.set_state('auto_title',False)
        worker.recover();job=worker.claim()
        with patch.object(m,'transcribe_recording') as asr,patch.object(m,'summarize_recording') as summary:
            v.run_job(job);asr.assert_not_called();summary.assert_not_called()
        self.assertIsNone(v.state('pilot_passed'))

    def test_acl_signature_and_scope(self):
        self.assertEqual(v.read_action('recordings',{},v.owner('bob'))['items'],[])
        with self.assertRaises(HTTPException):v.read_action('detail',{'recording_id':self.rid},v.owner('bob'))
        client=TestClient(m.app)
        def request(action,user='alice',scopes=['voice:read'],stamp=None):
            body=json.dumps({'action':action,'user_id':user,'arguments':{},'scopes':scopes}).encode();stamp=stamp or str(time.time())
            sig=hmac.new(b'k'*32,stamp.encode()+b'\n'+body,hashlib.sha256).hexdigest()
            return client.post('/api/internal/voice-mcp',content=body,headers={'X-Voice-Time':stamp,'X-Voice-Signature':sig})
        self.assertEqual(request('recordings').status_code,200)
        self.assertEqual(request('sync').status_code,403)
        self.assertEqual(request('sync','bob',['voice:read','voice:manage']).status_code,403)
        self.assertEqual(request('recordings',stamp='1').status_code,401)
        self.assertEqual(client.post('/api/internal/voice-mcp',json={}).status_code,401)


if __name__=='__main__':unittest.main()
