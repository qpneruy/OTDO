from __future__ import annotations

import json
import os
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from exam_store import (
    BASE_DIR,
    DEFAULT_PORT,
    _collect_ancestors,
    _normalize_folder_path,
    create_folder_path,
    delete_exam_by_id,
    delete_folder_path,
    move_exam_to_folder,
    read_store,
    rename_or_move_folder,
    summarize_exam,
    upsert_exam,
    validate_and_serialize_exam,
    validate_raw_yaml_basic,
)

PORT = int(os.environ.get("ONTAP_PORT", DEFAULT_PORT))
BASE_URL = f"http://127.0.0.1:{PORT}/"
HEALTH_URL = f"http://127.0.0.1:{PORT}/api/health"


def _check_web_health() -> dict[str, Any] | None:
    try:
        with urlopen(HEALTH_URL, timeout=0.8) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except (URLError, OSError, ValueError):
        return None
    return None


def _start_web_server(open_browser: bool = True) -> dict[str, Any]:
    info = _check_web_health()
    already_running = info is not None
    if not already_running:
        server_script = BASE_DIR / "server.py"
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
        subprocess.Popen(
            [sys.executable, str(server_script), "--port", str(PORT)],
            cwd=str(BASE_DIR),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        import time

        for _ in range(25):
            info = _check_web_health()
            if info:
                break
            time.sleep(0.12)

    if open_browser:
        try:
            webbrowser.open(BASE_URL)
        except Exception:
            pass

    return {
        "running": info is not None,
        "already_running": already_running,
        "url": BASE_URL,
        "health": info,
    }


_OPTIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "4 lựa chọn cho multiple_choice (bắt buộc đủ 4 khóa A, B, C, D).",
    "properties": {
        "A": {"type": "string"},
        "B": {"type": "string"},
        "C": {"type": "string"},
        "D": {"type": "string"},
    },
    "required": ["A", "B", "C", "D"],
}

_STATEMENTS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "is_true": {"type": "boolean"},
        },
        "required": ["text", "is_true"],
    },
}

_ACCEPTED_ANSWERS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "items": {"type": "string"},
}

_SUB_QUESTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "Câu hỏi con trong nhóm (type='group'). Có thể bỏ qua type (mặc định multiple_choice) và bỏ qua/để trống question cho câu điền khuyết.",
    "properties": {
        "type": {
            "type": "string",
            "enum": ["multiple_choice", "true_false", "short_answer"],
            "description": "Tùy chọn, mặc định 'multiple_choice'.",
        },
        "question": {
            "type": "string",
            "description": "Tùy chọn; có thể bỏ qua hoặc để chuỗi rỗng \"\" với câu điền khuyết (cloze).",
        },
        "options": _OPTIONS_SCHEMA,
        "answer": {"type": "string", "enum": ["A", "B", "C", "D"]},
        "statements": _STATEMENTS_SCHEMA,
        "accepted_answers": _ACCEPTED_ANSWERS_SCHEMA,
        "points": {"type": "number"},
        "explanation": {"type": "string"},
    },
}

