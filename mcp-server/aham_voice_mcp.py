"""MCP server for Aham Voice.

Exposes the local desktop app to an MCP client (Claude Desktop) over stdio. It
is a thin shell on purpose: every capability here is a plain HTTP endpoint of
the running app, so the app never gets smarter than itself just because an
assistant is attached.

Discovery: the app publishes its port and a local token to
``~/Library/Application Support/AhamVoice/runtime.json`` at startup. The app
must be running for any tool to work.

Run it:
    python mcp-server/aham_voice_mcp.py
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ResourceError, ToolError

# stdio transport *is* stdout: a stray log line corrupts the JSON-RPC stream.
# Pin every handler to stderr and mute httpx's per-request INFO chatter.
logging.basicConfig(level=logging.WARNING, stream=sys.stderr, force=True)
logging.getLogger("httpx").setLevel(logging.WARNING)

server = MCPServer("aham-voice")


def _base_dir() -> Path:
    override = os.environ.get("RECORDING_AI_HOME")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / "AhamVoice"


def _runtime() -> dict[str, Any]:
    path = _base_dir() / "runtime.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ToolError(
            "Aham Voice 没在运行（找不到 runtime.json）。请先打开 Aham Voice 桌面应用，再重试。"
        ) from None
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolError(f"runtime.json 读不出来：{exc}") from exc
    if not data.get("base_url"):
        raise ToolError("runtime.json 缺少 base_url，应用可能是旧版本。")
    return data


async def _call(method: str, path: str, **kwargs: Any) -> Any:
    runtime = _runtime()
    headers = {"X-Aham-Token": str(runtime.get("token") or "")}
    url = f"{runtime['base_url']}{path}"
    async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
        try:
            response = await client.request(method, url, headers=headers, **kwargs)
        except httpx.ConnectError as exc:
            raise ToolError(
                f"连不上 Aham Voice（{runtime['base_url']}）。应用可能已经关了。"
            ) from exc
    if response.status_code >= 400:
        detail = response.text
        try:
            detail = response.json().get("detail", detail)
        except Exception:
            pass
        raise ToolError(f"{method} {path} 失败（HTTP {response.status_code}）：{detail}")
    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    return response.text


# ---------------------------------------------------------------------------
# Recordings
# ---------------------------------------------------------------------------


@server.tool()
async def list_recordings(query: str = "", limit: int = 20) -> list[dict[str, Any]]:
    """列出录音库里的录音（最新在前）。query 匹配标题，limit 默认 20。"""
    params: dict[str, Any] = {}
    if query:
        params["q"] = query
    items = await _call("GET", "/api/recordings", params=params)
    return items[: max(1, min(int(limit), 200))]


@server.tool()
async def get_recording(recording_id: str) -> dict[str, Any]:
    """查一条录音的详情：转写/纪要状态、时长、说话人、正在跑的任务和进度。

    转写要几分钟，所以处理是「下单 + 轮询」：start_processing 之后用这个查
    asr_status（pending/queued/running/done/failed）和 tasks 里的 progress。
    """
    return await _call("GET", f"/api/recordings/{recording_id}")


@server.tool()
async def import_recording(
    path: str,
    title: str = "",
    briefing: str = "",
    terms: list[str] | None = None,
    tag: str = "",
) -> dict[str, Any]:
    """把本机上的音频导入 Aham Voice 并立即开始转写。

    path 必须是绝对路径。文件是复制进去的，原文件不动。

    briefing 是这场会的背景——谁在场、什么关系、要谈什么。请把用户在对话里
    讲的原话整理进去，它会原样交给纪要模型，并且比转写更可信（转写会听错，
    用户写的不会）。这是让纪要变准最省力的一处。

    terms 是这场会的专有名词，只对这条录音生效、优先级高于常驻热词库。
    中文专名效果最好；英文缩写对识别偏置基本无效（实测），但写进来仍然有用
    ——纪要模型会据此写对专名。不合规的词会连原因一并返回（比如公司全称
    口语里没人说），据此改写后重提即可。

    返回录音对象；被拒的词在 rejected_terms 里。
    """
    payload: dict[str, Any] = {"path": path}
    if title:
        payload["title"] = title
    if briefing:
        payload["briefing"] = briefing
    if terms:
        payload["terms"] = terms
    if tag:
        payload["tag"] = tag
    return await _call("POST", "/api/recordings/import", json=payload)


@server.tool()
async def start_processing(recording_id: str) -> dict[str, Any]:
    """开始（或重跑）完整处理：转写 + 说话人分离 + 生成纪要。立即返回，用
    get_recording 轮询进度。会用上当前的热词和这条录音的会前上下文。"""
    return await _call("POST", f"/api/recordings/{recording_id}/process")


# ---------------------------------------------------------------------------
# Per-recording context — the point of this integration
# ---------------------------------------------------------------------------


@server.tool()
async def set_recording_context(
    recording_id: str,
    briefing: str = "",
    terms: list[dict[str, Any]] | None = None,
    replace: bool = True,
) -> dict[str, Any]:
    """给一条录音写「会前上下文」：背景描述 + 这场会独有的专名。

    用法：用户在对话里说清楚这次录音的客户、项目、场景、参会人，你把里面会被
    说出口的专有名词提炼成 terms 传进来。这批词在本次转写里优先级最高，必定
    进入 ASR 热词表，转写完还会统计真实命中次数。

    terms 每项是 {"term": "明远科技", "aliases": ["明远", "明园科技"], "note": "客户"}：
      - term  = 正确写法，会喂给 ASR 做偏置
      - aliases = 你预判可能被听错的写法，只用于转写后替换，约束比 term 松
    term 有硬约束（ASR 偏置对不满足的词无效）：2–8 个字、不含空格、不是纯数字或
    编号、不能带「公司/集团/股份/有限/责任」这类书面组织词——要给口语里真会说
    出口的简称。被拒的词会在 rejected 里带原因返回，你可以改写后重提。

    replace=True（默认）覆盖这条录音已有的术语表；False 表示追加。
    上下文只在下一次转写时生效：已经转写过的录音要再调 start_processing。
    """
    payload: dict[str, Any] = {"briefing": briefing, "replace": bool(replace)}
    if terms is not None:
        payload["terms"] = terms
    return await _call("PUT", f"/api/recordings/{recording_id}/context", json=payload)


@server.tool()
async def get_recording_context(recording_id: str) -> dict[str, Any]:
    """读一条录音的会前上下文，含每个术语转写后的真实命中次数 hit_count。
    命中多的词值得用 add_hotwords 提升为常驻热词；命中 0 的随录音留着就行。"""
    return await _call("GET", f"/api/recordings/{recording_id}/context")


# ---------------------------------------------------------------------------
# Transcript / summary
# ---------------------------------------------------------------------------


@server.tool()
async def get_transcript(recording_id: str) -> str:
    """取分说话人的逐句转写稿（Markdown）。"""
    return await _call("GET", f"/api/recordings/{recording_id}/export/transcript.md")


@server.tool()
async def get_summary(recording_id: str) -> str:
    """取当前版本的会议纪要（Markdown）。"""
    return await _call("GET", f"/api/recordings/{recording_id}/export/summary.md")


@server.tool()
async def generate_summary(recording_id: str) -> dict[str, Any]:
    """基于已有转写稿重新生成会议纪要（走用户自己配置的大模型）。"""
    return await _call("POST", f"/api/recordings/{recording_id}/summarize")


@server.tool()
async def revise_summary(recording_id: str, instruction: str) -> dict[str, Any]:
    """按自然语言指令改写纪要，例如「把待办按负责人分组」。保留历史版本。"""
    return await _call(
        "POST", f"/api/recordings/{recording_id}/summary/revise", json={"instruction": instruction}
    )


# ---------------------------------------------------------------------------
# Hotwords (global, persistent)
# ---------------------------------------------------------------------------


@server.tool()
async def list_hotwords(query: str = "", limit: int = 100) -> list[dict[str, Any]]:
    """列出常驻热词库。frequency / hit_count 是转写里的真实出现次数。"""
    params: dict[str, Any] = {}
    if query:
        params["q"] = query
    items = await _call("GET", "/api/hotwords", params=params)
    return items[: max(1, min(int(limit), 500))]


@server.tool()
async def add_hotwords(words: list[dict[str, Any]]) -> dict[str, Any]:
    """往常驻热词库加词，对所有后续转写生效。

    每项 {"word": "安灯", "aliases": "安登,安灯系统", "kind": "业务术语", "weight": 6}。
    只影响一场会的词不要加到这里——用 set_recording_context。

    英文缩写务必带 spoken（口语形式），否则救不回来：ASR 偏置对显示形式无效，
    实测把 "MOM" 当热词与不加热词的输出逐字节相同。转写后的音素纠错靠 spoken
    工作，一条 {"word": "MOM", "spoken": "毛姆,mom"} 就能同时覆盖
    冒目 / 冒陌 / 冒某 / POM 这些听错的写法，不必逐个枚举。
    中文专名可以不填，按字面读即可。
    """
    added: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for item in words:
        if isinstance(item, str):
            item = {"word": item}
        try:
            added.append(await _call("POST", "/api/hotwords", json=item))
        except ToolError as exc:
            failed.append({"word": str(item.get("word")), "error": str(exc)})
    return {"added": added, "failed": failed}


@server.tool()
async def correct_transcript(recording_id: str) -> dict[str, Any]:
    """重新校对一份已有转写里被听错的专名。

    转写完会自动跑一次。这个工具用于事后补了热词、想让稿子再过一遍的情况——
    比重新转写便宜得多（几分钟 vs 几十分钟）。

    只改专有名词，不改写内容。模型给出的替换如果在原文里找不到可安全替换的
    位置（比如 "MS" 只出现在 "WMS" 内部），会被丢弃而不是硬改。
    返回 {"applied": 已改处数, "proposed": 模型给出的条数, "skipped": 丢弃条数}。
    """
    return await _call("POST", f"/api/recordings/{recording_id}/correct")


@server.tool()
async def suggest_hotwords(recording_id: str) -> dict[str, Any]:
    """从一段转写里挖掘该加的热词，以及疑似被听错的专名。

    返回 {"stored": 新建议数, "rejected": [被规则挡掉的及原因], "suggestions": [...]}。
    只产生待办建议，不会直接改热词库——要用 accept_hotword_suggestion 才落库。
    corrections 类的建议采纳后会把「听错的写法」加成别名，直接改善下一次转写。
    """
    return await _call("POST", f"/api/recordings/{recording_id}/hotword-suggestions")


@server.tool()
async def list_hotword_suggestions(recording_id: str = "", status: str = "pending") -> list[dict[str, Any]]:
    """列出热词建议。不给 recording_id 就列全库的。

    kind='term' 是建议新增的词；kind='correction' 是「heard 应该是 suggested」的纠错。
    """
    if recording_id:
        return await _call("GET", f"/api/recordings/{recording_id}/hotword-suggestions")
    return await _call("GET", "/api/hotword-suggestions", params={"status": status})


@server.tool()
async def accept_hotword_suggestion(suggestion_id: str) -> dict[str, Any]:
    """采纳一条热词建议，写进常驻热词库。

    纠错类建议会把听错的写法加成该词的别名；新词类会新建热词。
    """
    return await _call("POST", f"/api/hotword-suggestions/{suggestion_id}/accept")


@server.tool()
async def reject_hotword_suggestion(suggestion_id: str) -> dict[str, Any]:
    """否掉一条热词建议，不再出现在待办里。"""
    return await _call("POST", f"/api/hotword-suggestions/{suggestion_id}/reject")


@server.tool()
async def delete_hotword(hotword_id: str) -> dict[str, Any]:
    """按 id 删除一个常驻热词。"""
    return await _call("DELETE", f"/api/hotwords/{hotword_id}")


# ---------------------------------------------------------------------------
# Local models
# ---------------------------------------------------------------------------


@server.tool()
async def list_models() -> dict[str, Any]:
    """列出本机模型的状态：哪些必需、哪些已就绪、下载到了多少。

    转写、说话人分离、声学情绪都在本机跑，模型不在就没法处理录音。status 取值：
    ready（完整）/ partial（下了一半，续传即可）/ queued（排队）/ downloading /
    missing。完整性是按远端文件清单逐个比对大小算的，不是「目录在不在」。
    """
    return await _call("GET", "/api/models")


@server.tool()
async def download_models(include_optional: bool = False) -> dict[str, Any]:
    """把还没就绪的模型下下来。必需的约 2.2 GB；include_optional=True 会一并下
    声学情绪模型（约 1.95 GB）。下载按顺序排队进行，用 list_models 看进度。"""
    return await _call("POST", "/api/models/download", json={"include_optional": include_optional})


@server.tool()
async def download_model(key: str) -> dict[str, Any]:
    """单独下一个模型。key 取自 list_models：vad / voiceprint / asr / punc / emotion。"""
    return await _call("POST", f"/api/models/{key}/download")


@server.tool()
async def cancel_model_download(key: str) -> dict[str, Any]:
    """中断某个模型的下载。已下载的部分保留，下次从断点继续。"""
    return await _call("POST", f"/api/models/{key}/cancel")


# ---------------------------------------------------------------------------
# Speakers / voiceprints
# ---------------------------------------------------------------------------


@server.tool()
async def list_voiceprints() -> list[dict[str, Any]]:
    """列出已登记的声纹档案。"""
    return await _call("GET", "/api/voiceprints")


@server.tool()
async def rename_speaker(recording_id: str, speaker: str, name: str) -> dict[str, Any]:
    """把一条录音里某个说话人（如 "2"）改成真名。"""
    return await _call(
        "PATCH", f"/api/recordings/{recording_id}/speakers/{speaker}", json={"name": name}
    )


@server.tool()
async def list_speaker_candidates(recording_id: str) -> list[dict[str, Any]]:
    """列出这条录音里每个说话人的可用样本片段，用于建声纹档案。"""
    return await _call("GET", f"/api/recordings/{recording_id}/speaker-candidates")


@server.tool()
async def enroll_voiceprint(
    recording_id: str,
    speaker: str,
    name: str = "",
    profile_id: str = "",
    segment_ids: list[str] | None = None,
) -> dict[str, Any]:
    """用这条录音里某个说话人的片段建声纹档案（name），或补充到已有档案
    （profile_id）。不给 segment_ids 就自动挑质量最好的片段。"""
    payload: dict[str, Any] = {
        "recording_id": recording_id,
        "speaker": speaker,
        "segment_ids": segment_ids or [],
    }
    if profile_id:
        payload["profile_id"] = profile_id
    else:
        payload["name"] = name
    return await _call("POST", "/api/voiceprints/from-recording", json=payload)


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------


async def _resource(path: str) -> str:
    try:
        return await _call("GET", path)
    except ToolError as exc:
        raise ResourceError(str(exc)) from exc


@server.resource("aham://recording/{recording_id}/transcript")
async def transcript_resource(recording_id: str) -> str:
    """逐句转写稿。"""
    return await _resource(f"/api/recordings/{recording_id}/export/transcript.md")


@server.resource("aham://recording/{recording_id}/summary")
async def summary_resource(recording_id: str) -> str:
    """会议纪要。"""
    return await _resource(f"/api/recordings/{recording_id}/export/summary.md")


if __name__ == "__main__":
    server.run()
