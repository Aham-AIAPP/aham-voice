# MCP 接入（Claude Desktop）

把 Aham Voice 作为 MCP server 暴露给 Claude Desktop，让模型能导入录音、写会前上下文、启动处理、读取转写与纪要、维护热词和声纹。

服务器是薄壳：每个工具都对应桌面应用已有的本地 HTTP 接口。**应用没打开时所有工具都会失败**，这是刻意的——数据和模型都在应用里。

## 工作原理

应用启动时把端口和一个本地 token 写到 `~/Library/Application Support/AhamVoice/runtime.json`（权限 0600）。MCP server 读它来找到应用，所以端口变了也不用改配置。

## 安装

需要 Python 3.10+。推荐用 uv，不用自己建 venv：

```bash
uv run --with mcp --with httpx python /绝对路径/aham-voice/mcp-server/aham_voice_mcp.py
```

跑通不报错（会静默等待 stdio 输入）就说明依赖齐了，Ctrl+C 退出。

## 配置 Claude Desktop

> 最省事的办法：打开 Aham Voice →「设置 → 接 AI 助手（MCP）」，那里会按你这台机器的真实路径生成好配置，点一下复制即可。下面是手写版。


编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "aham-voice": {
      "command": "uv",
      "args": [
        "run", "--with", "mcp", "--with", "httpx",
        "python", "/绝对路径/aham-voice/mcp-server/aham_voice_mcp.py"
      ]
    }
  }
}
```

`uv` 不在 PATH 里就写全路径（通常是 `~/.local/bin/uv`）。也可以指向自己的 venv：

```json
{
  "mcpServers": {
    "aham-voice": {
      "command": "/绝对路径/venv/bin/python",
      "args": ["/绝对路径/aham-voice/mcp-server/aham_voice_mcp.py"]
    }
  }
}
```

改完重启 Claude Desktop。

装的是 DMG 版、没有源码仓库时，脚本在应用包里：

```
/Applications/Aham\ Voice.app/Contents/Resources/app/mcp-server/aham_voice_mcp.py
```

## 典型用法：带背景的转写

会前上下文是这套集成的重点。全局热词是静态的，而每场会的专名是临场的——你在对话里把背景说清楚，模型把里面的专名提炼出来，这批词在本次转写里优先级最高。

```
我：把 ~/Desktop/0908.m4a 导进来。这次是跟明远科技谈 MES 二期，
    客户方张伟和李娜，会聊到安灯、排产、某平台。

Claude：[import_recording]        → 导入，先不处理
        [set_recording_context]   → briefing + terms: 明远科技/安灯/排产/某平台
        [start_processing]        → 开始转写
        [get_recording]           → 轮询进度
        [get_transcript]          → 出稿
```

顺序要紧：`import_recording` 默认 `start_now=false`，先留出写上下文的窗口，否则上传即转写，热词来不及生效。已经转写过的录音，改完上下文要再调一次 `start_processing`。

术语有硬约束（ASR 偏置对不满足的词无效）：2–8 个字、不含空格、不是纯数字或编号、不带「公司/集团/股份/有限/责任」这类书面组织词。被拒的词会带原因返回，模型可以改写后重提——例如「某某科技股份有限公司」要换成「明远科技」。

转写完 `get_recording_context` 会给出每个术语的真实命中次数：命中多的值得用 `add_hotwords` 提升为常驻热词，命中 0 的随录音留着，不污染主库。

## 工具

| 工具 | 作用 |
|---|---|
| `list_recordings` / `get_recording` | 列录音 / 查状态与任务进度 |
| `import_recording` | 按本机路径导入（复制，不动原文件） |
| `set_recording_context` / `get_recording_context` | 会前上下文：背景 + 本场专名，含命中统计 |
| `start_processing` | 开始或重跑转写 + 纪要 |
| `get_transcript` / `get_summary` | 取逐句稿 / 纪要（Markdown） |
| `generate_summary` / `revise_summary` | 重新成稿 / 按指令改写 |
| `list_hotwords` / `add_hotwords` / `delete_hotword` | 常驻热词库 |
| `list_models` / `download_models` | 本地模型状态与下载（首次使用要先下模型） |
| `list_voiceprints` / `enroll_voiceprint` | 声纹档案 |
| `rename_speaker` / `list_speaker_candidates` | 说话人改名 / 可用样本片段 |

资源：`aham://recording/{id}/transcript`、`aham://recording/{id}/summary`。

## 安全

本地 API 一直是无鉴权的（只监听 127.0.0.1）。接了 MCP 之后，本机任何进程都能读走全部录音和纪要。要收紧就设 `AHAMVOICE_REQUIRE_TOKEN=1`，此后所有 `/api/` 请求都必须带 runtime.json 里的 token（`X-Aham-Token` 头或 `?token=`）。

**注意**：打开它会同时挡住应用自己的窗口——内置前端目前不带 token。所以默认关闭，等前端也带上 token 之后再改默认值。
