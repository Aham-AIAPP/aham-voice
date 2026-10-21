from __future__ import annotations

import csv
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any

import httpx
from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse


ROOT = Path(__file__).resolve().parents[2]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    try:
        from dotenv import dotenv_values
    except ImportError:
        # python-dotenv is in requirements.txt; missing only when the venv is
        # not bootstrapped. Keep the API bootable without env overrides.
        return
    try:
        values = dotenv_values(path) or {}
    except Exception:
        # Malformed .env should not block server start.
        return
    for key, value in values.items():
        if value is not None:
            os.environ.setdefault(key, str(value))


load_env_file(ROOT / ".env.local")
load_env_file(ROOT / ".env")

BASE = Path(os.environ.get("RECORDING_AI_HOME", Path.home() / ".cache" / "recording-ai"))
APP_DATA = BASE / "app-data"
DB_PATH = APP_DATA / "newvoice.sqlite3"
RECORDINGS = APP_DATA / "recordings"
EXPORTS = APP_DATA / "exports"
TMP = APP_DATA / "tmp"
MODELS = BASE / "models" / "modelscope" / "iic"
VAD = MODELS / "speech_fsmn_vad_zh-cn-16k-common-pytorch"
PUNC = MODELS / "punc_ct-transformer_cn-en-common-vocab471067-large"
PARAFORMER = MODELS / "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
CAMPLUS = MODELS / "speech_campplus_sv_zh-cn_16k-common"
EMOTION = MODELS / "emotion2vec_plus_large"
VOICEPRINTS = BASE / "voiceprints"
FFMPEG = BASE / "bin" / "ffmpeg"
FFPROBE = BASE / "bin" / "ffprobe"
os.environ["PATH"] = f"{BASE / 'bin'}:{os.environ.get('PATH', '')}"

# 推理设备。默认 cpu（macOS 本机部署）；Linux + NVIDIA 部署设 NEWVOICE_ASR_DEVICE=cuda:0
# 即可让 FunASR 的 ASR / 情绪模型走 GPU。ModelScope 的 speaker_verification
# pipeline 只认 "cpu" / "gpu"，所以单独映射一层。
ASR_DEVICE = (os.environ.get("NEWVOICE_ASR_DEVICE") or "cpu").strip()


def modelscope_device() -> str:
    return "gpu" if ASR_DEVICE.startswith("cuda") else "cpu"


for path in [APP_DATA, RECORDINGS, EXPORTS, TMP, VOICEPRINTS]:
    path.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# LLM 配置持久层（与 aham-voice 开源版对齐）
# 大模型配置存 BASE/config.json（原子写）。读取优先级:环境变量 -> config.json
# -> 默认值;同时兼容通用 LLM_* 新键与 DEEPSEEK_* 旧键(新键优先),所以原有
# .env / 环境变量部署不受影响。
# ---------------------------------------------------------------------------
CONFIG_PATH = BASE / "config.json"


def load_user_config() -> dict[str, Any]:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_user_config(updates: dict[str, Any]) -> dict[str, Any]:
    data = load_user_config()
    data.update(updates)
    BASE.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp.replace(CONFIG_PATH)
    return data


DEFAULT_LLM_API_BASE = "https://api.deepseek.com"
DEFAULT_LLM_MODEL = "deepseek-v4-flash"


def get_llm_config() -> tuple[str, str, str]:
    """Return (api_key, api_base, model) for any OpenAI-compatible LLM endpoint.

    Reading priority (each field independently): env -> config.json -> default.
    Both the new generic keys and the legacy DeepSeek keys are honoured so that
    existing config.json / environment setups keep working unchanged.
    """
    cfg = load_user_config()
    api_key = (
        os.environ.get("LLM_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or cfg.get("llm_api_key")
        or cfg.get("deepseek_api_key")
        or ""
    ).strip()
    base = (
        os.environ.get("LLM_API_BASE")
        or os.environ.get("DEEPSEEK_API_BASE")
        or cfg.get("llm_api_base")
        or cfg.get("deepseek_api_base")
        or DEFAULT_LLM_API_BASE
    ).rstrip("/")
    model = (
        os.environ.get("LLM_MODEL")
        or os.environ.get("DEEPSEEK_MODEL")
        or cfg.get("llm_model")
        or cfg.get("deepseek_model")
        or DEFAULT_LLM_MODEL
    ).strip()
    return api_key, base, model


def get_llm_provider() -> str:
    """Optional provider hint (free-form), only used for display in settings."""
    cfg = load_user_config()
    return (
        os.environ.get("LLM_PROVIDER")
        or cfg.get("llm_provider")
        or ""
    ).strip()


app = FastAPI(title="NewVoice Local API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://0.0.0.0:5173",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+):5173$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

_asr_model: Any | None = None
_speaker_verifier: Any | None = None
_emotion_model: Any | None = None
# FunASR's AutoModel and the modelscope speaker_verification pipeline both keep
# internal state across calls (cache dicts, tensor buffers, optional CUDA
# context). Concurrent invocations from starlette's threadpool — one upload
# transcribing while the user also clicks "重新转写" on another — corrupt that
# state. Serialize ASR + verifier work on a single process-wide lock.
_asr_lock = threading.Lock()
_asr_init_lock = threading.Lock()
_verifier_init_lock = threading.Lock()
_emotion_init_lock = threading.Lock()
DEFAULT_VOICEPRINT_THRESHOLD = 0.66


@contextmanager
def db() -> Any:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def rowdict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def rowsdict(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def safe_json(value: str | None, default: Any) -> Any:
    if isinstance(value, (list, dict)):
        return value
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def slug(text: str) -> str:
    text = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", text.strip(), flags=re.UNICODE)
    return text[:80] or "recording"


def clean_sensevoice_text(text: str) -> str:
    text = re.sub(r"<\|[^|]+?\|>", "", text or "")
    return re.sub(r"\s+", " ", text).strip()


def clean_wecom_name(text: str) -> str:
    return re.sub(r"^\s*\d+\s*[-_－—]\s*", "", text or "").strip()


def seconds_label(seconds: float | int | None) -> str:
    total = int(seconds or 0)
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def parse_local_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def initial_password() -> str:
    return os.environ.get("NEWVOICE_INITIAL_PASSWORD", "orchisky888888")


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    rounds = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), rounds).hex()
    return f"pbkdf2_sha256${rounds}${salt}${digest}"


def verify_password(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        algorithm, rounds, salt, digest = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(rounds)).hex()
        return hmac.compare_digest(candidate, digest)
    except (ValueError, TypeError):
        return False


