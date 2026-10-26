# Orchisky Voice — Ubuntu 22.04 + NVIDIA GPU 部署说明

> 本文档面向**执行部署的人或 AI**。前提：只有本仓库源码 + 一台干净的 Ubuntu 22.04 服务器。
> 按顺序执行即可，每步都给了验证方法。遇到与文档不符的现象，**停下来报告，不要猜着往下走**。
>
> 本机（macOS）部署见 [`部署说明-本机.md`](部署说明-本机.md)。两者共用同一套代码，差异只在
> 系统依赖、推理设备和进程托管方式。

---

## 0. 需要人工提供的三样东西

仓库里**没有**、必须由项目负责人另行提供，否则部署无法完成或功能不全：

| 缺什么 | 用途 | 没有会怎样 |
|---|---|---|
| `internal_seed.json` | 内部版种子：员工账号 + 客户热词库 | 系统能跑，但没有用户，需手工建账号；热词为空，转写专有名词准确率下降 |
| 大模型 API Key | 会议纪要、情绪语义分析 | 转写正常，但生成不了纪要 |
| 既有业务数据（可选） | 从旧机迁移录音 / 数据库 / 声纹 | 全新空库开始 |

种子文件结构见 `scripts/internal_seed.example.json`。Key 可以部署完成后在网页
「管理 → 大模型配置」里填，不必阻塞部署。

---

## 1. 目标硬件与可行性结论

本说明按以下配置验证过适配性：

| 部件 | 配置 | 结论 |
|---|---|---|
| CPU | Intel Xeon Gold 6430 ×2（32C64T ×2 = 64C128T，Sapphire Rapids） | 远超需求 |
| 内存 | 三星 32G DDR5-4800 ×2 = 64G | 容量够用，但见下方**内存插法警告** |
| GPU | GeForce RTX 4090 24G 涡轮 | 完全够，5 个模型总权重 3.9G |
| 存储 | 三星 1.92T SATA 企业级 SSD ×2 + LSI 9364-8i 阵列卡 | 建议做 RAID1，可用 1.92T |
| 网卡 | 英特尔 X540-T2 双口万兆 | 够用 |
| 平台 | RG4208 V4 4U，2600W 钛金 ×4 | 单卡下电源冗余极大 |

### 结论：可行，GPU 会带来明显提速

现有基线是 Apple M4 / 10 核 / 16G，**纯 CPU 推理**。换到 4090 后 ASR 与情绪分析走
CUDA，单个录音的转写延迟会大幅下降。

### ⚠️ 内存插法警告（部署前先确认）

双路主板 32 个 DIMM 槽只插 2 条，有两种插法，后果差别很大：

- **两条都插在 CPU0** → CPU1 没有本地内存，它的所有内存访问都要跨 UPI 走远程，NUMA 惩罚严重。
- **每路各一条** → 每颗 CPU 的 8 个内存通道只用了 1 个，内存带宽只有满配的 1/8。

对**本应用**（推理在 GPU 上、CPU 主要做 ffmpeg 转码和 Web 服务）影响有限，64G 容量也够
（torch + 5 个模型常驻约 6–8G）。但如果以后要回退 CPU 推理、或跑并发任务，这会成为瓶颈。

**建议**：至少每路补到 4 条（8×32G=256G），让内存控制器跑起来。现状能用，不阻塞部署。

### ⚠️ 架构限制：这台服务器对当前代码是过剩的

`backend/app/main.py` 里 ASR、说话人验证、情绪分析共用一把**进程级全局锁**
（`_asr_lock`，见文件内注释：FunASR 的 `AutoModel` 与 modelscope pipeline 都持有跨调用的
内部状态，并发会损坏）。也就是说：

**无论多少核、多少显存，同一时刻只有一个转写任务在跑。**

64C128T + 4090 的算力吃不满是**设计使然，不是部署没做对**。要利用起来需要改架构
（多 worker 进程各持一份模型 + 任务队列），不在本次部署范围内。请勿为此反复调参。

