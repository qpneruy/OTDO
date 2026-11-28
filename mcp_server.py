from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from exam_store import (
    ASSETS_DIR,
    BASE_DIR,
    DEFAULT_PORT,
    _UNSET,
    _collect_ancestors,
    _normalize_folder_path,
    create_folder_path,
    delete_exam_by_id,
    delete_folder_path,
    extract_exam_outline,
    get_exam_by_id,
    move_exam_to_folder,
    patch_exams_meta,
    read_exam_summaries,
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


def _is_port_open(host: str = "127.0.0.1", port: int = PORT, timeout: float = 0.12) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _check_web_health() -> dict[str, Any] | None:
    if not _is_port_open():
        return None
    try:
        with urlopen(HEALTH_URL, timeout=0.4) as resp:
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


def _safe_asset_relpath(subdir: str | None, filename: str) -> Path:
    clean_sub_parts = [
        re.sub(r"[^a-zA-Z0-9_.-]+", "-", seg.strip()).strip("-")
        for seg in str(subdir or "").replace("\\", "/").split("/")
        if seg.strip() and seg.strip() not in (".", "..")
    ]
    raw_name = Path(str(filename or "").strip()).name
    if not raw_name:
        raise ValueError("Thiếu tên file asset (filename).")
    stem = re.sub(r"[^a-zA-Z0-9_.-]+", "-", Path(raw_name).stem).strip("-") or "asset"
    ext = Path(raw_name).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"):
        ext = ".png"
    rel = Path(*clean_sub_parts) / f"{stem}{ext}" if clean_sub_parts else Path(f"{stem}{ext}")
    full = (ASSETS_DIR / rel).resolve()
    assets_root = ASSETS_DIR.resolve()
    if assets_root not in full.parents and full != assets_root:
        raise ValueError("Đường dẫn asset không hợp lệ.")
    return rel


def _save_exam_asset(args: dict[str, Any]) -> dict[str, Any]:
    filename = str(args.get("filename") or "").strip()
    subdir = str(args.get("subdir") or "").strip()
    alt_text = str(args.get("alt") or "Hình minh họa").strip() or "Hình minh họa"
    max_width_raw = args.get("max_width")
    max_width = int(max_width_raw) if isinstance(max_width_raw, (int, float)) and max_width_raw > 0 else 480
    trim_ws = bool(args.get("trim_whitespace", True))
    padding = max(0, int(args.get("padding", 12)))

    rel_path = _safe_asset_relpath(subdir, filename)
    dest_path = ASSETS_DIR / rel_path
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    source_path_raw = str(args.get("source_path") or "").strip()
    pdf_path_raw = str(args.get("pdf_path") or "").strip()

    if bool(source_path_raw) == bool(pdf_path_raw):
        raise ValueError("Phải truyền đúng một trong hai: 'source_path' (file ảnh có sẵn) hoặc 'pdf_path' (cắt hình từ PDF).")

    width: int | None = None
    height: int | None = None

    if source_path_raw:
        src = Path(source_path_raw)
        if not src.is_file():
            raise ValueError(f"Không tìm thấy file ảnh nguồn: {source_path_raw}")
        if src.suffix.lower() == ".svg":
            shutil.copy2(src, dest_path)
        else:
            try:
                from PIL import Image, ImageChops

                with Image.open(src) as im_in:
                    im = im_in.convert("RGBA" if im_in.mode in ("RGBA", "LA") else "RGB")
                    if trim_ws and im.mode == "RGB":
                        bg = Image.new("RGB", im.size, (255, 255, 255))
                        bbox = ImageChops.difference(im, bg).getbbox()
                        if bbox:
                            im = im.crop(bbox)
                            if padding > 0:
                                padded = Image.new("RGB", (im.width + 2 * padding, im.height + 2 * padding), (255, 255, 255))
                                padded.paste(im, (padding, padding))
                                im = padded
                    if max_width and im.width > max_width:
                        new_h = max(1, int(round(im.height * (max_width / im.width))))
                        im = im.resize((max_width, new_h), Image.Resampling.LANCZOS)
                    width, height = im.size
                    im.save(dest_path, optimize=True)
            except ImportError:
                shutil.copy2(src, dest_path)
    else:
        pdf_file = Path(pdf_path_raw)
        if not pdf_file.is_file():
            raise ValueError(f"Không tìm thấy file PDF: {pdf_path_raw}")
        page_num = int(args.get("page") or 1)
        crop_box = args.get("crop_box")
        if not isinstance(crop_box, list) or len(crop_box) != 4:
            raise ValueError("Khi dùng 'pdf_path', bắt buộc truyền 'crop_box' gồm 4 số [x0, top, x1, bottom] theo tọa độ PDF point.")
        x0, top, x1, bottom = (float(v) for v in crop_box)
        if x1 <= x0 or bottom <= top:
            raise ValueError("crop_box không hợp lệ: cần x1 > x0 và bottom > top.")
        scale = float(args.get("scale") or 3.0)

        try:
            import pypdfium2 as pdfium
            from PIL import Image, ImageChops
        except ImportError as exc:
            raise ValueError(f"Thiếu thư viện pypdfium2/Pillow để cắt PDF: {exc}") from exc

        doc = pdfium.PdfDocument(str(pdf_file))
        if not (1 <= page_num <= len(doc)):
            raise ValueError(f"Số trang page={page_num} vượt ngoài phạm vi PDF (1..{len(doc)}).")
        pil_page = doc[page_num - 1].render(scale=scale).to_pil().convert("RGB")
        px_box = (
            max(0, int(x0 * scale)),
            max(0, int(top * scale)),
            min(pil_page.width, int(x1 * scale)),
            min(pil_page.height, int(bottom * scale)),
        )
        cropped = pil_page.crop(px_box)
        if trim_ws:
            bg = Image.new("RGB", cropped.size, (255, 255, 255))
            bbox = ImageChops.difference(cropped, bg).getbbox()
            if bbox:
                cropped = cropped.crop(bbox)
            if padding > 0:
                padded = Image.new("RGB", (cropped.width + 2 * padding, cropped.height + 2 * padding), (255, 255, 255))
                padded.paste(cropped, (padding, padding))
                cropped = padded
        if max_width and cropped.width > max_width:
            new_h = max(1, int(round(cropped.height * (max_width / cropped.width))))
            cropped = cropped.resize((max_width, new_h), Image.Resampling.LANCZOS)
        width, height = cropped.size
        cropped.save(dest_path, optimize=True)

    url_path = "/assets/" + rel_path.as_posix()
    return {
        "saved": True,
        "path": str(dest_path),
        "url_path": url_path,
        "width": width,
        "height": height,
        "size_bytes": dest_path.stat().st_size,
        "markdown": f"![{alt_text}]({url_path})",
    }


def _diagnose_missing_snippet(cur_yaml: str, needle: str) -> str:
    stripped_needle = needle.strip()
    if stripped_needle and stripped_needle in cur_yaml:
        return " (Gợi ý: tìm thấy nội dung khi bỏ khoảng trắng đầu/cuối — hãy kiểm tra lại dấu cách thụt lề hoặc dòng trống)."
    first_non_empty = next((ln.strip() for ln in needle.splitlines() if ln.strip()), "")
    if first_non_empty and len(first_non_empty) >= 6:
        matches = [
            idx
            for idx, ln in enumerate(cur_yaml.splitlines(), start=1)
            if first_non_empty in ln
        ]
        if matches:
            sample = ", ".join(str(m) for m in matches[:5])
            return f" (Gợi ý: dòng đầu tiên khớp một phần tại dòng {sample} — hãy kiểm tra thụt lề hoặc ký tự liền sau)."
    return ""


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
                            "description": "Đoạn văn / ngữ liệu chung của nhóm (bắt buộc với type='group', hỗ trợ Markdown/LaTeX/bảng/ảnh).",
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
        "description": "Liệt kê đề thi hiện có trong OTDO (id, tiêu đề, đường dẫn thư mục, môn gốc, số câu hỏi, thời gian, ghim) với bộ lọc thư mục, từ khóa tìm kiếm và giới hạn kết quả.",
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
                "query": {
                    "type": "string",
                    "description": "Tùy chọn tìm kiếm không phân biệt hoa thường theo tiêu đề, id hoặc thư mục.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Tùy chọn giới hạn số lượng đề trả về (1..500) để tiết kiệm context khi kho đề lớn.",
                },
                "include_folders": {
                    "type": "boolean",
                    "description": "Có đính kèm danh sách folders và subjects hay không (mặc định true).",
                },
            },
        },
    },
    {
        "name": "get_exam",
        "description": "Đọc thông tin chi tiết của một đề thi theo id. Hỗ trợ đọc toàn bộ rawYaml, chỉ xem dàn ý (outline_only=true), hoặc chỉ trích xuất 1 phần (section_index).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi (lấy từ list_exams)."},
                "outline_only": {
                    "type": "boolean",
                    "description": "Nếu true, chỉ trả về dàn ý các phần, điểm số, tóm tắt từng câu và số dòng YAML (không trả về rawYaml dài).",
                },
                "section_index": {
                    "type": "integer",
                    "description": "Tùy chọn chỉ số phần (bắt đầu từ 1) để chỉ đọc phần YAML và dàn ý của đúng phần đó.",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "create_exam",
        "description": "Tạo một đề thi mới và đẩy thẳng lên web OTDO. Có thể truyền structured object (title, folder, time_limit, sections — hỗ trợ cả type='group' cho đọc hiểu/điền khuyết và nhúng ảnh ![alt](/assets/...)) hoặc raw_yaml.",
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
        "description": "Sửa nhanh một hoặc nhiều đoạn text trong rawYaml của đề thi theo id trong 1 lần gọi nguyên tử (validate 1 lần, ghi file 1 lần). Truyền old_text/new_text (1 chỗ) HOẶC mảng edits (nhiều chỗ).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của đề thi."},
                "old_text": {"type": "string", "description": "Đoạn text gốc cần thay (dùng khi sửa 1 chỗ)."},
                "new_text": {"type": "string", "description": "Đoạn text mới thay thế (dùng khi sửa 1 chỗ)."},
                "replace_all": {"type": "boolean", "description": "Mặc định false."},
                "edits": {
                    "type": "array",
                    "description": "Danh sách nhiều thao tác thay thế tuần tự trong 1 lần gọi (tiện sửa nhiều câu/điểm số ở các vị trí cách xa nhau mà không tốn nhiều turn).",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_text": {"type": "string"},
                            "new_text": {"type": "string"},
                            "replace_all": {"type": "boolean"},
                        },
                        "required": ["old_text", "new_text"],
                    },
                },
            },
            "required": ["id"],
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
        "description": "Di chuyển nhanh 1 hoặc nhiều đề thi sang thư mục mới, hoặc cập nhật nhanh metadata (pinned, title, time_limit) mà không cần viết lại nội dung câu hỏi.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "ID của 1 đề thi cần cập nhật (hoặc dùng 'ids' cho nhiều đề)."},
                "ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Danh sách ID nhiều đề thi để di chuyển / ghim hàng loạt trong 1 lần gọi.",
                },
                "folder": {
                    "type": "string",
                    "description": "Đường dẫn thư mục đích (vd: \"Toán/Đề thi thử/Sở GD\"); truyền chuỗi rỗng \"\" để chuyển về Chưa phân loại.",
                },
                "pinned": {
                    "type": "boolean",
                    "description": "Tùy chọn cập nhật trạng thái ghim.",
                },
                "title": {
                    "type": "string",
                    "description": "Tùy chọn đổi tiêu đề đề thi (chỉ áp dụng khi truyền 1 đề).",
                },
                "time_limit": {
                    "type": "integer",
                    "description": "Tùy chọn cập nhật thời gian làm bài (1..600 phút, hoặc 0 để xóa giới hạn thời gian).",
                },
            },
        },
    },
    {
        "name": "save_exam_asset",
        "description": "Lưu hoặc cắt hình vẽ / đồ thị / bảng biến thiên trực tiếp từ file PDF hoặc file ảnh vào thư mục assets/ của OTDO, trả về cú pháp Markdown ![alt](/assets/...) để nhúng thẳng vào câu hỏi hoặc lời giải.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Tên file ảnh đầu ra (vd: \"c1_bbt.png\").",
                },
                "subdir": {
                    "type": "string",
                    "description": "Thư mục con bên trong assets/ để gom nhóm ảnh theo đề (vd: \"toan12-de01\").",
                },
                "source_path": {
                    "type": "string",
                    "description": "Đường dẫn tuyệt đối tới file ảnh nguồn có sẵn (dùng khi copy/tối ưu ảnh sẵn có).",
                },
                "pdf_path": {
                    "type": "string",
                    "description": "Đường dẫn tuyệt đối tới file PDF nguồn (dùng khi cắt trực tiếp hình vẽ từ trang PDF).",
                },
                "page": {
                    "type": "integer",
                    "description": "Số trang PDF cần cắt (bắt đầu từ 1, dùng kèm pdf_path).",
                },
                "crop_box": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 4,
                    "maxItems": 4,
                    "description": "Khung cắt [x0, top, x1, bottom] tính theo đơn vị PDF point (dùng kèm pdf_path).",
                },
                "max_width": {
                    "type": "integer",
                    "description": "Chiều rộng tối đa (px, mặc định 480) để ảnh sắc nét và vừa vặn trên thẻ câu hỏi.",
                },
                "trim_whitespace": {
                    "type": "boolean",
                    "description": "Tự động cắt viền trắng thừa và chừa lề gọn gàng (mặc định true).",
                },
                "padding": {
                    "type": "integer",
                    "description": "Độ rộng lề trắng bao quanh sau khi trim (px, mặc định 12).",
                },
                "alt": {
                    "type": "string",
                    "description": "Mô tả alt cho thẻ ảnh Markdown (mặc định \"Hình minh họa\").",
                },
            },
            "required": ["filename"],
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
    persisted_folders: list[str],
    summaries: list[dict[str, Any]],
) -> tuple[list[str], list[str], dict[str, int], dict[str, int]]:
    seen_folders: set[str] = set()
    for raw_f in persisted_folders or []:
        for anc in _collect_ancestors(raw_f):
            seen_folders.add(anc)
    for item in summaries:
        for anc in _collect_ancestors(item.get("folder") or ""):
            seen_folders.add(anc)

    all_folders = sorted(
        seen_folders,
        key=lambda p: tuple(seg.casefold() for seg in p.split("/")),
    )
    folder_counts: dict[str, int] = {f: 0 for f in all_folders}
    subject_counts: dict[str, int] = {}
    subjects_set: set[str] = {f.split("/")[0] for f in all_folders}

    for item in summaries:
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


