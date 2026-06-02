"""Shared helpers for hotword sync scripts.

Both `import_crm_hotwords.py` and `import_wecom_journal_hotwords.py` rely on
this module. They are invoked by `backend/app/main.py` via subprocess and must
emit a JSON object on stdout. Progress and warnings go to stderr so stdout
stays parseable.

Contract with main.py (`run_hotword_source_sync`):
- exit 0 on success (even if 0 candidates extracted), non-zero on hard failure
- stdout: a single JSON object with keys inserted, updated, reactivated,
  expired, skipped, active_total (or source_total / total), report
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

import httpx


ROOT = Path(__file__).resolve().parents[1]


def load_env() -> None:
    try:
        from dotenv import dotenv_values
    except ImportError:
        return
    for path in [ROOT / ".env.local", ROOT / ".env"]:
        if not path.exists():
            continue
        for key, value in (dotenv_values(path) or {}).items():
            if value is not None and key not in os.environ:
                os.environ[key] = str(value)


def base_dir() -> Path:
    return Path(os.environ.get("RECORDING_AI_HOME", Path.home() / ".cache" / "recording-ai"))


def db_path() -> Path:
    return base_dir() / "app-data" / "newvoice.sqlite3"


def reports_dir() -> Path:
    target = base_dir() / "app-data" / "hotword-sync-reports"
    target.mkdir(parents=True, exist_ok=True)
    return target


@contextmanager
def db_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    sys.stderr.write(f"{datetime.now().strftime('%H:%M:%S')} {msg}\n")
    sys.stderr.flush()


VALID_KINDS = {
    "产品", "系统", "行业", "业务术语", "项目", "商机",
    "人员", "客户", "客户简称", "潜在客户", "组织",
}

KIND_ALIASES = {
    "产品名称": "产品", "产品名": "产品", "软件": "产品", "产品线": "产品",
    "系统名称": "系统", "平台": "系统", "工具": "系统",
    "客户名": "客户", "公司": "客户", "甲方": "客户",
    "项目名": "项目", "项目名称": "项目",
    "人物": "人员", "联系人": "人员", "角色": "人员",
    "术语": "业务术语", "概念": "业务术语",
    "简称": "客户简称", "缩写": "客户简称",
    "潜在": "潜在客户",
}


def normalize_kind(value: str) -> str:
    v = (value or "").strip()
    if v in VALID_KINDS:
        return v
    return KIND_ALIASES.get(v, "业务术语")


def valid_term(text: str) -> bool:
    t = (text or "").strip()
    if len(t) < 2 or len(t) > 36:
        return False
    if re.search(r"\s", t):
        return False
    if t.isdigit():
        return False
    return True


_FORMAL_ORG_MARKER = re.compile(r"(公司|集团|股份|有限|责任)")


def is_speakable_hotword(word: str) -> bool:
    """只有能被口语说出口的短词才值得入热词库当 ASR 偏置。超长全称（含
    公司/集团/股份等组织形式词）口语召回≈0，留着只会让 seaco 误偏置，不入库。
    阈值用 NEWVOICE_HOTWORD_MAX_LEN（默认 8）。"""
    w = (word or "").strip()
    try:
        max_len = int(os.environ.get("NEWVOICE_HOTWORD_MAX_LEN", "8"))
    except ValueError:
        max_len = 8
    max_len = max(4, min(20, max_len))
    if not (2 <= len(w) <= max_len):
        return False
    if _FORMAL_ORG_MARKER.search(w):
        return False
    return True


_PROVINCES = (
    "北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|"
    "广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门"
)
_CITIES = (
    "扬州|苏州|无锡|常州|南京|杭州|宁波|温州|绍兴|嘉兴|金华|台州|徐州|南通|盐城|泰州|镇江|淮安|连云港|宿迁|湖州|丽水|"
    "深圳|广州|东莞|佛山|珠海|中山|惠州|江门|肇庆|汕头|湛江|茂名|成都|绵阳|德阳|宜宾|南充|武汉|宜昌|襄阳|荆州|"
    "西安|宝鸡|咸阳|青岛|济南|烟台|潍坊|淄博|临沂|济宁|东营|威海|聊城|德州|滨州|菏泽|泰安|大连|沈阳|鞍山|长春|吉林|"
    "哈尔滨|大庆|郑州|洛阳|开封|新乡|南阳|许昌|信阳|焦作|平顶山|商丘|长沙|株洲|湘潭|衡阳|岳阳|常德|合肥|芜湖|蚌埠|"
    "马鞍山|福州|厦门|泉州|漳州|莆田|龙岩|三明|宁德|南昌|九江|上饶|赣州|昆明|大理|玉溪|贵阳|遵义|南宁|柳州|桂林|"
    "石家庄|唐山|保定|廊坊|沧州|邯郸|太原|银川|包头|呼和浩特|鄂尔多斯|兰州|西宁|乌鲁木齐"
)
_REGION_PREFIX = re.compile(
    rf"^(?:{_PROVINCES}|{_CITIES})(?:省|市|自治区|特别行政区|地区|自治州|盟)?"
)
# 通用兜底：开头 2-4 个汉字后接 省/市/区/自治州 这种行政区划尾巴
_REGION_SUFFIX_TOKEN = re.compile(r"^[一-鿿]{2,4}?(?:省|市|区|县|自治区|自治州|特别行政区)")
_LEGAL_SUFFIX = re.compile(
    r"(?:\([^)]*\)|（[^）]*）)?"
    r"(?:集团)?(?:股份)?(?:有限)?(?:责任)?公司$"
    r"|(?:集团|总公司|分公司|子公司|公司|厂|店|中心|研究院|研究所|设计院|事业部|工作室|合作社|事务所|门市部)$"
)
# 行业/经营特点词：在字号之后，出现即认为字号到此为止
_INDUSTRY = (
    "科技|网络|信息|技术|数据|软件|智能|数字|系统|通信|光电|半导体|电子|数码|自动化|"
    "电机|电气|机电|机械|传动|设备|装备|仪器|仪表|重工|精密|制造|工业|工程|建筑|建设|安装|"
    "材料|新材料|化工|化学|涂料|塑料|橡胶|金属|钢铁|冶金|有色|食品|饮料|农业|生物|医药|药业|"
    "医疗|器械|健康|能源|新能源|电力|环保|节能|物流|供应链|贸易|实业|商贸|进出口|国际|控股|"
    "投资|资本|金融|担保|租赁|咨询|顾问|服务|管理|文化|传媒|教育|地产|置业|物业|纺织|服装|"
    "家居|家具|包装|印刷|汽车|配件|电器|照明|阀门|泵业|轴承|模具|五金|工具|测控|检测|认证"
)
_INDUSTRY_CUT = re.compile(rf"(?:{_INDUSTRY})")


def derive_short_names(name: str) -> list[str]:
    """企业全称 → 口语口头简称（字号）。中文公司名结构是 [地区][字号][行业][组织形式]，
    人们开口只说字号（德能、新斯达），全称太长 ASR 反而匹配不上，所以要把字号抽出来当热词。
    策略：剥地区前缀 → 剥组织形式后缀 → 切到第一个行业词取前面字号；行业词没命中则取前 2-4 字兜底。"""
    full = (name or "").strip()
    if not full:
        return []
    out: list[str] = []

    def push(s: str) -> None:
        s = (s or "").strip()
        if 2 <= len(s) <= 8 and s != full and s not in out:
            out.append(s)

    # 1) 剥地区前缀
    core = _REGION_PREFIX.sub("", full, count=1).strip()
    if core == full:
        m = _REGION_SUFFIX_TOKEN.match(full)
        if m:
            core = full[m.end():].strip()
    core = core or full
    # 2) 剥组织形式后缀
    base = _LEGAL_SUFFIX.sub("", core).strip() or core
    # 3) 切到第一个行业词 → 前面是字号
    cut = _INDUSTRY_CUT.search(base)
    if cut and cut.start() >= 2:
        push(base[: cut.start()])
    else:
        # 4) 行业词没命中 → 取前 3/2/4 字当字号候选（中文字号几乎都在最前）
        for n in (3, 2, 4):
            if len(base) > n:
                push(base[:n])
    # 中间形态（剥完地区+组织形式，如「维嘉投资」「新斯达传动科技」）也保留一个
    push(base)
    return out


def _parse_json_object(content: str) -> dict[str, Any]:
    raw = (content or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return {}
        try:
            data = json.loads(match.group(0))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}


def derive_short_names_llm(names: list[str], *, max_batch: int = 100) -> dict[str, list[str]]:
    """规则兜不住的长尾交给 DeepSeek：给公司全称列表，产出口语简称（字号）。
    返回 {全称: [简称…]}。无 key / 无名称时返回 {}，不抛错。"""
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    base = os.environ.get("DEEPSEEK_API_BASE", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
    uniq = list(dict.fromkeys(n.strip() for n in (names or []) if n and n.strip()))
    if not api_key or not uniq:
        return {}
    out: dict[str, list[str]] = {}
    with httpx.Client(timeout=120) as client:
        for i in range(0, len(uniq), max_batch):
            batch = uniq[i:i + max_batch]
            log(f"DeepSeek 简称抽取 {i + 1}-{i + len(batch)}/{len(uniq)}")
            payload = {
                "model": model,
                "temperature": 0.1,
                "max_tokens": 4096,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是中文企业名称分析助手。给定公司全称，输出人们在口语里通常的简称（字号/俗称）。"
                            "只要能在口语里替代全称的简短叫法，优先 2-4 字；去掉地区、行业、组织形式（有限公司/集团等）。"
                            "只输出 JSON 对象，不要解释、不要 markdown 代码块。某个公司没有合适简称就给空数组。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            '给下面每个公司全称输出口语简称，JSON 形如 {"全称":["简称1","简称2"]}：\n'
                            + "\n".join(batch)
                        ),
                    },
                ],
            }
            try:
                res = client.post(
                    f"{base}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
                if res.status_code >= 400:
                    raise RuntimeError(f"DeepSeek HTTP {res.status_code}: {res.text[:200]}")
                content = res.json()["choices"][0]["message"]["content"]
            except Exception as exc:
                log(f"  简称批次失败：{exc}")
                continue
            for full, shorts in _parse_json_object(content).items():
                if not isinstance(shorts, list):
                    continue
                clean = [str(s).strip() for s in shorts if isinstance(s, (str, int)) and valid_term(str(s))]
                if clean:
                    out[str(full).strip()] = clean[:4]
    return out


def chunk_text(text: str, size: int = 24000, max_chunks: int = 6) -> list[str]:
    if not text:
        return []
    return [text[i:i + size] for i in range(0, len(text), size)][:max_chunks]


def call_deepseek_extract(
    text: str,
    *,
    source_label: str,
    max_terms: int = 1200,
) -> list[dict[str, Any]]:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    base = os.environ.get("DEEPSEEK_API_BASE", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured")
    chunks = chunk_text(text)
    if not chunks:
        return []
    candidates: dict[str, dict[str, Any]] = {}
    with httpx.Client(timeout=180) as client:
        for index, chunk in enumerate(chunks, 1):
            log(f"DeepSeek 抽取 chunk {index}/{len(chunks)} ({len(chunk)} 字)")
            try:
                content = _deepseek_chat(
                    client, base, api_key, model, source_label, index, len(chunks), chunk,
                )
            except Exception as exc:
                log(f"  chunk {index} 失败：{exc}")
                continue
            for item in _parse_terms_payload(content):
                _accumulate(candidates, item)
            if len(candidates) >= max_terms:
                break
    result = sorted(
        candidates.values(),
        key=lambda x: (x["confidence"], x["frequency"]),
        reverse=True,
    )
    return result[:max_terms]


def _deepseek_chat(
    client: httpx.Client, base: str, api_key: str, model: str,
    source_label: str, index: int, total: int, chunk: str,
) -> str:
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 4096,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是企业销售/项目场景的术语挖掘助手。"
                    "从素材里抽取真正应该进入语音识别热词库的专有名词（产品/系统/客户/项目/商机/人员等）。"
                    "只输出 JSON 对象，不要 markdown 代码块、不要解释、不要注释。"
                    "每个词必须能在原文里找到证据，不准编造。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"素材来源：{source_label}\n"
                    f"分块：{index}/{total}\n\n"
                    "请挖热词，仅输出形如下面结构的 JSON：\n"
                    '{"terms": [\n'
                    '  {"word":"...", "kind":"产品|系统|行业|业务术语|项目|商机|人员|客户|客户简称|潜在客户|组织",\n'
                    '   "aliases":["..."], "confidence":0.0-1.0, "frequency":整数}\n'
                    "]}\n\n"
                    "规则：\n"
                    "1. word 长度 2-36，不含空格，不能纯数字\n"
                    "2. aliases 只列原文里真实出现的同义/简称/英文/缩写写法，没有就给空数组\n"
                    "3. 只挖容易被语音识别误判的专有名词、客户简称、产品/系统/项目名\n"
                    "4. 口水词、通用动词、地名不要\n"
                    "5. 同一个词不要重复\n"
                    "6. 一次最多 200 个 term\n\n"
                    f"--- 素材 ---\n{chunk}\n--- 结束 ---"
                ),
            },
        ],
    }
    res = client.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"DeepSeek HTTP {res.status_code}: {res.text[:300]}")
    return res.json()["choices"][0]["message"]["content"]


def _parse_terms_payload(content: str) -> list[dict[str, Any]]:
    raw = (content or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return []
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return []
    if not isinstance(data, dict):
        return []
    terms = data.get("terms")
    return list(terms) if isinstance(terms, list) else []


def _accumulate(out: dict[str, dict[str, Any]], item: dict[str, Any]) -> None:
    if not isinstance(item, dict):
        return
    word = str(item.get("word") or "").strip()
    if not valid_term(word):
        return
    key = word.lower()
    kind = normalize_kind(str(item.get("kind") or ""))
    aliases = [
        str(a).strip()
        for a in (item.get("aliases") or [])
        if isinstance(a, (str, int)) and valid_term(str(a))
    ]
    try:
        conf = float(item.get("confidence") or 0.7)
    except (TypeError, ValueError):
        conf = 0.7
    conf = max(0.0, min(1.0, conf))
    try:
        freq = int(item.get("frequency") or 1)
    except (TypeError, ValueError):
        freq = 1
    freq = max(1, min(999, freq))
    existing = out.get(key)
    if existing:
        existing["frequency"] = min(9999, existing["frequency"] + freq)
        existing["aliases"] = list(dict.fromkeys(existing["aliases"] + aliases))
        if conf > existing["confidence"]:
            existing["confidence"] = conf
            existing["kind"] = kind
    else:
        out[key] = {
            "word": word,
            "kind": kind,
            "aliases": aliases,
            "confidence": conf,
            "frequency": freq,
        }


def upsert_hotwords(
    conn: sqlite3.Connection,
    source_name: str,
    candidates: list[dict[str, Any]],
    *,
    dry_run: bool,
) -> dict[str, int]:
    counts = {"inserted": 0, "updated": 0, "reactivated": 0, "skipped": 0}
    if not candidates:
        return counts
    existing = {
        (row["word"] or "").lower(): dict(row)
        for row in conn.execute("select * from hotwords where source = ?", (source_name,)).fetchall()
    }
    ts = now_str()
    for cand in candidates:
        word = cand["word"]
        if not is_speakable_hotword(word):
            counts["skipped"] += 1
            continue
        key = word.lower()
        source_key = f"{source_name}:{word}"
        kind = cand["kind"]
        confidence = cand["confidence"]
        frequency = cand["frequency"]
        weight = max(1, min(10, int(round(confidence * 10))))
        kind_bonus = 40 if kind in {"产品", "系统"} else 30
        score = weight * 12 + min(80, frequency * 3) + kind_bonus
        row = existing.get(key)
        if row:
            was_expired = (row.get("state") or "active") == "expired" or not int(row.get("active") or 0)
            if int(row.get("protected") or 0):
                # Protected rows are owned by the operator; just bump last_seen.
                if not dry_run:
                    conn.execute(
                        "update hotwords set last_seen_at = ?, updated_at = ? where id = ?",
                        (ts, ts, row["id"]),
                    )
                counts["skipped"] += 1
                continue
            merged_aliases = list(dict.fromkeys(
                [a.strip() for a in (row.get("aliases") or "").split(",") if a.strip()]
                + cand["aliases"]
            ))
            new_freq = min(9999, int(row.get("frequency") or 0) + frequency)
            new_confidence = max(float(row.get("confidence") or 0), confidence)
            new_weight = max(int(row.get("weight") or 0), weight)
            bucket = "reactivated" if was_expired else "updated"
            if dry_run:
                counts[bucket] += 1
                continue
            conn.execute(
                """
                update hotwords
                set kind = ?, aliases = ?, source_key = ?, weight = ?, confidence = ?,
                    frequency = ?, score = ?, state = 'active', active = 1,
                    last_seen_at = ?, updated_at = ?
                where id = ?
                """,
                (
                    kind, ",".join(merged_aliases), source_key, new_weight, new_confidence,
                    new_freq, score, ts, ts, row["id"],
                ),
            )
            counts[bucket] += 1
        else:
            if dry_run:
                counts["inserted"] += 1
                continue
            conn.execute(
                """
                insert into hotwords(
                    id, word, kind, aliases, source, scope, weight, active,
                    source_key, state, protected, frequency, confidence, score,
                    first_seen_at, last_seen_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', 0, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()), word, kind, ",".join(cand["aliases"]),
                    source_name, "部门共享", weight, source_key,
                    frequency, confidence, score, ts, ts, ts,
                ),
            )
            counts["inserted"] += 1
    return counts


