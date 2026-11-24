from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from exam_store import (
    BASE_DIR,
    DEFAULT_PORT,
    delete_exam_by_id,
    read_store,
    replace_all_exams,
    save_folders,
    toggle_pin_by_id,
    upsert_exam,
    validate_raw_yaml_basic,
)


class OnTapHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, format: str, *args) -> None:
        # Keep logs concise
        sys.stderr.write(f"[OTDO] {self.address_string()} - {format % args}\n")

    def end_headers(self) -> None:
        # Avoid stale cached JS/HTML/API when editing or syncing
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 10 * 1024 * 1024:
            raise ValueError("Payload vượt quá giới hạn 10MB.")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON body phải là object.")
        return data

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            store = read_store()
            self._send_json(
                200,
                {
                    "ok": True,
                    "port": self.server.server_port,
                    "version": store["version"],
                    "examCount": len(store["exams"]),
                },
            )
            return

        if path == "/api/exams":
            store = read_store()
            self._send_json(200, store)
            return

        if path.startswith("/api/exams/"):
            exam_id = unquote(path[len("/api/exams/") :]).strip("/")
            store = read_store()
            found = next((e for e in store["exams"] if e["id"] == exam_id), None)
            if not found:
                self._send_json(404, {"error": "Không tìm thấy đề thi."})
                return
            self._send_json(200, {"version": store["version"], "exam": found})
            return

        # Block serving internal data/ or python scripts over HTTP
        clean = posixpath.normpath(unquote(path)).lstrip("/")
        if clean.startswith("data/") or clean == "data" or clean.endswith((".py", ".pyw", ".bat")):
            self._send_json(403, {"error": "Forbidden"})
            return

        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/exams":
            try:
                body = self._read_json_body()
                raw_yaml = validate_raw_yaml_basic(body.get("rawYaml") or "")
                exam_id = body.get("id")
                pinned = body.get("pinned")
                entry, store = upsert_exam(
                    exam_id=str(exam_id) if exam_id else None,
                    raw_yaml=raw_yaml,
                    pinned=bool(pinned) if pinned is not None else None,
                    prepend=True,
                )
                self._send_json(201, {"version": store["version"], "exam": entry, "exams": store["exams"]})
            except Exception as err:
                self._send_json(400, {"error": str(err)})
            return

        if path.startswith("/api/exams/") and path.endswith("/pin"):
            exam_id = unquote(path[len("/api/exams/") : -len("/pin")]).strip("/")
            updated, store = toggle_pin_by_id(exam_id)
            if not updated:
                self._send_json(404, {"error": "Không tìm thấy đề thi."})
                return
            self._send_json(200, {"version": store["version"], "exam": updated, "exams": store["exams"]})
            return

        self._send_json(404, {"error": "Not found"})

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/exams":
            try:
                body = self._read_json_body()
                exams = body.get("exams")
                if not isinstance(exams, list):
                    raise ValueError("exams phải là mảng.")
                store = replace_all_exams(exams)
                self._send_json(200, store)
            except Exception as err:
                self._send_json(400, {"error": str(err)})
            return

        if path == "/api/folders":
            try:
                body = self._read_json_body()
                folders = body.get("folders")
                if not isinstance(folders, list):
                    raise ValueError("folders phải là mảng.")
                store = save_folders(folders)
                self._send_json(200, store)
            except Exception as err:
                self._send_json(400, {"error": str(err)})
            return

        if path.startswith("/api/exams/"):
            exam_id = unquote(path[len("/api/exams/") :]).strip("/")
            try:
                body = self._read_json_body()
                raw_yaml = validate_raw_yaml_basic(body.get("rawYaml") or "")
                pinned = body.get("pinned")
                entry, store = upsert_exam(
                    exam_id=exam_id,
                    raw_yaml=raw_yaml,
                    pinned=bool(pinned) if pinned is not None else None,
                    prepend=False,
                )
                self._send_json(200, {"version": store["version"], "exam": entry, "exams": store["exams"]})
            except Exception as err:
                self._send_json(400, {"error": str(err)})
            return

        self._send_json(404, {"error": "Not found"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/exams/"):
            exam_id = unquote(path[len("/api/exams/") :]).strip("/")
            deleted, store = delete_exam_by_id(exam_id)
            if not deleted:
                self._send_json(404, {"error": "Không tìm thấy đề thi."})
                return
            self._send_json(200, {"version": store["version"], "exams": store["exams"]})
            return

        self._send_json(404, {"error": "Not found"})


def main() -> None:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    parser = argparse.ArgumentParser(description="OTDO local web server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ONTAP_PORT", DEFAULT_PORT)))
    parser.add_argument("--open", action="store_true", help="Open browser after starting server")
    args = parser.parse_args()

    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), OnTapHandler)
    url = f"http://{args.host}:{args.port}/"
    print(f"[OTDO] Server running at {url}", flush=True)
    print("[OTDO] Press Ctrl+C or close this window to stop the server.", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[OTDO] Server stopped.", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
