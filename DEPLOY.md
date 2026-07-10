# AhamVoice 本地部署（从源码）

面向想在自己的 Mac 上从源码跑起来 / 自己打包 `.app` 的人。仓库里**只有代码**——
模型（约 4GB）、Python 重依赖、ffmpeg 都要按本文在本地准备好。

> 只支持 **Apple Silicon（M 系列）+ macOS 12 及以上**。

---

## 0. 前置条件

- Xcode Command Line Tools：`xcode-select --install`
- [Homebrew](https://brew.sh)
- Python 3.12（建议 `brew install python@3.12`）
- Node 18+（`brew install node`）
- ffmpeg：`brew install ffmpeg`

```bash
git clone https://github.com/Aham-AIAPP/aham-voice.git
cd aham-voice
```

---

## 1. 选一个数据目录（BASE）

应用把数据库、录音、模型、配置都放在一个数据目录里。默认是
`~/Library/Application Support/AhamVoice`；也可以用环境变量 `RECORDING_AI_HOME` 改到别处。

```bash
# 用默认目录：
export BASE="$HOME/Library/Application Support/AhamVoice"
# 或自定义并在每次跑后端时带上 RECORDING_AI_HOME=$BASE
mkdir -p "$BASE"
```

---

## 2. Python 虚拟环境 + 依赖

依赖较重（torch / funasr / modelscope / transformers），单独建一个 venv：

```bash
python3.12 -m venv "$BASE/venvs/asr"
"$BASE/venvs/asr/bin/pip" install -U pip
"$BASE/venvs/asr/bin/pip" install -r backend/requirements-asr.txt
```

`backend/requirements-asr.txt` 是冻结过的全量清单（含 torch 2.12 / funasr 1.3.7 /
modelscope 1.37 等），arm64 上 pip 会直接装到 CPU/MPS 版 torch。

> 之后命令里的 `<venv-python>` 都指 `"$BASE/venvs/asr/bin/python"`。

---

## 3. 下载 5 个本地模型（约 4GB）

全部来自 ModelScope 的 `iic` 命名空间，必须放到
`$BASE/models/modelscope/iic/<模型名>`（目录名要和下面完全一致）。
`modelscope` CLI 在第 2 步已随依赖装好：

```bash
MODELS="$BASE/models/modelscope/iic"
mkdir -p "$MODELS"
MS="$BASE/venvs/asr/bin/modelscope"

for m in \
  speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch \
  speech_fsmn_vad_zh-cn-16k-common-pytorch \
  punc_ct-transformer_cn-en-common-vocab471067-large \
  speech_campplus_sv_zh-cn_16k-common \
  emotion2vec_plus_large ; do
    "$MS" download --model "iic/$m" --local_dir "$MODELS/$m"
done
```

用途：paraformer=转写、fsmn_vad=断句、punc=标点、campplus=说话人分离/声纹、
emotion2vec=声学情绪。下载完目录应长这样：

```
$BASE/models/modelscope/iic/
├── speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
├── speech_fsmn_vad_zh-cn-16k-common-pytorch
├── punc_ct-transformer_cn-en-common-vocab471067-large
├── speech_campplus_sv_zh-cn_16k-common
└── emotion2vec_plus_large
```

> 备选：`git lfs install && git clone https://www.modelscope.cn/iic/<模型名>.git "$MODELS/<模型名>"`。

---

## 4. ffmpeg / ffprobe

后端用 ffmpeg 转码。dev 跑时让它能找到二进制，两种方式任选其一：

```bash
# A. 直接用 Homebrew 的（推荐 dev）
export AHAMVOICE_BIN_DIR=/opt/homebrew/bin
# B. 或拷进数据目录的 bin/
mkdir -p "$BASE/bin" && cp /opt/homebrew/bin/ffmpeg /opt/homebrew/bin/ffprobe "$BASE/bin/"
```

---

## 5. 构建前端

```bash
cd frontend-src && npm install && npm run build   # 产出 ../frontend/dist
cd ..
```

> 改了 `frontend-src` 必须重新 `npm run build`（`frontend/dist` 是被跟踪的）。

---

## 6. 跑起来（单进程）

```bash
RECORDING_AI_HOME="$BASE" AHAMVOICE_BIN_DIR=/opt/homebrew/bin \
  "$BASE/venvs/asr/bin/python" -m uvicorn backend.app.main:app --port 8765
# 浏览器打开 http://127.0.0.1:8765    （端口别用 5173/5174）
```

首次启动会在 `$BASE` 下建好 `app-data/`（库、录音、导出）。
转写/说话人/情绪全本地离线；**会议纪要 + 情绪语义分析需要云端 DeepSeek**——
打开左下「设置」填你自己的 DeepSeek API Key（仅存 `$BASE/config.json`，不上传）。

---

## 7. 打包成 .app + DMG（可选）

```bash
# 让打包脚本知道模型源在哪（第 3 步下载的目录）
AHAMVOICE_MODELS_SRC="$BASE/models/modelscope/iic" \
  bash packaging/macos/build_app.sh
# 约十几分钟，输出 ~/AhamVoice-build/AhamVoice.app + AhamVoice.dmg
```

脚本会内置 CPython(arm64) + 全部依赖 + 5 个模型 + 静态化 ffmpeg + 图标，ad-hoc 签名。
装到别的 Apple Silicon Mac：开 DMG 拖进「应用程序」，首次运行解除隔离：

```bash
xattr -dr com.apple.quarantine /Applications/AhamVoice.app
```

（或右键 → 打开 → 再点「打开」。）

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 启动报模型找不到 | 确认 `$BASE/models/modelscope/iic/` 下 5 个目录名完全一致，且非空 |
| 转写报 ffmpeg 相关错 | `AHAMVOICE_BIN_DIR` 指向含 ffmpeg/ffprobe 的目录，或拷进 `$BASE/bin/` |
| 纪要报 `DEEPSEEK_API_KEY ...` | 在「设置」页填 DeepSeek key（或写进 `$BASE/config.json`） |
| 前端连到 :8000 / 跨域 | dev 端口别用 5173/5174，用 8765 这类即可 |
| 装到别的 Mac 打不开 | 跑上面的 `xattr -dr com.apple.quarantine` |
