# Changelog 更新日志

本项目所有重要变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更
- 仓库迁移至新账号 [Aham-AIAPP](https://github.com/Aham-AIAPP)（旧账号不可用），全部链接更新；README 徽章行加「联系我（微信）」，「关于 Aham」加公众号/作者微信二维码，产品矩阵补 Aham Word。


## [2.0.0] - 2026-06-21

从团队协作版收敛为**单机个人版**，并对齐 Aham UI v6.1 全面重构界面。

### 新增
- **热词 txt 批量导入**：热词页单一富文本框（顿号「、」分隔），支持导入、校验（仅中文/字母/数字）、按拼音排序。
- **跨录音声纹自动识别**：点说话人 → 命名 + 备注 → 建立声纹，后续录音自动认出同一人。
- **说话人卡片试听**：播放 / 下一段按钮边听边确认是谁在说；点名字行内改名，不再弹窗。
- **大模型测试连接**：设置页一键测活 OpenAI 兼容接口，通过即标「已配置」。
- **任意 OpenAI 兼容接口**：不再限定 DeepSeek，支持 OpenAI / 通义千问 / Kimi / 智谱 / Ollama / 自定义。
- **纯 arm64 自包含 DMG**：内置 CPython + 5 个模型 + 静态 ffmpeg，开箱即用、只需填 API Key。
- 纳入 Aham UI v6.1 的 9 个招牌组件（媒体播放器 / 逐句转写 + 说话人标记 / 正文排版 / 对话输入等）。

### 变更
- **产品定位：团队版 → 单机个人版**。无登录、无多用户、无团队 / 权限。
- **应用更名** `AhamVoice` → `Aham Voice`（显示名；构建包与数据目录标识保持 `AhamVoice` 不变）。
- **界面全面对齐 Aham UI v6.1**：网页轨页面骨架、组件规范化（22 项自写类整改到官方类）、字体 / 颜色 / 布局统一。
- 默认落地页改为「新增录音」；「设置」从导航目录移到侧栏左下角。
- 录音详情的「修改纪要」改用官方对话输入组件。

### 修复
- 转写标点乱码（损坏的标点模型权重）。
- 说话人数（`speaker_count`）未写入、详情页「未配置」状态闪烁。
- 热词导入 / 保存来源不一致导致的往返丢词。
- DMG 误触发 Rosetta（瘦身 universal2 库为纯 arm64）。

### 移除
- 团队 / 多用户 / 权限相关：账号区、「我的 / 全部」过滤、任务进度独立页、客户 / 项目字段。
- 清理种子数据中的真实 / 示例人名与团队。

## [1.0.0] - 2026-06-18

- 首个版本：本地离线录音转写（FunASR paraformer + VAD + 标点）、说话人分离（CAM++）、声学情绪（emotion2vec）；会议纪要与情绪语义分析走云端大模型（OpenAI 兼容接口，比如 DeepSeek 等）。macOS 单机桌面应用。

[Unreleased]: https://github.com/Aham-AIAPP/aham-voice/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Aham-AIAPP/aham-voice/releases/tag/v2.0.0
[1.0.0]: https://github.com/Aham-AIAPP/aham-voice/releases/tag/v1.0.0
