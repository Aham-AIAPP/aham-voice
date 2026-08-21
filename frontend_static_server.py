from __future__ import annotations

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent / "frontend" / "dist"


class SpaHandler(SimpleHTTPRequestHandler):
    def requested_file(self) -> Path | None:
        raw_path = unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        candidate = (ROOT / raw_path.lstrip("/")).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            return None
        return candidate

    def end_headers(self) -> None:
        raw_path = unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        requested = self.requested_file()
        if raw_path.startswith("/assets/") and requested is not None and requested.is_file():
            # Vite assets are content-hashed, so they can be cached forever.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # SPA routes all serve index.html. It must be revalidated on every
            # visit so a deployment never boots an obsolete JS bundle.
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):  # type: ignore[no-untyped-def]
        raw_path = unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        requested = self.requested_file()
        if raw_path.startswith("/assets/") and (requested is None or not requested.is_file()):
            self.send_error(404, "Asset not found")
            return None
        return super().send_head()

    def translate_path(self, path: str) -> str:
        raw_path = unquote(path.split("?", 1)[0].split("#", 1)[0])
        relative = raw_path.lstrip("/")
        candidate = (ROOT / relative).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            return str(ROOT / "index.html")
        if candidate.is_file():
            return str(candidate)
        return str(ROOT / "index.html")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 5173), SpaHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
