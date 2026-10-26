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
不同时引入另一套会操作同一 DOM 的交互运行时。后端业务实现、SQLite 数据、
worker、OAuth/MCP 配置均不包含在本次变更中。

- 录音库：按更新日期分组，桌面 44px 单行；手机两行；搜索、类型、状态与可见范围保存在 URL，返回详情后保留条件。
- 详情：纪要与逐字稿直接展示；288px 属性栏；说话人命名与试听、历史纪要、情绪分析仍可使用。
- 状态操作：未处理时开始处理；纪要失败时只提交 summary_only；完成后导出所选版本。整条重新处理需确认。
- 排队后的详情持续刷新。检测纪要正文为空，不仅判断 done 标记。历史版本切换不会改写当前版本。
- 外框：220px 导航、收起与手机浮层；主题持久化；Ctrl/Cmd+B 导航，Ctrl/Cmd+K 搜索页面和当前页操作。
- 上传、热词、声纹、集成和管理页面沿用现有表单与权限，更新公共字体、颜色和控件。
- 修复说话人命名时 Enter 与 blur 重复提交；关闭自动处理时上传按钮显示“上传录音”。

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
上游关于侧栏底色、AI 灰底和紧凑行高的冲突，以 2.1/4.1 详细规则及 tokens 为准，
仅实现 44px 标准列表密度。

发布前应备份当前静态资源，在维护窗口切换已验证的构建，并进行真实账号烟雾检查。
本次代码验证不替代生产模型推理验证，也没有迁移或清理现有录音、用户和权限。