def session_expiry() -> str:
    return (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")


def probe_duration(path: Path) -> float:
    if not FFPROBE.exists():
        return 0.0
    proc = subprocess.run(
        [
            str(FFPROBE),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def ensure_schema() -> None:
    with db() as conn:
        conn.executescript(
            """
            create table if not exists teams (
                id text primary key,
                name text not null,
                dept text not null,
                wecom_department_id text,
                parent_wecom_department_id text,
                manager_ids text not null default '[]'
            );
            create table if not exists users (
                id text primary key,
                username text,
                name text not null,
                email text not null,
                mobile text,
                dept text not null,
                role text not null,
                team_id text,
                managed_team_ids text not null default '[]',
                status text not null default 'active',
                source text not null default 'local',
                wecom_userid text,
                password_hash text,
                must_change_password integer not null default 1,
                failed_login_count integer not null default 0,
                locked_until text,
                last_active_at text not null,
                last_login_at text,
                created_at text,
                updated_at text
            );
            create table if not exists sessions (
                token text primary key,
                user_id text not null,
                created_at text not null,
                expires_at text not null
            );
            create table if not exists app_settings (
                key text primary key,
                value text not null,
                updated_at text not null
            );
            create table if not exists role_mappings (
                id text primary key,
                match_type text not null,
                match_value text not null,
                role text not null,
                managed_team_ids text not null default '[]',
                active integer not null default 1,
                priority integer not null default 100,
                created_at text not null,
                updated_at text not null
            );
            create table if not exists recordings (
                id text primary key,
                title text not null,
                filename text not null,
                file_path text not null,
                meeting_type text not null,
                tag text,
                owner_id text not null,
                team_id text,
                duration real not null default 0,
                duration_label text not null,
                asr_status text not null default 'pending',
                summary_status text not null default 'pending',
                created_at text not null,
                updated_at text not null
            );
            create table if not exists transcript_segments (
                id text primary key,
                recording_id text not null,
                start_sec real not null,
                end_sec real not null,
                start_label text not null,
                speaker text not null,
                speaker_name text,
                voiceprint_id text,
                speaker_confidence real,
                text text not null,
                confidence real
            );
            create table if not exists summaries (
                id text primary key,
                recording_id text not null,
                content text not null,
                model text not null,
                created_at text not null
            );
            create table if not exists emotion_analyses (
                id text primary key,
                recording_id text not null,
                content text not null,
                model text not null,
                acoustic_json text,
                created_at text not null,
                version integer not null default 1,
                is_current integer not null default 1
            );
            create table if not exists tasks (
                id text primary key,
                recording_id text,
                recording_title text not null,
                step text not null,
                status text not null,
                progress integer not null default 0,
                error text,
                created_at text not null,
                updated_at text not null
            );
            create table if not exists hotwords (
                id text primary key,
                word text not null,
                kind text not null,
                aliases text,
                source text not null,
                scope text not null,
                weight integer not null,
                active integer not null default 1,
                source_key text,
                state text not null default 'active',
                protected integer not null default 0,
                frequency integer not null default 1,
                confidence real not null default 0.75,
                score real not null default 0,
                team_id text,
                owner_id text,
                first_seen_at text,
                last_seen_at text,
                last_used_at text,
                expires_at text,
                hit_count integer not null default 0,
                updated_at text
            );
            create table if not exists hotword_sources (
                id text primary key,
                name text not null unique,
                source_type text not null,
                enabled integer not null default 1,
                schedule_minutes integer not null default 360,
                lookback_days integer not null default 30,
                asr_limit integer not null default 3000,
                correction_limit integer not null default 10000,
                candidate_limit integer not null default 20000,
                last_success_at text,
                last_error text,
                created_at text not null,
                updated_at text not null
            );
            create table if not exists hotword_sync_runs (
                id text primary key,
                source_name text not null,
                mode text not null,
                status text not null,
                started_at text not null,
                finished_at text,
                inserted integer not null default 0,
                updated integer not null default 0,
                reactivated integer not null default 0,
                expired integer not null default 0,
                skipped integer not null default 0,
                total integer not null default 0,
                report_path text,
                error text
            );
            create table if not exists recording_hotword_packages (
                id text primary key,
                recording_id text not null,
                version integer not null,
                asr_terms_count integer not null default 0,
                correction_terms_count integer not null default 0,
                protected_terms_count integer not null default 0,
                dynamic_terms_count integer not null default 0,
                source_summary text,
                asr_terms text,
                correction_terms text,
                created_at text not null
            );
            create table if not exists speaker_profiles (
                id text primary key,
                name text not null,
                note text,
                owner_id text,
                team_id text,
                scope text not null default 'team',
                sample_path text not null,
                threshold real not null default 0.66,
                active integer not null default 1,
                created_at text not null
            );
            create table if not exists speaker_samples (
                id text primary key,
                profile_id text not null,
                recording_id text not null,
                segment_id text not null,
                start_sec real not null,
                end_sec real not null,
                duration real not null,
                text text,
                created_by text,
                created_at text not null
            );
            create table if not exists audit (
                id text primary key,
                created_at text not null,
                actor_id text,
                actor_name text not null,
                category text not null,
                message text not null
            );
            """
        )
        team_cols = {row["name"] for row in conn.execute("pragma table_info(teams)").fetchall()}
        if "wecom_department_id" not in team_cols:
            conn.execute("alter table teams add column wecom_department_id text")
        if "parent_wecom_department_id" not in team_cols:
            conn.execute("alter table teams add column parent_wecom_department_id text")
        user_cols = {row["name"] for row in conn.execute("pragma table_info(users)").fetchall()}
        user_migrations = {
            "username": "text",
            "mobile": "text",
            "source": "text not null default 'local'",
            "wecom_userid": "text",
            "password_hash": "text",
            "must_change_password": "integer not null default 1",
            "failed_login_count": "integer not null default 0",
            "locked_until": "text",
            "last_login_at": "text",
            "created_at": "text",
            "updated_at": "text",
        }
        for column, definition in user_migrations.items():
            if column not in user_cols:
                conn.execute(f"alter table users add column {column} {definition}")
        recording_cols = {row["name"] for row in conn.execute("pragma table_info(recordings)").fetchall()}
        recording_migrations = {
            "expected_speakers": "integer",
        }
        for column, definition in recording_migrations.items():
            if column not in recording_cols:
                conn.execute(f"alter table recordings add column {column} {definition}")
        segment_cols = {row["name"] for row in conn.execute("pragma table_info(transcript_segments)").fetchall()}
        if "speaker_name" not in segment_cols:
            conn.execute("alter table transcript_segments add column speaker_name text")
        if "voiceprint_id" not in segment_cols:
            conn.execute("alter table transcript_segments add column voiceprint_id text")
        if "speaker_confidence" not in segment_cols:
            conn.execute("alter table transcript_segments add column speaker_confidence real")
        summary_cols = {row["name"] for row in conn.execute("pragma table_info(summaries)").fetchall()}
        summary_migrations = {
            "version": "integer not null default 1",
            "instruction": "text",
            "base_summary_id": "text",
            "is_current": "integer not null default 1",
        }
        for column, definition in summary_migrations.items():
            if column not in summary_cols:
                conn.execute(f"alter table summaries add column {column} {definition}")
        conn.execute(
            """
            update summaries
            set version = coalesce(version, 1),
                is_current = case when is_current is null then 1 else is_current end
            """
        )
        task_cols = {row["name"] for row in conn.execute("pragma table_info(tasks)").fetchall()}
        task_migrations = {
            "started_at": "text",
            "finished_at": "text",
            "phase": "text",
            "phase_index": "integer",
            "phase_total": "integer",
        }
        for column, definition in task_migrations.items():
            if column not in task_cols:
                conn.execute(f"alter table tasks add column {column} {definition}")
        conn.execute("update tasks set started_at = coalesce(started_at, created_at)")
        conn.execute(
            """
            update tasks
            set finished_at = coalesce(finished_at, updated_at)
            where status in ('done', 'failed')
            """
        )
        hotword_cols = {row["name"] for row in conn.execute("pragma table_info(hotwords)").fetchall()}
        hotword_migrations = {
            "source_key": "text",
            "state": "text not null default 'active'",
            "protected": "integer not null default 0",
            "frequency": "integer not null default 1",
            "confidence": "real not null default 0.75",
            "score": "real not null default 0",
            "team_id": "text",
            "owner_id": "text",
            "first_seen_at": "text",
            "last_seen_at": "text",
            "last_used_at": "text",
            "expires_at": "text",
            "hit_count": "integer not null default 0",
            "updated_at": "text",
        }
        for column, definition in hotword_migrations.items():
            if column not in hotword_cols:
                conn.execute(f"alter table hotwords add column {column} {definition}")
        timestamp = now()
        conn.execute(
            """
            update hotwords
            set state = coalesce(state, case when active = 1 then 'active' else 'expired' end),
                protected = coalesce(protected, 0),
                frequency = coalesce(frequency, 1),
                confidence = coalesce(confidence, 0.75),
                score = case when coalesce(score, 0) <= 0 then coalesce(weight, 6) * 10 else score end,
                source_key = coalesce(source_key, source || ':' || word),
                first_seen_at = coalesce(first_seen_at, ?),
                last_seen_at = coalesce(last_seen_at, ?),
                updated_at = coalesce(updated_at, ?)
            """,
            (timestamp, timestamp, timestamp),
        )
        conn.execute(
            """
            update hotwords
            set protected = 1, state = 'active', active = 1
            where (source in ('系统内置', '产品库') or kind in ('产品', '系统'))
              and not (source = 'manual' and scope = 'personal')
            """
        )
        conn.execute("create index if not exists idx_hotwords_source on hotwords(source, active, state)")
        conn.execute("create index if not exists idx_hotwords_score on hotwords(active, state, protected, score)")
        conn.execute("create index if not exists idx_hotwords_word on hotwords(word)")
        default_sources = [
            ("protected", "保护热词", "protected", 1, 0, 0, 1200, 12000, 50000),
            ("crm", "CRM-金蝶-DeepSeek", "crm", 1, 360, 180, 3000, 10000, 50000),
            ("wecom-journals", "企微日报-DeepSeek", "wecom", 1, 720, 31, 3000, 10000, 50000),
            ("manual", "手工维护", "manual", 1, 0, 0, 3000, 10000, 50000),
        ]
        for source_id, name, source_type, enabled, schedule_minutes, lookback_days, asr_limit, correction_limit, candidate_limit in default_sources:
            if not conn.execute("select 1 from hotword_sources where id = ?", (source_id,)).fetchone():
                conn.execute(
                    """
                    insert into hotword_sources(
                        id,name,source_type,enabled,schedule_minutes,lookback_days,asr_limit,correction_limit,candidate_limit,created_at,updated_at
                    ) values(?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        source_id,
                        name,
                        source_type,
                        enabled,
                        schedule_minutes,
                        lookback_days,
                        asr_limit,
                        correction_limit,
                        candidate_limit,
                        timestamp,
                        timestamp,
                    ),
                )
        profile_cols = {row["name"] for row in conn.execute("pragma table_info(speaker_profiles)").fetchall()}
        if "scope" not in profile_cols:
            conn.execute("alter table speaker_profiles add column scope text not null default 'team'")
            conn.execute("update speaker_profiles set scope = case when team_id is null then 'global' else 'team' end")
        if "note" not in profile_cols:
            conn.execute("alter table speaker_profiles add column note text")
        # 演示团队 / 演示用户（销售一组·项目调研组 / 陈思源·林伟·韩雪·赵敏）的播种已移除——
        # 本部署只保留真实用户。仅保留下方的 administrator 引导账号。
        default_hash = hash_password(initial_password())
        timestamp = now()
        conn.execute(
            """
            update users
            set username = coalesce(username, id),
                email = coalesce(email, ''),
                mobile = coalesce(mobile, ''),
                source = coalesce(source, 'local'),
                password_hash = coalesce(password_hash, ?),
                must_change_password = coalesce(must_change_password, 1),
                failed_login_count = coalesce(failed_login_count, 0),
                created_at = coalesce(created_at, ?),
                updated_at = coalesce(updated_at, ?)
            """,
            (default_hash, timestamp, timestamp),
        )
        if not conn.execute("select 1 from users where username = ?", ("administrator",)).fetchone():
            conn.execute(
                """
                insert into users(
                    id,username,name,email,mobile,dept,role,team_id,managed_team_ids,status,source,wecom_userid,
                    password_hash,must_change_password,failed_login_count,last_active_at,last_login_at,created_at,updated_at
                )
                values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    "administrator",
                    "administrator",
                    "administrator",
                    "administrator@example.local",
                    "",
                    "系统管理",
                    "admin",
                    None,
                    "[]",
                    "active",
                    "local",
                    None,
                    hash_password(initial_password()),
                    1,
                    0,
                    timestamp,
                    None,
                    timestamp,
                    timestamp,
                ),
            )
        else:
            conn.execute(
                "update users set role = 'admin', status = 'active', source = coalesce(source, 'local'), updated_at = ? where username = ?",
                (timestamp, "administrator"),
            )
        if not conn.execute("select 1 from role_mappings limit 1").fetchone():
            conn.executemany(
                """
                insert into role_mappings(id,match_type,match_value,role,managed_team_ids,active,priority,created_at,updated_at)
                values(?,?,?,?,?,?,?,?,?)
                """,
                [
                    (str(uuid.uuid4()), "name", "李成豹", "manager", "[]", 1, 10, timestamp, timestamp),
                    (str(uuid.uuid4()), "local_username", "administrator", "admin", "[]", 1, 1, timestamp, timestamp),
                ],
            )
        if not conn.execute("select 1 from hotwords limit 1").fetchone():
            seed_hotwords = [
                ("NewVoice", "产品", "new voice,牛 voice", "系统内置", "部门共享", 10, 1),
                ("ERP", "行业", "企业资源计划", "产品库", "部门共享", 8, 1),
                ("MES", "行业", "制造执行系统", "产品库", "部门共享", 8, 1),
                ("金蝶接口", "项目", "金蝶 API,金蝶系统", "CRM", "团队共享", 9, 1),
                ("客户成功", "组织", "CS,售后成功", "通讯录", "部门共享", 6, 1),
            ]
            conn.executemany(
                "insert into hotwords(id,word,kind,aliases,source,scope,weight,active) values(?,?,?,?,?,?,?,?)",
                [(str(uuid.uuid4()), *row) for row in seed_hotwords],
            )
        if not conn.execute("select 1 from audit limit 1").fetchone():
            audit(conn, None, "system", "初始化本地数据库、用户、团队和热词。")


def recover_interrupted_tasks() -> int:
    with db() as conn:
        running = rowsdict(conn.execute("select * from tasks where status = 'running'").fetchall())
        if not running:
            return 0
        timestamp = now()
        recovered = 0
        for task in running:
            recording_id = task.get("recording_id")
            rec = rowdict(conn.execute("select * from recordings where id = ?", (recording_id,)).fetchone()) if recording_id else None
            segment_count = int(
                conn.execute("select count(*) from transcript_segments where recording_id = ?", (recording_id,)).fetchone()[0]
            ) if recording_id else 0
            summary_count = int(
                conn.execute("select count(*) from summaries where recording_id = ?", (recording_id,)).fetchone()[0]
            ) if recording_id else 0
            task_status = "failed"
            error = "服务重启或进程退出导致任务中断，请重新处理。"
            if rec:
                asr_status = rec["asr_status"]
                summary_status = rec["summary_status"]
                step = task.get("step") or ""
                if "转写" in step:
                    if segment_count > 0:
                        asr_status = "done"
                        task_status = "done"
                        error = None
                    else:
                        asr_status = "failed"
                        summary_status = "pending"
                elif "纪要" in step:
                    if summary_count > 0:
                        summary_status = "done"
                        task_status = "done"
                        error = None
                    else:
                        summary_status = "failed"
                else:
                    if segment_count > 0:
                        asr_status = "done"
                    elif asr_status == "running":
                        asr_status = "failed"
                    if summary_count > 0:
                        summary_status = "done"
                    elif summary_status == "running":
                        summary_status = "failed"
                conn.execute(
                    """
                    update recordings
                    set asr_status = ?, summary_status = ?, updated_at = ?
                    where id = ?
                    """,
                    (asr_status, summary_status, timestamp, recording_id),
                )
            conn.execute(
                """
                update tasks
                set status = ?, progress = 100, error = ?, updated_at = ?, finished_at = coalesce(finished_at, ?)
                where id = ?
                """,
                (task_status, error, timestamp, timestamp, task["id"]),
            )
            recovered += 1
        audit(conn, None, "system", f"恢复中断任务：{recovered} 个。")
        return recovered


def sweep_tmp_and_exports() -> dict[str, int]:
    """Delete stale segment/debug files in TMP and old exports.

    Without this, segment WAVs from /api/recordings/{id}/segments/.../audio
    accumulate forever (every playback writes a new one) — observed 131 files
    in TMP, 125 older than 1 day. Exports grow the same way.
    """
    tmp_ttl = int(os.environ.get("NEWVOICE_TMP_TTL_HOURS", "24")) * 3600
    export_ttl = int(os.environ.get("NEWVOICE_EXPORT_TTL_DAYS", "14")) * 86400
    now_ts = time.time()
    tmp_cutoff = now_ts - tmp_ttl
    export_cutoff = now_ts - export_ttl
    tmp_deleted = 0
    export_deleted = 0
    for path in TMP.glob("*"):
        try:
            if path.is_file() and path.stat().st_mtime < tmp_cutoff:
                path.unlink()
                tmp_deleted += 1
        except OSError:
            continue
    for path in EXPORTS.glob("*"):
        try:
            if path.is_file() and path.stat().st_mtime < export_cutoff:
                path.unlink()
                export_deleted += 1
        except OSError:
            continue
    return {"tmp_deleted": tmp_deleted, "export_deleted": export_deleted}


def _start_cleanup_loop() -> None:
    """Run sweep_tmp_and_exports on a timer in a daemon thread."""
    interval = int(os.environ.get("NEWVOICE_SWEEP_INTERVAL_MINUTES", "60")) * 60

    def _loop() -> None:
        # First sweep immediately so a fresh server reclaims stale files from
        # the prior run; subsequent sweeps run on the interval.
        while True:
            try:
                sweep_tmp_and_exports()
            except Exception:
                pass
            time.sleep(interval)

    threading.Thread(target=_loop, name="newvoice-cleanup", daemon=True).start()


def recover_queued_recordings() -> int:
    """Recordings stuck at asr_status='queued' lost their BackgroundTasks
    worker when the server died (BackgroundTasks lives in process memory).
    Drain them through a single recovery thread after startup; the model lock
    serializes them naturally with any new user-triggered transcribes.
    """
    with db() as conn:
        rows = rowsdict(
            conn.execute(
                "select * from recordings where asr_status = 'queued'"
            ).fetchall()
        )
        if not rows:
            return 0
        pending: list[tuple[str, dict[str, Any]]] = []
        orphaned = 0
        timestamp = now()
        for rec in rows:
            owner = rowdict(
                conn.execute(
                    "select * from users where id = ? and status = 'active'",
                    (rec["owner_id"],),
                ).fetchone()
            )
            if not owner:
                conn.execute(
                    """
                    update recordings
                    set asr_status = 'failed', updated_at = ?
                    where id = ?
                    """,
                    (timestamp, rec["id"]),
                )
                orphaned += 1
                continue
            pending.append((rec["id"], normalize_user(owner)))
        if pending or orphaned:
            audit(
                conn,
                None,
                "system",
                f"启动恢复 queued 录音：重新入队 {len(pending)} 个，无主丢弃 {orphaned} 个。",
            )

    if not pending:
        return 0

    def _drain() -> None:
        # Tiny stagger so the model load (first call) finishes before the
        # second recording also tries to grab the lock.
        time.sleep(1.0)
        for recording_id, user in pending:
            try:
                process_recording_background(recording_id, user)
            except Exception:
                # process_recording_background already records failure in DB.
                continue

    threading.Thread(target=_drain, name="newvoice-queued-recovery", daemon=True).start()
    return len(pending)


def audit(conn: sqlite3.Connection, user: dict[str, Any] | None, category: str, message: str, actor_name: str | None = None) -> None:
    conn.execute(
        "insert into audit(id,created_at,actor_id,actor_name,category,message) values(?,?,?,?,?,?)",
        (
            str(uuid.uuid4()),
            now(),
            user.get("id") if user else None,
            actor_name or (user.get("name") if user else "系统"),
            category,
            message,
        ),
    )


def normalize_user(row: dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    payload["managed_team_ids"] = safe_json(payload.get("managed_team_ids"), [])
    payload["username"] = payload.get("username") or payload.get("id")
    payload["mobile"] = payload.get("mobile") or ""
    payload["source"] = payload.get("source") or "local"
    payload["must_change_password"] = bool(payload.get("must_change_password"))
    payload.pop("password_hash", None)
    payload.pop("failed_login_count", None)
    return payload


def normalize_team(row: dict[str, Any]) -> dict[str, Any]:
    row["manager_ids"] = safe_json(row.get("manager_ids"), [])
    return row


def normalize_profile(row: dict[str, Any]) -> dict[str, Any]:
    if not row.get("scope"):
        row["scope"] = "global" if not row.get("team_id") else "team"
    return row


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("select value from app_settings where key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        insert into app_settings(key,value,updated_at) values(?,?,?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, now()),
    )


def normalize_mapping(row: dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    payload["managed_team_ids"] = safe_json(payload.get("managed_team_ids"), [])
    payload["active"] = bool(payload.get("active"))
    return payload


def create_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(40)
    conn.execute(
        "insert into sessions(token,user_id,created_at,expires_at) values(?,?,?,?)",
        (token, user_id, now(), session_expiry()),
    )
    return token


def current_user(
    authorization: str | None = Header(default=None),
    token_query: str | None = Query(default=None, alias="token"),
) -> dict[str, Any]:
    # Header Bearer is the normal path. The ?token= query fallback exists for
    # media/download URLs (<audio src>, <a download>) where the browser can't
    # attach an Authorization header.
    token = (authorization or "").removeprefix("Bearer").strip() or (token_query or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing session token")
    with db() as conn:
        session = rowdict(conn.execute("select * from sessions where token = ?", (token,)).fetchone())
        if not session or session["expires_at"] < now():
            raise HTTPException(status_code=401, detail="invalid or expired session")
        user = rowdict(conn.execute("select * from users where id = ?", (session["user_id"],)).fetchone())
        if not user or user.get("status") != "active":
            raise HTTPException(status_code=401, detail="user is disabled")
        conn.execute("update users set last_active_at = ? where id = ?", (now(), user["id"]))
        return normalize_user(user)


def require_admin(user: dict[str, Any]) -> None:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")


def managed_team_ids(user: dict[str, Any]) -> list[str]:
    return user.get("managed_team_ids") or ([user["team_id"]] if user.get("team_id") else [])


def recording_where(user: dict[str, Any], scope: str = "mine") -> tuple[str, list[Any]]:
    if user["role"] == "admin":
        return "1=0", []
    if user["role"] == "manager" and scope == "team":
        team_ids = managed_team_ids(user)
        if "*" in team_ids:
            # 业务管理员：用普通用户界面，但看全量数据（不限团队）。
            return "1=1", []
        placeholders = ",".join("?" for _ in team_ids) or "?"
        return f"recordings.team_id in ({placeholders})", team_ids or ["__none__"]
    return "recordings.owner_id = ?", [user["id"]]


def recording_filter_where(
    user: dict[str, Any],
    scope: str = "mine",
    q: str = "",
    meeting_type: str = "",
) -> tuple[str, list[Any]]:
    where, args = recording_where(user, scope)
    filters = [where]
    values = list(args)
    if meeting_type and meeting_type != "全部":
        filters.append("recordings.meeting_type = ?")
        values.append(meeting_type)
    if q.strip():
        like = f"%{q.strip()}%"
        filters.append(
            "(recordings.title like ? or recordings.filename like ? or recordings.tag like ? or users.name like ?)"
        )
        values.extend([like, like, like, like])
    return " and ".join(f"({item})" for item in filters), values


def can_access_recording(conn: sqlite3.Connection, recording_id: str, user: dict[str, Any]) -> dict[str, Any]:
    rec = rowdict(conn.execute("select * from recordings where id = ?", (recording_id,)).fetchone())
    if not rec:
        raise HTTPException(status_code=404, detail="recording not found")
    if user["role"] == "admin":
        raise HTTPException(status_code=403, detail="admin console has no recording library")
    if rec["owner_id"] == user["id"]:
        return rec
    if user["role"] == "manager":
        managed = user.get("managed_team_ids") or []
        if "*" in managed or rec["team_id"] in managed:
            return rec
    raise HTTPException(status_code=403, detail="recording is outside current permission scope")


def recording_payload(conn: sqlite3.Connection, rec: dict[str, Any]) -> dict[str, Any]:
    owner = rowdict(conn.execute("select name from users where id = ?", (rec["owner_id"],)).fetchone())
    payload = dict(rec)
    # Existing databases may still contain legacy CRM columns. They are kept
    # on disk for non-destructive compatibility but are no longer exposed.
    for key in tuple(payload):
        if key.startswith("crm_"):
            payload.pop(key)
    payload["owner_name"] = owner["name"] if owner else rec["owner_id"]
    return payload


def task_payload(row: dict[str, Any], recording_duration: float | int | None = None) -> dict[str, Any]:
    payload = dict(row)
    started = parse_local_time(payload.get("started_at") or payload.get("created_at"))
    updated = parse_local_time(payload.get("updated_at"))
    finished = parse_local_time(payload.get("finished_at"))
    now_dt = datetime.now()
    end_dt = finished or (now_dt if payload.get("status") in {"running", "queued"} else updated)
    elapsed = max(0, int((end_dt - started).total_seconds())) if started and end_dt else 0
    payload["elapsed_seconds"] = elapsed
    payload["elapsed_label"] = seconds_label(elapsed)
    progress = int(payload.get("progress") or 0)
    eta = None
    if payload.get("status") == "running" and 0 < progress < 100 and elapsed > 0:
        eta = int(elapsed * (100 - progress) / progress)
    payload["eta_seconds"] = eta
    payload["eta_label"] = seconds_label(eta) if eta is not None else None
    silence = max(0, int((now_dt - updated).total_seconds())) if updated else 0
    stale_after = 900
    if "转写" in (payload.get("step") or ""):
        stale_after = max(900, int(float(recording_duration or 0) * 0.45))
    payload["stale_seconds"] = silence
    payload["is_stale"] = payload.get("status") == "running" and silence > stale_after
    return payload


def team_payload(conn: sqlite3.Connection, row: dict[str, Any]) -> dict[str, Any]:
    payload = normalize_team(dict(row))
    payload["member_count"] = conn.execute("select count(*) from users where team_id = ?", (payload["id"],)).fetchone()[0]
    payload["recording_count"] = conn.execute("select count(*) from recordings where team_id = ?", (payload["id"],)).fetchone()[0]
    return payload


def update_task(conn: sqlite3.Connection, task_id: str, status: str, progress: int, error: str | None = None) -> None:
    timestamp = now()
    conn.execute(
        """
        update tasks
        set status = ?,
            progress = ?,
            error = ?,
            updated_at = ?,
            finished_at = case when ? in ('done', 'failed') then coalesce(finished_at, ?) else finished_at end
        where id = ?
        """,
        (status, max(0, min(100, progress)), error, timestamp, status, timestamp, task_id),
    )
    conn.commit()


def create_task(conn: sqlite3.Connection, recording_id: str, title: str, step: str) -> str:
    task_id = str(uuid.uuid4())
    timestamp = now()
    conn.execute(
        """
        insert into tasks(id,recording_id,recording_title,step,status,progress,created_at,updated_at,started_at,phase,phase_index,phase_total)
        values(?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (task_id, recording_id, title, step, "running", 0, timestamp, timestamp, timestamp, step, 1, 1),
    )
    conn.commit()
    return task_id


def code_like_hotword(text: str) -> bool:
    value = text.strip()
    if len(value) <= 3 and re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return True
    return bool(re.fullmatch(r"[A-Za-z]{2,}[-_]?\d{2,}[A-Za-z0-9_-]*", value))


def load_hotword_map(conn: sqlite3.Connection) -> dict[str, str]:
    mapping: dict[str, str] = {}
    rows = conn.execute("select word, aliases from hotwords where active = 1").fetchall()
    for row in rows:
        word = row["word"]
        for alias in (row["aliases"] or "").split(","):
            alias = alias.strip()
            if alias and len(alias) >= 2 and not code_like_hotword(alias):
                mapping[alias.lower()] = word
    return mapping


def apply_hotwords(text: str, hotwords: dict[str, str]) -> str:
    fixed = text
    for alias, word in sorted(hotwords.items(), key=lambda item: len(item[0]), reverse=True):
        fixed = re.sub(re.escape(alias), word, fixed, flags=re.IGNORECASE)
    return fixed


HOTWORD_KIND_PRIORITY = {
    "产品": 90,
    "系统": 88,
    "行业": 82,
    "业务术语": 78,
    "项目": 74,
    "商机": 70,
    "人员": 68,
    "客户简称": 64,
    "客户": 60,
    "潜在客户": 54,
    "客户规模": 30,
}


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def hotword_terms(row: dict[str, Any], alias_limit: int = 2) -> list[str]:
    terms = [str(row.get("word") or "").strip()]
    aliases = [
        item.strip()
        for item in str(row.get("aliases") or "").split(",")
        if item.strip() and valid_asr_hotword(item.strip())
    ]
    terms.extend(aliases[:alias_limit])
    clean_terms: list[str] = []
    seen: set[str] = set()
    for term in terms:
        key = term.lower()
        if valid_asr_hotword(term) and key not in seen:
            clean_terms.append(term)
            seen.add(key)
    return clean_terms


def hotword_row_score(row: dict[str, Any], rec: dict[str, Any] | None = None, user: dict[str, Any] | None = None) -> float:
    score = float(row.get("score") or 0)
    weight = int(row.get("weight") or 0)
    kind = str(row.get("kind") or "业务术语")
    source = str(row.get("source") or "")
    score += weight * 12
    score += HOTWORD_KIND_PRIORITY.get(kind, 45)
    if int(row.get("protected") or 0):
        score += 220
    if source.startswith("CRM"):
        score += 40
    elif source.startswith("企微"):
        score += 32
    elif source in {"系统内置", "产品库", "手工维护"}:
        score += 60
    frequency = int(row.get("frequency") or 0)
    score += min(80, frequency * 3)
    last_seen = parse_time(row.get("last_seen_at"))
    if last_seen:
        age_days = max(0, (datetime.now() - last_seen).days)
        if age_days <= 7:
            score += 80
        elif age_days <= 30:
            score += 45
        elif age_days <= 90:
            score += 15
        else:
            score -= min(90, age_days // 3)
    if rec:
        context = " ".join(
            str(item or "")
            for item in [rec.get("title"), rec.get("filename"), rec.get("tag"), rec.get("meeting_type")]
        ).lower()
        for term in hotword_terms(row, alias_limit=6):
            if term.lower() in context:
                score += 180
                break
        if row.get("team_id") and row.get("team_id") == rec.get("team_id"):
            score += 90
        if row.get("owner_id") and row.get("owner_id") == rec.get("owner_id"):
            score += 70
    if user:
        if row.get("team_id") and row.get("team_id") == user.get("team_id"):
            score += 50
        if row.get("owner_id") and row.get("owner_id") == user.get("id"):
            score += 45
    word = str(row.get("word") or "")
    if len(word) > 28:
        score -= len(word) - 28
    return score


def hotword_limits() -> dict[str, int]:
    return {
        "asr": env_int("NEWVOICE_HOTWORD_LIMIT", 3000, 200, 6000),
        "correction": env_int("NEWVOICE_CORRECTION_HOTWORD_LIMIT", 10000, 1000, 20000),
        "protected": env_int("NEWVOICE_PROTECTED_HOTWORD_LIMIT", 1200, 100, 5000),
    }


def build_hotword_package(conn: sqlite3.Connection, rec: dict[str, Any], user: dict[str, Any], persist: bool = True) -> dict[str, Any]:
    limits = hotword_limits()
    rows = rowsdict(
        conn.execute(
            """
            select * from hotwords
            where active = 1
              and coalesce(state, 'active') in ('active', 'protected')
              and (expires_at is null or expires_at = '' or datetime(expires_at) > datetime('now'))
              -- 个人手填热词(scope='personal')只对其所有者本人的录音生效,不泄漏给他人 ASR。
              and (coalesce(scope, '') != 'personal' or owner_id = ?)
            """,
            (user.get("id"),),
        ).fetchall()
    )
    ranked = sorted(rows, key=lambda row: hotword_row_score(row, rec, user), reverse=True)
    protected_rows = [row for row in ranked if int(row.get("protected") or 0)]
    dynamic_rows = [row for row in ranked if not int(row.get("protected") or 0)]
    selected_rows: list[dict[str, Any]] = []
    selected_terms: list[str] = []
    selected_keys: set[str] = set()

    def add_rows(candidates: list[dict[str, Any]], term_limit: int, alias_limit: int = 2) -> None:
        for row in candidates:
            row_terms = hotword_terms(row, alias_limit=alias_limit)
            new_terms = [term for term in row_terms if term.lower() not in selected_keys]
            if not new_terms:
                continue
            if len(selected_terms) + len(new_terms) > term_limit:
                continue
            selected_rows.append(row)
            for term in new_terms:
                selected_terms.append(term)
                selected_keys.add(term.lower())
            if len(selected_terms) >= term_limit:
                break

    add_rows(protected_rows, min(limits["protected"], limits["asr"]), alias_limit=6)
    selected_row_ids = {row.get("id") for row in selected_rows if row.get("id")}
    overflow_rows = [row for row in ranked if row.get("id") not in selected_row_ids]
    add_rows(overflow_rows or dynamic_rows, limits["asr"], alias_limit=3)

    correction_terms = selected_terms[:]
    correction_keys = {term.lower() for term in correction_terms}
    replacement_map: dict[str, str] = {}
    canonical_words = {str(row.get("word") or "").strip().lower() for row in rows}
    for row in selected_rows:
        word = str(row.get("word") or "").strip()
        for alias in hotword_terms(row, alias_limit=8):
            alias_key = alias.lower()
            if alias != word and alias_key not in canonical_words:
                existing = replacement_map.get(alias_key)
                if not existing or len(word) < len(existing):
                    replacement_map[alias_key] = word
            if alias_key not in correction_keys and len(correction_terms) < limits["correction"]:
                correction_terms.append(alias)
                correction_keys.add(alias_key)
    for row in rows:
        word = str(row.get("word") or "").strip()
        if not word or str(row.get("kind") or "") not in {"客户简称", "项目"}:
            continue
        if word.lower() not in correction_keys and word.lower() not in selected_keys:
            continue
        for alias in hotword_terms(row, alias_limit=8):
            alias_key = alias.lower()
            if alias == word or alias_key in canonical_words:
                continue
            existing = replacement_map.get(alias_key)
            if not existing or len(word) < len(existing):
                replacement_map[alias_key] = word

    source_counts: dict[str, int] = {}
    for row in selected_rows:
        source = str(row.get("source") or "未知来源")
        source_counts[source] = source_counts.get(source, 0) + 1
    package = {
        "asr_terms": selected_terms,
        "correction_terms": correction_terms,
        "asr_terms_count": len(selected_terms),
        "correction_terms_count": len(correction_terms),
        "protected_terms_count": sum(1 for row in selected_rows if int(row.get("protected") or 0)),
        "dynamic_terms_count": sum(1 for row in selected_rows if not int(row.get("protected") or 0)),
        "source_summary": source_counts,
        "replacement_map": replacement_map,
    }
    if persist:
        version = (
            conn.execute("select coalesce(max(version), 0) + 1 from recording_hotword_packages where recording_id = ?", (rec["id"],)).fetchone()[0]
            or 1
        )
        conn.execute(
            """
            insert into recording_hotword_packages(
                id,recording_id,version,asr_terms_count,correction_terms_count,protected_terms_count,dynamic_terms_count,
                source_summary,asr_terms,correction_terms,created_at
            ) values(?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                str(uuid.uuid4()),
                rec["id"],
                version,
                package["asr_terms_count"],
                package["correction_terms_count"],
                package["protected_terms_count"],
                package["dynamic_terms_count"],
                json.dumps(source_counts, ensure_ascii=False),
                json.dumps(selected_terms, ensure_ascii=False),
                json.dumps(correction_terms, ensure_ascii=False),
                now(),
            ),
        )
        selected_ids = [row["id"] for row in selected_rows if row.get("id")]
        if selected_ids:
            placeholders = ",".join("?" for _ in selected_ids)
            conn.execute(
                f"update hotwords set last_used_at = ?, hit_count = coalesce(hit_count, 0) + 1 where id in ({placeholders})",
                (now(), *selected_ids),
            )
    return package


def latest_hotword_package(conn: sqlite3.Connection, recording_id: str) -> dict[str, Any] | None:
    row = rowdict(
        conn.execute(
            """
            select * from recording_hotword_packages
            where recording_id = ?
            order by version desc, created_at desc
            limit 1
            """,
            (recording_id,),
        ).fetchone()
    )
    if not row:
        return None
    row["source_summary"] = safe_json(row.get("source_summary"), {})
    row["asr_terms"] = safe_json(row.get("asr_terms"), [])
    row["correction_terms"] = safe_json(row.get("correction_terms"), [])
    return row


def split_audio(source: Path, workdir: Path, segment_seconds: int) -> list[Path]:
    chunk_pattern = workdir / "chunk_%04d.wav"
    cmd = [
        str(FFMPEG),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "segment",
        "-segment_time",
        str(segment_seconds),
        str(chunk_pattern),
    ]
    subprocess.run(cmd, check=True)
    return sorted(workdir.glob("chunk_*.wav"))


def get_asr_model() -> Any:
    global _asr_model
    if _asr_model is None:
        with _asr_init_lock:
            if _asr_model is None:
                missing = [str(path) for path in [PARAFORMER, VAD, PUNC, CAMPLUS] if not path.exists()]
                if missing:
                    raise RuntimeError(f"ASR/diarization model missing: {', '.join(missing)}")
                from funasr import AutoModel

                _asr_model = AutoModel(
                    model=str(PARAFORMER),
                    vad_model=str(VAD),
                    vad_kwargs={"max_single_segment_time": int(os.environ.get("NEWVOICE_VAD_MAX_SEGMENT_MS", "30000"))},
                    punc_model=str(PUNC),
                    spk_model=str(CAMPLUS),
                    device=ASR_DEVICE,
                    disable_update=True,
                    disable_pbar=True,
                )
    return _asr_model


def get_speaker_verifier() -> Any:
    global _speaker_verifier
    if _speaker_verifier is None:
        with _verifier_init_lock:
            if _speaker_verifier is None:
                from modelscope.pipelines import pipeline
                from modelscope.utils.constant import Tasks

                _speaker_verifier = pipeline(
                    task=Tasks.speaker_verification, model=str(CAMPLUS), device=modelscope_device()
                )
    return _speaker_verifier


def voiceprint_threshold_default() -> float:
    return env_float("NEWVOICE_VOICEPRINT_THRESHOLD", DEFAULT_VOICEPRINT_THRESHOLD, 0.45, 0.95)


def clamp_voiceprint_threshold(value: Any) -> float:
    try:
        threshold = float(value)
    except (TypeError, ValueError):
        threshold = voiceprint_threshold_default()
    return max(0.45, min(0.95, threshold))


def voiceprint_match_settings() -> dict[str, float | int]:
    return {
        "min_threshold": env_float("NEWVOICE_VOICEPRINT_MIN_THRESHOLD", voiceprint_threshold_default(), 0.45, 0.95),
        "margin": env_float("NEWVOICE_VOICEPRINT_MARGIN", 0.08, 0.0, 0.35),
        "sample_limit": env_int("NEWVOICE_VOICEPRINT_MATCH_SAMPLES", 8, 3, 12),
        "max_sample_seconds": env_float("NEWVOICE_VOICEPRINT_SAMPLE_SECONDS", 14.0, 5.0, 25.0),
        "min_sample_seconds": env_float("NEWVOICE_VOICEPRINT_MIN_SAMPLE_SECONDS", 2.0, 1.0, 8.0),
    }


def ranked_voiceprint_intervals(sentence_info: list[dict[str, Any]], sample_limit: int, min_sample_seconds: float) -> dict[str, list[tuple[float, float]]]:
    intervals: dict[str, list[tuple[float, float, float]]] = {}
    for item in sentence_info:
        spk = str(item.get("spk", "unknown"))
        start = float(item.get("start", 0)) / 1000.0
        end = float(item.get("end", 0)) / 1000.0
        duration = max(0.0, end - start)
        if duration >= min_sample_seconds:
            quality = min(duration, 18.0)
            intervals.setdefault(spk, []).append((quality, start, end))
    return {
        spk: [(start, end) for _, start, end in sorted(ranges, reverse=True)[:sample_limit]]
        for spk, ranges in intervals.items()
    }


def aggregate_voiceprint_scores(scores: list[float]) -> float:
    if not scores:
        return -1.0
    top_scores = sorted(scores, reverse=True)[: min(5, len(scores))]
    return float(median(top_scores))


def load_speaker_profiles(conn: sqlite3.Connection, team_id: str | None, owner_id: str | None) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        select * from speaker_profiles
        where active = 1
          and (
            scope = 'global'
            or (scope = 'team' and team_id = ?)
            or (scope = 'personal' and owner_id = ?)
          )
        order by created_at desc
        """,
        (team_id, owner_id),
    ).fetchall()
    return [normalize_profile(dict(row)) for row in rows if Path(row["sample_path"]).exists()]


def extract_interval(source: Path, target: Path, start_sec: float, end_sec: float) -> None:
    duration = max(0.2, end_sec - start_sec)
    subprocess.run(
        [
            str(FFMPEG),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start_sec:.3f}",
            "-i",
            str(source),
            "-t",
            f"{duration:.3f}",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(target),
        ],
        check=True,
    )


def concat_audio(parts: list[Path], target: Path, workdir: Path) -> None:
    if not parts:
        raise RuntimeError("no audio parts to concat")
    concat_file = workdir / "concat.txt"
    concat_file.write_text(
        "\n".join(f"file '{str(part).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for part in parts),
        encoding="utf-8",
    )
    subprocess.run(
        [
            str(FFMPEG),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(target),
        ],
        check=True,
    )


def match_speaker_profiles(rec: dict[str, Any], sentence_info: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    with db() as conn:
        profiles = load_speaker_profiles(conn, rec.get("team_id"), rec.get("owner_id"))
    if not profiles:
        return {}

    settings = voiceprint_match_settings()
    intervals = ranked_voiceprint_intervals(
        sentence_info,
        int(settings["sample_limit"]),
        float(settings["min_sample_seconds"]),
    )
    matches: dict[str, dict[str, Any]] = {}
    verifier = get_speaker_verifier()
    with tempfile.TemporaryDirectory(dir=TMP) as tmp:
        tmpdir = Path(tmp)
        for spk, ranges in intervals.items():
            profile_scores: dict[str, list[float]] = {profile["id"]: [] for profile in profiles}
            for idx, (start, end) in enumerate(ranges):
                sample = tmpdir / f"spk_{spk}_{idx}.wav"
                extract_interval(Path(rec["file_path"]), sample, start, min(end, start + float(settings["max_sample_seconds"])))
                for profile in profiles:
                    try:
                        with _asr_lock:
                            result = verifier([str(sample), profile["sample_path"]])
                    except Exception:
                        continue
                    if isinstance(result, list):
                        result = result[0] if result else {}
                    score = float(result.get("score", -1.0))
                    if score >= 0:
                        profile_scores[profile["id"]].append(score)
            name_results: dict[str, dict[str, Any]] = {}
            for profile in profiles:
                scores = profile_scores.get(profile["id"], [])
                if not scores:
                    continue
                aggregate = aggregate_voiceprint_scores(scores)
                threshold = max(
                    float(settings["min_threshold"]),
                    clamp_voiceprint_threshold(profile.get("threshold")),
                )
                hit_count = sum(1 for score in scores if score >= threshold - 0.03)
                name_key = str(profile["name"]).strip()
                current = name_results.get(name_key)
                if not current or aggregate > float(current["score"]):
                    name_results[name_key] = {
                        "name": name_key,
                        "voiceprint_id": profile["id"],
                        "score": aggregate,
                        "threshold": threshold,
                        "hit_count": hit_count,
                    }
            ranked = sorted(name_results.values(), key=lambda item: float(item["score"]), reverse=True)
            if not ranked:
                continue
            best = ranked[0]
            second_score = float(ranked[1]["score"]) if len(ranked) > 1 else -1.0
            margin = float(best["score"]) - second_score if second_score >= 0 else 1.0
            if (
                best["name"]
                and float(best["score"]) >= float(best["threshold"])
                and margin >= float(settings["margin"])
                and int(best["hit_count"]) >= min(2, len(ranges))
            ):
                matches[spk] = {
                    "name": best["name"],
                    "voiceprint_id": best["voiceprint_id"] or None,
                    "score": round(float(best["score"]), 5),
                }
    return matches


# 组织形式词：口语里没人说全称（"…有限公司"），留着只会让 seaco 在听不清时
# 误偏置硬凑出来。带这些词或超长的，一律不喂给 ASR。
_FORMAL_ORG_MARKER = re.compile(r"(公司|集团|股份|有限|责任)")


def valid_asr_hotword(text: str) -> bool:
    value = text.strip()
    # 只喂能被说出口的短词：超长全称口语召回≈0、且会误偏置。
    max_len = env_int("NEWVOICE_HOTWORD_MAX_LEN", 8, 4, 20)
    if len(value) < 2 or len(value) > max_len:
        return False
    if re.search(r"\s", value):
        return False
    if value.isdigit() or code_like_hotword(value):
        return False
    if _FORMAL_ORG_MARKER.search(value):
        return False
    return True


def hotword_prompt(conn: sqlite3.Connection) -> str:
    limit = hotword_limits()["asr"]
    rows = conn.execute(
        """
        select * from hotwords
        where active = 1
          and coalesce(state, 'active') in ('active', 'protected')
          and (expires_at is null or expires_at = '' or datetime(expires_at) > datetime('now'))
        """
    ).fetchall()
    kind_limits = {
        "产品": 600,
        "系统": 600,
        "业务术语": 900,
        "项目": 700,
        "商机": 700,
        "人员": 500,
        "行业": 500,
        "客户简称": 500,
        "客户": 900,
        "潜在客户": 700,
    }
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        row_data = dict(row)
        kind = row_data.get("kind") or "业务术语"
        score = hotword_row_score(row_data)
        terms = hotword_terms(row_data, alias_limit=2)
        for raw in terms:
            term = raw.strip()
            key = term.lower()
            if not valid_asr_hotword(term) or key in seen:
                continue
            seen.add(key)
            length_penalty = max(0, len(term) - 20)
            candidates.append(
                {
                    "term": term,
                    "kind": kind,
                    "score": score - length_penalty,
                }
            )
    candidates.sort(key=lambda item: (item["score"], -len(item["term"])), reverse=True)
    selected: list[str] = []
    selected_keys: set[str] = set()
    counts: dict[str, int] = {}
    remainder: list[dict[str, Any]] = []
    for item in candidates:
        kind = item["kind"]
        if counts.get(kind, 0) >= kind_limits.get(kind, 50):
            remainder.append(item)
            continue
        selected.append(item["term"])
        selected_keys.add(item["term"].lower())
        counts[kind] = counts.get(kind, 0) + 1
        if len(selected) >= limit:
            return " ".join(selected)
    for item in remainder:
        key = item["term"].lower()
        if key in selected_keys:
            continue
        selected.append(item["term"])
        if len(selected) >= limit:
            break
    return " ".join(selected)


def normalize_speaker_id(value: Any) -> str:
    try:
        return str(int(value) + 1)
    except (TypeError, ValueError):
        raw = str(value or "unknown")
        return raw if raw.startswith("Speaker") else raw


FILLER_TRANSCRIPT_TEXT = {
    "嗯",
    "嗯嗯",
    "啊",
    "哦",
    "噢",
    "额",
    "呃",
    "对",
    "对对",
    "好",
    "好的",
    "是",
    "是的",
    "可以",
    "行",
}

CONTINUATION_ENDINGS = (
    "因为",
    "然后",
    "但是",
    "所以",
    "包括",
    "这个",
    "那个",
    "就是",
    "如果",
    "我们",
    "客户",
    "它",
    "他",
    "她",
    "的",
    "和",
    "跟",
    "把",
    "在",
    "对",
)


def normalized_transcript_text(value: Any) -> str:
    text = clean_sensevoice_text(str(value or ""))
    text = re.sub(r"\s+", "", text)
    return text.strip()


def bare_transcript_text(value: str) -> str:
    return value.strip().strip("，。！？,.!?、 ")


def is_filler_transcript(text: str) -> bool:
    bare = bare_transcript_text(text)
    return bare in FILLER_TRANSCRIPT_TEXT or len(bare) <= 1


def transcript_needs_continuation(text: str) -> bool:
    bare = bare_transcript_text(text)
    if not bare:
        return False
    return bare.endswith(CONTINUATION_ENDINGS) or not text.endswith(("。", "？", "！", "?", "!"))


def join_transcript_text(left: str, right: str) -> str:
    left = left.strip()
    right = right.strip()
    if not left:
        return right
    if not right:
        return left
    if is_filler_transcript(right) and len(bare_transcript_text(right)) <= 2:
        return left + right
    return left + right


def semantic_segment_settings() -> dict[str, float | int]:
    return {
        "max_chars": env_int("NEWVOICE_SEGMENT_MAX_CHARS", 120, 60, 240),
        "soft_chars": env_int("NEWVOICE_SEGMENT_SOFT_CHARS", 80, 40, 180),
        "max_seconds": env_int("NEWVOICE_SEGMENT_MAX_SECONDS", 35, 10, 90),
        "gap_seconds": float(os.environ.get("NEWVOICE_SEGMENT_GAP_SECONDS", "2.0")),
    }


def merge_transcript_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    settings = semantic_segment_settings()
    max_chars = int(settings["max_chars"])
    soft_chars = int(settings["soft_chars"])
    max_seconds = float(settings["max_seconds"])
    gap_seconds = float(settings["gap_seconds"])
    merged: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def push_current() -> None:
        nonlocal current
        if not current:
            return
        current["start_label"] = seconds_label(current["start_sec"])
        current["text"] = current["text"].strip()
        merged.append(current)
        current = None

    for raw in sorted(items, key=lambda item: float(item.get("start_sec") or 0)):
        text = normalized_transcript_text(raw.get("text"))
        if not text:
            continue
        start_sec = float(raw.get("start_sec") or 0)
        end_sec = max(start_sec, float(raw.get("end_sec") or start_sec))
        speaker = str(raw.get("speaker") or "unknown")
        speaker_name = raw.get("speaker_name")
        voiceprint_id = raw.get("voiceprint_id")
        speaker_confidence = raw.get("speaker_confidence")
        item_id = raw.get("id") or str(uuid.uuid4())
        item = {
            "id": item_id,
            "start_sec": start_sec,
            "end_sec": end_sec,
            "start_label": seconds_label(start_sec),
            "speaker": speaker,
            "speaker_name": speaker_name,
            "voiceprint_id": voiceprint_id,
            "speaker_confidence": speaker_confidence,
            "text": text,
            "confidence": raw.get("confidence"),
            "source_ids": [item_id],
            "source_count": int(raw.get("source_count") or 1),
        }
        filler = is_filler_transcript(text)
        if filler and current is None:
            continue
        if current is None:
            current = item
            continue

        same_speaker = speaker == current["speaker"]
        gap = start_sec - float(current["end_sec"])
        combined_len = len(current["text"]) + len(text)
        combined_seconds = end_sec - float(current["start_sec"])
        can_merge_same_speaker = (
            same_speaker
            and gap <= gap_seconds
            and combined_len <= max_chars
            and combined_seconds <= max_seconds
        )
        can_merge_short_backchannel = (
            same_speaker
            and filler
            and gap <= gap_seconds
            and combined_len <= max_chars
            and combined_seconds <= max_seconds
        )
        if filler and not same_speaker:
            continue
        should_continue = transcript_needs_continuation(str(current["text"])) and combined_len <= max_chars
        if can_merge_same_speaker and (len(current["text"]) < soft_chars or should_continue or filler):
            current["text"] = join_transcript_text(current["text"], text)
            current["end_sec"] = end_sec
            current["source_ids"].extend(item["source_ids"])
            current["source_count"] += item["source_count"]
            if not current.get("speaker_name") and speaker_name:
                current["speaker_name"] = speaker_name
            if not current.get("voiceprint_id") and voiceprint_id:
                current["voiceprint_id"] = voiceprint_id
            if current.get("speaker_confidence") is None and speaker_confidence is not None:
                current["speaker_confidence"] = speaker_confidence
            continue
        if can_merge_short_backchannel:
            current["text"] = join_transcript_text(current["text"], text)
            current["end_sec"] = end_sec
            current["source_ids"].extend(item["source_ids"])
            current["source_count"] += item["source_count"]
            continue
        push_current()
        current = item
    push_current()
    return [row for row in merged if len(bare_transcript_text(str(row.get("text") or ""))) >= 2]


def sentence_info_to_transcript_segments(
    sentence_info: list[dict[str, Any]],
    hotwords: dict[str, str],
    speaker_matches: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in sentence_info:
        text = normalized_transcript_text(item.get("text", ""))
        text = apply_hotwords(text, hotwords)
        if not text:
            continue
        start_sec = float(item.get("start", 0)) / 1000.0
        end_sec = float(item.get("end", item.get("start", 0))) / 1000.0
        raw_spk = str(item.get("spk", "unknown"))
        speaker_match = speaker_matches.get(raw_spk) or {}
        items.append(
            {
                "id": str(uuid.uuid4()),
                "start_sec": start_sec,
                "end_sec": end_sec,
                "speaker": normalize_speaker_id(raw_spk),
                "speaker_name": speaker_match.get("name"),
                "voiceprint_id": speaker_match.get("voiceprint_id"),
                "speaker_confidence": speaker_match.get("score"),
                "text": text,
                "confidence": None,
            }
        )
    return merge_transcript_items(items)


def transcribe_recording(recording_id: str, user: dict[str, Any], segment_seconds: int = 60) -> dict[str, Any]:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        task_id = create_task(conn, recording_id, rec["title"], "VAD+说话人分离转写")
        conn.execute("update recordings set asr_status = ?, updated_at = ? where id = ?", ("running", now(), recording_id))
        conn.execute("delete from transcript_segments where recording_id = ?", (recording_id,))
        conn.execute("delete from summaries where recording_id = ?", (recording_id,))
        conn.execute("delete from emotion_analyses where recording_id = ?", (recording_id,))
        conn.execute("update recordings set summary_status = ? where id = ?", ("pending", recording_id))
        conn.commit()

    try:
        model = get_asr_model()
        with db() as conn:
            rec_for_package = rowdict(conn.execute("select * from recordings where id = ?", (recording_id,)).fetchone()) or rec
            package = build_hotword_package(conn, rec_for_package, user)
            hotwords = package["replacement_map"]
            hotword_text = " ".join(package["asr_terms"])
        with db() as conn:
            update_task(conn, task_id, "running", 8)
        generate_kwargs: dict[str, Any] = {
            "input": str(Path(rec["file_path"])),
            "cache": {},
            "batch_size_s": int(os.environ.get("NEWVOICE_BATCH_SIZE_S", "300")),
        }
        if hotword_text:
            generate_kwargs["hotword"] = hotword_text
        expected_spk = rec_for_package.get("expected_speakers")
        if expected_spk and int(expected_spk) >= 2:
            # 用户填了预计人数 → 固定聚类簇数，避免 CAM++ 过度聚类。
            generate_kwargs["preset_spk_num"] = int(expected_spk)
        with _asr_lock:
            result = model.generate(**generate_kwargs)
        if not result:
            raise RuntimeError("ASR returned empty result")
        sentence_info = result[0].get("sentence_info") or []
        if not sentence_info:
            raise RuntimeError("ASR did not return sentence_info with speaker labels")
        with db() as conn:
            update_task(conn, task_id, "running", 82)
        speaker_matches = match_speaker_profiles(rec, sentence_info)
        merged_segments = sentence_info_to_transcript_segments(sentence_info, hotwords, speaker_matches)
        with db() as conn:
            update_task(conn, task_id, "running", 90)
            inserted = 0
            for item in merged_segments:
                conn.execute(
                    """
                    insert into transcript_segments(id,recording_id,start_sec,end_sec,start_label,speaker,speaker_name,voiceprint_id,speaker_confidence,text,confidence)
                    values(?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        item["id"],
                        recording_id,
                        item["start_sec"],
                        item["end_sec"],
                        item["start_label"],
                        item["speaker"],
                        item.get("speaker_name"),
                        item.get("voiceprint_id"),
                        item.get("speaker_confidence"),
                        item["text"],
                        item.get("confidence"),
                    ),
                )
                inserted += 1
            if inserted == 0:
                raise RuntimeError("ASR returned no usable transcript segments")
            conn.execute(
                "update recordings set asr_status = ?, updated_at = ? where id = ?",
                ("done", now(), recording_id),
            )
            update_task(conn, task_id, "done", 100)
            spk_count = len({row.get("spk", "unknown") for row in sentence_info})
            audit(
                conn,
                user,
                "recording",
                f"完成录音转写和说话人分离：{rec['title']}，生成 {inserted} 个语义发言段，检测到 {spk_count} 个说话人，使用热词 {package['asr_terms_count']} 条。",
            )
        return {"recording_id": recording_id, "segments": inserted, "speakers": spk_count}
    except Exception as exc:
        with db() as conn:
            conn.execute(
                "update recordings set asr_status = ?, updated_at = ? where id = ?",
                ("failed", now(), recording_id),
            )
            update_task(conn, task_id, "failed", 100, str(exc))
            audit(conn, user, "recording", f"录音转写失败：{rec['title']}。")
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc


def transcript_text(conn: sqlite3.Connection, recording_id: str) -> str:
    rows = conn.execute(
        "select start_label, end_sec, speaker, speaker_name, text from transcript_segments where recording_id = ? order by start_sec",
        (recording_id,),
    ).fetchall()
    lines = []
    for row in rows:
        label = row["speaker_name"] or f"Speaker {row['speaker']}"
        lines.append(f"[{row['start_label']}-{seconds_label(row['end_sec'])}] {label}: {row['text']}")
    return "\n".join(lines)


def summary_depth_instruction(rec: dict[str, Any], text: str) -> str:
    duration = float(rec.get("duration") or 0)
    if duration >= 7200:
        target = "最终纪要建议 4500-7000 个中文字符，至少覆盖 10 个以上具体议题或商机/项目节点。"
    elif duration >= 3600:
        target = "最终纪要建议 3200-5200 个中文字符，至少覆盖 8 个以上具体议题或商机/项目节点。"
    elif duration >= 1200:
        target = "最终纪要建议 1800-3200 个中文字符，至少覆盖 5 个以上具体议题。"
    else:
        target = "最终纪要建议 900-1800 个中文字符，短会也要保留具体事实，不要只写泛泛概括。"
    if len(text) > 90000:
        target += " 转写很长，合并时要优先保留反复讨论、出现具体客户/项目/数字/系统名的内容。"
    return target


def meeting_focus_instruction(meeting_type: str) -> str:
    if meeting_type == "内部会议":
        return (
            "会议类型是内部会议。重点沉淀：销售/项目复盘脉络、客户或商机名称、项目阶段、现场判断、争议点、"
            "资源/报价/方案/交付边界等讨论内容。不要写行动项或跟进清单。"
        )
    if meeting_type == "客户调研":
        return (
            "会议类型是客户调研。重点沉淀：客户业务背景、当前系统与流程、涉及部门/岗位、痛点或关注点、"
            "预算/周期/范围等被明确提到的信息、客户原话和待澄清点。不要生成客户需求库。"
        )
    if meeting_type == "方案汇报":
        return (
            "会议类型是方案汇报。重点沉淀：方案范围、模块能力、客户反馈、异议与澄清、部署/集成/数据口径、"
            "报价或边界讨论、达成共识与仍需确认的问题。"
        )
    if meeting_type == "销售电话":
        return (
            "会议类型是销售电话。重点沉淀：客户/联系人、来电背景、关注问题、产品或服务匹配点、价格/周期/竞品/决策链线索、"
            "对话中的明确结论和待确认问题。"
        )
    return "根据会议类型保留业务背景、讨论细节、明确结论、待确认问题和可追溯原文证据。"


def meeting_template(meeting_type: str) -> str:
    """每类会议的专属纪要结构骨架。AI 按对应结构逐节输出，无内容的小节写“未明确”。
    顶部「会议信息/一句话概览」与底部「关键原文证据」是所有类型共用的壳，
    中间板块按会议类型切换。"""
    head = ["# 会议纪要", "## 会议信息", "## 一句话概览"]
    foot = ["## 关键原文证据"]
    bodies = {
        "销售电话": [
            "## 通话背景（客户 / 联系人 / 来电由头）",
            "## 客户现状与关注点",
            "## 产品 / 服务匹配讨论",
            "## 价格 / 周期 / 竞品 / 决策链线索",
            "## 关键结论",
            "## 待确认问题",
        ],
        "客户调研": [
            "## 客户业务背景",
            "## 当前系统与流程现状",
            "## 涉及部门 / 岗位",
            "## 痛点与关注点",
            "## 预算 / 周期 / 范围（已明确提到的）",
            "## 客户原话与待澄清点",
        ],
        "方案汇报": [
            "## 方案范围与模块能力",
            "## 客户反馈",
            "## 异议与澄清",
            "## 部署 / 集成 / 数据口径",
            "## 报价与边界讨论",
            "## 达成共识与仍需确认",
        ],
        "内部会议": [
            "## 复盘主线（客户 / 商机 / 项目阶段）",
            "## 各汇报人分述（能识别汇报人时每人一节，逐个过其名下项目：阶段/卡点/策略/结论）",
            "## 争议点",
            "## 资源 / 报价 / 方案 / 交付边界",
            "## 关键结论",
            "## 待确认问题",
        ],
    }
    default_body = [
        "## 核心摘要",
        "## 讨论主线",
        "## 重点议题详述",
        "## 客户 / 项目 / 商机信息沉淀",
        "## 关键结论",
        "## 待确认问题",
    ]
    body = bodies.get((meeting_type or "").strip(), default_body)
    return "\n".join(head + body + foot)


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


async def _deepseek_post_with_retry(
    client: httpx.AsyncClient,
    url: str,
    api_key: str,
    payload: dict[str, Any],
    attempts: int = 5,
) -> str:
    """POST to a DeepSeek chat-completions endpoint, retrying on 5xx and on
    transient network errors (ConnectError, ReadTimeout, RemoteProtocolError).
    Without this, a single TCP blip during a 30-minute summary kills the whole
    job and the user has to re-run from scratch.
    """
    last_error = ""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    for attempt in range(attempts):
        try:
            res = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            last_error = f"network error: {type(exc).__name__}: {exc}"
            if attempt < attempts - 1:
                await asyncio.sleep(2 * (attempt + 1))
                continue
            break
        if res.status_code < 400:
            data = res.json()
            choice = data["choices"][0]
            message = choice.get("message") or {}
            content = (message.get("content") or "").strip()
            if not content:
                reasoning_chars = len(message.get("reasoning_content") or "")
                finish_reason = choice.get("finish_reason") or "unknown"
                raise RuntimeError(
                    "LLM returned empty content "
                    f"(finish_reason={finish_reason}, reasoning_chars={reasoning_chars})"
                )
            return content
        last_error = f"HTTP {res.status_code}: {res.text[:500]}"
        if res.status_code in {408, 409, 425, 429, 500, 502, 503, 504} and attempt < attempts - 1:
            await asyncio.sleep(2 * (attempt + 1))
            continue
        break
    raise RuntimeError(f"DeepSeek request failed: {last_error}")


async def call_deepseek_summary(text: str, rec: dict[str, Any]) -> tuple[str, str]:
    api_key, base, model = get_llm_config()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")

    chunk_chars = env_int("NEWVOICE_SUMMARY_CHUNK_CHARS", 18000, 8000, 28000)
    chunks = [text[i : i + chunk_chars] for i in range(0, len(text), chunk_chars)] or [""]
    depth = summary_depth_instruction(rec, text)
    focus = meeting_focus_instruction(rec.get("meeting_type") or "")
    partials: list[str] = []
    chat_url = f"{base}/chat/completions"
    async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
        for index, chunk in enumerate(chunks, 1):
            payload = {
                "model": model,
                "temperature": 0.2,
                "max_tokens": env_int("NEWVOICE_SUMMARY_CHUNK_MAX_TOKENS", 8192, 1200, 8192),
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是企业内部会议纪要的信息抽取助手。只基于转写文本输出，不编造事实。"
                            "你的任务不是压缩到最短，而是保留后续生成详细纪要所需的事实、对象、数字、观点和证据。"
                            "禁止提炼行动项、待办、下一步、风险或客户需求模块。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "请把下面这段转写整理成“分块纪要素材”，用于后续合成完整会议纪要。\n"
                            "要求：\n"
                            "1. 不要只写摘要，要保留具体客户/项目/系统/产品/人员/金额/时间/数量/阶段等信息。\n"
                            "2. 每个议题写清背景、讨论内容、不同说话人的观点或判断、已形成的共识、仍待确认的问题。\n"
                            "3. 原文证据必须带时间戳，优先选择能支撑结论的短句；识别不确定的词用“疑似”。\n"
                            "4. 如果本段只是闲聊或重复内容，可以标注为低信息密度，但不能编造。\n"
                            "5. 全文不要出现“行动项”“待办”“下一步”“跟进事项”等表述。\n\n"
                            "输出 Markdown，固定结构：\n"
                            "### 本段核心概览\n"
                            "### 议题与细节\n"
                            "### 客户/项目/商机/系统实体\n"
                            "### 结论与待确认\n"
                            "### 可引用原文证据\n\n"
                            f"录音标题：{rec['title']}\n"
                            f"会议类型：{rec['meeting_type']}\n"
                            f"分块：{index}/{len(chunks)}\n\n"
                            f"{focus}\n\n"
                            f"{chunk}"
                        ),
                    },
                ],
            }
            if "deepseek" in base.lower() or model.lower().startswith("deepseek"):
                payload["thinking"] = {"type": "disabled"}
            partials.append(await _deepseek_post_with_retry(client, chat_url, api_key, payload))

        final_payload = {
            "model": model,
            "temperature": 0.2,
            "max_tokens": env_int("NEWVOICE_SUMMARY_FINAL_MAX_TOKENS", 8192, 2000, 12000),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是企业内部会议纪要助手。输出信息丰富、层次清楚、可追溯的 Markdown 纪要。"
                        "只基于转写和分块素材，不编造事实；不确定内容必须标注“疑似”或“未明确”。"
                        "重要：转写里的公司/项目/人名可能被语音识别带偏或张冠李戴——突兀的长全称"
                        "（尤其含“有限公司/集团”且只出现一两次的）不要当成标准项目名，优先用口语高频的简称；"
                        "同一项目出现多个候选名时取最一致的那个；项目归属（谁负责/哪个客户）拿不准就标“疑似”，绝不硬编。"
                        "禁止输出或提及行动项、待办、下一步、风险、客户需求或外部跟进模块。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"请将以下分块素材合并为最终纪要。纪要要比普通摘要更丰富，适合销售经理或项目负责人回看会议全貌。\n\n"
                        f"标题：{rec['title']}\n"
                        f"会议类型：{rec['meeting_type']}\n"
                        f"录音时长：{rec['duration_label']}\n\n"
                        f"深度要求：{depth}\n"
                        f"类型侧重点：{focus}\n\n"
                        "写作要求：\n"
                        "- 先给整体判断，再按议题展开细节；不要把所有内容压成三五条。\n"
                        "- 每个重点议题尽量包含：背景/上下文、讨论细节、相关人或客户态度、明确结论、待确认问题、时间戳证据。\n"
                        "- 对长会议，要按客户/项目/模块/流程分组，合并重复表达，但保留具体名称和关键数字。\n"
                        "- 关键原文证据要分散覆盖主要议题，不要只引用开头几分钟。\n"
                        "- 不要出现“行动项”“待办”“下一步”“跟进事项”等表述。\n\n"
                        "请严格按以下结构输出（小节标题和顺序保持不变；某节无内容就写“未明确”，不要删节也不要新增顶级小节）：\n"
                        + meeting_template(rec.get("meeting_type") or "") + "\n\n"
                        + "\n\n".join(partials)
                    ),
                },
            ],
        }
        if "deepseek" in base.lower() or model.lower().startswith("deepseek"):
            final_payload["thinking"] = {"type": "disabled"}
        return await _deepseek_post_with_retry(client, chat_url, api_key, final_payload), model


