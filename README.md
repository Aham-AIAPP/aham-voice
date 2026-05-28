# NewVoice — 录音转写与会议纪要

本地化的销售/项目会议录音处理工具。本机跑 FunASR + 说话人分离，云端调
DeepSeek 写纪要，最后把纪要回写到 NewCRM 商机/客户上。前端是 React + Vite
+ 兰之天 Aham 设计系统。

## 结构

```
backend/app/main.py           # FastAPI 后端（4300+ 行，路由 + ASR 调度 + DeepSeek + NewCRM 同步）
frontend/dist/                # 当前构建的前端静态产物（生产服务直接服务这里）
frontend-src/                 # 前端源码（Vite + React + TS + Tailwind v4 + Aham 设计系统）
frontend_static_server.py     # 单文件 Python SPA 静态服务器（端口 5173）
scripts/                      # 热词同步脚本（CRM / 企微日报 / 共享 lib）
.env.example                  # 必填环境变量样板
```

---

## 从 GitHub 拉下来部署

### 1. clone + 准备目录

```bash
git clone https://github.com/li599198347-svg/newvoice.git
cd newvoice
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填：
#   DEEPSEEK_API_KEY     — DeepSeek 控制台拿
#   NEWCRM_BASE_URL      — 你的 NewCRM 部署地址（如 https://ai.orchisky.cn）
#   NEWCRM_TRANSCRIPT_IMPORT_TOKEN  — NewCRM 那边 .env 里的 LOCAL_TRANSCRIPT_IMPORT_TOKEN
#   RECORDING_AI_HOME    — 本地数据目录，例如 /Users/<you>/.cache/recording-ai
```

### 3. 准备 Python venv（FunASR + 依赖较重）

```bash
# 建议单独建一个 venv，因为 FunASR + modelscope + torch 体积大
mkdir -p $RECORDING_AI_HOME/venvs
python3 -m venv $RECORDING_AI_HOME/venvs/asr
$RECORDING_AI_HOME/venvs/asr/bin/pip install -U pip
$RECORDING_AI_HOME/venvs/asr/bin/pip install -r backend/requirements.txt
# 然后按 FunASR 文档安装 funasr / modelscope / torch（不在 requirements.txt 里，体积太大）
```

模型文件需要先放到 `$RECORDING_AI_HOME/models/modelscope/iic/`：

```
speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch    # 转写
speech_fsmn_vad_zh-cn-16k-common-pytorch                              # VAD
punc_ct-transformer_cn-en-common-vocab471067-large                    # 标点
speech_campplus_sv_zh-cn_16k-common                                   # 说话人分离 / 声纹
```

`ffmpeg` / `ffprobe` 二进制放到 `$RECORDING_AI_HOME/bin/`。

### 4. 构建前端

```bash
cd frontend-src
npm install
npm run build              # 输出到 ../frontend/dist
cd ..
```

### 5. 启动后端 + 前端静态服务

```bash
# 后端 — uvicorn 在 8000
$RECORDING_AI_HOME/venvs/asr/bin/python -m uvicorn backend.app.main:app \
    --host 0.0.0.0 --port 8000 \
    >> logs/backend.runtime.log 2>> logs/backend.runtime.err.log &

# 前端静态服务 — 端口 5173
python3 frontend_static_server.py \
    >> logs/frontend.runtime.log 2>> logs/frontend.runtime.err.log &
```

打开浏览器：`http://localhost:5173/`

**默认管理员**：用户名 `administrator`、初始密码 `orchisky888888`（首次登录强制改）

### 6. 推荐：用 launchd 托管（macOS）

让两个服务跟着系统启动 + 自动重启：

```bash
# 把下面两个文件放到 ~/Library/LaunchAgents/，然后 launchctl load 它们
# com.newvoice.backend.plist  — 拉 uvicorn
# com.newvoice.frontend.plist — 拉 frontend_static_server.py
```

样例 plist 见仓库 `docs/launchd/`（如果以后补的话）。当前本机用法是：