def write_report(
    *,
    source_name: str,
    source_label: str,
    candidates: list[dict[str, Any]],
    counts: dict[str, int],
    dry_run: bool,
    extras: dict[str, Any] | None = None,
    note: str = "",
) -> Path:
    extras = extras or {}
    tag = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_source = re.sub(r"[^\w一-鿿.-]+", "_", source_name)
    target = reports_dir() / f"{safe_source}_{tag}.md"
    lines: list[str] = [
        f"# {source_label} 热词同步报告",
        "",
        f"- 时间：{now_str()}",
        f"- 模式：{'预演 (dry-run)' if dry_run else '正式写入'}",
        f"- 候选词总数：{len(candidates)}",
        f"- 新增：{counts.get('inserted', 0)}",
        f"- 更新：{counts.get('updated', 0)}",
        f"- 重新激活：{counts.get('reactivated', 0)}",
        f"- 跳过（受保护或重复）：{counts.get('skipped', 0)}",
    ]
    for key, value in extras.items():
        lines.append(f"- {key}：{value}")
    if note:
        lines.append("")
        for paragraph in note.splitlines():
            lines.append(f"> {paragraph}" if paragraph.strip() else ">")
    lines.append("")
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for cand in candidates:
        by_kind.setdefault(cand["kind"], []).append(cand)
    for kind in sorted(by_kind, key=lambda k: -len(by_kind[k])):
        rows = by_kind[kind]
        lines.append(f"## {kind}（{len(rows)} 条）")
        lines.append("")
        for cand in rows[:50]:
            aliases_text = "、".join(cand["aliases"]) if cand["aliases"] else "-"
            lines.append(
                f"- **{cand['word']}** · 置信 {cand['confidence']:.2f} · 频次 {cand['frequency']} · 别名 {aliases_text}"
            )
        if len(rows) > 50:
            lines.append(f"- ...（其余 {len(rows) - 50} 条已写入但未列出）")
        lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def common_argparser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--json", action="store_true", help="结果以 JSON 写到 stdout（main.py 必传）")
    parser.add_argument("--dry-run", action="store_true", help="只预演不写入 DB")
    parser.add_argument("--max-terms", type=int, default=1200, help="本次最多导入多少个热词")
    parser.add_argument("--lookback-days", type=int, default=None, help="覆盖默认回看天数")
    return parser