_SECTIONS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "description": "Danh sách các phần (mỗi phần gồm title, tùy chọn points, và questions; hỗ trợ câu đơn và nhóm đọc hiểu/điền khuyết type='group').",
    "items": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "points": {"type": "number"},
            "questions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["multiple_choice", "true_false", "short_answer", "group"],
                            "description": "Loại câu hỏi: multiple_choice, true_false, short_answer, hoặc group (nhóm đọc hiểu/điền khuyết có chung đoạn văn content và danh sách câu con questions).",
                        },
                        "question": {
                            "type": "string",
                            "description": "Nội dung câu hỏi (bắt buộc với câu đơn; không dùng cho type='group').",
                        },
                        "title": {
                            "type": "string",
                            "description": "Tiêu đề tùy chọn cho nhóm câu hỏi (chỉ dùng với type='group').",
                        },
                        "content": {
                            "type": "string",
                            "description": "Đoạn văn / ngữ liệu chung của nhóm (bắt buộc với type='group', hỗ trợ Markdown/LaTeX/bảng).",
                        },
                        "questions": {
                            "type": "array",
                            "description": "Danh sách 1..50 câu hỏi con thuộc nhóm (bắt buộc với type='group').",
                            "minItems": 1,
                            "maxItems": 50,
                            "items": _SUB_QUESTION_SCHEMA,
                        },
                        "options": _OPTIONS_SCHEMA,
                        "answer": {"type": "string", "enum": ["A", "B", "C", "D"]},
                        "statements": _STATEMENTS_SCHEMA,
                        "accepted_answers": _ACCEPTED_ANSWERS_SCHEMA,
                        "points": {"type": "number"},
                        "explanation": {"type": "string"},
                    },
                    "required": ["type"],
                },
            },
        },
        "required": ["title", "questions"],
    },
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_exams",
        "description": "Liệt kê đề thi hiện có trong OTDO (id, tiêu đề, đường dẫn thư mục, môn gốc, số câu hỏi, thời gian, ghim) kèm danh sách thư mục và môn học.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder": {
                    "type": "string",
                    "description": "Tùy chọn lọc theo đường dẫn thư mục (vd: \"Toán\" hoặc \"Toán/Đề thi thử\"). Mặc định khớp cả thư mục con theo tiền tố trừ khi exact=true.",
                },
                "exact": {
                    "type": "boolean",
                    "description": "Nếu true, chỉ trả về đề nằm đúng trong thư mục đó (mặc định false: gồm cả thư mục con; truyền folder=\"\" và exact=true để lọc đề chưa phân loại).",
                },
                "pinned_only": {
                    "type": "boolean",
                    "description": "Nếu true, chỉ trả về các đề đang được ghim (mặc định false).",
                },
            },
        },
    },
    {
        "name": "get_exam",
        "description": "Đọc toàn bộ nội dung YAML và thông tin chi tiết của một đề thi theo id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi (lấy từ list_exams)."}
            },
            "required": ["id"],
        },
    },
    {
        "name": "create_exam",
        "description": "Tạo một đề thi mới và đẩy thẳng lên web OTDO. Có thể truyền structured object (title, folder, time_limit, sections — hỗ trợ cả type='group' cho đọc hiểu/điền khuyết) hoặc raw_yaml.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Tùy chọn ID tùy chỉnh (mặc định tự sinh)."},
                "title": {"type": "string", "description": "Tiêu đề đề thi (bắt buộc nếu không dùng raw_yaml)."},
                "folder": {
                    "type": "string",
                    "description": "Đường dẫn môn/thư mục phân cấp bằng '/' (vd: \"Toán\", \"Toán/Đề thi thử/Sở GD\"). Phân cấp đầu tiên là tên Môn gốc dùng để tính ĐTB và thống kê.",
                },
                "time_limit": {"type": "integer", "description": "Thời gian làm bài (phút, 1..600)."},
                "pinned": {"type": "boolean", "description": "Ghim đề lên tab Đã ghim."},
                "sections": _SECTIONS_SCHEMA,
                "raw_yaml": {
                    "type": "string",
                    "description": "Tùy chọn truyền thẳng chuỗi YAML chuẩn schema OTDO thay cho structured fields.",
                },
            },
        },
    },
    {
        "name": "update_exam",
        "description": "Cập nhật toàn bộ nội dung một đề thi theo id (truyền structured fields — hỗ trợ cả type='group' — hoặc raw_yaml). Web đang mở sẽ tự đồng bộ.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi cần sửa."},
                "title": {"type": "string"},
                "folder": {
                    "type": "string",
                    "description": "Đường dẫn môn/thư mục phân cấp bằng '/' (vd: \"Toán/Đề thi thử/Sở GD\"). Phân cấp đầu tiên là tên Môn gốc dùng để tính ĐTB và thống kê.",
                },
                "time_limit": {"type": "integer"},
                "pinned": {"type": "boolean"},
                "sections": _SECTIONS_SCHEMA,
                "raw_yaml": {"type": "string"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "replace_exam_snippet",
        "description": "Tìm và thay thế chính xác một đoạn text trong rawYaml của đề thi theo id (tiện để sửa nhanh 1 câu hỏi, đáp án hoặc lời giải trong đề dài).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi."},
                "old_text": {"type": "string", "description": "Đoạn text gốc cần thay (phải khớp duy nhất 1 lần hoặc đặt replace_all=true)."},
                "new_text": {"type": "string", "description": "Đoạn text mới thay thế."},
                "replace_all": {"type": "boolean", "description": "Mặc định false."},
            },
            "required": ["id", "old_text", "new_text"],
        },
    },
    {
        "name": "delete_exam",
        "description": "Xóa một đề thi khỏi kho đề theo id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi cần xóa."}
            },
            "required": ["id"],
        },
    },
    {
        "name": "list_folders",
        "description": "Liệt kê toàn bộ cây thư mục lồng nhau, danh sách Môn gốc và số lượng đề theo từng thư mục/môn học (bao gồm cả thư mục rỗng).",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "manage_folder",
        "description": "Tạo, đổi tên, di chuyển hoặc xóa thư mục / Môn học trong OTDO (tự đồng bộ cây thư mục và cập nhật hàng loạt đường dẫn đề thi bên trong).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "rename", "move", "delete"],
                    "description": "Thao tác: create (tạo mới), rename (đổi tên), move (di chuyển sang đường dẫn mới), delete (xóa thư mục).",
                },
                "path": {
                    "type": "string",
                    "description": "Đường dẫn đầy đủ của thư mục (vd: \"Toán/Đề thi thử\").",
                },
                "new_path": {
                    "type": "string",
                    "description": "Đường dẫn đích đầy đủ (bắt buộc khi action là rename hoặc move, vd: \"Toán/Đề Sở 2026\").",
                },
                "delete_mode": {
                    "type": "string",
                    "enum": ["keep_exams", "delete_all"],
                    "description": "Chế độ khi action='delete': 'keep_exams' (mặc định, giữ đề và chuyển lên thư mục cha) hoặc 'delete_all' (xóa luôn đề bên trong).",
                },
            },
            "required": ["action", "path"],
        },
    },
    {
        "name": "move_exam",
        "description": "Di chuyển nhanh một đề thi sang thư mục mới (chỉ cập nhật meta.folder và tùy chọn pinned mà không cần viết lại nội dung câu hỏi).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi cần di chuyển."},
                "folder": {
                    "type": "string",
                    "description": "Đường dẫn thư mục đích (vd: \"Toán/Đề thi thử/Sở GD\"); truyền chuỗi rỗng \"\" để chuyển về Chưa phân loại.",
                },
                "pinned": {
                    "type": "boolean",
                    "description": "Tùy chọn cập nhật trạng thái ghim đồng thời.",
                },
            },
            "required": ["id", "folder"],
        },
    },
    {
        "name": "start_web_server",
        "description": "Kiểm tra hoặc bật server web OTDO (localhost:8765) và mở trên trình duyệt.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "open_browser": {
                    "type": "boolean",
                    "description": "Có tự động mở trình duyệt hay không (mặc định true).",
                }
            },
        },
    },
]


