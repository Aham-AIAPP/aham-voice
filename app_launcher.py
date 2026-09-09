"""AhamVoice desktop launcher.

Starts the FastAPI backend (which also serves the built frontend) on a local
port in a background thread, then opens a native window pointing at it via
pywebview. Used as the entry point inside the packaged macOS .app, and also
runnable directly from a dev checkout.

Path model:
  - This file lives next to backend/ and frontend/ (repo root, or
    AhamVoice.app/Contents/Resources/app inside the bundle).
  - Read-only assets (models, ffmpeg) live as siblings of this dir inside the
    bundle (Resources/models, Resources/bin). When present we point the backend
    at them; otherwise the backend falls back to its per-user data dir.
  - Writable data (DB, recordings, config.json) always goes to the per-user dir
    (~/Library/Application Support/AhamVoice), resolved by the backend itself.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
RES_DIR = APP_DIR.parent  # bundle Resources/ (or repo parent in dev)

# Make `backend.app.main` importable when launched as a plain script.
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

# Point the backend at bundled read-only assets when they exist. setdefault so
# an explicit env (dev override) always wins.
_bundle_models = RES_DIR / "models" / "modelscope" / "iic"
if _bundle_models.is_dir():
    os.environ.setdefault("AHAMVOICE_MODELS_DIR", str(_bundle_models))
_bundle_bin = RES_DIR / "bin"
if (_bundle_bin / "ffmpeg").exists():
    os.environ.setdefault("AHAMVOICE_BIN_DIR", str(_bundle_bin))
_bundle_dist = APP_DIR / "frontend" / "dist"
if (_bundle_dist / "index.html").exists():
    os.environ.setdefault("AHAMVOICE_FRONTEND_DIR", str(_bundle_dist))


DEFAULT_PORT = 8766  # 8765 is the dev script's port; keep them apart.


def _free_port() -> int:
    # Bind to 0 to let the OS pick an open port, then hand it to uvicorn.
    # Avoid 5173/5174 so the frontend's deriveBaseURL() uses a relative /api.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return port


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _pick_port() -> int:
    """Prefer a stable port so external clients (the MCP server, scripts) can
    reconnect across restarts; fall back to any free one if it is taken. Either
    way the chosen port is published in runtime.json by the backend."""
    requested = os.environ.get("AHAMVOICE_PORT", "").strip()
    if requested.isdigit() and _port_is_free(int(requested)):
        return int(requested)
    if _port_is_free(DEFAULT_PORT):
        return DEFAULT_PORT
    return _free_port()


def _wait_until_up(port: int, timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.3)
    return False


class _DesktopApi:
    """Exposed to the webview as ``window.pywebview.api``.

    WKWebView (pywebview's macOS backend) ignores ``<a download>``, so in-app
    download buttons would just open the file in the window. The frontend calls
    ``save_file()`` instead: it fetches the local URL and writes it to a
    user-chosen path via a native Save dialog.
    """

    def __init__(self, port: int) -> None:
        self._port = port

    def save_file(self, url: str, filename: str) -> bool:
        import webview
        import httpx

        win = webview.windows[0] if webview.windows else None
        if win is None:
            return False
        full = url if url.startswith("http") else f"http://127.0.0.1:{self._port}{url}"
        result = win.create_file_dialog(webview.SAVE_DIALOG, save_filename=filename or "download")
        if not result:
            return False
        dest = result[0] if isinstance(result, (list, tuple)) else result
        try:
            with httpx.Client(timeout=120, trust_env=False) as client:
                resp = client.get(full)
                resp.raise_for_status()
            with open(dest, "wb") as fh:
                fh.write(resp.content)
            return True
        except Exception:
            return False


def main() -> int:
    import uvicorn

    port = _pick_port()
    # The backend reads this on startup and publishes runtime.json from it.
    os.environ["AHAMVOICE_PORT"] = str(port)
    config = uvicorn.Config(
        "backend.app.main:app",
        host="127.0.0.1",
        port=port,
        log_level="warning",
        workers=1,
    )
    server = uvicorn.Server(config)
    # Signal handlers can only be installed on the main thread; the server runs
    # on a worker thread here, so disable them and stop it explicitly on exit.
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    thread = threading.Thread(target=server.run, name="ahamvoice-uvicorn", daemon=True)
    thread.start()

    if not _wait_until_up(port):
        sys.stderr.write("AhamVoice backend failed to start in time.\n")
        return 1

    import webview

    webview.create_window(
        "Aham Voice",
        f"http://127.0.0.1:{port}",
        js_api=_DesktopApi(port),
        width=1320,
        height=880,
        min_size=(1024, 720),
    )
    # Blocks on the main thread until the window is closed (macOS requirement).
    webview.start()

    # Window closed → shut the server down and exit.
    server.should_exit = True
    thread.join(timeout=5)
    backend = sys.modules.get("backend.app.main")
    if backend is not None:
        # Stop advertising a port nothing is listening on any more.
        backend.clear_runtime_file()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
