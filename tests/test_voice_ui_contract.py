"""HTTP contracts used by the Aham UI. Temporary SQLite/files only; no models."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