def _build_folder_tree(
    store: dict[str, Any],
    summaries: list[dict[str, Any]] | None = None,
) -> tuple[list[str], list[str], dict[str, int], dict[str, int]]:
    items = summaries if summaries is not None else [summarize_exam(e) for e in store.get("exams", [])]
    seen_folders: set[str] = set()
    for raw_f in store.get("folders") or []:
        for anc in _collect_ancestors(raw_f):
            seen_folders.add(anc)
    for item in items:
        for anc in _collect_ancestors(item.get("folder") or ""):
            seen_folders.add(anc)

    all_folders = sorted(
        seen_folders,
        key=lambda p: tuple(seg.casefold() for seg in p.split("/")),
    )
    folder_counts: dict[str, int] = {f: 0 for f in all_folders}
    subject_counts: dict[str, int] = {}
    subjects_set: set[str] = {f.split("/")[0] for f in all_folders}

    for item in items:
        cur_folder = item.get("folder") or ""
        if not cur_folder:
            continue
        ancs = _collect_ancestors(cur_folder)
        for anc in ancs:
            folder_counts[anc] = folder_counts.get(anc, 0) + 1
        subj = ancs[0]
        subjects_set.add(subj)
        subject_counts[subj] = subject_counts.get(subj, 0) + 1

    subjects = sorted(subjects_set, key=lambda s: s.casefold())
    for subj in subjects:
        subject_counts.setdefault(subj, 0)

    return all_folders, subjects, folder_counts, subject_counts


