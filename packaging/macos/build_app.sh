#!/bin/bash
# Build a self-contained AhamVoice.app for macOS (Apple Silicon / arm64).
#
# Produces a clickable, copy-anywhere app with the Python runtime, all
# dependencies (torch/funasr/modelscope/...), the local models and a static
# ffmpeg bundled inside.
#
# Two shapes, same code:
#   full (default)          ~5.6GB app — every model inside, works offline on a
#                           clean Mac with no downloads at all.
#   AHAMVOICE_SKIP_MODELS=1 ~1.6GB app — no models; the app fetches them on
#                           first run from 设置 → 本地模型. This is the one to
#                           publish: it fits GitHub's 2GB per-asset limit as a
#                           single file, so releases no longer need splitting.
#
# Either way the user still enters their own LLM API key on the Settings page
# to enable meeting summaries.
#
# Output: $BUILD_DIR/AhamVoice.app  and  $BUILD_DIR/AhamVoice.dmg
#
# Requirements on the BUILD machine: macOS arm64, Xcode Command Line Tools
# (otool/install_name_tool/codesign/hdiutil), node+npm, curl, and the existing
# AhamVoice model dir. Everything else is fetched/assembled here.

set -euo pipefail

# ---- paths -----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="${AHAMVOICE_BUILD_DIR:-$HOME/AhamVoice-build}"
APP="$BUILD_DIR/Aham Voice.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
PYROOT="$RES/python"
PYBIN="$PYROOT/bin/python3"

MODELS_SRC="${AHAMVOICE_MODELS_SRC:-$HOME/Library/Application Support/AhamVoice/models/modelscope/iic}"
# A static (or relocatable) ffmpeg/ffprobe. Defaults to the Homebrew binaries,
# whose Homebrew dylibs we then copy + relocate into the bundle so the app is
# self-contained on a clean Mac.
FFMPEG_SRC="${FFMPEG_SRC:-/opt/homebrew/bin/ffmpeg}"
FFPROBE_SRC="${FFPROBE_SRC:-/opt/homebrew/bin/ffprobe}"

PY_TAG="3.12"

echo "==> AhamVoice macOS bundle"
echo "    repo:   $REPO"
echo "    build:  $BUILD_DIR"
if [[ "${AHAMVOICE_SKIP_MODELS:-0}" == "1" ]]; then
  echo "    models: (skipped — app downloads them on first run)"
else
  echo "    models: $MODELS_SRC"
fi

# ---- preflight -------------------------------------------------------------
[[ "$(uname -m)" == "arm64" ]] || { echo "ERROR: build host must be arm64"; exit 1; }
SKIP_MODELS="${AHAMVOICE_SKIP_MODELS:-0}"
if [[ "$SKIP_MODELS" != "1" ]]; then
  [[ -d "$MODELS_SRC" ]] || { echo "ERROR: models dir not found: $MODELS_SRC"; exit 1; }
fi
command -v npm >/dev/null || { echo "ERROR: npm not found"; exit 1; }
command -v install_name_tool >/dev/null || { echo "ERROR: Xcode CLT (install_name_tool) missing"; exit 1; }

rm -rf "$APP"
mkdir -p "$MACOS" "$RES"

# ---- 1. relocatable CPython (python-build-standalone) -----------------------
echo "==> [1/8] fetching python-build-standalone CPython $PY_TAG (aarch64)"
# Pinned, verified asset (the GitHub API is rate-limited for anonymous use, so
# we don't resolve "latest" dynamically). Override with PBS_URL= if needed.
PBS_URL="${PBS_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/20250115/cpython-3.12.8+20250115-aarch64-apple-darwin-install_only.tar.gz}"
[[ -n "$PBS_URL" ]] || { echo "ERROR: no python-build-standalone URL (set PBS_URL=)"; exit 1; }
echo "    $PBS_URL"
TARBALL="$BUILD_DIR/.pbs.tar.gz"
mkdir -p "$BUILD_DIR"
[[ -f "$TARBALL" ]] || curl -fsSL "$PBS_URL" -o "$TARBALL"
# Extracts to a top-level "python/" directory.
tar -xzf "$TARBALL" -C "$RES"
[[ -x "$PYBIN" ]] || { echo "ERROR: extracted python missing at $PYBIN"; exit 1; }
echo "    python: $("$PYBIN" --version)"