def count_for_source(conn: sqlite3.Connection, source_name: str) -> tuple[int, int]:
    active = conn.execute(
        """
        select count(*) from hotwords
        where source = ? and active = 1 and coalesce(state, 'active') = 'active'
        """,
        (source_name,),
    ).fetchone()[0]
    total = conn.execute(
        "select count(*) from hotwords where source = ?",
        (source_name,),
    ).fetchone()[0]
    return int(active), int(total)


def emit_json(result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Corpus assembly helpers used by import_crm_hotwords.py
# ---------------------------------------------------------------------------


def merge_candidate_lists(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge multiple candidate lists, deduping by lowercase word and combining
    aliases / frequencies. Use after collecting rule-based and LLM-based terms.
    """
    out: dict[str, dict[str, Any]] = {}
    for items in lists:
        for item in items or []:
            _accumulate(out, item)
    return sorted(
        out.values(),
        key=lambda x: (x["confidence"], x["frequency"]),
        reverse=True,
    )


def build_rule_terms(corpus: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn structured Kingdee data (from /api/external/kingdee/hotword-corpus)
    into hotword candidates without invoking the LLM. Names go in with high
    confidence; industries/people with lower confidence.
    """
    candidates: dict[str, dict[str, Any]] = {}

    def add(word: Any, kind: str, *, confidence: float = 0.95, aliases: list[str] | None = None) -> None:
        if word is None:
            return
        text = str(word).strip()
        if not valid_term(text):
            return
        _accumulate(candidates, {
            "word": text,
            "kind": kind,
            "aliases": [a for a in (aliases or []) if a and valid_term(str(a))],
            "confidence": confidence,
            "frequency": 1,
        })

    def add_company(name: Any, kind: str, *, extra_aliases: list[str] | None = None) -> None:
        """Add a company/customer name AND its derived spoken short forms, so the
        ASR can match "维嘉" not just "维嘉投资有限公司"."""
        if name is None:
            return
        text = str(name).strip()
        shorts = derive_short_names(text)
        aliases = list(shorts) + [a for a in (extra_aliases or []) if a]
        add(text, kind, aliases=aliases)
        for short in shorts:
            add(short, "客户简称", confidence=0.9)

    for c in corpus.get("customers", []) or []:
        if not isinstance(c, dict):
            continue
        add_company(c.get("name"), "客户", extra_aliases=[c.get("shortName")])
        add(c.get("shortName"), "客户简称")
        add(c.get("sellerName"), "人员", confidence=0.85)
        add(c.get("industry"), "行业", confidence=0.7)

    for o in corpus.get("opportunities", []) or []:
        if not isinstance(o, dict):
            continue
        add(o.get("name"), "商机")
        add_company(o.get("customerName"), "客户")
        add(o.get("responsibleName"), "人员", confidence=0.85)
        add(o.get("industry"), "行业", confidence=0.7)

    for e in corpus.get("enterprises", []) or []:
        if not isinstance(e, dict):
            continue
        add_company(e.get("name"), "潜在客户")
        add(e.get("saleRep"), "人员", confidence=0.85)
        add(e.get("industry"), "行业", confidence=0.7)

    for t in corpus.get("tracks", []) or []:
        if not isinstance(t, dict):
            continue
        add(t.get("ownerName"), "人员", confidence=0.85)
        add_company(t.get("customerName"), "客户")

    for v in corpus.get("visits", []) or []:
        if not isinstance(v, dict):
            continue
        add_company(v.get("customerName"), "客户")
        add(v.get("personName"), "人员", confidence=0.85)

    return list(candidates.values())


def build_free_text_corpus(corpus: dict[str, Any], cap: int = 140_000) -> str:
    """Concatenate the long-form free text from Kingdee records so DeepSeek can
    mine products / systems / industry terms out of the body, not just names.
    """
    blocks: list[str] = []
    for o in corpus.get("opportunities", []) or []:
        if not isinstance(o, dict):
            continue
        requirement = (o.get("requirement") or "").strip()
        if requirement:
            blocks.append(f"[商机·{o.get('name') or ''}] {requirement}")
    for t in corpus.get("tracks", []) or []:
        if not isinstance(t, dict):
            continue
        result = (t.get("result") or "").strip()
        if result:
            blocks.append(f"[跟进·{t.get('opportunityName') or ''}] {result}")
        attention = (t.get("attention") or "").strip()
        if attention:
            blocks.append(f"[关注·{t.get('opportunityName') or ''}] {attention}")
    for v in corpus.get("visits", []) or []:
        if not isinstance(v, dict):
            continue
        content = (v.get("content") or "").strip()
        if content:
            blocks.append(f"[拜访·{v.get('customerName') or ''}] {content}")
    for e in corpus.get("enterprises", []) or []:
        if not isinstance(e, dict):
            continue
        desc = (e.get("description") or "").strip()
        if desc:
            blocks.append(f"[企业·{e.get('name') or ''}] {desc}")
    joined = "\n\n".join(blocks)
    return joined[:cap] if len(joined) > cap else joined


def gather_local_corpus(conn: sqlite3.Connection, lookback_days: int, max_chars: int = 180_000) -> tuple[str, dict[str, int]]:
    """Fallback corpus: when the external CRM endpoint is unreachable, mine the
    local NewVoice DB (recording titles + tags, current summaries, transcript
    samples). Used by import_crm_hotwords.py's fallback path.
    """
    cutoff = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
    title_lines: list[str] = []
    for row in conn.execute(
        "select title, tag, meeting_type from recordings where updated_at >= ? order by updated_at desc limit 400",
        (cutoff,),
    ).fetchall():
        pieces = [row["title"] or "", row["tag"] or "", row["meeting_type"] or ""]
        merged = " / ".join(p for p in pieces if p)
        if merged:
            title_lines.append(merged)
    title_block = "\n".join(title_lines)

    summary_rows = conn.execute(
        """
        select content from summaries
        where created_at >= ? and is_current = 1
        order by created_at desc
        limit 60
        """,
        (cutoff,),
    ).fetchall()
    summary_block = "\n\n".join(str(row["content"]) for row in summary_rows if row["content"])

    transcripts: list[str] = []
    transcript_chars = 0
    transcript_cap = max_chars // 2
    for row in conn.execute(
        """
        select text from transcript_segments
        where recording_id in (
            select id from recordings where updated_at >= ?
            order by updated_at desc limit 120
        )
        order by start_sec
        """,
        (cutoff,),
    ):
        snippet = (row["text"] or "").strip()
        if not snippet:
            continue
        transcripts.append(snippet)
        transcript_chars += len(snippet)
        if transcript_chars >= transcript_cap:
            break
    transcript_block = "\n".join(transcripts)

    sections: list[str] = []
    if title_block:
        sections.append("【录音标题与客户/项目标签】\n" + title_block)
    if summary_block:
        sections.append("【当前会议纪要正文】\n" + summary_block)
    if transcript_block:
        sections.append("【转写片段样本】\n" + transcript_block)
    corpus = "\n\n".join(sections)
    if len(corpus) > max_chars:
        corpus = corpus[:max_chars]
    return corpus, {
        "录音条数": len(title_lines),
        "纪要条数": len(summary_rows),
        "转写片段数": len(transcripts),
        "语料字数": len(corpus),
    }