```xml
<dict>
  <key>Label</key><string>com.newvoice.backend</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>cd /path/to/newvoice && exec $RECORDING_AI_HOME/venvs/asr/bin/python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 >> logs/backend.runtime.log 2>> logs/backend.runtime.err.log</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
```

---

## 日常代码同步

```bash
cd /path/to/newvoice
git add -A
git commit -m "你的描述"
git push
```

后端改了 Python 代码 → SIGTERM uvicorn 让 launchd 重启它：

```bash
kill -TERM $(lsof -nP -iTCP:8000 -sTCP:LISTEN | awk 'NR==2 {print $2}')
# launchd 会在 1-2 秒内自动拉新进程加载新代码
```

前端改了 React → 重新 build：

```bash
cd frontend-src && npm run build
# 然后浏览器硬刷（⌘+Shift+R）
```

---

## 前端开发

```bash
cd frontend-src
npm install
npm run dev          # vite 起在 5174，/api 自动代理到 localhost:8000
npm run build        # 一次性输出到 ../frontend/dist
```

开发模式下后端必须先起在 8000，否则前端 fetch 会 connection-refused。

---

## 设计系统

前端使用 Aham 设计系统 v3+（claude.ai 风格的纸面感）。

| 文件 | 用途 |
|---|---|
| `frontend-src/src/styles/index.css` | 入口，按顺序 import 下面所有 |
| `design-tokens.css` | oklch 色板 + spacing/radii/shadows/motion |
| `colors_and_type.css` | 元素级 typography + 三种列表 + 文件预览壳 |
| `tailwind.theme.css` | Tailwind v4 `@theme` 桥接，可直接用 `bg-canvas` 这种 utility |
| `components-shell.css` | app-shell / breadcrumb / page-head / 5 个页模板 |
| `components-{ai,business,ops,identity,conversation}.css` | 各领域组件 |
| `app-extras.css` | 设计系统 README 写了但 CSS 没出的原语：`.btn` `.field` `.card` `.icon-btn` `.menu` `.markdown` `.nv-timeline` + app-shell 高度修复 + split-panel 容器约束 + 录音详情布局 |

---

## NewCRM 集成

- 端点 `POST /api/external/transcripts/import` 在 NewCRM 那边接收转写 + 纪要
- 端点 `GET  /api/external/kingdee/hotword-corpus` 在 NewCRM 那边吐金蝶
  mirror（客户/商机/企业/跟进/拜访），供 NewVoice 的热词同步脚本采收

两个端点都用同一个 Bearer token（NewCRM 那边的
`LOCAL_TRANSCRIPT_IMPORT_TOKEN` env var）。

---

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

---

## 运维 / 故障排查

| 现象 | 排查 |
|---|---|
| 上传后录音卡在 `queued` | uvicorn 重启过；启动时会自动恢复（`recover_queued_recordings`）— 等几秒看 |
| 纪要 `failed: DEEPSEEK_API_KEY is not configured` | `.env` 里 `DEEPSEEK_API_KEY=` 是否填？launchd 起的 uvicorn 不读 shell env，**必须**写在 .env |
| CRM 同步 `failed: All connection attempts failed` | `NEWCRM_BASE_URL` 配错了 / NewCRM 服务挂了。本机 curl 验证 |
| `tmp/` 目录爆磁盘 | `NEWVOICE_TMP_TTL_HOURS`（默 24）+ `NEWVOICE_SWEEP_INTERVAL_MINUTES`（默 60）。启动会立刻清一次 |
| ASR 并发崩溃 / 模型状态错乱 | 已加 `_asr_lock` 全局序列化 + 启动时初始化锁 + 模型 single-load |
| 管理员把自己降级了登不上 | DB 里把 administrator 的 role 改回 admin。`_guard_admin_change` 防自降级，但已有数据可能未受保护 |
| 前端硬刷后还显示旧版 | Safari ⌘+Shift+R 或者 Chrome DevTools → 禁 cache → reload |

日志：
- `logs/backend.runtime.log` / `.err.log` — uvicorn stdout/stderr
- `logs/frontend.runtime.log` / `.err.log` — Python 静态服务器访问日志
- audit 表（sqlite）— `actor / category / message` 三元组覆盖所有用户操作和系统事件