async def call_deepseek_revision(instruction: str, base_summary: str, transcript: str, rec: dict[str, Any]) -> tuple[str, str]:
    api_key, base, model = get_llm_config()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")

    if len(transcript) <= 26000:
        transcript_context = transcript
    else:
        transcript_context = (
            transcript[:9000]
            + "\n\n[中间转写过长，以下保留当前纪要和末尾校验片段；需要更多细节时请重新生成完整纪要。]\n\n"
            + transcript[-9000:]
        )
    depth = summary_depth_instruction(rec, transcript)
    focus = meeting_focus_instruction(rec.get("meeting_type") or "")
    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": env_int("NEWVOICE_SUMMARY_FINAL_MAX_TOKENS", 8192, 2000, 12000),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是企业内部会议纪要助手。根据用户修改要求重写完整 Markdown 纪要。"
                    "保持信息丰富、结构清楚、可追溯；只基于原纪要和转写文本，不编造事实。"
                    "转写里的公司/项目/人名可能被语音识别带偏——突兀的长全称不要当标准名、优先口语简称，归属拿不准标“疑似”。"
                    "禁止输出或提及行动项、待办、下一步、风险、客户需求或外部跟进模块。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"录音标题：{rec['title']}\n"
                    f"会议类型：{rec['meeting_type']}\n"
                    f"录音时长：{rec['duration_label']}\n\n"
                    f"深度要求：{depth}\n"
                    f"类型侧重点：{focus}\n\n"
                    f"目标结构（除非用户明确要求改结构，否则按此组织小节）：\n{meeting_template(rec.get('meeting_type') or '')}\n\n"
                    f"用户修改要求：\n{instruction}\n\n"
                    f"当前纪要：\n{base_summary}\n\n"
                    f"转写文本校验依据：\n{transcript_context}\n\n"
                    "请输出修改后的完整 Markdown 纪要。除非用户明确要求删减，否则要保留并补足具体信息、实体名称、数字、讨论细节和时间戳证据；不要只输出简短摘要。"
                ),
            },
        ],
    }
    if "deepseek" in base.lower() or model.lower().startswith("deepseek"):
        payload["thinking"] = {"type": "disabled"}
    async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
        content = await _deepseek_post_with_retry(client, f"{base}/chat/completions", api_key, payload)
    return content, model