---

## 2. 系统准备

### 2.1 基础包

```bash
sudo apt update
sudo apt install -y build-essential git curl ca-certificates ffmpeg sqlite3
```

`ffmpeg` 是必需的：录音要重采样到 16kHz 单声道、切片、抽取声纹片段，全部靠它。

验证：

```bash
ffmpeg -version | head -1
ffprobe -version | head -1
```

### 2.2 NVIDIA 驱动（关键，版本不能低）

本项目锁定 `torch==2.12.0`。**该版本的 Linux 轮子自带 CUDA 13.0.2 运行时**
（依赖 `cuda-toolkit==13.0.2`、`nvidia-cudnn-cu13`），因此要求：

> **NVIDIA 驱动 ≥ 580**

Ubuntu 22.04 自带仓库里的驱动版本**不够新**，必须用 NVIDIA 官方仓库：

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update
sudo apt install -y nvidia-driver-580-open   # 或仓库中更高的版本
sudo reboot
```

重启后验证：

```bash
nvidia-smi
```

必须能看到 RTX 4090 和驱动版本号。**`Driver Version` 低于 580 就不要继续**——
后面 `torch.cuda.is_available()` 一定是 False，白装一遍。

> 只需要驱动，**不需要单独装 CUDA Toolkit**——CUDA 运行时由 pip 装 torch 时一并带入。

### 2.3 Python 3.12

Ubuntu 22.04 默认是 Python 3.10，而本项目验证环境是 **3.12**（代码用了 3.10+ 语法，
依赖锁定按 3.12 解析）：

```bash
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3.12-dev
python3.12 -V    # 应输出 Python 3.12.x
```

### 2.4 Node.js（可选）

**通常不需要**——仓库里已经带了构建好的前端 `frontend/dist/`，直接就能用。

只有当你要改前端源码（`frontend-src/`）重新构建时才需要 Node。项目用 Vite 8 /
React 19 / TypeScript 6，需 **Node ≥ 22**：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 3. 目录规划

```bash
sudo mkdir -p /opt/orchisky-voice          # 源码
sudo mkdir -p /srv/orchisky-voice-data     # 数据目录（RECORDING_AI_HOME）
sudo chown -R "$USER:$USER" /opt/orchisky-voice /srv/orchisky-voice-data
```

数据目录最终会长成这样（**总计约 15G 起步，录音持续增长**）：

```
/srv/orchisky-voice-data/
├── venvs/asr/                    # Python 虚拟环境（CUDA 版 torch，约 8–10G）
├── models/modelscope/iic/        # 5 个本地模型，3.9G
├── app-data/
│   ├── newvoice.sqlite3          # 数据库：用户/录音/纪要/热词
│   ├── recordings/               # 原始录音（主要增长项）
│   ├── exports/                  # 导出的 md
│   └── tmp/                      # 转码中间文件，自动清理
├── voiceprints/                  # 声纹样本
├── bin/{ffmpeg,ffprobe}          # 指向系统 ffmpeg 的软链
├── config.json                   # 大模型配置（网页端写入）
└── internal_seed.json            # 内部版种子（人工放入，不在仓库里）
```

> 存储放在 RAID1 上。1.92T 可用容量，按旧机 43 个录音占 2.6G 估算，够用很久。

---

## 4. 拉源码

```bash
git clone https://github.com/Orchisky/orchisky-voice.git /opt/orchisky-voice
cd /opt/orchisky-voice
```

私有仓库，需要有权限的凭据（`gh auth login` 或 SSH key / PAT）。

---

## 5. Python 环境与依赖

### 5.1 建 venv

```bash
python3.12 -m venv /srv/orchisky-voice-data/venvs/asr
source /srv/orchisky-voice-data/venvs/asr/bin/activate
pip install -U pip wheel setuptools
```

国内网络建议配镜像（模型走 ModelScope，本身就是国内直连）：

```bash
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