def _handle_tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "list_exams":
        store = read_store()
        all_items = [summarize_exam(e) for e in store["exams"]]
        all_folders, subjects, _, _ = _build_folder_tree(store, all_items)

        has_folder_arg = "folder" in args and args.get("folder") is not None
        folder_filter = _normalize_folder_path(args.get("folder")).lower() if has_folder_arg else ""
        exact = bool(args.get("exact", False))
        pinned_only = bool(args.get("pinned_only", False))

        items = all_items
        if folder_filter:
            if exact:
                items = [x for x in items if x["folder"].lower() == folder_filter]
            else:
                items = [
                    x
                    for x in items
                    if x["folder"].lower() == folder_filter or x["folder"].lower().startswith(folder_filter + "/")
                ]
        elif has_folder_arg and exact:
            items = [x for x in items if x["folder"] == ""]

        if pinned_only:
            items = [x for x in items if x["pinned"]]

        return {
            "version": store["version"],
            "count": len(items),
            "exams": items,
            "folders": all_folders,
            "subjects": subjects,
            "web_server_running": _check_web_health() is not None,
            "web_url": BASE_URL,
        }

    if name == "get_exam":
        eid = str(args.get("id") or "").strip()
        store = read_store()
        found = next((e for e in store["exams"] if e["id"] == eid), None)
        if not found:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")
        return {**summarize_exam(found), "rawYaml": found["rawYaml"]}

    if name == "create_exam":
        raw_yaml = args.get("raw_yaml")
        if raw_yaml is not None and str(raw_yaml).strip():
            yaml_str = validate_raw_yaml_basic(str(raw_yaml))
        else:
            yaml_str = validate_and_serialize_exam(args)
        entry, store = upsert_exam(
            exam_id=args.get("id"),
            raw_yaml=yaml_str,
            pinned=args.get("pinned"),
            prepend=True,
        )
        return {
            "created": True,
            "version": store["version"],
            "exam": summarize_exam(entry),
            "web_url": BASE_URL,
        }

    if name == "update_exam":
        eid = str(args.get("id") or "").strip()
        if not eid:
            raise ValueError("Thiếu id đề thi.")
        store = read_store()
        existing = next((e for e in store["exams"] if e["id"] == eid), None)
        if not existing:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")

        raw_yaml = args.get("raw_yaml")
        if raw_yaml is not None and str(raw_yaml).strip():
            yaml_str = validate_raw_yaml_basic(str(raw_yaml))
        else:
            yaml_str = validate_and_serialize_exam(args)

        entry, next_store = upsert_exam(
            exam_id=eid,
            raw_yaml=yaml_str,
            pinned=args.get("pinned"),
            prepend=False,
        )
        return {
            "updated": True,
            "version": next_store["version"],
            "exam": summarize_exam(entry),
        }

    if name == "replace_exam_snippet":
        eid = str(args.get("id") or "").strip()
        old_text = str(args.get("old_text") or "")
        new_text = str(args.get("new_text") or "")
        replace_all = bool(args.get("replace_all", False))
        if not eid or not old_text:
            raise ValueError("Thiếu id hoặc old_text.")

        store = read_store()
        existing = next((e for e in store["exams"] if e["id"] == eid), None)
        if not existing:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")

        cur_yaml = existing["rawYaml"]
        occurrences = cur_yaml.count(old_text)
        if occurrences == 0:
            raise ValueError("Không tìm thấy old_text trong nội dung YAML của đề.")
        if occurrences > 1 and not replace_all:
            raise ValueError(f"old_text xuất hiện {occurrences} lần; hãy truyền đoạn dài hơn để khớp duy nhất hoặc đặt replace_all=true.")

        next_yaml = cur_yaml.replace(old_text, new_text) if replace_all else cur_yaml.replace(old_text, new_text, 1)
        next_yaml = validate_raw_yaml_basic(next_yaml)
        entry, next_store = upsert_exam(exam_id=eid, raw_yaml=next_yaml, prepend=False)
        return {
            "updated": True,
            "replacements": occurrences if replace_all else 1,
            "version": next_store["version"],
            "exam": summarize_exam(entry),
        }

    if name == "delete_exam":
        eid = str(args.get("id") or "").strip()
        deleted, store = delete_exam_by_id(eid)
        if not deleted:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")
        return {"deleted": True, "id": eid, "version": store["version"]}

    if name == "list_folders":
        store = read_store()
        all_folders, subjects, folder_counts, subject_counts = _build_folder_tree(store)
        return {
            "version": store["version"],
            "folders": all_folders,
            "subjects": subjects,
            "folder_counts": folder_counts,
            "subject_counts": subject_counts,
        }

    if name == "manage_folder":
        action = str(args.get("action") or "").strip()
        path = str(args.get("path") or "")
        norm_path = _normalize_folder_path(path)
        if action == "create":
            next_store = create_folder_path(path)
            all_folders, subjects, _, _ = _build_folder_tree(next_store)
            return {
                "action": "create",
                "path": norm_path,
                "version": next_store["version"],
                "folders": all_folders,
                "subjects": subjects,
            }
        if action in ("rename", "move"):
            new_path = str(args.get("new_path") or "")
            affected, next_store = rename_or_move_folder(path, new_path)
            all_folders, subjects, _, _ = _build_folder_tree(next_store)
            return {
                "action": action,
                "path": norm_path,
                "new_path": _normalize_folder_path(new_path),
                "affected_exams": affected,
                "version": next_store["version"],
                "folders": all_folders,
                "subjects": subjects,
            }
        if action == "delete":
            delete_mode = str(args.get("delete_mode") or "keep_exams").strip()
            affected, next_store = delete_folder_path(path, mode=delete_mode)
            all_folders, subjects, _, _ = _build_folder_tree(next_store)
            return {
                "action": "delete",
                "path": norm_path,
                "delete_mode": delete_mode,
                "affected_exams": affected,
                "version": next_store["version"],
                "folders": all_folders,
                "subjects": subjects,
            }
        raise ValueError("action phải là 'create', 'rename', 'move' hoặc 'delete'.")

    if name == "move_exam":
        eid = str(args.get("id") or "").strip()
        if "folder" not in args or args.get("folder") is None:
            raise ValueError("Thiếu trường 'folder' (truyền chuỗi rỗng \"\" để chuyển về Chưa phân loại).")
        pinned_arg = args.get("pinned")
        if pinned_arg is not None and not isinstance(pinned_arg, bool):
            raise ValueError("pinned phải là boolean.")
        entry, next_store = move_exam_to_folder(eid, str(args.get("folder")), pinned=pinned_arg)
        all_folders, _, _, _ = _build_folder_tree(next_store)
        return {
            "updated": True,
            "version": next_store["version"],
            "exam": summarize_exam(entry),
            "folders": all_folders,
        }

    if name == "start_web_server":
        open_browser = bool(args.get("open_browser", True))
        return _start_web_server(open_browser=open_browser)

    raise ValueError(f"Tool không tồn tại: {name}")


def _write_message(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        req_id = None
        try:
            req = json.loads(raw)
        except Exception as err:
            _write_message({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {err}"}})
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        # Notifications do not have an id and must not receive a response
        if req_id is None:
            continue

        try:
            if method == "initialize":
                proto = str(params.get("protocolVersion") or "2024-11-05")
                result = {
                    "protocolVersion": proto,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "otdo-mcp", "version": "1.1.0"},
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                tname = str(params.get("name") or "")
                targs = params.get("arguments") or {}
                if not isinstance(targs, dict):
                    raise ValueError("arguments phải là object.")
                try:
                    payload = _handle_tool_call(tname, targs)
                    result = {
                        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
                        "isError": False,
                    }
                except Exception as tool_err:
                    result = {
                        "content": [{"type": "text", "text": f"Lỗi: {tool_err}"}],
                        "isError": True,
                    }
            else:
                _write_message(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32601, "message": f"Method not found: {method}"},
                    }
                )
                continue

            _write_message({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as err:
            _write_message(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32603, "message": str(err)},
                }
            )


if __name__ == "__main__":
    main()
