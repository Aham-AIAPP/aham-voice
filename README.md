# Orchisky Voice

> **内部版** · 销售 / 项目会议录音处理：本地转写 → DeepSeek 纪要与情绪分析
> Python FastAPI · FunASR · 说话人分离 · 前端 React 19 + Vite + Tailwind v4（Aham 设计系统）

## 它做什么

1. 本机跑 FunASR + 说话人分离，把录音转成带说话人的逐字稿；
2. 云端调 DeepSeek 生成会议纪要、对话情绪分析。

多用户：管理员 / 经理 / 成员三级；声纹、热词均支持个人 / 团队 / 全公司作用域。

## 密钥与配置（都不入库）

| 放哪 | 内容 | 是否进 git |
|---|---|---|
| 仓库根 `.env` | `DEEPSEEK_API_KEY`、`RECORDING_AI_HOME` | **否**（.gitignore）|
| 数据目录 `config.json` | 大模型 Key / Base / Model（管理员在「系统配置」页填）| 否（在 BASE 目录，不在仓库）|
| 数据目录 `app-data/newvoice.sqlite3` | 用户、录音、纪要、声纹、热词 | 否 |
| 数据目录 `internal_seed.json` | 内部版种子：员工名 + 客户热词 | 否（.gitignore）|

模板见 `.env.example`。**仓库内不含任何真实密钥 / 密码 / token。**

## 内部版种子数据（真实用户名 + 热词库）

真实**用户名**与**热词库**以种子文件形式换机 / 团队部署（不含密码 / 密钥 / 邮箱 / 手机号）。
种子里是员工名和客户名，**不入版本库**——放数据目录，仓库里只留结构模板：

- `/internal_seed.json` —— 真实种子：7 个用户（administrator + 6 销售部成员）+ 约 3300 条热词（客户 / 产品 / 行业术语）。已在 `.gitignore` 排除。
- `scripts/internal_seed.example.json` —— 结构模板（假数据），入库。
- `scripts/seed_internal.py` —— 幂等导入：用户按 `username`、热词按 `(word, owner)` 去重，可反复运行。
  查找顺序 `--seed <路径>` → `$INTERNAL_SEED_PATH` → `$RECORDING_AI_HOME/internal_seed.json`。

```bash
export RECORDING_AI_HOME=...                 # 指向数据目录（含 app-data/newvoice.sqlite3）
python3 scripts/seed_internal.py --dry-run   # 预览
python3 scripts/seed_internal.py             # 导入
```

导入的用户密码统一为 `NEWVOICE_INITIAL_PASSWORD`（默认 `orchisky888888`），**首次登录强制改**；邮箱按 `<username>@orchisky.cn` 合成。

## 部署要点

- FunASR / modelscope / torch 体积大，单独建 venv；模型放 `$RECORDING_AI_HOME/models/`。
- 后端 uvicorn :8000，前端静态服务 :5173，建议 launchd 托管（`com.newvoice.backend` / `com.newvoice.frontend`）。
- 本机部署的完整步骤、启停、运维见 [`部署说明-本机.md`](部署说明-本机.md)。

## 本次内部改造（2026-06）

- **UI 全面对齐 Aham 设计系统 v6.1**：单蓝 `#336EE8`、三层灰、卡片无边框无阴影、去衬线；新增统一弹窗（`ConfirmDialog` / `VoiceprintEditModal`）+ 焦点陷阱。
- **三功能对齐 aham-voice 开源版**（保留多用户作用域）：大模型配置（任意 OpenAI 兼容接口 + 测试连接）、热词（个人「、」分隔）、声纹（建/改/删 + 可见范围）。
- **清死功能**：砍热词在线更新、任务进度、占位管理页、顶栏死按钮；删后端死路由 / 孤儿前端 API。
- **代码质量**：内联样式抽成 token 原子工具层（`styles/utilities.css`，147→8 仅余动态值）；清死 CSS 约 1750 行（多 agent 审计 + 逐字回归核验）。

> 完整路由表见 `backend/app/main.py`（搜 `@app.` 装饰器）。
