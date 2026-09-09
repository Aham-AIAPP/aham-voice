#!/usr/bin/env bash
# Run AhamVoice as a single-process local web app (backend + prebuilt frontend).
# Open http://127.0.0.1:8765 in your browser after it starts.
#
# Transcription / speaker / emotion run fully local. Meeting minutes need a
# DeepSeek API key, set in the in-app 设置 (Settings) page.
set -euo pipefail

# Native toolchain (Homebrew ffmpeg/node) + uv-managed python.
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

BASE="${RECORDING_AI_HOME:-$HOME/Library/Application Support/AhamVoice}"
VENV_PY="$BASE/venvs/asr/bin/python"
PORT="${PORT:-8765}"

if [[ ! -x "$VENV_PY" ]]; then
  echo "venv python not found at $VENV_PY — run the ASR deps install first." >&2
  exit 1
fi

echo "BASE        = $BASE"
echo "models      = $BASE/models/modelscope/iic"
echo "ffmpeg dir  = /opt/homebrew/bin"
echo "open        = http://127.0.0.1:$PORT"
echo

exec env \
  RECORDING_AI_HOME="$BASE" \
  AHAMVOICE_BIN_DIR="/opt/homebrew/bin" \
  AHAMVOICE_PORT="$PORT" \
  "$VENV_PY" -m uvicorn backend.app.main:app --host 127.0.0.1 --port "$PORT"
