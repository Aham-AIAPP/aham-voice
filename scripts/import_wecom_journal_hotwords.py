"""Sync hotwords from WeCom (企业微信) work journals (工作汇报).

Reads `wecom_corp_id`, `wecom_secret`, `wecom_sales_department_id` from the
local app_settings table (set via the admin UI), then walks the sales
department's journals over the lookback window, feeds the combined text to
DeepSeek, and upserts the extracted terms with source `企微日报-DeepSeek`.

Requires the WeCom self-built app to have OA "工作汇报" permissions enabled.
"""
from __future__ import annotations

import sys
import traceback
from datetime import datetime, timedelta
from typing import Any

import httpx

from _hotword_sync_lib import (
    call_deepseek_extract,
    common_argparser,
    count_for_source,
    db_conn,
    emit_json,
    load_env,
    log,
    upsert_hotwords,
    write_report,
)


WECOM_BASE = "https://qyapi.weixin.qq.com"
SOURCE_NAME = "企微日报-DeepSeek"
SOURCE_LABEL = "企业微信工作汇报"


def get_setting(conn, key: str) -> str:
    row = conn.execute("select value from app_settings where key = ?", (key,)).fetchone()
    return (row["value"] if row else "") or ""


def fetch_access_token(client: httpx.Client, corp_id: str, secret: str) -> str:
    res = client.get(
        f"{WECOM_BASE}/cgi-bin/gettoken",
        params={"corpid": corp_id, "corpsecret": secret},
    )
    res.raise_for_status()
    data = res.json()
    if data.get("errcode"):
        raise RuntimeError(f"gettoken: {data.get('errmsg')} (errcode={data.get('errcode')})")
    return data["access_token"]


def fetch_department_users(client: httpx.Client, token: str, dept_id: str) -> list[str]:
    res = client.get(
        f"{WECOM_BASE}/cgi-bin/user/simplelist",
        params={"access_token": token, "department_id": dept_id, "fetch_child": 1},
    )
    res.raise_for_status()
    data = res.json()
    if data.get("errcode"):
        raise RuntimeError(f"user/simplelist: {data.get('errmsg')} (errcode={data.get('errcode')})")
    return [str(u.get("userid")) for u in data.get("userlist", []) if u.get("userid")]


def fetch_journal_uuids(
    client: httpx.Client,
    token: str,
    starttime: int,
    endtime: int,
    creators: list[str],
    per_user_cap: int = 50,
) -> list[str]:
    """Walk getjournallist per creator (the API limits filters to a single creator)."""
    collected: list[str] = []
    for creator in creators:
        cursor = ""
        fetched = 0
        while fetched < per_user_cap:
            body: dict[str, Any] = {
                "starttime": starttime,
                "endtime": endtime,
                "cursor": cursor,
                "limit": min(100, per_user_cap - fetched),
                "filters": [{"key": "creator", "value": creator}],
            }
            try:
                res = client.post(
                    f"{WECOM_BASE}/cgi-bin/oa/getjournallist",
                    params={"access_token": token},
                    json=body,
                )
                res.raise_for_status()
                data = res.json()
            except Exception as exc:
                log(f"  {creator} getjournallist 失败：{exc}")
                break
            if data.get("errcode"):
                # 60011 = no permission; 60020 = ip not whitelisted; etc.
                log(f"  {creator}: errcode={data.get('errcode')} {data.get('errmsg')}")
                break
            items = data.get("journaluuid_list") or data.get("journal_uuid_list") or []
            page: list[str] = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                uid = item.get("journaluuid") or item.get("journal_uuid")
                if uid:
                    page.append(str(uid))
            collected.extend(page)
            fetched += len(page)
            cursor = data.get("next_cursor") or ""
            if not cursor or not page:
                break
    return collected