### 5.2 先装 torch（体积大，单独装便于排错）

```bash
pip install torch==2.12.0 torchaudio==2.11.0
```

Linux x86_64 的 PyPI 轮子自带 CUDA 13.0.2，**不要**加 `--index-url .../whl/cpu`，
那会装成 CPU 版，4090 就白买了。

**立刻验证**，不通过就不要往下走：

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

期望输出类似：`2.12.0 True NVIDIA GeForce RTX 4090`

`False` 的排查顺序：`nvidia-smi` 能否输出 → 驱动是否 ≥ 580 → 是否装成了 CPU 版
（`pip show torch` 看是否有 nvidia-* 依赖）。

### 5.3 装其余依赖

```bash
cd /opt/orchisky-voice
pip install -r backend/requirements-asr.txt
```

该文件是从已验证的生产环境导出的完整锁定清单（111 个包，含 funasr 1.3.7 /
modelscope 1.37.1 / transformers 5.9.0 等）。它里面也有 `torch==2.12.0`，
pip 会识别为已满足，不会重装。

> `backend/requirements.txt` 只有 Web 层的 5 个包（fastapi/uvicorn/…），**不足以跑起 ASR**。
> 一定要用 `requirements-asr.txt`。

---

## 6. 下载模型（3.9G，5 个）

模型不入库，需从 ModelScope 下载到指定路径。**目录名必须精确匹配**，代码按路径硬编码查找
（见 `backend/app/main.py` 顶部 `MODELS` / `VAD` / `PUNC` / `PARAFORMER` / `CAMPLUS` / `EMOTION`）。

```bash
source /srv/orchisky-voice-data/venvs/asr/bin/activate
export MODEL_DIR=/srv/orchisky-voice-data/models/modelscope/iic
mkdir -p "$MODEL_DIR"

python - <<'PY'
import os
from modelscope import snapshot_download

root = os.environ["MODEL_DIR"]
models = [
    "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",  # ASR 主模型 953M
    "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",                                  # 断句 VAD 3.9M
    "iic/punc_ct-transformer_cn-en-common-vocab471067-large",                        # 标点 1.1G
    "iic/speech_campplus_sv_zh-cn_16k-common",                                       # 说话人 CAM++ 28M
    "iic/emotion2vec_plus_large",                                                    # 声学情绪 1.8G
]
for mid in models:
    target = os.path.join(root, mid.split("/", 1)[1])
    print("下载:", mid, "->", target, flush=True)
    snapshot_download(mid, local_dir=target)
print("全部完成")
PY
```

验证 5 个目录都在且体积合理：

```bash
du -sh /srv/orchisky-voice-data/models/modelscope/iic/*
```

期望（±10% 正常）：

```
953M  speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
3.9M  speech_fsmn_vad_zh-cn-16k-common-pytorch
1.1G  punc_ct-transformer_cn-en-common-vocab471067-large
 28M  speech_campplus_sv_zh-cn_16k-common
1.8G  emotion2vec_plus_large
```

---

## 7. ffmpeg 软链

代码从 `$RECORDING_AI_HOME/bin/ffmpeg` 调用，不走 PATH 查找：

```bash
mkdir -p /srv/orchisky-voice-data/bin
ln -sf "$(command -v ffmpeg)"  /srv/orchisky-voice-data/bin/ffmpeg
ln -sf "$(command -v ffprobe)" /srv/orchisky-voice-data/bin/ffprobe
/srv/orchisky-voice-data/bin/ffmpeg -version | head -1
```

---

## 8. 配置 `.env`

```bash
cd /opt/orchisky-voice
cp .env.example .env
```

编辑 `.env`，Linux + GPU 部署的最小配置：

```ini
RECORDING_AI_HOME=/srv/orchisky-voice-data

# 让 ASR / 情绪模型走 GPU。不设则默认 cpu（macOS 本机部署的默认值）。
NEWVOICE_ASR_DEVICE=cuda:0

# 新建用户的初始密码，首次登录强制修改
NEWVOICE_INITIAL_PASSWORD=orchisky888888
```

