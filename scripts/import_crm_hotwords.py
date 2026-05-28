"""Sync hotwords for the "CRM-金蝶-DeepSeek" source.

Primary path: call NewCRM's `GET /api/external/kingdee/hotword-corpus` (Bearer-
auth, same token as transcripts/import) to pull the Kingdee mirror — customers,
opportunities, enterprises, follow-up tracks, visit notes.

Two-stage extraction:
  1. Rule terms: customer / opportunity / enterprise / person names go in
     directly with high confidence — DeepSeek isn't needed, these are CRM
     ground truth.
  2. LLM terms: concatenate the free-text fields (opportunity requirement,
     track result, visit content, enterprise description) and ask DeepSeek to
     mine product / system / industry terminology.

Both lists are merged and upserted under source `CRM-金蝶-DeepSeek`.

Fallback: if NEWCRM_BASE_URL / token aren't configured, or the endpoint isn't
reachable, mine the local NewVoice DB (recording titles + summaries +
transcript samples) so the hotword library still grows.
"""
from __future__ import annotations

import os
import sys
import time
import traceback
from typing import Any

import httpx

from _hotword_sync_lib import (
    build_free_text_corpus,
    build_rule_terms,
    call_deepseek_extract,
    common_argparser,
    count_for_source,
    db_conn,
    emit_json,
    gather_local_corpus,
    load_env,
    log,
    merge_candidate_lists,
    upsert_hotwords,
    write_report,
)


SOURCE_NAME = "CRM-金蝶-DeepSeek"
SOURCE_LABEL = "NewCRM 金蝶 mirror"
ENDPOINT_PATH = "/api/external/kingdee/hotword-corpus"


def newcrm_credentials() -> tuple[str, str]:
    base = os.environ.get("NEWCRM_BASE_URL", "").strip().rstrip("/")
    token = (
        os.environ.get("NEWCRM_TRANSCRIPT_IMPORT_TOKEN", "").strip()
        or os.environ.get("LOCAL_TRANSCRIPT_IMPORT_TOKEN", "").strip()
        or os.environ.get("AHAM_TRANSCRIPT_IMPORT_TOKEN", "").strip()
    )
    return base, token


def fetch_newcrm_corpus(base: str, token: str, timeout: float = 60.0) -> dict[str, Any] | None:
    """Pull the Kingdee mirror from NewCRM. Retry on transient 5xx / network
    blips — Next.js dev mode in particular returns 503 while a route is
    recompiling, which is a few-second window we shouldn't fail on.
    """
    url = f"{base}{ENDPOINT_PATH}"
    last_status = ""
    # trust_env=False: NewCRM is local. macOS system proxy config (e.g. ClashX
    # at 127.0.0.1:1082) would otherwise intercept localhost requests and
    # return 503 because the user's NO_PROXY=localhost only exists in their
    # interactive shell, not in launchd-spawned uvicorn.
    with httpx.Client(timeout=timeout, trust_env=False) as client:
        for attempt in range(4):
            try:
                res = client.get(url, headers={"Authorization": f"Bearer {token}"})
            except Exception as exc:
                last_status = f"network error: {exc}"
                log(f"NewCRM 请求异常：{exc}（attempt {attempt + 1}/4）")
                time.sleep(2 * (attempt + 1))
                continue
            if res.status_code == 404:
                log(f"NewCRM 端点 404，可能未部署 {ENDPOINT_PATH}")
                return None
            if res.status_code in {401, 403}:
                log(f"NewCRM 鉴权失败：HTTP {res.status_code} — 检查 token 是否一致")
                return None
            if res.status_code in {500, 502, 503, 504}:
                last_status = f"HTTP {res.status_code}: {res.text[:200]}"
                log(f"NewCRM {last_status}（attempt {attempt + 1}/4，可能 dev 模式热重载）")
                time.sleep(2 * (attempt + 1))
                continue
            if res.status_code >= 400:
                log(f"NewCRM HTTP {res.status_code}: {res.text[:200]}")
                return None
            try:
                data = res.json()
            except ValueError:
                log(f"NewCRM 返回非 JSON：{res.text[:200]}")
                return None
            if not data.get("ok"):
                log(f"NewCRM 返回错误：{data.get('diagnostic')} {data.get('error')}")
                return None
            return data.get("data") or {}
    log(f"NewCRM 重试 4 次都失败：{last_status}")
    return None


