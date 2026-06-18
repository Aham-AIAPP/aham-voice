# Orchisky Voice

> 内部销售 / 项目会议录音处理：本地转写 → DeepSeek 纪要 → 回写 Orchisky CRM
> Python FastAPI · FunASR · 说话人分离 · 前端 React + Vite
> 本项目原名 newvoice，「NewCRM」相关品牌已统一为 Orchisky CRM。

## 它做什么

1. 本机跑 FunASR + 说话人分离，把录音转成带说话人的逐字稿；
2. 云端调 DeepSeek 生成会议纪要、对话情绪分析；
3. 把纪要回写到 Orchisky CRM 的商机 / 客户上。

## 与 CRM 的对接

- `POST {NEWCRM_BASE_URL}/api/external/transcripts/import` —— 写入转写 + 纪要
- `GET  {NEWCRM_BASE_URL}/api/external/kingdee/hotword-corpus` —— 取金蝶镜像供热词同步
- 两个端点共用同一 Bearer token（CRM 侧 `LOCAL_TRANSCRIPT_IMPORT_TOKEN`）。

> 说明：环境变量名（`NEWCRM_*`）与 launchd 标签（`com.newvoice.*`）**沿用原名**，以兼容现有线上部署；这些是运行期契约，未随品牌改名而改动。

## 部署要点

- `.env` 至少填：`DEEPSEEK_API_KEY`、`NEWCRM_BASE_URL`、`NEWCRM_TRANSCRIPT_IMPORT_TOKEN`、`RECORDING_AI_HOME`。
- FunASR / modelscope / torch 体积大，单独建 venv；模型放 `$RECORDING_AI_HOME/models/`。
- 后端 uvicorn :8000，前端静态服务 :5173，建议 launchd 托管（`com.newvoice.backend` / `com.newvoice.frontend`）。
- 默认管理员 `administrator`，初始密码 `orchisky888888`（首次登录强制改）。

> 完整路由表见 `backend/app/main.py`（搜 `@app.` 装饰器）；运维排查见本仓库 git 历史中的原 README 段落。