`NEWVOICE_ASR_DEVICE` 是本次为 Linux 部署新增的开关，会同时作用于：
FunASR 主模型（ASR + VAD + 标点 + 说话人）、emotion2vec 情绪模型、
以及 modelscope 的说话人验证 pipeline（内部自动映射为 `gpu`）。

大模型 Key **建议不写在 `.env`**——留空，部署完成后由管理员在网页
「管理 → 大模型配置」填写，存进 `config.json`。`.env` 里一旦设了非空值会**覆盖**网页配置。

`.env` 在 `.gitignore` 里，永远不要提交。

---

## 9. 首次启动与初始化

### 9.1 手工起一次，确认能跑

```bash
cd /opt/orchisky-voice
source /srv/orchisky-voice-data/venvs/asr/bin/activate
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

首次启动会自动建 sqlite 表结构。看到 `Application startup complete.` 即成功。
另开一个终端：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/me
```

返回 **401** 就是对的（未登录）——说明后端活着、路由正常。
返回连接拒绝说明没起来，去看终端报错。

确认无误后 Ctrl-C 停掉，交给 systemd。

### 9.2 导入种子数据（有 `internal_seed.json` 才做）

把人工提供的种子文件放到数据目录，然后：

```bash
cp /path/to/internal_seed.json /srv/orchisky-voice-data/internal_seed.json

cd /opt/orchisky-voice
source /srv/orchisky-voice-data/venvs/asr/bin/activate
export RECORDING_AI_HOME=/srv/orchisky-voice-data

python scripts/seed_internal.py --dry-run   # 先预览
python scripts/seed_internal.py             # 确认无误再导入
```

脚本幂等：用户按 `username` 去重、热词按 `(word, owner)` 去重，重复运行只会「跳过」。
导入的用户密码统一为 `NEWVOICE_INITIAL_PASSWORD`，**首次登录强制修改**。

没有种子文件时，脚本会报出它找过的路径并退出，属正常行为。此时需手工创建管理员账号。

---

## 10. systemd 托管（替代 macOS 的 launchd）

### 10.1 后端

```bash
sudo tee /etc/systemd/system/orchisky-voice-backend.service >/dev/null <<'EOF'
[Unit]
Description=Orchisky Voice backend (FastAPI + FunASR)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i_PLACEHOLDER
WorkingDirectory=/opt/orchisky-voice
Environment=RECORDING_AI_HOME=/srv/orchisky-voice-data
Environment=NEWVOICE_ASR_DEVICE=cuda:0
ExecStart=/srv/orchisky-voice-data/venvs/asr/bin/python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
StandardOutput=append:/var/log/orchisky-voice-backend.log
StandardError=append:/var/log/orchisky-voice-backend.log

[Install]
WantedBy=multi-user.target
EOF

# 把 User 换成实际运行账号（拥有 /opt 与 /srv 两个目录的那个）
sudo sed -i "s/%i_PLACEHOLDER/$USER/" /etc/systemd/system/orchisky-voice-backend.service
```

### 10.2 前端静态服务

```bash
sudo tee /etc/systemd/system/orchisky-voice-frontend.service >/dev/null <<'EOF'
[Unit]
Description=Orchisky Voice frontend static server
After=network-online.target

[Service]
Type=simple
User=%i_PLACEHOLDER
WorkingDirectory=/opt/orchisky-voice
ExecStart=/srv/orchisky-voice-data/venvs/asr/bin/python frontend_static_server.py
Restart=always
RestartSec=5
StandardOutput=append:/var/log/orchisky-voice-frontend.log
StandardError=append:/var/log/orchisky-voice-frontend.log

[Install]
WantedBy=multi-user.target
EOF

sudo sed -i "s/%i_PLACEHOLDER/$USER/" /etc/systemd/system/orchisky-voice-frontend.service
```

