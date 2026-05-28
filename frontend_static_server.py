from __future__ import annotations

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent / "frontend" / "dist"


class SpaHandler(SimpleHTTPRequestHandler):
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