def extract_from_newcrm(corpus: dict[str, Any], max_terms: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], str]:
    rule_terms = build_rule_terms(corpus)
    log(f"规则提取候选词 {len(rule_terms)} 个")
    free_text = build_free_text_corpus(corpus)
    log(f"自由文本 {len(free_text)} 字")
    llm_terms: list[dict[str, Any]] = []
    note = ""
    if free_text.strip():
        try:
            llm_terms = call_deepseek_extract(free_text, source_label=SOURCE_LABEL, max_terms=max_terms)
            log(f"DeepSeek 抽取候选词 {len(llm_terms)} 个")
        except Exception as exc:
            log(f"DeepSeek 调用失败：{exc}（仅使用规则术语）")
            note = f"DeepSeek 调用失败：{exc}"
    else:
        note = "NewCRM 返回的自由文本字段全空，跳过 LLM 提炼"
    extras = {
        "客户数": len(corpus.get("customers", []) or []),
        "商机数": len(corpus.get("opportunities", []) or []),
        "企业数": len(corpus.get("enterprises", []) or []),
        "跟进数": len(corpus.get("tracks", []) or []),
        "拜访数": len(corpus.get("visits", []) or []),
        "自由文本字数": len(free_text),
        "NewCRM 生成时间": corpus.get("generatedAt") or "-",
    }
    return rule_terms, llm_terms, extras, note


def extract_from_local(lookback_days: int, max_terms: int) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    with db_conn() as conn:
        corpus_text, stats = gather_local_corpus(conn, lookback_days)
    log(f"本地素材：{stats}")
    llm_terms: list[dict[str, Any]] = []
    note_parts = [
        "未能调用 NewCRM 金蝶语料端点，已回退到本地录音/纪要语料。",
        "如要走 NewCRM 真实数据，请检查 NEWCRM_BASE_URL、Bearer token，",
        "以及 NewCRM 是否部署了 /api/external/kingdee/hotword-corpus 路由。",
    ]
    if corpus_text.strip():
        try:
            llm_terms = call_deepseek_extract(corpus_text, source_label="本地录音/纪要语料", max_terms=max_terms)
            log(f"本地素材 DeepSeek 抽取 {len(llm_terms)} 个候选词")
        except Exception as exc:
            log(f"DeepSeek 调用失败：{exc}")
            note_parts.append(f"DeepSeek 调用失败：{exc}")
    else:
        note_parts.append("本次回看窗口内无任何录音/纪要可挖。")
    return llm_terms, stats, "\n".join(note_parts)


def main() -> int:
    load_env()
    parser = common_argparser("从 NewCRM 金蝶 mirror 抽取热词")
    args = parser.parse_args()
    base, token = newcrm_credentials()

    rule_terms: list[dict[str, Any]] = []
    llm_terms: list[dict[str, Any]] = []
    extras: dict[str, Any] = {}
    note = ""
    data_source = "local-fallback"

    if base and token:
        log(f"调用 NewCRM {base}{ENDPOINT_PATH}")
        corpus = fetch_newcrm_corpus(base, token)
        if corpus is not None:
            data_source = "newcrm-kingdee"
            rule_terms, llm_terms, extras, note = extract_from_newcrm(corpus, args.max_terms)
    else:
        log("NEWCRM_BASE_URL / token 未配置，直接走本地回退")

    if data_source == "local-fallback":
        llm_terms, extras, note = extract_from_local(args.lookback_days or 180, args.max_terms)

    extras["数据来源"] = data_source
    extras["规则术语"] = len(rule_terms)
    extras["LLM 术语"] = len(llm_terms)

    candidates = merge_candidate_lists(rule_terms, llm_terms)[: args.max_terms]
    extras["合并候选"] = len(candidates)

    with db_conn() as conn:
        counts = upsert_hotwords(conn, SOURCE_NAME, candidates, dry_run=args.dry_run)
        report_path = write_report(
            source_name=SOURCE_NAME,
            source_label=SOURCE_LABEL if data_source == "newcrm-kingdee" else "本地回退",
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
        "data_source": data_source,
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