### 10.3 启用

```bash
sudo touch /var/log/orchisky-voice-backend.log /var/log/orchisky-voice-frontend.log
sudo chown "$USER" /var/log/orchisky-voice-*.log
sudo systemctl daemon-reload
sudo systemctl enable --now orchisky-voice-backend orchisky-voice-frontend
sudo systemctl status orchisky-voice-backend --no-pager
```

---

## 11. 网络访问

### ⚠️ 端口 5173 不能改

前端在浏览器里根据自身端口推导后端地址（`frontend-src/src/api/client.ts`
的 `deriveBaseURL()`）：端口是 `5173` 时，API 指向 `http://<同一主机名>:8000/api`。

同时后端 CORS 白名单（`backend/app/main.py` 的 `allow_origin_regex`）**只放行内网网段
且端口为 5173** 的来源：`10.x` / `192.168.x` / `172.16–31.x`。

所以：

- 用户必须通过 `http://<服务器内网IP>:5173` 访问，**端口改了就会 CORS 失败**。
- 服务器 IP 必须落在上述私有网段内。公网 IP 直接访问会被 CORS 拦掉。
- 要换端口、上域名或套反向代理，**必须同时改前端 `deriveBaseURL()` 和后端 CORS 规则**，
  改完重新构建前端。不要只改一头。

### 防火墙

```bash
sudo ufw allow from 10.0.0.0/8 to any port 5173 proto tcp
sudo ufw allow from 10.0.0.0/8 to any port 8000 proto tcp
# 按实际网段调整；两个端口都要放行，浏览器会直连 8000
```

---

## 12. 验证清单

逐条确认，全绿才算部署完成：

```bash
# 1. GPU 可用
nvidia-smi | head -12
/srv/orchisky-voice-data/venvs/asr/bin/python -c \
  "import torch;print('cuda:',torch.cuda.is_available(),torch.cuda.get_device_name(0))"

# 2. 服务在跑
systemctl is-active orchisky-voice-backend orchisky-voice-frontend

# 3. 后端应答（401 = 正常，未登录）
curl -s -o /dev/null -w "backend %{http_code}\n" http://127.0.0.1:8000/api/me

# 4. 前端应答（200）
curl -s -o /dev/null -w "frontend %{http_code}\n" http://127.0.0.1:5173/

# 5. 模型齐全（5 个目录）
ls /srv/orchisky-voice-data/models/modelscope/iic/ | wc -l

# 6. ffmpeg 软链有效
/srv/orchisky-voice-data/bin/ffmpeg -version | head -1
```

**最终验收（必须做）**：浏览器打开 `http://<服务器IP>:5173`，用管理员账号登录 →
「管理 → 系统状态」，确认 `paraformer` / `vad` / `punc` / `voiceprint` / `ffmpeg`
全为 true。然后**真实上传一段录音跑完整流程**——只有跑通转写才能证明模型和 GPU 真的在工作。

首次转写会加载模型，慢是正常的；之后模型常驻内存。转写时用 `nvidia-smi` 观察显存占用，
应能看到 python 进程占用显存——**看不到就说明还在跑 CPU**，回去检查 `NEWVOICE_ASR_DEVICE`。

---

## 13. 从旧机迁移既有数据（可选）

在**两端服务都停止**的状态下做，否则 sqlite 可能拷到不一致的状态。

```bash
# 旧机（macOS）上停服务
launchctl unload ~/Library/LaunchAgents/com.newvoice.backend.plist

# 新机上停服务
sudo systemctl stop orchisky-voice-backend orchisky-voice-frontend

# 从旧机拷三样：数据库、录音、声纹
OLD="lichengbao@<旧机IP>:'~/Library/Application Support/AhamVoice'"
rsync -avP "$OLD/app-data/newvoice.sqlite3" /srv/orchisky-voice-data/app-data/
rsync -avP "$OLD/app-data/recordings/"      /srv/orchisky-voice-data/app-data/recordings/
rsync -avP "$OLD/voiceprints/"              /srv/orchisky-voice-data/voiceprints/

sudo systemctl start orchisky-voice-backend orchisky-voice-frontend
```