def _build_folder_tree_from_store(
    store: dict[str, Any],
) -> tuple[list[str], list[str], dict[str, int], dict[str, int]]:
    items = [summarize_exam(e) for e in store.get("exams", [])]
    return _build_folder_tree(store.get("folders") or [], items)


def _handle_tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "list_exams":
        version, all_items, persisted_folders = read_exam_summaries()
        include_folders = bool(args.get("include_folders", True))
        all_folders, subjects, _, _ = _build_folder_tree(persisted_folders, all_items)

        has_folder_arg = "folder" in args and args.get("folder") is not None
        folder_filter = _normalize_folder_path(args.get("folder")).casefold() if has_folder_arg else ""
        exact = bool(args.get("exact", False))
        pinned_only = bool(args.get("pinned_only", False))
        query = str(args.get("query") or "").strip().casefold()

        items = all_items
        if folder_filter:
            if exact:
                items = [x for x in items if x["folder"].casefold() == folder_filter]
            else:
                prefix = folder_filter + "/"
                items = [
                    x
                    for x in items
                    if x["folder"].casefold() == folder_filter or x["folder"].casefold().startswith(prefix)
                ]
        elif has_folder_arg and exact:
            items = [x for x in items if x["folder"] == ""]

        if pinned_only:
            items = [x for x in items if x["pinned"]]

        if query:
            items = [
                x
                for x in items
                if query in x["title"].casefold()
                or query in x["id"].casefold()
                or query in x["folder"].casefold()
            ]

        total_matched = len(items)
        limit_raw = args.get("limit")
        if limit_raw is not None:
            limit = max(1, min(500, int(limit_raw)))
            items = items[:limit]

        payload: dict[str, Any] = {
            "version": version,
            "count": len(items),
            "total_matched": total_matched,
            "exams": items,
            "web_server_running": _is_port_open(),
            "web_url": BASE_URL,
        }
        if include_folders:
            payload["folders"] = all_folders
            payload["subjects"] = subjects
        return payload

    if name == "get_exam":
        eid = str(args.get("id") or "").strip()
        found = get_exam_by_id(eid)
        if not found:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")

        summary = summarize_exam(found)
        outline_only = bool(args.get("outline_only", False))
        sec_idx_raw = args.get("section_index")

        if outline_only or sec_idx_raw is not None:
            outline = extract_exam_outline(found["rawYaml"])
            if sec_idx_raw is not None:
                sec_idx = int(sec_idx_raw)
                if not (1 <= sec_idx <= len(outline)):
                    raise ValueError(f"section_index={sec_idx} nằm ngoài phạm vi số phần của đề (1..{len(outline)}).")
                sec_meta = outline[sec_idx - 1]
                yaml_lines = found["rawYaml"].replace("\r\n", "\n").replace("\r", "\n").split("\n")
                slice_yaml = "\n".join(yaml_lines[sec_meta["start_line"] - 1 : sec_meta["end_line"]]) + "\n"
                out = {**summary, "section": sec_meta}
                if not outline_only:
                    out["sectionYaml"] = slice_yaml
                return out
            return {**summary, "sections_outline": outline}

        return {**summary, "rawYaml": found["rawYaml"]}

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
        existing = get_exam_by_id(eid)
        if not existing:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")

        raw_yaml = args.get("raw_yaml")
        if raw_yaml is not None and str(raw_yaml).strip():
            yaml_str = validate_raw_yaml_basic(str(raw_yaml))
        else:
            yaml_str = validate_and_serialize_exam(args)

        entry, next_store = upsert_exam(
            exam_id=existing["id"],
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
        if not eid:
            raise ValueError("Thiếu id đề thi.")

        edits_in = args.get("edits")
        edit_ops: list[dict[str, Any]] = []
        if isinstance(edits_in, list) and len(edits_in) > 0:
            for idx, item in enumerate(edits_in, start=1):
                if not isinstance(item, dict) or not str(item.get("old_text") or ""):
                    raise ValueError(f"edits[{idx}] thiếu old_text.")
                edit_ops.append(
                    {
                        "old_text": str(item.get("old_text") or "").replace("\r\n", "\n").replace("\r", "\n"),
                        "new_text": str(item.get("new_text") or "").replace("\r\n", "\n").replace("\r", "\n"),
                        "replace_all": bool(item.get("replace_all", False)),
                    }
                )
        else:
            old_text = str(args.get("old_text") or "").replace("\r\n", "\n").replace("\r", "\n")
            new_text = str(args.get("new_text") or "").replace("\r\n", "\n").replace("\r", "\n")
            if not old_text:
                raise ValueError("Thiếu old_text hoặc danh sách edits.")
            edit_ops.append(
                {
                    "old_text": old_text,
                    "new_text": new_text,
                    "replace_all": bool(args.get("replace_all", False)),
                }
            )

        existing = get_exam_by_id(eid)
        if not existing:
            raise ValueError(f"Không tìm thấy đề thi có id '{eid}'.")

        cur_yaml = existing["rawYaml"].replace("\r\n", "\n").replace("\r", "\n")
        total_replacements = 0
        for op_idx, op in enumerate(edit_ops, start=1):
            needle = op["old_text"]
            rep = op["new_text"]
            rep_all = op["replace_all"]
            occurrences = cur_yaml.count(needle)
            prefix = f"edits[{op_idx}]: " if len(edit_ops) > 1 else ""
            if occurrences == 0:
                hint = _diagnose_missing_snippet(cur_yaml, needle)
                raise ValueError(f"{prefix}Không tìm thấy old_text trong nội dung YAML của đề.{hint}")
            if occurrences > 1 and not rep_all:
                raise ValueError(
                    f"{prefix}old_text xuất hiện {occurrences} lần; hãy truyền đoạn dài hơn để khớp duy nhất hoặc đặt replace_all=true."
                )
            cur_yaml = cur_yaml.replace(needle, rep) if rep_all else cur_yaml.replace(needle, rep, 1)
            total_replacements += occurrences if rep_all else 1

        validated_yaml = validate_raw_yaml_basic(cur_yaml)
        entry, next_store = upsert_exam(exam_id=existing["id"], raw_yaml=validated_yaml, prepend=False)
        return {
            "updated": True,
            "edits_applied": len(edit_ops),
            "replacements": total_replacements,
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
        version, summaries, persisted_folders = read_exam_summaries()
        all_folders, subjects, folder_counts, subject_counts = _build_folder_tree(persisted_folders, summaries)
        return {
            "version": version,
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
            all_folders, subjects, _, _ = _build_folder_tree_from_store(next_store)
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
            all_folders, subjects, _, _ = _build_folder_tree_from_store(next_store)
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
            all_folders, subjects, _, _ = _build_folder_tree_from_store(next_store)
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
        ids_arg = args.get("ids")
        single_id = str(args.get("id") or "").strip()
        if isinstance(ids_arg, list) and ids_arg:
            target_ids = [str(x or "").strip() for x in ids_arg if str(x or "").strip()]
        elif single_id:
            target_ids = [single_id]
        else:
            raise ValueError("Cần truyền 'id' hoặc danh sách 'ids'.")

        has_folder = "folder" in args and args.get("folder") is not None
        has_pinned = "pinned" in args and args.get("pinned") is not None
        has_title = "title" in args and args.get("title") is not None
        has_limit = "time_limit" in args and args.get("time_limit") is not None

        if not (has_folder or has_pinned or has_title or has_limit):
            raise ValueError("Cần truyền ít nhất một trường cần cập nhật: folder, pinned, title hoặc time_limit.")

        pinned_arg = args.get("pinned") if has_pinned else None
        if pinned_arg is not None and not isinstance(pinned_arg, bool):
            raise ValueError("pinned phải là boolean.")

        updated_entries, next_store = patch_exams_meta(
            target_ids,
            folder=str(args.get("folder")) if has_folder else _UNSET,
            pinned=pinned_arg,
            title=str(args.get("title")) if has_title else _UNSET,
            time_limit=args.get("time_limit") if has_limit else _UNSET,
        )
        all_folders, _, _, _ = _build_folder_tree_from_store(next_store)
        summarized = [summarize_exam(e) for e in updated_entries]
        if len(summarized) == 1 and not isinstance(ids_arg, list):
            return {
                "updated": True,
                "version": next_store["version"],
                "exam": summarized[0],
                "folders": all_folders,
            }
        return {
            "updated": True,
            "count": len(summarized),
            "version": next_store["version"],
            "exams": summarized,
            "folders": all_folders,
        }

    if name == "save_exam_asset":
        return _save_exam_asset(args)

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
                    "serverInfo": {"name": "otdo-mcp", "version": "2.0.0"},
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
