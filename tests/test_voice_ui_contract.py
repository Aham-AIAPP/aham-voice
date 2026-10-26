"""HTTP contracts used by the Aham UI. Temporary SQLite/files only; no models."""
import os
import json
import hmac
import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

_bootstrap = tempfile.TemporaryDirectory()
os.environ["RECORDING_AI_HOME"] = _bootstrap.name
from backend.app import main as m, voice_integration as v
from fastapi.testclient import TestClient


class VoiceUiContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        app_data = base / "app-data"
        values = {
            "BASE": base, "APP_DATA": app_data, "DB_PATH": app_data / "test.sqlite",
            "RECORDINGS": app_data / "recordings", "EXPORTS": app_data / "exports",
            "TMP": app_data / "tmp", "VOICEPRINTS": base / "voiceprints",
            "CONFIG_PATH": base / "config.json",
        }
        for name in ("APP_DATA", "RECORDINGS", "EXPORTS", "TMP", "VOICEPRINTS"):
            values[name].mkdir(parents=True, exist_ok=True)
        self.paths = patch.multiple(m, **values)
        self.paths.start()
        m.ensure_schema()
        v.ensure_schema()
        self.audio = m.RECORDINGS / "test.wav"
        self.audio.write_bytes(b"test-audio-bytes")
        with m.db() as connection:
            for uid, role, team in (("alice", "member", "team-a"), ("bob", "member", "team-b"),
                                    ("manager", "manager", "team-a"), ("admin", "admin", "team-a")):
                connection.execute(
                    "insert into users(id,username,name,email,dept,role,team_id,last_active_at,must_change_password) values(?,?,?,?,?,?,?,?,0)",
                    (uid, uid, uid, uid + "@example.invalid", "Test", role, team, m.now()))
            for rid, owner, team in (("r1", "alice", "team-a"), ("r2", "bob", "team-b")):
                connection.execute(
                    "insert into recordings(id,title,filename,file_path,meeting_type,owner_id,team_id,duration,duration_label,asr_status,summary_status,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, "测试会议", "test.wav", str(self.audio), "内部会议", owner, team, 10, "00:10", "done", "done", m.now(), m.now()))
            connection.execute("insert into transcript_segments(id,recording_id,start_sec,end_sec,start_label,speaker,speaker_name,text) values('seg','r1',0,5,'00:00','1','测试发言人','保留原有功能')")
            for sid, version, current, content in (("s1", 1, 0, "第一版纪要正文"), ("s2", 2, 1, "当前纪要正文")):
                connection.execute("insert into summaries(id,recording_id,content,model,created_at,version,is_current) values(?,?,?,?,?,?,?)",
                                   (sid, "r1", content, "fixture", m.now(), version, current))
        self.user = {"id": "alice", "role": "member", "name": "alice", "team_id": "team-a", "managed_team_ids": []}
        self.previous_overrides = dict(m.app.dependency_overrides)
        m.app.dependency_overrides[m.current_user] = lambda: self.user
        self.client = TestClient(m.app)

    def tearDown(self):
        self.client.close()
        m.app.dependency_overrides.clear()
        m.app.dependency_overrides.update(self.previous_overrides)
        self.paths.stop()
        self.temp.cleanup()

    def test_detail_has_current_and_historical_content(self):
        response = self.client.get("/api/recordings/r1")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["summary"]["content"], "当前纪要正文")
        self.assertEqual([s["id"] for s in body["summaries"]], ["s2", "s1"])
        self.assertEqual(body["segments"][0]["text"], "保留原有功能")
        self.assertIn("tasks", body)
        self.assertIn("emotion_analysis", body)

    def test_summary_retry_queues_only_summary_without_erasing_content(self):
        first = self.client.post("/api/recordings/r1/summarize")
        again = self.client.post("/api/recordings/r1/summarize")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["job_id"], again.json()["job_id"])
        with m.db() as connection:
            job = connection.execute("select * from voice_jobs").fetchone()
            self.assertEqual(job["stage"], "summary_only")
            self.assertEqual(job["status"], "queued")
            self.assertEqual(connection.execute("select asr_status from recordings where id='r1'").fetchone()[0], "done")
            self.assertEqual(connection.execute("select count(*) from transcript_segments").fetchone()[0], 1)
            self.assertEqual(connection.execute("select content from summaries where id='s2'").fetchone()[0], "当前纪要正文")

    def test_downloads_return_selected_version_and_audio_bytes(self):
        old = self.client.get("/api/recordings/r1/export/summaries/s1.md")
        self.assertEqual(old.status_code, 200)
        self.assertEqual(old.text, "第一版纪要正文")
        current = self.client.get("/api/recordings/r1/export/summary.md")
        self.assertEqual(current.text, "当前纪要正文")
        transcript = self.client.get("/api/recordings/r1/export/transcript.md")
        self.assertEqual(transcript.status_code, 200)
        self.assertIn("保留原有功能", transcript.text)
        self.assertEqual(self.client.get("/api/recordings/r1/audio").content, b"test-audio-bytes")
        self.assertEqual(self.client.get("/api/recordings/r1/export/summaries/missing.md").status_code, 404)

    def test_role_scope_is_enforced_on_detail_media_export_and_jobs(self):
        for suffix in ("", "/audio", "/export/summary.md"):
            self.assertEqual(self.client.get("/api/recordings/r2" + suffix).status_code, 403)
        self.assertEqual(self.client.post("/api/recordings/r2/summarize").status_code, 403)
        self.user = {"id": "manager", "role": "manager", "name": "manager", "managed_team_ids": ["team-a"]}
        self.assertEqual(self.client.get("/api/recordings/r1").status_code, 200)
        self.assertEqual(self.client.get("/api/recordings/r2").status_code, 403)
        self.user["managed_team_ids"] = ["*"]
        self.assertEqual(self.client.get("/api/recordings/r2").status_code, 200)
        self.user = {"id": "admin", "role": "admin", "name": "admin"}
        self.assertEqual(self.client.get("/api/recordings/r1").status_code, 403)

    def preview(self, rid="r1"):
        with patch.object(m, "call_deepseek_revision", new=AsyncMock(return_value=("改写后正文", "fixture-model"))):
            response = self.client.post(f"/api/recordings/{rid}/summary/revise/preview", json={"instruction": "按议题整理"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_revision_preview_is_isolated_from_web_export_and_mcp_until_confirmed(self):
        draft = self.preview()
        self.assertEqual(draft["status"], "awaiting_confirmation")
        self.assertEqual(draft["base_summary_id"], "s2")
        self.assertEqual(draft["base_content"], "当前纪要正文")
        detail = self.client.get("/api/recordings/r1").json()
        before = v.read_action("summary", {"recording_id": "r1"}, self.user)
        self.assertEqual(before["summary"]["id"], "s2")
        self.assertEqual(before["summary"]["content"], "当前纪要正文")
        self.assertEqual(detail["summary"]["evidence"], before["summary"]["evidence"])
        self.assertEqual(len(detail["summaries"]), 2)
        self.assertEqual(detail["recording"]["summary_status"], "done")
        self.assertEqual(self.client.get("/api/recordings/r1/export/summary.md").text, "当前纪要正文")
        body = {"draft_id": draft["draft_id"], "content": "客户端不能篡改已预览正文"}
        applied = self.client.post("/api/recordings/r1/summary/revise/apply", json=body)
        self.assertEqual(applied.status_code, 200, applied.text)
        again = self.client.post("/api/recordings/r1/summary/revise/apply", json=body)
        self.assertEqual(again.json(), applied.json())
        after = v.read_action("summary", {"recording_id": "r1"}, self.user)["summary"]
        self.assertEqual(after["id"], applied.json()["summary_id"])
        self.assertEqual(after["base_summary_id"], "s2")
        self.assertEqual(after["content"], "改写后正文")
        self.assertEqual(after["version"], 3)
        self.assertEqual(self.client.get("/api/recordings/r1/export/summaries/s2.md").text, "当前纪要正文")
        with m.db() as conn:
            self.assertEqual(conn.execute("select count(*) from summaries where recording_id='r1'").fetchone()[0], 3)
            self.assertEqual(conn.execute("select sum(is_current) from summaries where recording_id='r1'").fetchone()[0], 1)

    def test_revision_rejects_stale_expired_and_processing_drafts(self):
        for change in ("summary", "transcript", "expired", "processing"):
            with self.subTest(change=change):
                draft = self.preview()
                with m.db() as conn:
                    if change == "summary":
                        conn.execute("update summaries set is_current=0 where id='s2'")
                        conn.execute("update summaries set is_current=1 where id='s1'")
                    elif change == "transcript": conn.execute("update transcript_segments set text='新逐字稿' where id='seg'")
                    elif change == "expired": conn.execute("update summary_revision_drafts set expires_at=0")
                    else: conn.execute("update recordings set summary_status='running' where id='r1'")
                response = self.client.post("/api/recordings/r1/summary/revise/apply", json={"draft_id": draft["draft_id"]})
                self.assertEqual(response.status_code, 409, response.text)
                with m.db() as conn:
                    conn.execute("update summaries set is_current=case when id='s2' then 1 else 0 end")
                    conn.execute("update transcript_segments set text='保留原有功能' where id='seg'")
                    conn.execute("update recordings set summary_status='done' where id='r1'")
                    self.assertEqual(conn.execute("select count(*) from summaries").fetchone()[0], 2)

    def test_preview_and_confirmation_enforce_recording_and_draft_owner(self):
        draft = self.preview()
        self.assertEqual(self.client.post("/api/recordings/r2/summary/revise/preview", json={"instruction":"重写"}).status_code, 403)
        self.assertEqual(self.client.post("/api/recordings/r2/summary/revise/apply", json={"draft_id":draft["draft_id"]}).status_code, 403)
        self.user = {"id":"manager", "name":"manager", "role":"manager", "managed_team_ids":["*"]}
        self.assertEqual(self.client.post("/api/recordings/r1/summary/revise/apply", json={"draft_id":draft["draft_id"]}).status_code, 404)
        self.assertEqual(self.client.post("/api/recordings/r2/summary/revise/apply", json={"draft_id":draft["draft_id"]}).status_code, 404)
        self.user = {"id":"admin", "name":"admin", "role":"admin"}
        self.assertEqual(self.client.post("/api/recordings/r1/summary/revise/apply", json={"draft_id":draft["draft_id"]}).status_code, 403)

    def test_failed_or_empty_preview_preserves_current_content_and_status(self):
        for result in (AsyncMock(side_effect=ValueError("provider failure")), AsyncMock(return_value=("  ", "fixture"))):
            with patch.object(m, "call_deepseek_revision", new=result):
                self.assertEqual(self.client.post("/api/recordings/r1/summary/revise/preview", json={"instruction":"重写"}).status_code, 502)
        with m.db() as conn:
            self.assertEqual(conn.execute("select count(*) from summary_revision_drafts").fetchone()[0], 0)
            self.assertEqual(conn.execute("select summary_status from recordings where id='r1'").fetchone()[0], "done")
        self.assertEqual(v.read_action("summary", {"recording_id":"r1"}, self.user)["summary"]["content"], "当前纪要正文")

    def test_mcp_signed_bridge_returns_the_same_effective_summary_and_evidence(self):
        private = m.BASE / "private"
        private.mkdir()
        key = b"fixture-only-bridge-key"
        (private / "mcp-bridge-key").write_bytes(key)
        self.preview()
        payload = json.dumps({"user_id":"alice", "scopes":["voice:read"], "action":"summary", "arguments":{"recording_id":"r1"}}).encode()
        stamp = str(time.time())
        signature = hmac.new(key, stamp.encode() + b"\n" + payload, hashlib.sha256).hexdigest()
        response = self.client.post("/api/internal/voice-mcp", content=payload, headers={"X-Voice-Time":stamp, "X-Voice-Signature":signature})
        self.assertEqual(response.status_code, 200, response.text)
        summary = response.json()["summary"]
        web = self.client.get("/api/recordings/r1").json()["summary"]
        for field in ("id", "recording_id", "content", "model", "version", "base_summary_id", "is_current", "evidence"):
            self.assertEqual(summary[field], web[field])
        self.assertEqual(summary["evidence"], {"kind":"transcript", "recording_id":"r1", "title":"测试会议"})

    def test_concurrent_confirmations_cannot_overwrite_a_newer_version(self):
        drafts = [self.preview(), self.preview()]
        def apply(draft):
            return self.client.post("/api/recordings/r1/summary/revise/apply", json={"draft_id":draft["draft_id"]})
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(apply, drafts))
        self.assertEqual(sorted(r.status_code for r in results), [200, 409])
        with m.db() as conn:
            self.assertEqual(conn.execute("select count(*) from summaries").fetchone()[0], 3)
            self.assertEqual(conn.execute("select sum(is_current) from summaries").fetchone()[0], 1)

    def test_confirmation_rolls_back_if_audit_cannot_be_saved(self):
        draft = self.preview()
        with patch.object(m, "audit", side_effect=RuntimeError("test audit failure")):
            with self.assertRaises(RuntimeError):
                self.client.post("/api/recordings/r1/summary/revise/apply", json={"draft_id":draft["draft_id"]})
        with m.db() as conn:
            self.assertEqual(conn.execute("select count(*) from summaries").fetchone()[0], 2)
            self.assertEqual(conn.execute("select id from summaries where is_current=1").fetchone()[0], "s2")
            self.assertIsNone(conn.execute("select applied_summary_id from summary_revision_drafts where id=?", (draft["draft_id"],)).fetchone()[0])
            self.assertEqual(conn.execute("select count(*) from tasks").fetchone()[0], 0)

    def test_queued_summary_job_blocks_confirmation_without_changing_current(self):
        draft = self.preview()
        self.client.post("/api/recordings/r1/summarize")
        self.assertEqual(self.client.post("/api/recordings/r1/summary/revise/apply", json={"draft_id":draft["draft_id"]}).status_code, 409)
        self.assertEqual(self.client.post("/api/recordings/r1/summary/revise/preview", json={"instruction":"重写"}).status_code, 409)
        self.assertEqual(self.client.get("/api/recordings/r1/export/summary.md").text, "当前纪要正文")

    def test_legacy_revision_endpoint_retains_its_response_contract(self):
        with patch.object(m, "call_deepseek_revision", new=AsyncMock(return_value=("兼容调用正文", "fixture"))):
            response = self.client.post("/api/recordings/r1/summary/revise", json={"instruction":"重写"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["version"], 3)
        self.assertEqual(v.read_action("summary", {"recording_id":"r1"}, self.user)["summary"]["content"], "兼容调用正文")

    def test_upload_options_round_trip_and_no_automatic_job_when_disabled(self):
        with patch.object(m, "probe_duration", return_value=10):
            response = self.client.post("/api/recordings",
                files={"file": ("sample.wav", b"uploaded-audio", "audio/wav")},
                data={"title": "上传验证", "meeting_type": "客户调研", "tag": "测试项目", "expected_speakers": "3", "auto_process": "false"})
        self.assertEqual(response.status_code, 200, response.text)
        record = response.json()
        self.assertEqual(record["title"], "上传验证")
        self.assertEqual(record["meeting_type"], "客户调研")
        self.assertEqual(record["tag"], "测试项目")
        with m.db() as connection:
            row = connection.execute("select * from recordings where id=?", (record["id"],)).fetchone()
            self.assertEqual(row["expected_speakers"], 3)
            self.assertEqual(Path(row["file_path"]).read_bytes(), b"uploaded-audio")
            self.assertEqual(connection.execute("select count(*) from voice_jobs where recording_id=?", (record["id"],)).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
