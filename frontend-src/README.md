# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Aham UI 9.1 改造

基线为 aham-ui 9.1.0，提交 `464daa3bc1db4d77b8a9f132e48bc7dda3d4dbf3`。
`src/styles/aham/tokens.json` 保留上游原始取值，`scripts/build-aham-tokens.mjs` 生成 CSS。
字体随应用自托管，许可在 `public/fonts/LICENSE.txt`。不再依赖 Google Fonts 请求。

React 继续管理路由、表单、请求和弹窗状态。通过 token 适配层统一旧组件，
不同时引入另一套会操作同一 DOM 的交互运行时。后端增加独立的纪要改写预览/确认接口和草稿表；MCP 同步增加纪要来源字段。
原有录音字段、worker 管道、OAuth 授权范围和管理权限保持兼容。

- 录音库：按更新日期分组，桌面 44px 单行；手机两行；搜索、类型、状态与可见范围保存在 URL，返回详情后保留条件。
- 详情：纪要与逐字稿直接展示；288px 属性栏；说话人命名与试听、历史纪要、情绪分析仍可使用。
- 状态操作：未处理时开始处理；纪要失败时只提交 summary_only；完成后导出所选版本。整条重新处理需确认。
- 排队后的详情持续刷新。检测纪要正文为空，不仅判断 done 标记。历史版本切换不会改写当前版本。
- 外框：220px 导航、收起与手机浮层；主题持久化；Ctrl/Cmd+B 导航，Ctrl/Cmd+K 搜索页面和当前页操作；? 查看快捷键（输入框内不触发）。
- 上传、热词、声纹、集成和管理页面沿用现有表单与权限，更新公共字体、颜色和控件。
- 修复说话人命名时 Enter 与 blur 重复提交；关闭自动处理时上传按钮显示“上传录音”。
- UI 精修：列表显示列名与分组数量；正文、来源、修改入口统一对齐；长内容阅读时保留播放器与章节导航，当前播放位置标记对应发言；手机控件扩大点击区域，统一“说话人 / 所属成员”术语。见 [精修说明与界面](../docs/ui-9.1-refinement.md)。

### 本地运行和验证

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5187 --strictPort
npm run build -- --outDir ../.run/ui-build
npm run check:tokens
npx playwright install chromium
npm run test:ui
```

生产默认构建目录仍是 `../frontend/dist`；验证时显式输出到 `.run/ui-build`。
开发代理默认使用本机 8000 端口；可用 `VOICE_API_TARGET` 指定隔离后端。
浏览器测试强制代理到测试专用 5189 端口，所有业务请求使用固定数据；
原生下载走测试 HTTP 服务，不会访问正在运行的业务后端。
测试只在 5188/5189 运行，和手动预览的 5187 分开。

有系统 Chrome 时也可以用环境变量指定可执行文件：
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:ui`。

后端测试从仓库根目录执行（使用装好相应依赖的 Python 环境）：

```sh
python -m unittest discover -s tests -p 'test_voice_pipeline.py' -v
python -m unittest discover -s tests -p 'test_voice_ui_contract.py' -v
python -m pytest tests/test_voice_oauth.py -q
```

后端测试全部使用临时数据库与文件；契约测试验证实际 HTTP 返回正文、历史版本下载、
上传字段、录音范围授权与只生成纪要的队列语义，不调用真实 ASR/LLM 服务。

### 验证边界

本次修改的 TypeScript/TSX 文件通过 ESLint，TypeScript 和生产构建通过。
全仓 `npm run lint` 仍有 8 项基线遗留错误，分布在 Icon、VoiceprintEditModal、
auth、Settings、Wecom、Hotwords 和 Preview，涉及 hooks 和 Fast Refresh 规则。
改造前为 11 项错误；未通过关闭规则掩盖这些问题。构建仍有原有的大 bundle 提示。

当前接入是保留业务行为的产品适配，不宣称已通过上游 Aham 全仓所有验收：
管理页的数据表格保留表头；录音上传保留独立路由；窄屏属性栏放到正文下方；
当前页命令搜索覆盖可点击操作，表单输入和选择仍通过 Tab 完成。
取舍以 `设计理念.md` 的可读、可用、防误操作、内容主次为先，再用规则与 tokens 落实细节。
侧栏底色和 AI 底色的细则差异记录为适配项；正文不增加装饰性卡片，列表采用 44px 标准密度。

发布时需要一起更新后端、MCP 服务与静态资源。先备份 SQLite 与当前静态资源，更新后端和 MCP 后再切换网页，并进行真实账号烟雾检查。
本次代码验证不替代生产模型推理验证，也没有迁移或清理现有录音、用户和权限。

### 设计理念复核与 API / MCP 契约

- 理念 1/3：按当前阶段显示下一步，标明正在等待录音服务还是等待用户核对。预览打开后，“确认应用改写”成为唯一主要操作，导出降为次要操作。
- 理念 4：还没有正文的纪要、逐字稿不占空板块；失败原因和重试入口保留在页首。情绪分析在转写完成后才提供。
- 理念 11：命令搜索加快捷键帮助；? 在输入时保持正常输入。
- 理念 13：`owner_name` 的页面用语为“所属成员”，没有新增或改名数据库字段，也没有把录音归属伪装成任务负责人。
- 理念 14：纪要、情绪分析与改写预览标明 AI 来源，并链接本录音的逐字稿。该链接提供核对材料，不代表每个结论已被人工核验。改写先预览，对照原文后明确确认才生效。

| 契约 | 本次变化 | 兼容与验证 |
| --- | --- | --- |
| `Recording`、上传字段、处理状态 | 保留原字段和值；阶段描述由 UI 派生 | 上传、权限、队列与 worker 回归 |
| `Summary.evidence` | 可选新增 `{kind: "transcript", recording_id, title}` | 网页和 MCP 通过同一后端 `summary_payload` 生成 |
| `voice_get_summary` | 既有字段保留，新增 `id/recording_id/base_summary_id/is_current/evidence` | 工具仍只读；返回当前生效版，绝不读取草稿表；默认读取与可选管理 scope 不变 |
| `POST /summary/revise/preview` | 返回 `draft_id/base_summary_id/base_content/content/model/created_at/status/evidence`；`status=awaiting_confirmation` | 仅保存独立草稿；不更改录音状态、当前纪要、历史版本或导出 |
| `POST /summary/revise/apply` | 接收 `draft_id`；返回原有版本结果结构 `recording_id/summary_id/version/model` | 服务端采用存储的预览正文；用户、录音、基准版本和逐字稿哈希均校验；事务保证重复提交不重复保存 |
| `summary_revision_drafts` | 新增独立表，不改动旧字段 | 未应用草稿 24 小时失效，后续预览时清理过期草稿；取消不会产生生效纪要 |
| 旧 `POST /summary/revise` | 保留原有立即生成新版本的接口契约 | 供旧客户端兼容；新版网页完全不调用；MCP 从未提供此写工具 |

兼容范围：既有自动转写、自动生成纪要和钉钉回写按原配置运行，未擅自改为人工审批队列。
因此本轮“先预览再生效”适用于新版网页的**纪要改写**，不是整个后台管道的全面重构。
若要后续统一旧客户端和自动管道，也应单独设计版本迁移与人工审核状态，而不能仅靠换文案。

前后端需要成套部署：原端口 8000 若仍是旧版本，不支持新增的预览/确认接口；不可只替换静态包。
当前工作副本测试使用临时数据库与虚构浏览器数据，正式数据库没有执行新增表迁移。