def next_summary_version(conn: sqlite3.Connection, recording_id: str) -> int:
    current = conn.execute(
        "select coalesce(max(version), 0) from summaries where recording_id = ?",
        (recording_id,),
    ).fetchone()[0]
    return int(current or 0) + 1


async def summarize_recording(recording_id: str, user: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if rec["asr_status"] != "done":
            raise HTTPException(status_code=409, detail="transcript is not ready")
        text = transcript_text(conn, recording_id)
        if not text.strip():
            raise HTTPException(status_code=409, detail="transcript is empty")
        task_id = create_task(conn, recording_id, rec["title"], "云端纪要")
        conn.execute("update recordings set summary_status = ?, updated_at = ? where id = ?", ("running", now(), recording_id))
        version = next_summary_version(conn, recording_id)
        conn.commit()

    try:
        content, model = await call_deepseek_summary(text, rec)
        with db() as conn:
            summary_id = str(uuid.uuid4())
            conn.execute("update summaries set is_current = 0 where recording_id = ?", (recording_id,))
            conn.execute(
                """
                insert into summaries(id,recording_id,content,model,created_at,version,instruction,base_summary_id,is_current)
                values(?,?,?,?,?,?,?,?,?)
                """,
                (summary_id, recording_id, content, model, now(), version, None, None, 1),
            )
            conn.execute(
                "update recordings set summary_status = ?, updated_at = ? where id = ?",
                ("done", now(), recording_id),
            )
            update_task(conn, task_id, "done", 100)
            audit(conn, user, "summary", f"生成会议纪要：{rec['title']}，模型 {model}。")
        return {"recording_id": recording_id, "model": model, "summary_id": summary_id, "version": version}
    except Exception as exc:
        with db() as conn:
            conn.execute(
                "update recordings set summary_status = ?, updated_at = ? where id = ?",
                ("failed", now(), recording_id),
            )
            update_task(conn, task_id, "failed", 100, str(exc))
            audit(conn, user, "summary", f"DeepSeek 调用失败：{rec['title']}。")
        raise HTTPException(status_code=500, detail=f"summary generation failed: {exc}") from exc


async def revise_summary(recording_id: str, instruction: str, user: dict[str, Any]) -> dict[str, Any]:
    instruction = (instruction or "").strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction is required")
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if rec["asr_status"] != "done":
            raise HTTPException(status_code=409, detail="transcript is not ready")
        base_summary = rowdict(
            conn.execute(
                """
                select * from summaries
                where recording_id = ?
                order by is_current desc, version desc, created_at desc
                limit 1
                """,
                (recording_id,),
            ).fetchone()
        )
        if not base_summary:
            raise HTTPException(status_code=409, detail="summary is not ready")
        text = transcript_text(conn, recording_id)
        task_id = create_task(conn, recording_id, rec["title"], "自然语言修改纪要")
        conn.execute("update recordings set summary_status = ?, updated_at = ? where id = ?", ("running", now(), recording_id))
        version = next_summary_version(conn, recording_id)
        conn.commit()

    try:
        content, model = await call_deepseek_revision(instruction, base_summary["content"], text, rec)
        with db() as conn:
            summary_id = str(uuid.uuid4())
            conn.execute("update summaries set is_current = 0 where recording_id = ?", (recording_id,))
            conn.execute(
                """
                insert into summaries(id,recording_id,content,model,created_at,version,instruction,base_summary_id,is_current)
                values(?,?,?,?,?,?,?,?,?)
                """,
                (summary_id, recording_id, content, model, now(), version, instruction, base_summary["id"], 1),
            )
            conn.execute(
                "update recordings set summary_status = ?, updated_at = ? where id = ?",
                ("done", now(), recording_id),
            )
            update_task(conn, task_id, "done", 100)
            audit(conn, user, "summary", f"按自然语言要求修改纪要：{rec['title']}，版本 v{version}。")
        return {"recording_id": recording_id, "model": model, "summary_id": summary_id, "version": version}
    except Exception as exc:
        with db() as conn:
            conn.execute(
                "update recordings set summary_status = ?, updated_at = ? where id = ?",
                ("failed", now(), recording_id),
            )
            update_task(conn, task_id, "failed", 100, str(exc))
            audit(conn, user, "summary", f"自然语言修改纪要失败：{rec['title']}。")
        raise HTTPException(status_code=500, detail=f"summary revision failed: {exc}") from exc


def transcript_markdown(conn: sqlite3.Connection, rec: dict[str, Any]) -> str:
    rows = conn.execute(
        "select start_label, end_sec, speaker, speaker_name, text from transcript_segments where recording_id = ? order by start_sec",
        (rec["id"],),
    ).fetchall()
    parts = []
    for row in rows:
        label = row["speaker_name"] or f"Speaker {row['speaker']}"
        parts.append(f"### {row['start_label']}-{seconds_label(row['end_sec'])} · {label}\n\n{row['text']}")
    body = "\n\n".join(parts)
    return (
        f"# {rec['title']} 转写\n\n"
        "## 录音信息\n\n"
        f"- 会议类型：{rec['meeting_type']}\n"
        f"- 客户 / 项目：{rec.get('tag') or '-'}\n"
        f"- 录音时长：{rec['duration_label']}\n"
        "- ASR 引擎：Paraformer + FSMN-VAD + CT-Punc + CAM++\n"
        "- 切分方式：VAD 动态切分后合并为语义发言段\n"
        "- 热词：启用本地热词库纠错\n\n"
        "## 完整转写\n\n"
        f"{body or '暂无转写内容。'}\n"
    )


def write_export(recording_id: str, kind: str, user: dict[str, Any]) -> Path:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if kind == "transcript":
            content = transcript_markdown(conn, rec)
            suffix = "转写"
        elif kind == "summary":
            summary = rowdict(
                conn.execute(
                    """
                    select * from summaries
                    where recording_id = ?
                    order by is_current desc, version desc, created_at desc
                    limit 1
                    """,
                    (recording_id,),
                ).fetchone()
            )
            if not summary:
                raise HTTPException(status_code=404, detail="summary not found")
            content = summary["content"]
            suffix = f"纪要_v{summary.get('version') or 1}"
        elif kind == "emotion":
            emotion = current_emotion_analysis(conn, recording_id)
            if not emotion:
                raise HTTPException(status_code=404, detail="emotion analysis not found")
            content = emotion["content"]
            suffix = f"情绪分析_v{emotion.get('version') or 1}"
        else:
            raise HTTPException(status_code=404, detail="unknown export")
    path = EXPORTS / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{slug(rec['title'])}_{suffix}.md"
    path.write_text(content, encoding="utf-8")
    return path


def write_summary_export(recording_id: str, summary_id: str, user: dict[str, Any]) -> Path:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        summary = rowdict(
            conn.execute(
                "select * from summaries where recording_id = ? and id = ?",
                (recording_id, summary_id),
            ).fetchone()
        )
        if not summary:
            raise HTTPException(status_code=404, detail="summary not found")
        suffix = f"纪要_v{summary.get('version') or 1}"
        path = EXPORTS / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{slug(rec['title'])}_{suffix}.md"
        path.write_text(summary["content"], encoding="utf-8")
        return path


# ---------------------------------------------------------------------------
# 对话情绪分析（独立的第 3 类产物）
#   B 声学层：emotion2vec 逐段识别说话情绪（生气/难过/开心…）
#   A 语义层：DeepSeek 结合带情绪标注的转写做对话情绪分析（意向 + 异议）
#   只导出 markdown；不产出任何行动项 / 跟进建议。
# ---------------------------------------------------------------------------

_EMOTION_CN = {
    "生气": "生气", "angry": "生气", "厌恶": "厌恶", "disgusted": "厌恶",
    "恐惧": "恐惧", "fearful": "恐惧", "开心": "开心", "happy": "开心",
    "中立": "中立", "neutral": "中立", "难过": "难过", "sad": "难过",
    "吃惊": "吃惊", "surprised": "吃惊", "其他": "其他", "other": "其他",
    "unknown": "未知", "<unk>": "未知",
}
_EMOTION_NEGATIVE = {"生气", "厌恶", "恐惧", "难过"}


def emotion_label_cn(raw: str) -> str:
    parts = [p.strip() for p in str(raw or "").split("/") if p.strip()]
    for p in parts:
        if p in _EMOTION_CN:
            return _EMOTION_CN[p]
    return parts[0] if parts else "未知"


def get_emotion_model() -> Any:
    global _emotion_model
    if _emotion_model is None:
        with _emotion_init_lock:
            if _emotion_model is None:
                if not EMOTION.exists():
                    raise RuntimeError(f"情绪模型缺失：{EMOTION}")
                from funasr import AutoModel

                _emotion_model = AutoModel(model=str(EMOTION), device=ASR_DEVICE, disable_update=True)
    return _emotion_model


def analyze_segment_emotion(wav_path: str) -> tuple[str, float]:
    with _asr_lock:
        res = get_emotion_model().generate(wav_path, granularity="utterance", extract_embedding=False)
    if not res:
        return "未知", 0.0
    item = res[0]
    labels = [emotion_label_cn(x) for x in (item.get("labels") or [])]
    scores = [float(s) for s in (item.get("scores") or [])]
    if not labels or not scores:
        return "未知", 0.0
    top = max(range(len(scores)), key=lambda i: scores[i])
    return labels[top], round(scores[top], 3)


def analyze_acoustic_emotions(rec: dict[str, Any], segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """逐段跑 emotion2vec。只取 >=1.2s 的段，最多 220 段（超出时优先取长段），
    避免几百个碎段拖慢。音频缺失时返回空，让语义层退化为纯文本分析。"""
    import shutil

    src = Path(rec.get("file_path") or "")
    if not src.exists():
        return [], {}
    cands = [s for s in segments if (float(s.get("end_sec") or 0) - float(s.get("start_sec") or 0)) >= 1.2]
    if len(cands) > 220:
        cands = sorted(cands, key=lambda s: float(s.get("end_sec") or 0) - float(s.get("start_sec") or 0), reverse=True)[:220]
        cands = sorted(cands, key=lambda s: float(s.get("start_sec") or 0))
    per_segment: list[dict[str, Any]] = []
    workdir = TMP / f"emotion_{rec['id']}_{uuid.uuid4().hex[:8]}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        for idx, seg in enumerate(cands):
            start = float(seg.get("start_sec") or 0.0)
            end = float(seg.get("end_sec") or 0.0)
            speaker = seg.get("speaker_name") or (f"Speaker {seg.get('speaker')}" if seg.get("speaker") is not None else "未知")
            clip = workdir / f"seg_{idx}.wav"
            try:
                extract_interval(src, clip, start, min(end, start + 20.0))
                emotion, score = analyze_segment_emotion(str(clip))
            except Exception:
                continue
            finally:
                try:
                    clip.unlink()
                except Exception:
                    pass
            per_segment.append({
                "start": start,
                "start_label": seg.get("start_label") or seconds_label(start),
                "speaker": speaker,
                "emotion": emotion,
                "score": score,
                "text": (seg.get("text") or "")[:60],
            })
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    stats: dict[str, Any] = {}
    for item in per_segment:
        st = stats.setdefault(item["speaker"], {"count": 0, "emotions": {}, "negative": 0})
        st["count"] += 1
        st["emotions"][item["emotion"]] = st["emotions"].get(item["emotion"], 0) + 1
        if item["emotion"] in _EMOTION_NEGATIVE:
            st["negative"] += 1
    for st in stats.values():
        st["dominant"] = max(st["emotions"], key=st["emotions"].get) if st["emotions"] else "未知"
        st["negative_ratio"] = round(st["negative"] / st["count"], 2) if st["count"] else 0.0
    return per_segment, stats


def acoustic_markdown(per_speaker: dict[str, Any], per_segment: list[dict[str, Any]]) -> str:
    lines = ["## 声学情绪分布（emotion2vec 逐段识别）", ""]
    if not per_segment:
        lines.append("> 转写段落过短或音频缺失，本次未做声学情绪识别，以上分析仅基于文本。")
        return "\n".join(lines)
    lines.append("| 说话人 | 主导情绪 | 负面占比 | 采样段数 | 情绪分布 |")
    lines.append("|---|---|---|---|---|")
    for sp, st in sorted(per_speaker.items(), key=lambda kv: -kv[1]["count"]):
        dist = "、".join(f"{e}×{n}" for e, n in sorted(st["emotions"].items(), key=lambda kv: -kv[1]))
        lines.append(f"| {sp} | {st['dominant']} | {int(st['negative_ratio'] * 100)}% | {st['count']} | {dist} |")
    peaks = [s for s in per_segment if s["emotion"] in _EMOTION_NEGATIVE and s["score"] >= 0.6][:12]
    if peaks:
        lines += ["", "**声学上情绪强烈的片段（负面，置信 ≥ 0.6）：**", ""]
        for p in peaks:
            lines.append(f"- `{p['start_label']}` {p['speaker']}（{p['emotion']} {p['score']}）：{p['text']}")
    return "\n".join(lines)


def emotion_annotated_transcript(conn: sqlite3.Connection, recording_id: str, per_segment: list[dict[str, Any]]) -> str:
    emo_by_start = {round(s["start"], 1): (s["emotion"], s["score"]) for s in per_segment}
    rows = conn.execute(
        "select start_label, end_sec, start_sec, speaker, speaker_name, text from transcript_segments where recording_id = ? order by start_sec",
        (recording_id,),
    ).fetchall()
    lines = []
    for row in rows:
        label = row["speaker_name"] or f"Speaker {row['speaker']}"
        emo = emo_by_start.get(round(float(row["start_sec"] or 0), 1))
        tag = f"（声学:{emo[0]}{emo[1]}）" if emo else ""
        lines.append(f"[{row['start_label']}-{seconds_label(row['end_sec'])}] {label}{tag}: {row['text']}")
    return "\n".join(lines)


def call_deepseek_emotion(annotated_transcript: str, rec: dict[str, Any], acoustic_md: str) -> tuple[str, str]:
    api_key, base, model = get_llm_config()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")
    transcript = annotated_transcript
    if len(transcript) > 48000:
        transcript = transcript[:26000] + "\n\n[中间过长省略，仅保留首尾]\n\n" + transcript[-18000:]
    payload = {
        "model": model,
        "temperature": 0.3,
        "max_tokens": env_int("NEWVOICE_EMOTION_MAX_TOKENS", 6000, 2000, 12000),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是销售 / 项目对话的情绪分析专家。基于带时间戳和声学情绪标注的对话转写，分析对话里的情绪与态度。"
                    "“（声学:情绪+置信）”来自语音情绪模型，是辅助证据，要结合说话内容判断，不要照搬数字。"
                    "重点突出情绪本身：整体氛围松紧、各方参与度、是否有防御 / 抵触 / 不耐烦 / 敷衍 / 热情，以及客户的购买意向信号和异议顾虑。"
                    "只基于转写内容，不编造；不确定的写“疑似”。"
                    "严禁输出行动项、待办、下一步、跟进建议或任何外部业务模块——这是情绪分析，不是会议纪要。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"录音标题：{rec.get('title')}\n会议类型：{rec.get('meeting_type')}\n时长：{rec.get('duration_label')}\n\n"
                    "请严格按以下结构输出 Markdown（小节顺序不变；无内容的小节写“未明确”）：\n"
                    "# 对话情绪分析\n"
                    "## 整体情绪基调\n"
                    "## 各方情绪画像\n"
                    "## 情绪转折点\n"
                    "## 客户意向信号\n"
                    "## 异议与顾虑\n\n"
                    "每节尽量引用时间戳和原话作为证据；“各方情绪画像”按说话人分别写参与度与情绪主线。\n\n"
                    f"【声学情绪概览】\n{acoustic_md}\n\n"
                    f"【带情绪标注的对话转写】\n{transcript}\n"
                ),
            },
        ],
    }
    if "deepseek" in base.lower() or model.lower().startswith("deepseek"):
        payload["thinking"] = {"type": "disabled"}
    chat_url = f"{base}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    last_err: Any = None
    with httpx.Client(timeout=180, trust_env=False) as client:
        for attempt in range(3):
            try:
                res = client.post(chat_url, headers=headers, json=payload)
                if res.status_code >= 500:
                    last_err = RuntimeError(f"DeepSeek HTTP {res.status_code}: {res.text[:200]}")
                    time.sleep(1.5 * (attempt + 1))
                    continue
                if res.status_code >= 400:
                    raise RuntimeError(f"DeepSeek HTTP {res.status_code}: {res.text[:300]}")
                choice = res.json()["choices"][0]
                message = choice.get("message") or {}
                content = (message.get("content") or "").strip()
                if not content:
                    raise RuntimeError(
                        "LLM returned empty content "
                        f"(finish_reason={choice.get('finish_reason') or 'unknown'}, "
                        f"reasoning_chars={len(message.get('reasoning_content') or '')})"
                    )
                return content, model
            except httpx.RequestError as exc:
                last_err = exc
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"DeepSeek 调用失败：{last_err}")