# ---- 2. install dependencies ----------------------------------------------
echo "==> [2/8] installing python dependencies (torch/funasr/... + pywebview)"
"$PYBIN" -m pip install --upgrade pip >/dev/null
"$PYBIN" -m pip install -r "$REPO/backend/requirements-asr.txt" \
  pywebview pyobjc-core pyobjc-framework-Cocoa pyobjc-framework-WebKit
# Trim caches/tests to keep the bundle smaller.
"$PYBIN" -m pip cache purge >/dev/null 2>&1 || true
find "$PYROOT" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYROOT" -type d -name "tests" -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true

# ---- 3. build + copy the app code -----------------------------------------
echo "==> [3/8] building frontend + copying app code"
( cd "$REPO/frontend-src" && npm run build )
mkdir -p "$RES/app"
# backend package, built frontend, launcher. Exclude caches.
/usr/bin/rsync -a --exclude "__pycache__" "$REPO/backend" "$RES/app/"
mkdir -p "$RES/app/frontend"
/usr/bin/rsync -a "$REPO/frontend/dist" "$RES/app/frontend/"
cp "$REPO/app_launcher.py" "$RES/app/app_launcher.py"
# MCP server: ships with the bundle so an installed .app (no repo checkout) can
# still be pointed at from Claude Desktop. It runs in the client's own Python,
# not ours — see docs/MCP.md.
/usr/bin/rsync -a --exclude "__pycache__" "$REPO/mcp-server" "$RES/app/"

# ---- 4. copy models --------------------------------------------------------
if [[ "$SKIP_MODELS" == "1" ]]; then
  echo "==> [4/8] skipping models (slim build)"
  # Still create the directory: app_launcher.py only points the backend at the
  # bundle's model dir when it exists, and the in-app downloader writes to the
  # per-user dir either way. An empty dir here keeps both paths predictable.
  mkdir -p "$RES/models/modelscope/iic"
else
  echo "==> [4/8] copying models (~4GB, this takes a while)"
  mkdir -p "$RES/models/modelscope/iic"
  /usr/bin/rsync -a "$MODELS_SRC/" "$RES/models/modelscope/iic/"
fi

# ---- 5. bundle a self-contained ffmpeg ------------------------------------
echo "==> [5/8] bundling ffmpeg + relocating dylibs"
mkdir -p "$RES/bin"
cp "$FFMPEG_SRC" "$RES/bin/ffmpeg"
cp "$FFPROBE_SRC" "$RES/bin/ffprobe"
chmod +x "$RES/bin/ffmpeg" "$RES/bin/ffprobe"

