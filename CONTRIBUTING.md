# 贡献指南

Aham Voice 是一个单机 macOS 桌面应用（FastAPI 后端 + React 前端，pywebview 打包）。欢迎 issue 与 PR。

## 本机开发

```bash
cd frontend-src && npm install && npm run build    # 产出 ../frontend/dist
cd .. && <venv-python> -m uvicorn backend.app.main:app --port 8765
# 浏览器打开 http://127.0.0.1:8765   （端口别用 5173/5174）
```

- 改了 `frontend-src/` **必须**重新 `npm run build`——`frontend/dist` 是被跟踪的构建产物。
- 后端语法自检：`<venv-python> -m py_compile backend/app/main.py`。
- 模型 / 依赖 / ffmpeg 安装与从源码部署见 [DEPLOY.md](DEPLOY.md)。

## 约定

- 提交信息用中文、`类型: 说明` 结构（`feat:` / `fix:` / `docs:` / `refactor:` 等）。
- UI 改动对齐 [Aham UI](https://github.com/Aham-AIAPP/aham-ui) 设计规范（单蓝点缀、三层灰、扁平、仅浮层有阴影、状态用点+文字不用红黄绿灯）。

## 发版流程（维护者）

遵循 [SemVer](https://semver.org/lang/zh-CN/) + [Keep a Changelog](https://keepachangelog.com/zh-CN/)：

1. **定版本号**：破坏性 = MAJOR、向后兼容新功能 = MINOR、修复 = PATCH。
2. **升版本号**：`frontend-src/package.json` 的 `version`、`packaging/macos/build_app.sh` 的 `CFBundleVersion` / `CFBundleShortVersionString`。
3. **更新 `CHANGELOG.md`**：把 `[Unreleased]` 内容移入 `## [X.Y.Z] - YYYY-MM-DD`，按 新增 / 变更 / 修复 / 移除 分组，底部补版本链接。
4. **提交推送**：`git commit && git push`。
5. **打包 + 发布**：`bash packaging/macos/build_app.sh` 出 DMG → 因体积超 GitHub 单文件上限需分卷 → `gh release create vX.Y.Z --title "…" --notes-file … --latest` 并上传分卷。