def next_emotion_version(conn: sqlite3.Connection, recording_id: str) -> int:
    row = conn.execute(
        "select coalesce(max(version), 0) from emotion_analyses where recording_id = ?",
        (recording_id,),
    ).fetchone()
    return int(row[0]) + 1


def current_emotion_analysis(conn: sqlite3.Connection, recording_id: str) -> dict[str, Any] | None:
    return rowdict(
        conn.execute(
            """
            select * from emotion_analyses
            where recording_id = ?
            order by is_current desc, version desc, created_at desc
            limit 1
            """,
            (recording_id,),
        ).fetchone()
    )


def generate_emotion_analysis(recording_id: str, user: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if rec["asr_status"] != "done":
            raise HTTPException(status_code=409, detail="转写尚未完成")
        segments = rowsdict(
            conn.execute(
                "select * from transcript_segments where recording_id = ? order by start_sec",
                (recording_id,),
            ).fetchall()
        )
        if not segments:
            raise HTTPException(status_code=409, detail="转写为空")
        task_id = create_task(conn, recording_id, rec["title"], "对话情绪分析")
        version = next_emotion_version(conn, recording_id)
        conn.commit()

    try:
        per_segment, per_speaker = analyze_acoustic_emotions(rec, segments)
        acoustic_md = acoustic_markdown(per_speaker, per_segment)
        with db() as conn:
            annotated = emotion_annotated_transcript(conn, recording_id, per_segment)
        analysis_md, model = call_deepseek_emotion(annotated, rec, acoustic_md)
        content = analysis_md.rstrip() + "\n\n" + acoustic_md + "\n"
        model_label = f"emotion2vec_plus_large + {model}"
        with db() as conn:
            emotion_id = str(uuid.uuid4())
            conn.execute("update emotion_analyses set is_current = 0 where recording_id = ?", (recording_id,))
            conn.execute(
                "insert into emotion_analyses(id,recording_id,content,model,acoustic_json,created_at,version,is_current) values(?,?,?,?,?,?,?,?)",
                (
                    emotion_id,
                    recording_id,
                    content,
                    model_label,
                    json.dumps({"per_speaker": per_speaker, "segments": per_segment[:400]}, ensure_ascii=False),
                    now(),
                    version,
                    1,
                ),
            )
            update_task(conn, task_id, "done", 100)
            audit(conn, user, "emotion", f"生成对话情绪分析：{rec['title']}，模型 {model_label}。")
        return {"recording_id": recording_id, "emotion_id": emotion_id, "model": model_label, "version": version}
    except HTTPException:
        with db() as conn:
            update_task(conn, task_id, "failed", 100, "emotion analysis failed")
        raise
    except Exception as exc:
        with db() as conn:
            update_task(conn, task_id, "failed", 100, str(exc))
            audit(conn, user, "emotion", f"对话情绪分析失败：{rec['title']}。")
        raise HTTPException(status_code=500, detail=f"emotion analysis failed: {exc}") from exc


def run_emotion_job(recording_id: str, user: dict[str, Any]) -> None:
    """Background worker for emotion analysis. Failures are already recorded on
    the task row by generate_emotion_analysis, so just swallow the exception."""
    try:
        generate_emotion_analysis(recording_id, user)
    except Exception:
        pass


def process_recording_background(recording_id: str, user: dict[str, Any]) -> None:
    try:
        transcribe_recording(recording_id, user)
        asyncio.run(summarize_recording(recording_id, user))
    except HTTPException:
        return
    except Exception as exc:
        with db() as conn:
            rec = rowdict(conn.execute("select title from recordings where id = ?", (recording_id,)).fetchone())
            create_task(conn, recording_id, rec["title"] if rec else recording_id, "完整处理")
            last = rowdict(conn.execute("select id from tasks where recording_id = ? order by created_at desc limit 1", (recording_id,)).fetchone())
            if last:
                update_task(conn, last["id"], "failed", 100, str(exc))


@app.on_event("startup")
def startup() -> None:
    ensure_schema()
    voice_integration.ensure_schema()
    _start_cleanup_loop()


@app.post("/api/auth/login")
def login(payload: dict[str, str]) -> dict[str, Any]:
    username = (payload.get("username") or payload.get("user_id") or "").strip()
    password = payload.get("password") or ""
    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password are required")
    with db() as conn:
        user = rowdict(
            conn.execute(
                """
                select * from users
                where lower(coalesce(username, id)) = lower(?)
                   or lower(id) = lower(?)
                   or lower(coalesce(email, '')) = lower(?)
                   or coalesce(mobile, '') = ?
                   or lower(coalesce(wecom_userid, '')) = lower(?)
                limit 1
                """,
                (username, username, username, username, username),
            ).fetchone()
        )
        if not user:
            raise HTTPException(status_code=401, detail="账号或密码错误")
        if user.get("status") != "active":
            raise HTTPException(status_code=403, detail="账号已停用")
        if user.get("locked_until") and user["locked_until"] > now():
            raise HTTPException(status_code=423, detail=f"账号已锁定到 {user['locked_until']}")
        if not verify_password(password, user.get("password_hash")):
            failed = int(user.get("failed_login_count") or 0) + 1
            locked_until = (datetime.now() + timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S") if failed >= 5 else None
            conn.execute(
                "update users set failed_login_count = ?, locked_until = ?, updated_at = ? where id = ?",
                (failed, locked_until, now(), user["id"]),
            )
            conn.commit()  # Persist lockout even though the request raises below.
            raise HTTPException(status_code=401, detail="账号或密码错误")
        token = create_session(conn, user["id"])
        conn.execute(
            "update users set failed_login_count = 0, locked_until = null, last_login_at = ?, last_active_at = ?, updated_at = ? where id = ?",
            (now(), now(), now(), user["id"]),
        )
        user = rowdict(conn.execute("select * from users where id = ?", (user["id"],)).fetchone())
        audit(conn, normalize_user(user), "auth", "登录本地系统。")
    return {"token": token, "user": normalize_user(user)}


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None), user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    token = (authorization or "").removeprefix("Bearer").strip()
    with db() as conn:
        conn.execute("delete from sessions where token = ?", (token,))
        audit(conn, user, "auth", "退出本地系统。")
    return {"ok": True}


@app.post("/api/auth/change-password")
def change_password(payload: dict[str, str], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    current = payload.get("current_password") or ""
    new_password = payload.get("new_password") or ""
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    with db() as conn:
        row = rowdict(conn.execute("select * from users where id = ?", (user["id"],)).fetchone())
        if not row or not verify_password(current, row.get("password_hash")):
            raise HTTPException(status_code=401, detail="当前密码不正确")
        conn.execute(
            "update users set password_hash = ?, must_change_password = 0, updated_at = ? where id = ?",
            (hash_password(new_password), now(), user["id"]),
        )
        changed = rowdict(conn.execute("select * from users where id = ?", (user["id"],)).fetchone())
        audit(conn, user, "auth.password", "修改自己的登录密码。")
    return normalize_user(changed)


@app.get("/api/me")
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return user


# ---------------------------------------------------------------------------
# 大模型（LLM）配置端点 —— 对齐 aham-voice 开源版。
# 配置是全局单份(存 config.json),读取对登录用户开放;写入/测试限管理员
# (orchisky 多用户语义,不同于 aham 单用户的全放行)。
# ---------------------------------------------------------------------------
def _settings_view() -> dict[str, Any]:
    api_key, base, model = get_llm_config()
    provider = get_llm_provider()
    return {
        "llm_configured": bool(api_key),
        "llm_api_base": base,
        "llm_model": model,
        "llm_provider": provider,
        # legacy DeepSeek 别名,兼容旧前端缓存
        "deepseek_configured": bool(api_key),
        "deepseek_api_base": base,
        "deepseek_model": model,
    }


@app.get("/api/settings")
def get_settings(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _settings_view()


@app.patch("/api/settings")
def patch_settings(
    payload: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_admin(user)
    updates: dict[str, Any] = {}

    def _pick(*keys: str) -> str | None:
        for key in keys:
            if key in payload:
                return (payload.get(key) or "").strip()
        return None

    api_key = _pick("llm_api_key", "deepseek_api_key")
    if api_key is not None:
        updates["llm_api_key"] = api_key
        updates["deepseek_api_key"] = api_key

    api_base = _pick("llm_api_base", "deepseek_api_base")
    if api_base is not None:
        api_base = api_base or DEFAULT_LLM_API_BASE
        updates["llm_api_base"] = api_base
        updates["deepseek_api_base"] = api_base

    model = _pick("llm_model", "deepseek_model")
    if model is not None:
        model = model or DEFAULT_LLM_MODEL
        updates["llm_model"] = model
        updates["deepseek_model"] = model

    if "llm_provider" in payload:
        updates["llm_provider"] = (payload.get("llm_provider") or "").strip()

    if updates:
        save_user_config(updates)
        with db() as conn:
            audit(conn, user, "settings.update", f"{user['name']} 更新了大模型配置。")
    return _settings_view()


@app.post("/api/settings/test")
async def test_settings(
    payload: dict[str, Any] | None = Body(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """探测当前(或临时覆盖的)LLM 端点是否可用。可选 body 覆盖 api_key/api_base/model。
    返回 {ok, model, latency_ms, error?}。错误为友好中文,不泄露 key/堆栈。"""
    require_admin(user)
    body = payload if isinstance(payload, dict) else {}
    api_key, base, model = get_llm_config()

    if isinstance(body.get("api_key"), str) and body["api_key"].strip():
        api_key = body["api_key"].strip()
    if isinstance(body.get("api_base"), str) and body["api_base"].strip():
        base = body["api_base"].strip().rstrip("/")
    if isinstance(body.get("model"), str) and body["model"].strip():
        model = body["model"].strip()

    if not api_key:
        return {"ok": False, "model": model, "latency_ms": 0, "error": "未配置 API Key，请先填写并保存。"}

    chat_url = f"{base}/chat/completions"
    request_body = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            res = await client.post(chat_url, headers=headers, json=request_body)
    except httpx.TimeoutException:
        return {"ok": False, "model": model, "latency_ms": int((time.monotonic() - started) * 1000),
                "error": "连接超时（15 秒内未响应），请检查 API Base 地址与网络。"}
    except httpx.RequestError as exc:
        return {"ok": False, "model": model, "latency_ms": int((time.monotonic() - started) * 1000),
                "error": f"网络连接失败（{type(exc).__name__}），请检查 API Base 地址与网络。"}

    latency_ms = int((time.monotonic() - started) * 1000)

    if res.status_code < 400:
        served = model
        try:
            data = res.json()
            if isinstance(data, dict) and isinstance(data.get("model"), str) and data["model"].strip():
                served = data["model"].strip()
        except Exception:
            pass
        return {"ok": True, "model": served, "latency_ms": latency_ms}

    status = res.status_code
    if status in (401, 403):
        error = "鉴权失败（API Key 无效或无权限），请检查 Key 是否正确。"
    elif status in (400, 404):
        error = f"模型不存在或请求被拒绝（HTTP {status}），请检查模型名称与 API Base。"
    elif status == 429:
        error = "请求过于频繁或额度不足（HTTP 429），请稍后再试或检查账户额度。"
    else:
        reason = (res.text or "").strip().replace("\n", " ")[:120]
        error = f"请求失败（HTTP {status}）{('：' + reason) if reason else ''}"
    return {"ok": False, "model": model, "latency_ms": latency_ms, "error": error}


@app.get("/api/users")
def users(
    role: str = "",
    status: str = "",
    q: str = "",
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    filters: list[str] = []
    args: list[Any] = []
    if user["role"] == "member":
        filters.append("id = ?")
        args.append(user["id"])
    elif user["role"] == "manager":
        team_ids = user.get("managed_team_ids") or ([user["team_id"]] if user.get("team_id") else [])
        if "*" not in team_ids:
            placeholders = ",".join("?" for _ in team_ids) or "?"
            filters.append(f"(id = ? or team_id in ({placeholders}))")
            args.extend([user["id"], *(team_ids or ["__none__"])])
        # "*" → 业务管理员，看全部用户，不加过滤
    if role:
        filters.append("role = ?")
        args.append(role)
    if status:
        filters.append("status = ?")
        args.append(status)
    if q.strip():
        like = f"%{q.strip()}%"
        filters.append("(name like ? or username like ? or email like ? or mobile like ? or dept like ? or wecom_userid like ?)")
        args.extend([like, like, like, like, like, like])
    where = f"where {' and '.join(filters)}" if filters else ""
    with db() as conn:
        return [normalize_user(row) for row in rowsdict(conn.execute(f"select * from users {where} order by dept, name", args).fetchall())]


SEED_ADMIN_USERNAME = "administrator"


def _guard_admin_change(
    conn: sqlite3.Connection,
    actor: dict[str, Any],
    target: dict[str, Any],
    next_role: str | None,
    next_status: str | None,
) -> None:
    """Reject admin-modifications that would self-lock or empty the admin pool.

    Rules:
    - admin cannot demote / disable themselves (force pairing-account model)
    - cannot demote / disable the last remaining active admin
    - cannot disable the seed `administrator` (it's the bootstrap recovery hatch
      that ensure_schema re-asserts on every startup; disabling it just creates
      a confusing zombie state)
    """
    target_id = target.get("id")
    is_self = target_id == actor.get("id")
    current_role = target.get("role")
    current_status = target.get("status")
    role_after = next_role if next_role is not None else current_role
    status_after = next_status if next_status is not None else current_status
    role_changing = next_role is not None and next_role != current_role
    status_changing = next_status is not None and next_status != current_status

    if is_self and role_changing and role_after != "admin":
        raise HTTPException(status_code=403, detail="不能修改自己的角色")
    if is_self and status_changing and status_after != "active":
        raise HTTPException(status_code=403, detail="不能停用自己")

    if target.get("username") == SEED_ADMIN_USERNAME and (
        (role_changing and role_after != "admin") or (status_changing and status_after != "active")
    ):
        raise HTTPException(status_code=403, detail="不能修改种子管理员账号的角色或状态")

    target_was_active_admin = current_role == "admin" and current_status == "active"
    target_remains_active_admin = role_after == "admin" and status_after == "active"
    if target_was_active_admin and not target_remains_active_admin:
        other_admins = conn.execute(
            "select count(*) from users where role = 'admin' and status = 'active' and id != ?",
            (target_id,),
        ).fetchone()[0]
        if int(other_admins or 0) == 0:
            raise HTTPException(status_code=409, detail="至少要保留一个启用的管理员")


@app.patch("/api/users/{user_id}")
def patch_user(user_id: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    allowed = {"username", "name", "email", "mobile", "dept", "role", "team_id", "managed_team_ids", "status"}
    updates: dict[str, Any] = {key: payload[key] for key in allowed if key in payload}
    if not updates:
        raise HTTPException(status_code=400, detail="no supported user fields")
    if "role" in updates and updates["role"] not in {"member", "manager", "admin"}:
        raise HTTPException(status_code=400, detail="invalid role")
    if "status" in updates and updates["status"] not in {"active", "disabled"}:
        raise HTTPException(status_code=400, detail="invalid status")
    if "managed_team_ids" in updates:
        if not isinstance(updates["managed_team_ids"], list):
            raise HTTPException(status_code=400, detail="managed_team_ids must be a list")
        updates["managed_team_ids"] = json.dumps(updates["managed_team_ids"], ensure_ascii=False)
    with db() as conn:
        current = rowdict(conn.execute("select * from users where id = ?", (user_id,)).fetchone())
        if not current:
            raise HTTPException(status_code=404, detail="user not found")
        _guard_admin_change(conn, user, current, updates.get("role"), updates.get("status"))
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"update users set {assignments} where id = ?", (*updates.values(), user_id))
        audit(conn, user, "user.update", f"{user['name']} 修改用户 {current['name']}。")
        changed = rowdict(conn.execute("select * from users where id = ?", (user_id,)).fetchone())
    return normalize_user(changed)


@app.post("/api/users/{user_id}/reset-password")
def reset_user_password(user_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    with db() as conn:
        current = rowdict(conn.execute("select * from users where id = ?", (user_id,)).fetchone())
        if not current:
            raise HTTPException(status_code=404, detail="user not found")
        conn.execute(
            "update users set password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = null, updated_at = ? where id = ?",
            (hash_password(initial_password()), now(), user_id),
        )
        conn.execute("delete from sessions where user_id = ?", (user_id,))
        audit(conn, user, "user.password", f"{user['name']} 重置用户 {current['name']} 的密码。")
        changed = rowdict(conn.execute("select * from users where id = ?", (user_id,)).fetchone())
    return normalize_user(changed)


@app.get("/api/teams")
def teams(_: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    with db() as conn:
        return [team_payload(conn, row) for row in rowsdict(conn.execute("select * from teams order by dept, name").fetchall())]


@app.patch("/api/teams/{team_id}")
def patch_team(team_id: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    allowed = {"name", "dept", "manager_ids"}
    updates: dict[str, Any] = {key: payload[key] for key in allowed if key in payload}
    if not updates:
        raise HTTPException(status_code=400, detail="no supported team fields")
    if "manager_ids" in updates:
        if not isinstance(updates["manager_ids"], list):
            raise HTTPException(status_code=400, detail="manager_ids must be a list")
        updates["manager_ids"] = json.dumps(updates["manager_ids"], ensure_ascii=False)
    with db() as conn:
        current = rowdict(conn.execute("select * from teams where id = ?", (team_id,)).fetchone())
        if not current:
            raise HTTPException(status_code=404, detail="team not found")
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"update teams set {assignments} where id = ?", (*updates.values(), team_id))
        audit(conn, user, "team.update", f"{user['name']} 修改团队 {current['name']}。")
        changed = rowdict(conn.execute("select * from teams where id = ?", (team_id,)).fetchone())
        return team_payload(conn, changed)


def wecom_config(conn: sqlite3.Connection, include_secret: bool = False) -> dict[str, Any]:
    secret = get_setting(conn, "wecom_secret")
    payload = {
        "corp_id": get_setting(conn, "wecom_corp_id"),
        "sales_department_id": get_setting(conn, "wecom_sales_department_id"),
        "secret_configured": bool(secret),
    }
    if include_secret:
        payload["secret"] = secret
    return payload


def wecom_api_get(client: httpx.Client, path: str, params: dict[str, Any]) -> dict[str, Any]:
    # All failures here are raised as HTTPException, never a bare exception:
    # an unhandled error bubbles to a 500 emitted OUTSIDE the CORS middleware,
    # so it has no CORS headers and the browser surfaces a useless "Network
    # Error" instead of WeCom's real message (e.g. "invalid corpid").
    try:
        res = client.get(f"https://qyapi.weixin.qq.com{path}", params=params)
        res.raise_for_status()
        data = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"企业微信接口 {path} 请求失败：{exc}") from exc
    if data.get("errcode") not in (0, None):
        raise HTTPException(
            status_code=502,
            detail=f"企业微信接口 {path} 返回错误 {data.get('errcode')}：{data.get('errmsg') or ''}".strip(),
        )
    return data


def fetch_wecom_sales(config: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    corp_id = config.get("corp_id", "").strip()
    secret = config.get("secret", "").strip()
    sales_department_id = str(config.get("sales_department_id", "")).strip()
    if not corp_id or not secret or not sales_department_id:
        raise HTTPException(status_code=400, detail="企业微信 CorpID、Secret、销售部门 ID 必须先配置")
    with httpx.Client(timeout=30) as client:
        token_data = wecom_api_get(client, "/cgi-bin/gettoken", {"corpid": corp_id, "corpsecret": secret})
        access_token = token_data["access_token"]
        departments: dict[str, dict[str, Any]] = {}
        try:
            dept_data = wecom_api_get(
                client,
                "/cgi-bin/department/list",
                {"access_token": access_token, "id": sales_department_id},
            )
            for item in dept_data.get("department", []):
                departments[str(item.get("id"))] = item
        except Exception:
            departments[sales_department_id] = {"id": sales_department_id, "name": f"企微部门 {sales_department_id}", "parentid": ""}
        user_data = wecom_api_get(
            client,
            "/cgi-bin/user/list",
            {"access_token": access_token, "department_id": sales_department_id, "fetch_child": 1},
        )
    members: list[dict[str, Any]] = []
    for item in user_data.get("userlist", []):
        userid = str(item.get("userid") or "").strip()
        if not userid:
            continue
        department_ids = [str(dept) for dept in item.get("department", [])]
        primary_department_id = department_ids[0] if department_ids else sales_department_id
        departments.setdefault(
            primary_department_id,
            {"id": primary_department_id, "name": f"企微部门 {primary_department_id}", "parentid": sales_department_id},
        )
        members.append(
            {
                "userid": userid,
                "name": clean_wecom_name(item.get("name") or userid) or userid,
                "email": item.get("email") or item.get("biz_mail") or "",
                "mobile": item.get("mobile") or "",
                "department_ids": department_ids or [sales_department_id],
                "primary_department_id": primary_department_id,
                "status": item.get("status", 1),
            }
        )
    return members, departments


def mapping_matches(mapping: dict[str, Any], member: dict[str, Any], username: str, team_id: str) -> bool:
    value = str(mapping.get("match_value") or "").strip()
    match_type = mapping.get("match_type")
    if not value:
        return False
    if match_type == "wecom_userid":
        return member.get("userid") == value
    if match_type == "name":
        return member.get("name") == value
    if match_type == "mobile":
        return member.get("mobile") == value
    if match_type == "department_id":
        return value in (member.get("department_ids") or [])
    if match_type == "local_username":
        return username == value
    if match_type == "team_id":
        return team_id == value
    return False


def role_for_wecom_member(
    member: dict[str, Any],
    team_id: str,
    all_team_ids: list[str],
    mappings: list[dict[str, Any]],
) -> tuple[str, list[str]]:
    username = member["userid"]
    for mapping in mappings:
        if not mapping.get("active") or not mapping_matches(mapping, member, username, team_id):
            continue
        role = mapping.get("role") if mapping.get("role") in {"admin", "manager", "member"} else "member"
        managed_team_ids = mapping.get("managed_team_ids") or []
        if role == "manager" and not managed_team_ids:
            managed_team_ids = all_team_ids
        if role != "manager":
            managed_team_ids = []
        return role, managed_team_ids
    return "member", []


def sync_wecom_users(conn: sqlite3.Connection, actor: dict[str, Any], preview: bool = False) -> dict[str, Any]:
    members, departments = fetch_wecom_sales(wecom_config(conn, include_secret=True))
    timestamp = now()
    team_ids: list[str] = []
    for dept_id, dept in departments.items():
        team_id = f"wecom-{dept_id}"
        team_ids.append(team_id)
        if preview:
            continue
        conn.execute(
            """
            insert into teams(id,name,dept,wecom_department_id,parent_wecom_department_id,manager_ids)
            values(?,?,?,?,?,?)
            on conflict(id) do update set
                name = excluded.name,
                dept = excluded.dept,
                wecom_department_id = excluded.wecom_department_id,
                parent_wecom_department_id = excluded.parent_wecom_department_id
            """,
            (
                team_id,
                str(dept.get("name") or f"企微部门 {dept_id}"),
                "销售部",
                str(dept_id),
                str(dept.get("parentid") or ""),
                "[]",
            ),
        )
    mappings = [
        normalize_mapping(row)
        for row in rowsdict(
            conn.execute("select * from role_mappings where active = 1 order by priority asc, created_at asc").fetchall()
        )
    ]
    existing_by_wecom = {
        row["wecom_userid"]: row
        for row in rowsdict(conn.execute("select * from users where wecom_userid is not null and wecom_userid != ''").fetchall())
    }
    existing_by_username = {
        row["username"]: row
        for row in rowsdict(conn.execute("select * from users where username is not null and username != ''").fetchall())
    }
    added: list[str] = []
    updated: list[str] = []
    disabled: list[str] = []
    synced_userids = {member["userid"] for member in members}
    for member in members:
        team_id = f"wecom-{member['primary_department_id']}"
        role, managed_team_ids = role_for_wecom_member(member, team_id, team_ids, mappings)
        current = existing_by_wecom.get(member["userid"]) or existing_by_username.get(member["userid"])
        if preview:
            (updated if current else added).append(member["name"])
            continue
        if current:
            conn.execute(
                """
                update users
                set username = ?, name = ?, email = ?, mobile = ?, dept = ?, role = ?, team_id = ?,
                    managed_team_ids = ?, status = ?, source = 'wecom', wecom_userid = ?, updated_at = ?
                where id = ?
                """,
                (
                    member["userid"],
                    member["name"],
                    member["email"],
                    member["mobile"],
                    departments.get(member["primary_department_id"], {}).get("name") or "销售部",
                    role,
                    team_id,
                    json.dumps(managed_team_ids, ensure_ascii=False),
                    "active",
                    member["userid"],
                    timestamp,
                    current["id"],
                ),
            )
            updated.append(member["name"])
        else:
            user_id = f"wecom:{member['userid']}"
            conn.execute(
                """
                insert into users(
                    id,username,name,email,mobile,dept,role,team_id,managed_team_ids,status,source,wecom_userid,
                    password_hash,must_change_password,failed_login_count,last_active_at,last_login_at,created_at,updated_at
                )
                values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    user_id,
                    member["userid"],
                    member["name"],
                    member["email"],
                    member["mobile"],
                    departments.get(member["primary_department_id"], {}).get("name") or "销售部",
                    role,
                    team_id,
                    json.dumps(managed_team_ids, ensure_ascii=False),
                    "active",
                    "wecom",
                    member["userid"],
                    hash_password(initial_password()),
                    1,
                    0,
                    timestamp,
                    None,
                    timestamp,
                    timestamp,
                ),
            )
            added.append(member["name"])
    stale_rows = rowsdict(
        conn.execute(
            "select * from users where source = 'wecom' and status = 'active' and wecom_userid is not null and wecom_userid != ''"
        ).fetchall()
    )
    for row in stale_rows:
        if row["wecom_userid"] in synced_userids:
            continue
        disabled.append(row["name"])
        if not preview:
            conn.execute(
                "update users set status = 'disabled', updated_at = ? where id = ?",
                (timestamp, row["id"]),
            )
            conn.execute("delete from sessions where user_id = ?", (row["id"],))
    if not preview:
        for team_id in team_ids:
            managers = [
                row["id"]
                for row in rowsdict(
                    conn.execute(
                        "select id, managed_team_ids from users where role = 'manager' and status = 'active'"
                    ).fetchall()
                )
                if team_id in safe_json(row.get("managed_team_ids"), [])
            ]
            conn.execute("update teams set manager_ids = ? where id = ?", (json.dumps(managers, ensure_ascii=False), team_id))
        audit(conn, actor, "wecom.sync", f"同步企业微信销售团队：新增 {len(added)}，更新 {len(updated)}，禁用 {len(disabled)}。")
    return {
        "preview": preview,
        "added": added,
        "updated": updated,
        "disabled": disabled,
        "added_count": len(added),
        "updated_count": len(updated),
        "disabled_count": len(disabled),
        "team_count": len(team_ids),
        "initial_password": initial_password() if not preview else None,
    }


@app.get("/api/wecom/config")
def get_wecom_config(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    with db() as conn:
        return wecom_config(conn)


@app.patch("/api/wecom/config")
def patch_wecom_config(payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    with db() as conn:
        if "corp_id" in payload:
            set_setting(conn, "wecom_corp_id", str(payload.get("corp_id") or "").strip())
        if "secret" in payload and str(payload.get("secret") or "").strip():
            set_setting(conn, "wecom_secret", str(payload.get("secret") or "").strip())
        if "sales_department_id" in payload:
            set_setting(conn, "wecom_sales_department_id", str(payload.get("sales_department_id") or "").strip())
        audit(conn, user, "wecom.config", f"{user['name']} 修改企业微信同步配置。")
        return wecom_config(conn)


@app.get("/api/wecom/role-mappings")
def get_role_mappings(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    require_admin(user)
    with db() as conn:
        return [
            normalize_mapping(row)
            for row in rowsdict(conn.execute("select * from role_mappings order by priority asc, created_at asc").fetchall())
        ]


@app.post("/api/wecom/role-mappings")
def create_role_mapping(payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    match_type = str(payload.get("match_type") or "").strip()
    match_value = str(payload.get("match_value") or "").strip()
    role = str(payload.get("role") or "member").strip()
    if match_type not in {"wecom_userid", "name", "mobile", "department_id", "team_id", "local_username"}:
        raise HTTPException(status_code=400, detail="invalid match type")
    if role not in {"admin", "manager", "member"}:
        raise HTTPException(status_code=400, detail="invalid role")
    if not match_value:
        raise HTTPException(status_code=400, detail="match value is required")
    mapping_id = str(uuid.uuid4())
    timestamp = now()
    managed_team_ids = payload.get("managed_team_ids") or []
    if not isinstance(managed_team_ids, list):
        raise HTTPException(status_code=400, detail="managed_team_ids must be a list")
    with db() as conn:
        conn.execute(
            """
            insert into role_mappings(id,match_type,match_value,role,managed_team_ids,active,priority,created_at,updated_at)
            values(?,?,?,?,?,?,?,?,?)
            """,
            (
                mapping_id,
                match_type,
                match_value,
                role,
                json.dumps(managed_team_ids, ensure_ascii=False),
                1 if payload.get("active", True) else 0,
                int(payload.get("priority") or 100),
                timestamp,
                timestamp,
            ),
        )
        audit(conn, user, "wecom.role", f"{user['name']} 新增角色映射：{match_type}={match_value} -> {role}。")
        row = rowdict(conn.execute("select * from role_mappings where id = ?", (mapping_id,)).fetchone())
    return normalize_mapping(row)


@app.patch("/api/wecom/role-mappings/{mapping_id}")
def patch_role_mapping(mapping_id: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    allowed = {"match_type", "match_value", "role", "managed_team_ids", "active", "priority"}
    updates = {key: payload[key] for key in allowed if key in payload}
    if not updates:
        raise HTTPException(status_code=400, detail="no supported mapping fields")
    if "match_type" in updates and updates["match_type"] not in {"wecom_userid", "name", "mobile", "department_id", "team_id", "local_username"}:
        raise HTTPException(status_code=400, detail="invalid match type")
    if "role" in updates and updates["role"] not in {"admin", "manager", "member"}:
        raise HTTPException(status_code=400, detail="invalid role")
    if "managed_team_ids" in updates:
        if not isinstance(updates["managed_team_ids"], list):
            raise HTTPException(status_code=400, detail="managed_team_ids must be a list")
        updates["managed_team_ids"] = json.dumps(updates["managed_team_ids"], ensure_ascii=False)
    if "active" in updates:
        updates["active"] = 1 if updates["active"] else 0
    updates["updated_at"] = now()
    with db() as conn:
        current = rowdict(conn.execute("select * from role_mappings where id = ?", (mapping_id,)).fetchone())
        if not current:
            raise HTTPException(status_code=404, detail="role mapping not found")
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"update role_mappings set {assignments} where id = ?", (*updates.values(), mapping_id))
        audit(conn, user, "wecom.role", f"{user['name']} 修改角色映射：{current['match_value']}。")
        changed = rowdict(conn.execute("select * from role_mappings where id = ?", (mapping_id,)).fetchone())
    return normalize_mapping(changed)


@app.delete("/api/wecom/role-mappings/{mapping_id}")
def delete_role_mapping(mapping_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_admin(user)
    with db() as conn:
        current = rowdict(conn.execute("select * from role_mappings where id = ?", (mapping_id,)).fetchone())
        if not current:
            raise HTTPException(status_code=404, detail="role mapping not found")
        conn.execute("delete from role_mappings where id = ?", (mapping_id,))
        audit(conn, user, "wecom.role", f"{user['name']} 删除角色映射：{current['match_value']}。")
    return {"ok": True}


@app.post("/api/wecom/sync")
def sync_wecom(payload: dict[str, Any] | None = None, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    with db() as conn:
        return sync_wecom_users(conn, user, preview=bool((payload or {}).get("preview")))


@app.get("/api/recordings")
def recordings(
    scope: str = "mine",
    q: str = "",
    meeting_type: str = "",
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    where, args = recording_filter_where(user, scope, q, meeting_type)
    with db() as conn:
        rows = conn.execute(
            f"""
            select recordings.* from recordings
            left join users on users.id = recordings.owner_id
            where {where}
            order by recordings.updated_at desc
            """,
            args,
        ).fetchall()
        return [recording_payload(conn, dict(row)) for row in rows]


@app.post("/api/recordings")
def upload_recording(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form(...),
    meeting_type: str = Form("内部会议"),
    tag: str = Form(""),
    auto_process: bool = Form(True),
    expected_speakers: int | None = Form(None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return create_recording(
        background_tasks, file, title, meeting_type, tag, auto_process,
        expected_speakers, user,
    )


def create_recording(
    background_tasks: BackgroundTasks, file: UploadFile, title: str,
    meeting_type: str, tag: str, auto_process: bool,
    expected_speakers: int | None, user: dict[str, Any],
) -> dict[str, Any]:
    """Shared recording business service. Caller must authenticate its principal."""
    if user["role"] == "admin":
        raise HTTPException(status_code=403, detail="admin cannot upload recordings")
    rec_id = str(uuid.uuid4())
    ext = Path(file.filename or "recording.mp3").suffix or ".mp3"
    target = RECORDINGS / f"{rec_id}{ext}"
    max_mb = env_int("NEWVOICE_UPLOAD_MAX_MB", 2048, 16, 16384)
    max_bytes = max_mb * 1024 * 1024
    chunk_size = 1024 * 1024  # 1 MB
    written = 0
    try:
        with target.open("wb") as out:
            while True:
                chunk = file.file.read(chunk_size)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    out.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"upload exceeds {max_mb} MB limit (NEWVOICE_UPLOAD_MAX_MB)",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except Exception:
        target.unlink(missing_ok=True)
        raise
    if written == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="uploaded file is empty")
    try:
        duration = probe_duration(target)
        with db() as conn:
            conn.execute(
                """
                insert into recordings(id,title,filename,file_path,meeting_type,tag,owner_id,team_id,duration,duration_label,asr_status,summary_status,expected_speakers,created_at,updated_at)
                values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    rec_id,
                    title.strip() or Path(file.filename or "录音").stem,
                    file.filename or target.name,
                    str(target),
                    meeting_type,
                    tag,
                    user["id"],
                    user.get("team_id"),
                    duration,
                    seconds_label(duration),
                    "queued" if auto_process else "pending",
                    "pending",
                    (expected_speakers if (expected_speakers and 2 <= expected_speakers <= 50) else None),
                    now(),
                    now(),
                ),
            )
            audit(conn, user, "recording", f"上传录音：{title.strip() or file.filename}。")
            rec = rowdict(conn.execute("select * from recordings where id = ?", (rec_id,)).fetchone())
            payload = recording_payload(conn, rec)
            if auto_process:
                voice_integration.enqueue(rec_id, user['id'], connection=conn)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return payload


@app.post("/api/recordings/{recording_id}/process")
def process_api(
    recording_id: str,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if rec["asr_status"] == "running" or rec["summary_status"] == "running":
            raise HTTPException(status_code=409, detail="recording is already processing")
        audit(conn, user, "recording.process", f"{user['name']} 启动完整处理：{rec['title']}。")
    voice_integration.enqueue(recording_id, user['id'], reset=True)
    return {"recording_id": recording_id, "status": "queued"}


@app.get("/api/recordings/{recording_id}")
def recording_detail(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        rec_payload = recording_payload(conn, rec)
        segments = rowsdict(
            conn.execute(
                "select * from transcript_segments where recording_id = ? order by start_sec",
                (recording_id,),
            ).fetchall()
        )
        summary = rowdict(
            conn.execute(
                """
                select * from summaries
                where recording_id = ?
                order by is_current desc, version desc, created_at desc
                limit 1
                """,
                (recording_id,),
            ).fetchone()
        )
        summaries = rowsdict(
            conn.execute(
                """
                select id, recording_id, content, model, created_at, version, instruction, base_summary_id, is_current, length(content) as content_length
                from summaries
                where recording_id = ?
                order by version desc, created_at desc
                """,
                (recording_id,),
            ).fetchall()
        )
        emotion = current_emotion_analysis(conn, recording_id)
        tasks = [
            task_payload(dict(row), rec["duration"])
            for row in conn.execute(
                "select * from tasks where recording_id = ? order by datetime(created_at)",
                (recording_id,),
            ).fetchall()
        ]
        hotword_package = latest_hotword_package(conn, recording_id)
        outputs = []
        if segments:
            outputs.append(
                {
                    "id": "transcript",
                    "kind": "transcript",
                    "title": "逐字稿",
                    "format": "Markdown",
                    "status": rec["asr_status"],
                    "download_url": f"/api/recordings/{recording_id}/export/transcript.md",
                    "segment_count": len(segments),
                    "speaker_count": len({row.get("speaker_name") or row.get("speaker") for row in segments}),
                }
            )
        if summary:
            outputs.append(
                {
                    "id": summary["id"],
                    "kind": "summary",
                    "title": f"会议纪要 v{summary.get('version') or 1}",
                    "format": "Markdown",
                    "status": rec["summary_status"],
                    "download_url": f"/api/recordings/{recording_id}/export/summary.md",
                    "model": summary["model"],
                    "created_at": summary["created_at"],
                    "version": summary.get("version") or 1,
                }
            )
        if emotion:
            outputs.append(
                {
                    "id": emotion["id"],
                    "kind": "emotion",
                    "title": f"对话情绪分析 v{emotion.get('version') or 1}",
                    "format": "Markdown",
                    "status": "done",
                    "download_url": f"/api/recordings/{recording_id}/export/emotion.md",
                    "model": emotion["model"],
                    "created_at": emotion["created_at"],
                    "version": emotion.get("version") or 1,
                }
            )
        return {
            "recording": rec_payload,
            "segments": segments,
            "summary": summary,
            "summaries": summaries,
            "emotion_analysis": emotion,
            "tasks": tasks,
            "outputs": outputs,
            "hotword_package": hotword_package,
            # Compatibility for browser tabs that loaded the pre-removal
            # frontend bundle. That bundle dereferences crm_sync.synced_at
            # while rendering a recording detail page. Keep this inert,
            # read-only shape until those tabs have naturally refreshed; no
            # CRM configuration, search, sync, or write route is restored.
            "crm_sync": {
                "status": "not_configured",
                "error": None,
                "synced_at": None,
                "recording_id": None,
                "minute_id": None,
                "recording_url": None,
                "minute_url": None,
                "emotion_id": None,
                "emotion_url": None,
                "relation_status": None,
                "relation_source": None,
                "relation_confidence": None,
                "relation_target_type": None,
                "relation_target_id": None,
                "relation_target_name": None,
                "selected": None,
                "candidates": [],
            },
        }


@app.get("/api/recordings/{recording_id}/audio")
def recording_audio(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
    return FileResponse(Path(rec["file_path"]), filename=rec["filename"])


@app.post("/api/recordings/{recording_id}/transcribe")
def transcribe_api(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    job_id=voice_integration.enqueue(recording_id,user['id'],'transcribe_only')
    return {'recording_id':recording_id,'job_id':job_id,'status':'queued'}


@app.post("/api/recordings/{recording_id}/summarize")
async def summarize_api(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    job_id=voice_integration.enqueue(recording_id,user['id'],'summary_only')
    return {'recording_id':recording_id,'job_id':job_id,'status':'queued'}


@app.post("/api/recordings/{recording_id}/summary/revise")
async def revise_summary_api(recording_id: str, payload: dict[str, str], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await revise_summary(recording_id, payload.get("instruction") or "", user)


@app.get("/api/recordings/{recording_id}/export/transcript.md")
def export_transcript(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    path = write_export(recording_id, "transcript", user)
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


@app.get("/api/recordings/{recording_id}/export/summary.md")
def export_summary(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    path = write_export(recording_id, "summary", user)
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


@app.get("/api/recordings/{recording_id}/export/summaries/{summary_id}.md")
def export_summary_version(recording_id: str, summary_id: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    path = write_summary_export(recording_id, summary_id, user)
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


@app.post("/api/recordings/{recording_id}/emotion")
def emotion_api(
    recording_id: str,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if rec["asr_status"] != "done":
            raise HTTPException(status_code=409, detail="转写完成后才能做情绪分析")
        count = conn.execute(
            "select count(*) from transcript_segments where recording_id = ?",
            (recording_id,),
        ).fetchone()[0]
        if not count:
            raise HTTPException(status_code=409, detail="转写为空")
    background_tasks.add_task(run_emotion_job, recording_id, dict(user))
    return {"status": "started", "recording_id": recording_id}


@app.get("/api/recordings/{recording_id}/export/emotion.md")
def export_emotion(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    path = write_export(recording_id, "emotion", user)
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


def normalize_hotword(row: dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    payload["active"] = bool(payload.get("active"))
    payload["protected"] = bool(payload.get("protected"))
    payload["frequency"] = int(payload.get("frequency") or 0)
    payload["weight"] = int(payload.get("weight") or 0)
    payload["score"] = round(float(payload.get("score") or hotword_row_score(payload)), 1)
    return payload


@app.get("/api/hotwords")
def hotwords(
    state: str = "",
    q: str = "",
    protected: str = "",
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    with db() as conn:
        where = ["1=1"]
        args: list[Any] = []
        # 普通成员只能看到非个人热词 + 自己的个人手填热词;manager/admin 看全库(供热词总览页)。
        if user["role"] not in {"manager", "admin"}:
            where.append("(coalesce(scope, '') != 'personal' or owner_id = ?)")
            args.append(user["id"])
        if state:
            where.append("coalesce(state, 'active') = ?")
            args.append(state)
        if protected in {"0", "1"}:
            where.append("protected = ?")
            args.append(int(protected))
        if q:
            where.append("(word like ? or aliases like ? or source like ? or kind like ?)")
            like = f"%{q}%"
            args.extend([like, like, like, like])
        rows = conn.execute(
            f"""
            select * from hotwords
            where {' and '.join(where)}
            order by protected desc, active desc, score desc, weight desc, word
            limit 1000
            """,
            args,
        ).fetchall()
        return [normalize_hotword(dict(row)) for row in rows]


# ---------------------------------------------------------------------------
# 个人手填热词 —— 对齐 aham-voice 开源版的「一个大文本框」体验。
# 多用户语义：个人热词按 owner_id 作用域（每个用户独立一套），不触碰外部同步热词。
# 同步进来的热词(其它 source)。前端富文本框用顿号「、」分隔,GET words 与 PUT
# 的读写范围保持一致,保证无损 round-trip。
# ---------------------------------------------------------------------------
HOTWORD_WORD_PATTERN = re.compile(r"^[一-鿿A-Za-z0-9]+$")


@app.get("/api/hotwords/words")
def hotword_words(user: dict[str, Any] = Depends(current_user)) -> list[str]:
    """返回当前用户的全部个人热词(source='manual' 且 owner_id=本人),无分页,按词排序。"""
    with db() as conn:
        rows = conn.execute(
            "select word from hotwords where source = 'manual' and owner_id = ? order by word",
            (user["id"],),
        ).fetchall()
        return [row[0] for row in rows]


@app.post("/api/hotwords")
def create_hotword(payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """手动新增一条个人热词(归属当前用户)。"""
    word = (payload.get("word") or "").strip()
    if not word:
        raise HTTPException(status_code=400, detail="word is required")
    if not HOTWORD_WORD_PATTERN.match(word):
        raise HTTPException(status_code=400, detail=f"热词「{word}」含有不允许的符号，只能是中文/字母/数字")
    kind = (payload.get("kind") or "术语").strip() or "术语"
    aliases = (payload.get("aliases") or "").strip()
    weight = max(1, min(int(payload.get("weight") or 8), 10))
    ts = now()
    with db() as conn:
        if conn.execute(
            "select 1 from hotwords where word = ? and source = 'manual' and owner_id = ?",
            (word, user["id"]),
        ).fetchone():
            raise HTTPException(status_code=409, detail="热词已存在")
        hid = str(uuid.uuid4())
        conn.execute(
            """
            insert into hotwords(
                id,word,kind,aliases,source,scope,weight,active,state,protected,
                frequency,confidence,score,owner_id,first_seen_at,last_seen_at,updated_at
            )
            values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (hid, word, kind, aliases, "manual", "personal", weight, 1, "active", 1,
             1, 0.95, 0, user["id"], ts, ts, ts),
        )
        row = rowdict(conn.execute("select * from hotwords where id = ?", (hid,)).fetchone())
        conn.execute("update hotwords set score = ? where id = ?", (hotword_row_score(row), hid))
        audit(conn, user, "hotword.create", f"{user['name']} 新增热词：{word}。")
        row = rowdict(conn.execute("select * from hotwords where id = ?", (hid,)).fetchone())
        return normalize_hotword(row)


@app.put("/api/hotwords")
def save_all_hotwords(payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """全量覆盖当前用户的个人热词(只删/建 owner_id=本人 且 source='manual' 的行,
    团队及外部同步热词不受影响)。"""
    raw_words = payload.get("words")
    if not isinstance(raw_words, list):
        raise HTTPException(status_code=400, detail="words 必须是字符串数组")
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in raw_words:
        if not isinstance(raw, str):
            raise HTTPException(status_code=400, detail="words 中每一项都必须是字符串")
        word = raw.strip()
        if not word:
            raise HTTPException(status_code=400, detail="热词不能为空")
        if not HOTWORD_WORD_PATTERN.match(word):
            raise HTTPException(status_code=400, detail=f"热词「{word}」含有不允许的符号，只能是中文/字母/数字")
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(word)
    words = sorted(cleaned)
    ts = now()
    with db() as conn:
        conn.execute("delete from hotwords where source = 'manual' and owner_id = ?", (user["id"],))
        for word in words:
            hid = str(uuid.uuid4())
            score = hotword_row_score({
                "score": 0, "weight": 8, "kind": "术语", "source": "manual",
                "protected": 1, "frequency": 1, "last_seen_at": ts,
            })
            conn.execute(
                """
                insert into hotwords(
                    id,word,kind,aliases,source,scope,weight,active,state,protected,
                    frequency,confidence,score,owner_id,first_seen_at,last_seen_at,updated_at
                )
                values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (hid, word, "术语", "", "manual", "personal", 8, 1, "active", 1,
                 1, 0.95, score, user["id"], ts, ts, ts),
            )
        audit(conn, user, "hotword.save_all", f"{user['name']} 全量保存个人热词：共 {len(words)} 条。")
    return {"ok": True, "count": len(words), "words": words}


@app.delete("/api/hotwords/{hotword_id}")
def delete_hotword(hotword_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """删除热词:本人可删自己的个人热词;manager/admin 可删任意。"""
    with db() as conn:
        row = rowdict(conn.execute("select * from hotwords where id = ?", (hotword_id,)).fetchone())
        if not row:
            raise HTTPException(status_code=404, detail="hotword not found")
        is_own_manual = row.get("source") == "manual" and row.get("owner_id") == user["id"]
        if not is_own_manual and user["role"] not in {"manager", "admin"}:
            raise HTTPException(status_code=403, detail="无权删除该热词")
        conn.execute("delete from hotwords where id = ?", (hotword_id,))
        audit(conn, user, "hotword.delete", f"{user['name']} 删除热词：{row['word']}。")
        return {"ok": True, "id": hotword_id}


@app.patch("/api/hotwords/{hotword_id}")
def patch_hotword(hotword_id: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["role"] not in {"manager", "admin"}:
        raise HTTPException(status_code=403, detail="manager or admin only")
    allowed = {"kind", "aliases", "scope", "weight", "active", "state", "protected"}
    updates = {key: payload[key] for key in allowed if key in payload}
    if not updates:
        raise HTTPException(status_code=400, detail="no supported hotword fields")
    if "active" in updates:
        updates["active"] = 1 if updates["active"] else 0
    if "protected" in updates:
        updates["protected"] = 1 if updates["protected"] else 0
    if "weight" in updates:
        updates["weight"] = max(1, min(int(updates["weight"]), 10))
    with db() as conn:
        row = rowdict(conn.execute("select * from hotwords where id = ?", (hotword_id,)).fetchone())
        if not row:
            raise HTTPException(status_code=404, detail="hotword not found")
        next_protected = bool(updates["protected"]) if "protected" in updates else bool(row.get("protected"))
        if next_protected:
            updates["state"] = "active"
            updates["active"] = 1
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"update hotwords set {assignments}, updated_at = ? where id = ?", (*updates.values(), now(), hotword_id))
        changed = rowdict(conn.execute("select * from hotwords where id = ?", (hotword_id,)).fetchone())
        conn.execute(
            "update hotwords set score = ? where id = ?",
            (hotword_row_score(changed), hotword_id),
        )
        audit(conn, user, "hotword.update", f"{user['name']} 修改热词：{row['word']}。")
        changed = rowdict(conn.execute("select * from hotwords where id = ?", (hotword_id,)).fetchone())
        return normalize_hotword(changed)


@app.get("/api/voiceprints")
def voiceprints(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    if user["role"] == "admin":
        where, args = "1=1", []
    elif user["role"] == "manager":
        team_ids = managed_team_ids(user)
        placeholders = ",".join("?" for _ in team_ids) or "?"
        where, args = f"(scope = 'global' or owner_id = ? or team_id in ({placeholders}))", [user["id"], *(team_ids or ["__none__"])]
    else:
        where, args = "(scope = 'global' or owner_id = ? or team_id = ?)", [user["id"], user.get("team_id")]
    with db() as conn:
        return [
            normalize_profile(row)
            for row in rowsdict(
                conn.execute(
                    f"select id,name,note,owner_id,team_id,scope,threshold,active,created_at from speaker_profiles where {where} order by created_at desc",
                    args,
                ).fetchall()
            )
        ]


def resolve_voiceprint_scope(user: dict[str, Any], scope: str = "", team_id: str = "") -> tuple[str, str | None]:
    requested_scope = scope or ("global" if user["role"] == "admin" else "team" if user["role"] == "manager" else "personal")
    if requested_scope not in {"personal", "team", "global"}:
        raise HTTPException(status_code=400, detail="invalid voiceprint scope")
    if user["role"] == "member" and requested_scope != "personal":
        raise HTTPException(status_code=403, detail="members can only create personal voiceprints")
    if user["role"] == "manager" and requested_scope == "global":
        raise HTTPException(status_code=403, detail="managers cannot create global voiceprints")
    if user["role"] == "admin" and requested_scope == "personal":
        raise HTTPException(status_code=403, detail="admins can create team or global voiceprints")
    profile_team_id = None
    if requested_scope == "team":
        profile_team_id = team_id or user.get("team_id")
        mtids = managed_team_ids(user)
        if not profile_team_id:
            # 没有可归属的团队（如经理/管理员未分配固定团队）→ 退化为全团队共享(global)，
            # 全员可见，而不是报错卡住。这是「声纹默认全团队共享」的兜底。
            return "global", None
        if user["role"] == "manager" and "*" not in mtids and profile_team_id not in mtids:
            raise HTTPException(status_code=403, detail="team is outside manager scope")
    return requested_scope, profile_team_id


def segment_quality(row: dict[str, Any]) -> str:
    duration = max(0.0, float(row.get("end_sec") or 0) - float(row.get("start_sec") or 0))
    text = str(row.get("text") or "").strip()
    if 5 <= duration <= 40 and len(text) >= 8:
        return "good"
    if duration >= 2.0 and len(text) >= 4:
        return "usable"
    return "short"


def candidate_sample_rows(rows: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    rank = {"good": 3, "usable": 2, "short": 1}
    sorted_rows = sorted(
        rows,
        key=lambda row: (
            rank.get(segment_quality(row), 0),
            min(float(row.get("end_sec") or 0) - float(row.get("start_sec") or 0), 18.0),
            len(str(row.get("text") or "")),
        ),
        reverse=True,
    )
    return sorted_rows[:limit]


def speaker_candidate_payload(speaker: str, rows: list[dict[str, Any]], recording_id: str) -> dict[str, Any]:
    total = sum(max(0.0, float(row["end_sec"]) - float(row["start_sec"])) for row in rows)
    named = [row for row in rows if row.get("speaker_name")]
    voiceprinted = [row for row in rows if row.get("voiceprint_id")]
    samples = []
    for row in candidate_sample_rows(rows):
        duration = max(0.0, float(row["end_sec"]) - float(row["start_sec"]))
        samples.append(
            {
                "id": row["id"],
                "recording_id": recording_id,
                "speaker": speaker,
                "start_sec": row["start_sec"],
                "end_sec": row["end_sec"],
                "start_label": row["start_label"],
                "duration": duration,
                "duration_label": seconds_label(duration),
                "text": row["text"],
                "quality": segment_quality(row),
                "audio_url": f"/api/recordings/{recording_id}/segments/{row['id']}/audio",
            }
        )
    return {
        "speaker": speaker,
        "display_name": named[0]["speaker_name"] if named else f"Speaker {speaker}",
        "speaker_name": named[0]["speaker_name"] if named else None,
        "voiceprint_id": voiceprinted[0]["voiceprint_id"] if voiceprinted else None,
        "segment_count": len(rows),
        "total_duration": total,
        "total_duration_label": seconds_label(total),
        "sample_segments": samples,
    }


@app.get("/api/recordings/{recording_id}/speaker-candidates")
def recording_speaker_candidates(recording_id: str, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    with db() as conn:
        can_access_recording(conn, recording_id, user)
        rows = rowsdict(
            conn.execute(
                "select * from transcript_segments where recording_id = ? order by start_sec",
                (recording_id,),
            ).fetchall()
        )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["speaker"]), []).append(row)
    return [
        speaker_candidate_payload(speaker, grouped[speaker], recording_id)
        for speaker in sorted(grouped, key=lambda value: (not str(value).isdigit(), int(value) if str(value).isdigit() else str(value)))
    ]


@app.get("/api/recordings/{recording_id}/segments/{segment_id}/audio")
def recording_segment_audio(recording_id: str, segment_id: str, user: dict[str, Any] = Depends(current_user)) -> FileResponse:
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        segment = rowdict(
            conn.execute(
                "select * from transcript_segments where id = ? and recording_id = ?",
                (segment_id, recording_id),
            ).fetchone()
        )
    if not segment:
        raise HTTPException(status_code=404, detail="segment not found")
    start = max(0.0, float(segment["start_sec"]) - 0.2)
    end = min(float(segment["end_sec"]) + 0.2, float(rec.get("duration") or segment["end_sec"]))
    target = TMP / f"segment_{recording_id}_{segment_id}.wav"
    extract_interval(Path(rec["file_path"]), target, start, end)
    return FileResponse(target, media_type="audio/wav", filename=f"{slug(rec['title'])}_{segment['start_label']}.wav")


@app.post("/api/voiceprints")
def create_voiceprint(
    name: str = Form(...),
    threshold: float | None = Form(None),
    scope: str = Form(""),
    team_id: str = Form(""),
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    requested_scope, profile_team_id = resolve_voiceprint_scope(user, scope, team_id)
    profile_id = str(uuid.uuid4())
    ext = Path(file.filename or "voiceprint.wav").suffix or ".wav"
    raw = TMP / f"{profile_id}{ext}"
    target = VOICEPRINTS / f"{profile_id}.wav"
    with raw.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    if probe_duration(raw) < 5:
        raw.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="voiceprint sample must be at least 5 seconds")
    subprocess.run(
        [
            str(FFMPEG),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(raw),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(target),
        ],
        check=True,
    )
    raw.unlink(missing_ok=True)
    profile_threshold = clamp_voiceprint_threshold(threshold)
    with db() as conn:
        conn.execute(
            """
            insert into speaker_profiles(id,name,owner_id,team_id,sample_path,threshold,active,created_at)
            values(?,?,?,?,?,?,1,?)
            """,
            (profile_id, name.strip(), user["id"], profile_team_id, str(target), profile_threshold, now()),
        )
        conn.execute("update speaker_profiles set scope = ? where id = ?", (requested_scope, profile_id))
        audit(conn, user, "voiceprint.create", f"{user['name']} 登记{requested_scope}声纹样本：{name.strip()}。")
        row = rowdict(conn.execute("select id,name,note,owner_id,team_id,scope,threshold,active,created_at from speaker_profiles where id = ?", (profile_id,)).fetchone())
    return normalize_profile(row)


def can_manage_voiceprint(profile: dict[str, Any], user: dict[str, Any]) -> bool:
    if user["role"] == "admin":
        # admin 是全公司视角,可管理全部声纹(含成员个人声纹),与 admin 列表可见性一致。
        return True
    if user["role"] == "manager":
        return profile.get("owner_id") == user["id"] or profile.get("team_id") in managed_team_ids(user)
    return profile.get("scope") == "personal" and profile.get("owner_id") == user["id"]


@app.post("/api/voiceprints/from-recording")
def create_voiceprint_from_recording(payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    recording_id = str(payload.get("recording_id") or "").strip()
    speaker = str(payload.get("speaker") or "").strip()
    if not recording_id or not speaker:
        raise HTTPException(status_code=400, detail="recording_id and speaker are required")
    raw_segment_ids = payload.get("segment_ids") or []
    segment_ids = [str(item) for item in raw_segment_ids if str(item).strip()]
    profile_id = str(payload.get("profile_id") or "").strip()
    update_current = bool(payload.get("update_current_recording", True))
    threshold = clamp_voiceprint_threshold(payload.get("threshold"))
    note = payload.get("note")
    note = str(note).strip() if note is not None else None

    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        existing_profile = None
        if profile_id:
            existing_profile = rowdict(conn.execute("select * from speaker_profiles where id = ?", (profile_id,)).fetchone())
            if not existing_profile:
                raise HTTPException(status_code=404, detail="voiceprint not found")
            existing_profile = normalize_profile(existing_profile)
            if not can_manage_voiceprint(existing_profile, user):
                raise HTTPException(status_code=403, detail="voiceprint is outside current permission scope")
            name = existing_profile["name"]
            requested_scope = existing_profile["scope"]
            profile_team_id = existing_profile.get("team_id")
            threshold = clamp_voiceprint_threshold(existing_profile.get("threshold") or threshold)
            if note is None:
                note = existing_profile.get("note")
        else:
            name = str(payload.get("name") or "").strip()
            if not name:
                raise HTTPException(status_code=400, detail="name is required")
            requested_scope, profile_team_id = resolve_voiceprint_scope(user, str(payload.get("scope") or ""), str(payload.get("team_id") or ""))
        # 取要建声纹的样本段：显式选段则用所选，否则自动挑代表片段。
        # 不做「<5s 仅命名」的降级——能建声纹的就建，建不了的由前端不让进入此流程
        # （不显示试听/命名建声纹入口）。
        if segment_ids:
            sel = set(segment_ids)
            rows = rowsdict(
                conn.execute(
                    "select * from transcript_segments where recording_id = ? and speaker = ? order by start_sec",
                    (recording_id, speaker),
                ).fetchall()
            )
            rows = [r for r in rows if r["id"] in sel]
        else:
            all_rows = rowsdict(
                conn.execute(
                    "select * from transcript_segments where recording_id = ? and speaker = ? order by start_sec",
                    (recording_id, speaker),
                ).fetchall()
            )
            rows = candidate_sample_rows(all_rows, limit=8)
        if not rows:
            raise HTTPException(status_code=404, detail="speaker segments not found")

    total_duration = sum(max(0.0, float(row["end_sec"]) - float(row["start_sec"])) for row in rows)
    if total_duration < 5:
        raise HTTPException(status_code=400, detail="selected voiceprint samples must be at least 5 seconds in total")

    final_profile_id = profile_id or str(uuid.uuid4())
    target = VOICEPRINTS / f"{final_profile_id}.wav"
    with tempfile.TemporaryDirectory(dir=TMP) as tmp:
        tmpdir = Path(tmp)
        parts: list[Path] = []
        if existing_profile and Path(existing_profile.get("sample_path") or "").exists():
            parts.append(Path(existing_profile["sample_path"]))
        for index, row in enumerate(rows):
            start = max(0.0, float(row["start_sec"]))
            end = min(float(row["end_sec"]), start + 20.0)
            part = tmpdir / f"sample_{index}.wav"
            extract_interval(Path(rec["file_path"]), part, start, end)
            parts.append(part)
        output = tmpdir / "voiceprint.wav" if existing_profile else target
        concat_audio(parts, output, tmpdir)
        if existing_profile:
            shutil.move(str(output), target)

    with db() as conn:
        if existing_profile:
            conn.execute(
                "update speaker_profiles set sample_path = ?, threshold = ?, note = ? where id = ?",
                (str(target), threshold, note, final_profile_id),
            )
        else:
            conn.execute(
                """
                insert into speaker_profiles(id,name,note,owner_id,team_id,scope,sample_path,threshold,active,created_at)
                values(?,?,?,?,?,?,?,?,1,?)
                """,
                (final_profile_id, name, note, user["id"], profile_team_id, requested_scope, str(target), threshold, now()),
            )
        conn.executemany(
            """
            insert into speaker_samples(id,profile_id,recording_id,segment_id,start_sec,end_sec,duration,text,created_by,created_at)
            values(?,?,?,?,?,?,?,?,?,?)
            """,
            [
                (
                    str(uuid.uuid4()),
                    final_profile_id,
                    recording_id,
                    row["id"],
                    row["start_sec"],
                    row["end_sec"],
                    max(0.0, float(row["end_sec"]) - float(row["start_sec"])),
                    row["text"],
                    user["id"],
                    now(),
                )
                for row in rows
            ],
        )
        updated_segments = 0
        if update_current:
            cursor = conn.execute(
                """
                update transcript_segments
                set speaker_name = ?, voiceprint_id = ?, speaker_confidence = null
                where recording_id = ? and speaker = ?
                """,
                (name, final_profile_id, recording_id, speaker),
            )
            updated_segments = cursor.rowcount
            conn.execute("update recordings set updated_at = ? where id = ?", (now(), recording_id))
        audit(
            conn,
            user,
            "voiceprint.create",
            f"{user['name']} 从录音《{rec['title']}》的 Speaker {speaker} 保存{name}声纹，样本 {len(rows)} 段。",
        )
        profile = rowdict(
            conn.execute(
                "select id,name,note,owner_id,team_id,scope,threshold,active,created_at from speaker_profiles where id = ?",
                (final_profile_id,),
            ).fetchone()
        )
    return {
        "profile": normalize_profile(profile),
        "sample_count": len(rows),
        "sample_duration": total_duration,
        "sample_duration_label": seconds_label(total_duration),
        "updated_segments": updated_segments,
    }


@app.patch("/api/recordings/{recording_id}/speakers/{speaker}")
def patch_recording_speaker(recording_id: str, speaker: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    profile_id = str(payload.get("voiceprint_id") or "").strip() or None
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        if profile_id:
            profile = rowdict(conn.execute("select * from speaker_profiles where id = ?", (profile_id,)).fetchone())
            if not profile:
                raise HTTPException(status_code=404, detail="voiceprint not found")
            profile = normalize_profile(profile)
            if not can_manage_voiceprint(profile, user):
                raise HTTPException(status_code=403, detail="voiceprint is outside current permission scope")
        cursor = conn.execute(
            """
            update transcript_segments
            set speaker_name = ?, voiceprint_id = coalesce(?, voiceprint_id), speaker_confidence = null
            where recording_id = ? and speaker = ?
            """,
            (name, profile_id, recording_id, speaker),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="speaker not found")
        conn.execute("update recordings set updated_at = ? where id = ?", (now(), recording_id))
        audit(conn, user, "voiceprint.assign", f"{user['name']} 将录音《{rec['title']}》的 Speaker {speaker} 标记为{name}。")
    return {"recording_id": recording_id, "speaker": speaker, "name": name, "updated_segments": cursor.rowcount}


@app.post("/api/recordings/{recording_id}/speakers/merge")
def merge_recording_speakers(recording_id: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """把过度聚类拆出来的多个 Speaker 合并成一个人：from 的所有段并入 into。"""
    src = str(payload.get("from") or "").strip()
    dst = str(payload.get("into") or "").strip()
    if not src or not dst:
        raise HTTPException(status_code=400, detail="from / into are required")
    if src == dst:
        raise HTTPException(status_code=400, detail="from and into must differ")
    with db() as conn:
        rec = can_access_recording(conn, recording_id, user)
        cursor = conn.execute(
            "update transcript_segments set speaker = ? where recording_id = ? and speaker = ?",
            (dst, recording_id, src),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="source speaker not found")
        # 若 into 已命名，把整簇统一成该姓名 / 声纹
        named = rowdict(
            conn.execute(
                """
                select speaker_name, voiceprint_id from transcript_segments
                where recording_id = ? and speaker = ? and speaker_name is not null and speaker_name != ''
                order by start_sec limit 1
                """,
                (recording_id, dst),
            ).fetchone()
        )
        if named and named.get("speaker_name"):
            conn.execute(
                "update transcript_segments set speaker_name = ?, voiceprint_id = coalesce(?, voiceprint_id) where recording_id = ? and speaker = ?",
                (named["speaker_name"], named.get("voiceprint_id"), recording_id, dst),
            )
        conn.execute("update recordings set updated_at = ? where id = ?", (now(), recording_id))
        audit(conn, user, "speaker.merge", f"{user['name']} 把录音《{rec['title']}》的 Speaker {src} 合并到 Speaker {dst}（{cursor.rowcount} 段）。")
    return {"recording_id": recording_id, "merged_from": src, "into": dst, "moved_segments": cursor.rowcount}


@app.patch("/api/voiceprints/{profile_id}")
def patch_voiceprint(profile_id: str, payload: dict[str, Any], user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    with db() as conn:
        profile = rowdict(conn.execute("select * from speaker_profiles where id = ?", (profile_id,)).fetchone())
        if not profile:
            raise HTTPException(status_code=404, detail="voiceprint not found")
        profile = normalize_profile(profile)
        if not can_manage_voiceprint(profile, user):
            raise HTTPException(status_code=403, detail="voiceprint is outside current permission scope")
        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = str(payload["name"]).strip()
        if "note" in payload:
            note = payload["note"]
            updates["note"] = str(note).strip() if note is not None else None
        if "threshold" in payload:
            updates["threshold"] = clamp_voiceprint_threshold(payload["threshold"])
        if "active" in payload:
            updates["active"] = 1 if payload["active"] else 0
        if not updates:
            raise HTTPException(status_code=400, detail="no supported voiceprint fields")
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"update speaker_profiles set {assignments} where id = ?", (*updates.values(), profile_id))
        audit(conn, user, "voiceprint.update", f"{user['name']} 修改声纹样本：{profile['name']}。")
        changed = rowdict(conn.execute("select id,name,note,owner_id,team_id,scope,threshold,active,created_at from speaker_profiles where id = ?", (profile_id,)).fetchone())
    return normalize_profile(changed)


@app.delete("/api/voiceprints/{profile_id}")
def delete_voiceprint(profile_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """硬删声纹:删 profile 行、级联 speaker_samples、删样本音频文件、把引用它的
    transcript_segments.voiceprint_id 置 NULL(保留 speaker_name 文本,逐字稿仍带标注)。
    走 can_manage_voiceprint 多用户作用域校验。"""
    with db() as conn:
        profile = rowdict(conn.execute("select * from speaker_profiles where id = ?", (profile_id,)).fetchone())
        if not profile:
            raise HTTPException(status_code=404, detail="voiceprint not found")
        profile = normalize_profile(profile)
        if not can_manage_voiceprint(profile, user):
            raise HTTPException(status_code=403, detail="voiceprint is outside current permission scope")
        sample_path = str(profile.get("sample_path") or "").strip()
        conn.execute("update transcript_segments set voiceprint_id = null where voiceprint_id = ?", (profile_id,))
        conn.execute("delete from speaker_samples where profile_id = ?", (profile_id,))
        conn.execute("delete from speaker_profiles where id = ?", (profile_id,))
        audit(conn, user, "voiceprint.delete", f"{user['name']} 删除声纹样本：{profile['name']}。")
    if sample_path:
        try:
            Path(sample_path).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True, "id": profile_id}


@app.get("/api/audit")
def audit_rows(
    category: str = "",
    q: str = "",
    from_date: str = Query("", alias="from"),
    to: str = "",
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    require_admin(user)
    filters: list[str] = []
    args: list[Any] = []
    if category:
        filters.append("category like ?")
        args.append(f"{category}%")
    if q.strip():
        like = f"%{q.strip()}%"
        filters.append("(actor_name like ? or message like ? or category like ?)")
        args.extend([like, like, like])
    if from_date:
        filters.append("created_at >= ?")
        args.append(from_date)
    if to:
        filters.append("created_at <= ?")
        args.append(to)
    where = f"where {' and '.join(filters)}" if filters else ""
    with db() as conn:
        return rowsdict(conn.execute(f"select * from audit {where} order by created_at desc limit 200", args).fetchall())


@app.get("/api/audit.csv")
def audit_csv(
    category: str = "",
    q: str = "",
    from_date: str = Query("", alias="from"),
    to: str = "",
    user: dict[str, Any] = Depends(current_user),
) -> PlainTextResponse:
    require_admin(user)
    filters: list[str] = []
    args: list[Any] = []
    if category:
        filters.append("category like ?")
        args.append(f"{category}%")
    if q.strip():
        like = f"%{q.strip()}%"
        filters.append("(actor_name like ? or message like ? or category like ?)")
        args.extend([like, like, like])
    if from_date:
        filters.append("created_at >= ?")
        args.append(from_date)
    if to:
        filters.append("created_at <= ?")
        args.append(to)
    where = f"where {' and '.join(filters)}" if filters else ""
    with db() as conn:
        rows = rowsdict(conn.execute(f"select created_at, actor_name, category, message from audit {where} order by created_at desc", args).fetchall())
    lines: list[list[str]] = [["created_at", "actor_name", "category", "message"]]
    lines.extend([[row["created_at"], row["actor_name"], row["category"], row["message"]] for row in rows])
    out = tempfile.NamedTemporaryFile("w+", newline="", encoding="utf-8", delete=False)
    writer = csv.writer(out)
    writer.writerows(lines)
    out.close()
    content = Path(out.name).read_text(encoding="utf-8")
    Path(out.name).unlink(missing_ok=True)
    return PlainTextResponse(content, media_type="text/csv; charset=utf-8")


@app.get("/api/system/status")
def system_status(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    _llm_status = get_llm_config()
    return {
        "base": str(BASE),
        "db": str(DB_PATH),
        "paraformer": PARAFORMER.exists(),
        "vad": VAD.exists(),
        "punc": PUNC.exists(),
        "voiceprint": CAMPLUS.exists(),
        "ffmpeg": FFMPEG.exists(),
        "deepseek_configured": bool(_llm_status[0]),
        "deepseek_model": _llm_status[2],
        "llm_configured": bool(_llm_status[0]),
        "llm_model": _llm_status[2],
        "llm_provider": get_llm_provider(),
        "segmentation": "fsmn-vad dynamic segmentation",
        "diarization": "cam++ speaker diarization",
    }


@app.get("/api/admin/overview")
def admin_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_admin(user)
    today = datetime.now().strftime("%Y-%m-%d")
    with db() as conn:
        active_users = conn.execute("select count(*) from users where status = 'active'").fetchone()[0]
        team_count = conn.execute("select count(*) from teams").fetchone()[0]
        today_seconds = conn.execute(
            "select coalesce(sum(duration), 0) from recordings where updated_at >= ? and asr_status = 'done'",
            (today,),
        ).fetchone()[0]
        storage_bytes = sum(path.stat().st_size for path in RECORDINGS.glob("*") if path.is_file())
        recent_audit = rowsdict(conn.execute("select * from audit order by created_at desc limit 4").fetchall())
    return {
        "active_users": active_users,
        "team_count": team_count,
        "today_processed_seconds": today_seconds,
        "today_processed_label": seconds_label(today_seconds),
        "storage_bytes": storage_bytes,
        "storage_label": f"{storage_bytes / 1024 / 1024:.1f} MB",
        "integrations": [
            {"name": "ASR", "description": "Paraformer + FSMN-VAD + CT-Punc + CAM++", "ok": PARAFORMER.exists() and VAD.exists() and PUNC.exists() and CAMPLUS.exists()},
            {"name": "云端大模型", "description": get_llm_config()[2], "ok": bool(get_llm_config()[0])},
        ],
        "recent_audit": recent_audit,
    }

# Register after the existing authentication and business services are defined.
from . import voice_integration
voice_integration.install(app)
