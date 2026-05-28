# NewVoice — 录音转写与会议纪要

本地化的销售/项目会议录音处理工具。本机跑 FunASR + 说话人分离，云端调
DeepSeek 写纪要，最后把纪要回写到 NewCRM 商机/客户上。前端是 React + Vite
+ 兰之天 Aham 设计系统。

## 结构

```
backend/app/main.py           # FastAPI 后端（4000+ 行，路由 + ASR 调度 + DeepSeek + NewCRM 同步）
frontend/dist/                # 当前构建的前端静态产物（生产服务直接服务这里）
frontend-src/                 # 前端源码（Vite + React + TS + Tailwind v4 + Aham 设计系统）
frontend_static_server.py     # 单文件 Python SPA 静态服务器（端口 5173）
scripts/                      # 热词同步脚本（CRM / 企微日报 / 共享 lib）
.env.example                  # 必填环境变量样板
```

## 跑起来

1. 把 `.env.example` 复制成 `.env`，填好 `DEEPSEEK_API_KEY` + `NEWCRM_*`
2. 启动后端：
   ```
   /Users/.../.cache/recording-ai/venvs/asr/bin/python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```
3. 启动前端静态服务（开发场景可以用 vite dev）：
   ```
   python frontend_static_server.py    # 5173
   ```
4. 浏览器开 `http://localhost:5173/`，admin 默认密码 `orchisky888888`

## 前端开发

```
cd frontend-src
npm install
npm run dev          # vite 起在 5174，/api 代理到 8000
npm run build        # 输出到 ../frontend/dist
```

## 设计系统

前端使用 Aham 设计系统 v3+（claude.ai 风格的纸面感）。设计系统 CSS 文件
位于 `frontend-src/src/styles/`，主入口 `index.css`，定制扩展在
`app-extras.css`。

## NewCRM 集成

- 端点 `POST /api/external/transcripts/import` 在 NewCRM 那边接收转写 + 纪要
- 端点 `GET  /api/external/kingdee/hotword-corpus` 在 NewCRM 那边吐金蝶
  mirror（客户/商机/企业/跟进/拜访），供 NewVoice 的热词同步脚本采收

两个端点都用同一个 Bearer token（NewCRM 那边的
`LOCAL_TRANSCRIPT_IMPORT_TOKEN` env var）。

## 主要 API

| 路由 | 用途 |
|---|---|
| `POST /api/auth/login` | 登录，返回 session token |
| `GET  /api/me` | 当前用户 |
| `GET  /api/recordings` | 录音列表（scope=mine\|team） |
| `POST /api/recordings` | 上传录音（form-data，含自动处理标记） |
| `GET  /api/recordings/{id}` | 录音详情（含 transcript/summary/tasks/crm_sync） |
| `POST /api/recordings/{id}/summarize` | 触发 DeepSeek 生成纪要 |
| `POST /api/recordings/{id}/summary/revise` | 按自然语言要求重写纪要 |
| `POST /api/recordings/{id}/crm/sync` | 同步到 NewCRM |
| `GET/PATCH /api/hotwords` | 热词管理 |
| `POST /api/hotwords/sync` | 拉 CRM / 企微日报热词 |
| `GET/POST /api/voiceprints` | 声纹管理 |
| `GET/PATCH /api/users`, `/api/teams`, `/api/wecom/*` | 管理端 |

完整路由表在 `backend/app/main.py`，找 `@app.` 装饰器即可。