def _walk_text_nodes(node: Any, out: list[str]) -> None:
    """Recursively collect any reasonable text value found inside a journal node."""
    if isinstance(node, dict):
        for key in ("text", "content", "value", "title", "name", "summary"):
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                out.append(value.strip())
        for value in node.values():
            _walk_text_nodes(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk_text_nodes(value, out)


def fetch_journal_text(client: httpx.Client, token: str, uid: str) -> str:
    try:
        res = client.post(
            f"{WECOM_BASE}/cgi-bin/oa/getjournal_record_detail",
            params={"access_token": token},
            json={"journaluuid": uid},
        )
        res.raise_for_status()
        data = res.json()
    except Exception as exc:
        log(f"  journal {uid[:8]} 拉详情失败：{exc}")
        return ""
    if data.get("errcode"):
        return ""
    record = data.get("journal_record") or data.get("journal_detail") or {}
    parts: list[str] = []
    template_name = record.get("template_name") or record.get("name")
    if isinstance(template_name, str) and template_name.strip():
        parts.append(template_name.strip())
    _walk_text_nodes(record.get("apply_data") or {}, parts)
    deduped: list[str] = []
    seen: set[str] = set()
    for piece in parts:
        clean = piece.strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        deduped.append(clean)
    return "\n".join(deduped)


def main() -> int:
    load_env()
    parser = common_argparser("从企业微信工作汇报里抽取热词")
    args = parser.parse_args()
    lookback_days = args.lookback_days or 31
    starttime = int((datetime.now() - timedelta(days=lookback_days)).timestamp())
    endtime = int(datetime.now().timestamp())

    with db_conn() as conn:
        corp_id = get_setting(conn, "wecom_corp_id")
        secret = get_setting(conn, "wecom_secret")
        sales_dept = get_setting(conn, "wecom_sales_department_id")
    if not (corp_id and secret and sales_dept):
        raise RuntimeError(
            "企业微信配置缺失：请先在管理后台配置 CorpID / Secret / 销售部门 ID"
        )

    log(f"回看 {lookback_days} 天，部门 {sales_dept}")
    journal_uuids: list[str] = []
    creators: list[str] = []
    texts: list[str] = []
    with httpx.Client(timeout=60) as client:
        token = fetch_access_token(client, corp_id, secret)
        log("access_token OK")
        creators = fetch_department_users(client, token, sales_dept)
        log(f"销售部门成员 {len(creators)} 人")
        if creators:
            journal_uuids = fetch_journal_uuids(client, token, starttime, endtime, creators)
            log(f"日报 uuid {len(journal_uuids)} 条")
            journal_uuids = journal_uuids[:800]
            for idx, uid in enumerate(journal_uuids, 1):
                text = fetch_journal_text(client, token, uid)
                if text:
                    texts.append(text)
                if idx % 50 == 0:
                    log(f"  抓取进度 {idx}/{len(journal_uuids)}")

    combined = "\n\n".join(texts)
    log(f"汇总 {len(combined)} 字")

    extras = {
        "覆盖天数": lookback_days,
        "成员数": len(creators),
        "日报数": len(journal_uuids),
        "有效正文数": len(texts),
        "汇总字数": len(combined),
    }
    if not combined.strip():
        note = (
            "未抓取到任何日报正文。常见原因：销售部门下无成员、应用未开通"
            "「工作汇报」权限、时间窗内没有提交、或 IP 未加白名单。"
        )
        return _finish([], note, args, extras)

    candidates = call_deepseek_extract(
        combined, source_label=SOURCE_LABEL, max_terms=args.max_terms,
    )
    log(f"DeepSeek 抽取 {len(candidates)} 个候选词")
    return _finish(candidates, "", args, extras)


def _finish(
    candidates: list[dict[str, Any]],
    note: str,
    args,
    extras: dict[str, Any],
) -> int:
    with db_conn() as conn:
        counts = upsert_hotwords(conn, SOURCE_NAME, candidates, dry_run=args.dry_run)
        report_path = write_report(
            source_name=SOURCE_NAME,
            source_label=SOURCE_LABEL,
            candidates=candidates,
            counts=counts,
            dry_run=args.dry_run,
            extras=extras,
            note=note,
        )
        active, total = count_for_source(conn, SOURCE_NAME)
    result = {
        **counts,
        "expired": 0,
        "candidates": len(candidates),
        "active_total": active,
        "source_total": total,
        "report": str(report_path),
        "preview": args.dry_run,
    }
    if args.json:
        emit_json(result)
    else:
        log(f"完成：{result}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
