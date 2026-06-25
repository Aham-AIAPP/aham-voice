#!/usr/bin/env python3
"""
Orchisky Voice 内部版种子导入（幂等）。

把 scripts/internal_seed.json 里的**真实用户名**与**热词库**导入本机 sqlite。
- 不含任何密钥/密码：用户密码统一用 NEWVOICE_INITIAL_PASSWORD（默认 orchisky888888），
  must_change_password=1（首次登录强制改）；邮箱按 <username>@orchisky.cn 合成。
- 幂等：用户按 username、热词按 (word, owner) 去重，已存在则跳过；可反复运行。

用法：
    python3 scripts/seed_internal.py            # 导入
    python3 scripts/seed_internal.py --dry-run  # 只看会做什么，不写库

DB 路径与后端一致：$RECORDING_AI_HOME/app-data/newvoice.sqlite3
（RECORDING_AI_HOME 默认 ~/.cache/recording-ai；本机部署指向 AhamVoice 数据目录）。
"""
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(os.environ.get("RECORDING_AI_HOME", Path.home() / ".cache" / "recording-ai"))
DB_PATH = BASE / "app-data" / "newvoice.sqlite3"
SEED_PATH = Path(__file__).resolve().parent / "internal_seed.json"
DRY = "--dry-run" in sys.argv


def initial_password() -> str:
    return os.environ.get("NEWVOICE_INITIAL_PASSWORD", "orchisky888888")


def hash_password(password: str) -> str:
    # 与 backend/app/main.py 完全一致，保证种子用户能正常登录。
    salt = secrets.token_hex(16)
    rounds = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), rounds).hex()
    return f"pbkdf2_sha256${rounds}${salt}${digest}"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    if not DB_PATH.exists():
        print(f"✗ 找不到数据库：{DB_PATH}\n  先启动一次后端让它建表，或确认 RECORDING_AI_HOME 指向正确目录。")
        return 1
    seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # ---- 用户 ----
    pw_hash = hash_password(initial_password())
    u_added = u_skip = 0
    for u in seed["users"]:
        username = u["username"]
        exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if exists:
            u_skip += 1
            continue
        u_added += 1
        if DRY:
            print(f"  + 用户 {username}（{u['name']}/{u['role']}）")
            continue
        ts = now()
        conn.execute(
            """insert into users(
                 id,username,name,email,mobile,dept,role,team_id,managed_team_ids,status,source,wecom_userid,
                 password_hash,must_change_password,failed_login_count,last_active_at,last_login_at,created_at,updated_at)
               values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                f"local-{username}", username, u["name"], f"{username}@orchisky.cn", None,
                u.get("dept") or "销售部", u["role"], u.get("team_id"),
                json.dumps(u.get("managed_team_ids", []), ensure_ascii=False),
                "active", "local", None,
                pw_hash, 1, 0, ts, None, ts, ts,
            ),
        )

    # username -> id（含刚插入的）
    uid = {r["username"]: r["id"] for r in conn.execute("SELECT username,id FROM users")}

    # ---- 热词 ----（按 word+owner 去重）
    h_added = h_skip = 0
    for h in seed["hotwords"]:
        owner_id = uid.get(h["owner_username"]) if h.get("owner_username") else None
        if h.get("owner_username") and owner_id is None:
            h_skip += 1  # 主人不存在（理论上不会，用户已先导入）
            continue
        dup = conn.execute(
            "SELECT 1 FROM hotwords WHERE word = ? AND IFNULL(owner_id,'') = IFNULL(?, '')",
            (h["word"], owner_id),
        ).fetchone()
        if dup:
            h_skip += 1
            continue
        h_added += 1
        if DRY:
            continue
        ts = now()
        conn.execute(
            """insert into hotwords(
                 id,word,kind,aliases,source,scope,weight,active,source_key,state,protected,
                 frequency,confidence,score,team_id,owner_id,first_seen_at,last_seen_at,last_used_at,expires_at,hit_count,updated_at)
               values(?,?,?,?,?,?,?,1,NULL,'active',0,1,0.75,0,?,?,?,?,NULL,NULL,0,?)""",
            (
                str(uuid.uuid4()), h["word"], h.get("kind") or "术语",
                ",".join(h.get("aliases") or []), "manual", h.get("scope") or "personal",
                int(h.get("weight") or 8), h.get("team_id"), owner_id, ts, ts, ts,
            ),
        )

    if not DRY:
        conn.commit()
    conn.close()
    tag = "[dry-run] " if DRY else ""
    print(f"{tag}用户：新增 {u_added}，跳过(已存在) {u_skip}")
    print(f"{tag}热词：新增 {h_added}，跳过(已存在) {h_skip}")
    print(f"{tag}完成。密码=NEWVOICE_INITIAL_PASSWORD（默认 orchisky888888），首登强制改。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