**不要**拷 `venvs/`（macOS ARM 的二进制在 Linux 上跑不了）和 `models/`
（可以拷，但重新下载更省事且不会出错）。

`config.json` 里存着大模型 Key，按需单独拷贝或在网页重填。

---

## 14. 日常运维

```bash
# 状态 / 重启 / 日志
systemctl status orchisky-voice-backend --no-pager
sudo systemctl restart orchisky-voice-backend
tail -f /var/log/orchisky-voice-backend.log

# 更新代码
cd /opt/orchisky-voice && git pull
sudo systemctl restart orchisky-voice-backend orchisky-voice-frontend

# 改了前端源码后重新构建（需要 Node ≥ 22）
cd /opt/orchisky-voice/frontend-src && npm install && npm run build   # 产出 ../frontend/dist
sudo systemctl restart orchisky-voice-frontend

# 备份（sqlite 用 .backup，别直接拷运行中的文件）
sqlite3 /srv/orchisky-voice-data/app-data/newvoice.sqlite3 \
  ".backup '/srv/backup/newvoice-$(date +%F).sqlite3'"
```

---

## 15. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `torch.cuda.is_available()` 为 False | 驱动 < 580，或装成了 CPU 版 torch | `nvidia-smi` 看驱动版本；`pip show torch` 看有无 nvidia-* 依赖 |
| 转写时显存占用为 0 | `NEWVOICE_ASR_DEVICE` 没生效 | 确认 systemd unit 里有该 Environment 行，重启服务 |
| 启动报 `ASR/diarization model missing` | 模型路径或目录名不对 | 对照第 6 节，目录名必须精确匹配 |
| 前端能打开但所有请求失败 | CORS 被拦 | 确认访问端口是 5173、服务器 IP 在内网私有网段、8000 端口已放行 |
| 上传大文件失败 | 超出上限（默认 2GB） | `.env` 加 `NEWVOICE_UPLOAD_MAX_MB` |
| 纪要生成失败但转写正常 | 大模型 Key 未配 / 配错 | 网页「管理 → 大模型配置」测试连接 |
| `seed_internal.py` 找不到种子 | 种子文件不在数据目录 | 见第 9.2 节，或用 `--seed <路径>` 指定 |
| 转写排队很慢 | 全局锁串行，见第 1 节架构限制 | 属预期行为，不是配置问题 |

日志优先看 `/var/log/orchisky-voice-backend.log`，FunASR 的报错都会打在那里。

---

## 16. 可调参数

全部通过 `.env` 或 systemd 的 `Environment=` 设置，改完重启后端生效。

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEWVOICE_ASR_DEVICE` | `cpu` | 推理设备，GPU 部署设 `cuda:0` |
| `NEWVOICE_UPLOAD_MAX_MB` | 2048 | 上传大小上限 |
| `NEWVOICE_VAD_MAX_SEGMENT_MS` | 30000 | VAD 单段最长时长 |
| `NEWVOICE_HOTWORD_LIMIT` | 3000 | 送进 ASR 的热词条数上限 |
| `NEWVOICE_VOICEPRINT_THRESHOLD` | 0.66 | 声纹匹配阈值（0.45–0.95） |
| `NEWVOICE_TMP_TTL_HOURS` | 24 | 临时文件保留时长 |
| `NEWVOICE_EXPORT_TTL_DAYS` | 14 | 导出文件保留天数 |
| `NEWVOICE_INITIAL_PASSWORD` | `orchisky888888` | 新建用户初始密码 |

完整清单可从源码提取：`grep -oE 'NEWVOICE_[A-Z_]+' backend/app/main.py | sort -u`