# Recursively copy every non-system (Homebrew/local) dylib a binary needs into
# bin/ and rewrite the load paths to @loader_path so it runs on a clean Mac.
relocate() {
  local bindir="$1"
  local changed=1
  while [[ "$changed" == "1" ]]; do
    changed=0
    for f in "$bindir"/*; do
      [[ -f "$f" ]] || continue
      while IFS= read -r dep; do
        case "$dep" in
          /opt/homebrew/*|/usr/local/*)
            local base; base="$(basename "$dep")"
            if [[ ! -f "$bindir/$base" ]]; then
              cp "$dep" "$bindir/$base" 2>/dev/null || continue
              chmod u+w "$bindir/$base"
              install_name_tool -id "@loader_path/$base" "$bindir/$base" 2>/dev/null || true
              changed=1
            fi
            install_name_tool -change "$dep" "@loader_path/$base" "$f" 2>/dev/null || true
            ;;
        esac
      done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
    done
  done
}
relocate "$RES/bin"
# install_name_tool invalidated each dylib's original signature; re-sign every
# Mach-O in bin/ ad-hoc. Required on Apple Silicon — otherwise dyld SIGKILLs
# ffmpeg (exit 137). The later app-wide --deep sign does NOT cover these loose
# dylibs, so sign them explicitly here.
for f in "$RES/bin"/*; do
  codesign --force --sign - "$f" >/dev/null 2>&1 || true
done
# Sanity: no remaining Homebrew/local references.
if otool -L "$RES/bin/ffmpeg" "$RES/bin/ffprobe" 2>/dev/null | grep -qE '/opt/homebrew/|/usr/local/'; then
  echo "WARNING: ffmpeg still references external dylibs — may not run on a clean Mac:"
  otool -L "$RES/bin/ffmpeg" | grep -E '/opt/homebrew/|/usr/local/' || true
fi
"$RES/bin/ffmpeg" -version >/dev/null 2>&1 && echo "    ffmpeg runs ✓" || echo "    WARNING: bundled ffmpeg failed to run"

# ---- 6. Info.plist + launcher ---------------------------------------------
echo "==> [6/8] writing Info.plist + launcher"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Aham Voice</string>
  <key>CFBundleDisplayName</key><string>Aham Voice</string>
  <key>CFBundleIdentifier</key><string>com.ahamvoice.desktop</string>
  <key>CFBundleVersion</key><string>2.1.0</string>
  <key>CFBundleShortVersionString</key><string>2.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AhamVoice</string>
  <key>CFBundleIconFile</key><string>AhamVoice</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
</dict>
</plist>
PLIST

# App icon (Resources/AhamVoice.icns, referenced by CFBundleIconFile above).
cp "$SCRIPT_DIR/icon/AhamVoice.icns" "$RES/AhamVoice.icns"

cat > "$MACOS/AhamVoice" <<'LAUNCH'
#!/bin/sh
# Resolve Contents/ from this script's location, then run the launcher with the
# bundled interpreter. app_launcher.py derives all asset paths from its own dir.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RES="$DIR/Resources"
exec "$RES/python/bin/python3" "$RES/app/app_launcher.py"
LAUNCH
chmod +x "$MACOS/AhamVoice"

# ---- 6.5 thin universal2 -> arm64 -----------------------------------------
# Python wheels often ship universal2 (.so/.dylib carrying an x86_64 slice).
# Drop the x86_64 slice so the app is pure arm64 — no Rosetta prompt on Apple
# Silicon, and a smaller bundle. arm64 slice is verified-loadable beforehand.
echo "==> [6.5/8] thinning universal2 binaries to arm64-only"
while IFS= read -r -d '' f; do
  if lipo -archs "$f" 2>/dev/null | grep -qw x86_64; then
    lipo "$f" -thin arm64 -output "$f.__a" 2>/dev/null && mv -f "$f.__a" "$f" || rm -f "$f.__a"
  fi
done < <(find "$RES" -type f \( -name "*.so" -o -name "*.dylib" \) -print0)

# ---- 7. ad-hoc codesign ----------------------------------------------------
echo "==> [7/8] ad-hoc codesigning (arm64 requires a signature to run)"
codesign --force --deep --sign - "$APP" 2>/dev/null || \
  codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP" && echo "    signature OK (ad-hoc)"

APP_SIZE=$(du -sh "$APP" | awk '{print $1}')
echo "    app size: $APP_SIZE"

# ---- 8. DMG ----------------------------------------------------------------
# Build directly from the .app (no staging copy) to keep peak disk usage low.
# The install README ships alongside the DMG and is referenced there.
echo "==> [8/8] building DMG"
DMG="$BUILD_DIR/Aham Voice.dmg"
cp "$SCRIPT_DIR/README-install.txt" "$BUILD_DIR/Aham Voice-安装说明.txt" 2>/dev/null || true
rm -f "$DMG"
hdiutil create -volname "Aham Voice" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
DMG_SIZE=$(du -sh "$DMG" | awk '{print $1}')

echo ""
echo "==> DONE"
echo "    app: $APP  ($APP_SIZE)"
echo "    dmg: $DMG  ($DMG_SIZE)"
echo ""
echo "Install on another Apple Silicon Mac: open the DMG, drag Aham Voice to"
echo "Applications, then run once in Terminal to clear the quarantine flag:"
echo "    xattr -dr com.apple.quarantine "/Applications/Aham Voice.app""
echo "(or right-click the app → Open the first time)."
