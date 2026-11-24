from __future__ import annotations

import hashlib
import json
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
INDEX_FILE = DATA_DIR / "index.json"
EXAMS_DIR = DATA_DIR / "exams"
LEGACY_STORE_FILE = DATA_DIR / "exams.json"
LOCK_FILE = DATA_DIR / ".store.lock"
DEFAULT_PORT = 8765


def _normalize_folder_path(raw: Any) -> str:
    if raw is None or isinstance(raw, (bool, dict, list)):
        return ""
    parts = [seg.strip() for seg in str(raw).split("/")]
    return "/".join(seg for seg in parts if seg)


def _sanitize_folders(folders: Any) -> list[str]:
    if not isinstance(folders, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in folders:
        norm = _normalize_folder_path(item)
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def _collect_ancestors(path: str) -> list[str]:
    norm = _normalize_folder_path(path)
    if not norm:
        return []
    parts = norm.split("/")
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


def _merge_folder_ancestors(existing: list[str], *paths: str) -> list[str]:
    extra = [anc for p in paths for anc in _collect_ancestors(p)]
    return _sanitize_folders([*existing, *extra])


def _resolve_exam_yaml_path(entries: list[dict[str, Any]], exam_id: str) -> tuple[int, Path | None]:
    idx = next((i for i, e in enumerate(entries) if e["id"] == exam_id), -1)
    if idx != -1:
        ypath = _exam_yaml_path(exam_id, entries[idx].get("file"))
        return idx, ypath if ypath.exists() else None
    if EXAMS_DIR.exists():
        for cand in sorted(EXAMS_DIR.iterdir(), key=lambda p: p.name.lower()):
            if cand.is_file() and cand.suffix.lower() in (".yaml", ".yml") and _safe_exam_id(cand.stem) == exam_id:
                return -1, cand
    return -1, None


def _safe_exam_id(raw_id: str | None) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(raw_id or "").strip()).strip("-")
    return cleaned or f"exam-{int(time.time() * 1000)}"


def _exam_yaml_path(exam_id: str, filename: str | None = None) -> Path:
    if filename:
        name = Path(filename).name
        if name.endswith((".yaml", ".yml")):
            return EXAMS_DIR / name
    return EXAMS_DIR / f"{_safe_exam_id(exam_id)}.yaml"


def _write_yaml_atomic(path: Path, content: str) -> None:
    EXAMS_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = DATA_DIR / f".yaml.tmp.{os.getpid()}"
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(str(tmp_path), str(path))


def _write_index_atomic(
    base_version: int,
    entries: list[dict[str, Any]],
    folders: list[Any] | None = None,
) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if folders is None:
        _, _, clean_folders = _read_index_unlocked()
    else:
        clean_folders = _sanitize_folders(folders)
    index_payload = {
        "version": int(base_version),
        "exams": [
            {
                "id": e["id"],
                "file": e["file"],
                "updatedAt": int(e["updatedAt"]),
                "pinned": bool(e.get("pinned", False)),
            }
            for e in entries
        ],
        "folders": clean_folders,
    }
    tmp_path = DATA_DIR / f".index.json.tmp.{os.getpid()}"
    tmp_path.write_text(json.dumps(index_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(str(tmp_path), str(INDEX_FILE))


def _compute_effective_version(
    base_version: int,
    exams: list[dict[str, Any]],
    file_stats: list[tuple[str, int, int]],
    folders: list[str] | None = None,
) -> int:
    clean_folders = folders or []
    if base_version == 0 and not exams and not file_stats and not clean_folders:
        return 0
    payload: dict[str, Any] = {"v": base_version, "f": file_stats}
    if clean_folders:
        payload["d"] = clean_folders
    sig = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    digest = int(hashlib.blake2b(sig.encode("utf-8"), digest_size=6).hexdigest(), 16)
    return digest or 1


def _migrate_legacy_unlocked() -> None:
    if not LEGACY_STORE_FILE.exists() or INDEX_FILE.exists():
        return
    try:
        raw = json.loads(LEGACY_STORE_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
        legacy_exams = raw.get("exams")
        if not isinstance(legacy_exams, list):
            legacy_exams = []
        legacy_folders = _sanitize_folders(raw.get("folders"))
        base_version = max(1, int(raw.get("version") or 1))
        EXAMS_DIR.mkdir(parents=True, exist_ok=True)
        index_entries: list[dict[str, Any]] = []
        seen = set()
        now_ms = int(time.time() * 1000)
        for item in legacy_exams:
            if not isinstance(item, dict):
                continue
            eid = _safe_exam_id(item.get("id"))
            raw_yaml = item.get("rawYaml")
            if not isinstance(raw_yaml, str) or eid in seen:
                continue
            seen.add(eid)
            fname = f"{eid}.yaml"
            _write_yaml_atomic(EXAMS_DIR / fname, raw_yaml if raw_yaml.endswith("\n") else raw_yaml + "\n")
            index_entries.append(
                {
                    "id": eid,
                    "file": fname,
                    "updatedAt": int(item.get("updatedAt") or now_ms),
                    "pinned": bool(item.get("pinned", False)),
                }
            )
        _write_index_atomic(base_version, index_entries, legacy_folders)
        LEGACY_STORE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


@contextmanager
def _store_lock(timeout: float = 5.0):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    fd = None
    while True:
        try:
            fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_RDWR)
            break
        except FileExistsError:
            try:
                if time.time() - LOCK_FILE.stat().st_mtime > 15:
                    LOCK_FILE.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("Không thể khóa kho đề để ghi dữ liệu.")
            time.sleep(0.03)
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            LOCK_FILE.unlink(missing_ok=True)
        except OSError:
            pass


def _read_index_unlocked() -> tuple[int, list[dict[str, Any]], list[str]]:
    if not INDEX_FILE.exists():
        return 0, [], []
    try:
        raw = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return 0, [], []
        base_version = int(raw.get("version") or 0)
        entries_in = raw.get("exams")
        if not isinstance(entries_in, list):
            entries_in = []
        entries = []
        seen = set()
        for item in entries_in:
            if not isinstance(item, dict):
                continue
            eid = _safe_exam_id(item.get("id"))
            if eid in seen:
                continue
            seen.add(eid)
            fname = str(item.get("file") or f"{eid}.yaml").strip()
            entries.append(
                {
                    "id": eid,
                    "file": Path(fname).name,
                    "updatedAt": int(item.get("updatedAt") or int(time.time() * 1000)),
                    "pinned": bool(item.get("pinned", False)),
                }
            )
        folders = _sanitize_folders(raw.get("folders"))
        return base_version, entries, folders
    except Exception:
        return 0, [], []


def _read_store_unlocked() -> dict[str, Any]:
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        _migrate_legacy_unlocked()

    base_version, index_entries, folders = _read_index_unlocked()
    exams: list[dict[str, Any]] = []
    file_stats: list[tuple[str, int, int]] = []
    seen_files: set[str] = set()
    seen_ids: set[str] = set()

    for entry in index_entries:
        ypath = _exam_yaml_path(entry["id"], entry.get("file"))
        if not ypath.exists():
            continue
        try:
            st = ypath.stat()
            raw_yaml = ypath.read_text(encoding="utf-8")
        except OSError:
            continue
        seen_files.add(ypath.name.lower())
        seen_ids.add(entry["id"])
        file_stats.append((ypath.name, st.st_mtime_ns, st.st_size))
        exams.append(
            {
                "id": entry["id"],
                "rawYaml": raw_yaml,
                "updatedAt": entry["updatedAt"],
                "pinned": entry["pinned"],
            }
        )

    # Auto-discover any manually added .yaml / .yml files in data/exams/
    if EXAMS_DIR.exists():
        for ypath in sorted(EXAMS_DIR.iterdir(), key=lambda p: p.name.lower()):
            if not ypath.is_file() or ypath.suffix.lower() not in (".yaml", ".yml"):
                continue
            if ypath.name.lower() in seen_files:
                continue
            eid = _safe_exam_id(ypath.stem)
            if eid in seen_ids:
                continue
            try:
                st = ypath.stat()
                raw_yaml = ypath.read_text(encoding="utf-8")
            except OSError:
                continue
            seen_files.add(ypath.name.lower())
            seen_ids.add(eid)
            file_stats.append((ypath.name, st.st_mtime_ns, st.st_size))
            exams.append(
                {
                    "id": eid,
                    "rawYaml": raw_yaml,
                    "updatedAt": int(st.st_mtime * 1000),
                    "pinned": False,
                }
            )

    version = _compute_effective_version(base_version, exams, file_stats, folders)
    return {"version": version, "exams": exams, "folders": folders}


def read_store() -> dict[str, Any]:
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        with _store_lock():
            _migrate_legacy_unlocked()
    return _read_store_unlocked()


def replace_all_exams(exams: list[dict[str, Any]]) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, old_entries, folders = _read_index_unlocked()
        EXAMS_DIR.mkdir(parents=True, exist_ok=True)
        new_entries: list[dict[str, Any]] = []
        keep_files: set[str] = set()
        seen = set()

        for item in exams:
            if not isinstance(item, dict):
                continue
            eid = _safe_exam_id(item.get("id"))
            raw_yaml = item.get("rawYaml")
            if eid in seen or not isinstance(raw_yaml, str):
                continue
            seen.add(eid)
            fname = f"{eid}.yaml"
            keep_files.add(fname.lower())
            _write_yaml_atomic(EXAMS_DIR / fname, raw_yaml if raw_yaml.endswith("\n") else raw_yaml + "\n")
            new_entries.append(
                {
                    "id": eid,
                    "file": fname,
                    "updatedAt": int(item.get("updatedAt") or now_ms),
                    "pinned": bool(item.get("pinned", False)),
                }
            )

        for old in old_entries:
            if old["file"].lower() not in keep_files:
                (EXAMS_DIR / old["file"]).unlink(missing_ok=True)

        _write_index_atomic(base_version + 1, new_entries, folders)
        return _read_store_unlocked()


def save_folders(folders: list[Any]) -> dict[str, Any]:
    if not isinstance(folders, list):
        raise ValueError("folders phải là mảng.")
    clean_folders = _sanitize_folders(folders)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, _ = _read_index_unlocked()
        _write_index_atomic(base_version + 1, entries, clean_folders)
        return _read_store_unlocked()


def _skip_block_scalar_lines(lines: list[str], start_idx: int, limit_idx: int, key_indent_len: int) -> int:
    j = start_idx + 1
    while j < limit_idx:
        nxt = lines[j]
        if nxt.strip() == "":
            j += 1
            continue
        if len(nxt) - len(nxt.lstrip(" \t")) > key_indent_len:
            j += 1
        else:
            break
    while j > start_idx + 1 and lines[j - 1].strip() == "":
        j -= 1
    return j


def update_exam_folder_in_yaml(raw_yaml: str, new_folder: str) -> str:
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")
    norm = _normalize_folder_path(new_folder)
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]

    meta_start = next((i for i, ln in enumerate(lines) if re.match(r"^meta\s*:(?:\s+#.*)?\s*$", ln)), None)
    if meta_start is None:
        raise ValueError("YAML thiếu trường gốc 'meta:'.")

    meta_end = meta_start + 1
    while meta_end < len(lines):
        ln = lines[meta_end]
        if ln.strip() == "" or ln.startswith((" ", "\t")):
            meta_end += 1
        else:
            break

    folder_re = re.compile(r"^([ \t]+)folder\s*:(.*)$")
    title_re = re.compile(r"^([ \t]+)title\s*:(.*)$")

    new_meta_lines: list[str] = []
    replaced = False
    i = meta_start + 1
    while i < meta_end:
        ln = lines[i]
        m_folder = folder_re.match(ln)
        if m_folder:
            indent_str = m_folder.group(1)
            rest = m_folder.group(2).strip()
            end_i = i + 1
            if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", rest):
                end_i = _skip_block_scalar_lines(lines, i, meta_end, len(indent_str))
            if norm and not replaced:
                new_meta_lines.append(f"{indent_str}folder: {_format_yaml_scalar(norm, len(indent_str) + 2)}")
                replaced = True
            i = end_i
            continue
        new_meta_lines.append(ln)
        i += 1

    if norm and not replaced:
        insert_at = 0
        indent_str = "  "
        for idx, ln in enumerate(new_meta_lines):
            m_title = title_re.match(ln)
            if m_title:
                indent_str = m_title.group(1)
                rest = m_title.group(2).strip()
                end_title = idx + 1
                if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", rest):
                    end_title = _skip_block_scalar_lines(new_meta_lines, idx, len(new_meta_lines), len(indent_str))
                insert_at = end_title
                break
        new_meta_lines.insert(insert_at, f"{indent_str}folder: {_format_yaml_scalar(norm, len(indent_str) + 2)}")

    result_lines = lines[: meta_start + 1] + new_meta_lines + lines[meta_end:]
    return "\n".join(result_lines) + "\n"


def _set_or_touch_entry(
    entries: list[dict[str, Any]],
    exam_id: str,
    ypath: Path,
    now_ms: int,
    pinned: bool | None = None,
) -> dict[str, Any]:
    idx = next((i for i, e in enumerate(entries) if e["id"] == exam_id), -1)
    if idx != -1:
        cur = entries[idx]
        updated = {
            **cur,
            "file": ypath.name,
            "updatedAt": now_ms,
            "pinned": cur["pinned"] if pinned is None else bool(pinned),
        }
        entries[idx] = updated
        return updated
    created = {
        "id": exam_id,
        "file": ypath.name,
        "updatedAt": now_ms,
        "pinned": bool(pinned) if pinned is not None else False,
    }
    entries.append(created)
    return created


def create_folder_path(path: str) -> dict[str, Any]:
    norm = _normalize_folder_path(path)
    if not norm:
        raise ValueError("Đường dẫn thư mục không được để trống.")
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        next_folders = _merge_folder_ancestors(folders, norm)
        _write_index_atomic(base_version + 1, entries, next_folders)
        return _read_store_unlocked()


def rename_or_move_folder(old_path: str, new_path: str) -> tuple[int, dict[str, Any]]:
    old_norm = _normalize_folder_path(old_path)
    new_norm = _normalize_folder_path(new_path)
    if not old_norm or not new_norm:
        raise ValueError("Đường dẫn thư mục cũ và mới không được để trống.")
    if old_norm == new_norm:
        raise ValueError("Đường dẫn mới trùng với đường dẫn cũ.")
    if new_norm.startswith(old_norm + "/"):
        raise ValueError("Không thể di chuyển thư mục vào chính thư mục con của nó.")

    now_ms = int(time.time() * 1000)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        store = _read_store_unlocked()
        all_known = set(folders) | {
            anc for e in store["exams"] for anc in _collect_ancestors(summarize_exam(e)["folder"])
        }
        if old_norm not in all_known:
            raise ValueError(f"Không tìm thấy thư mục '{old_norm}'.")

        rewritten: list[str] = []
        for f in folders:
            if f == old_norm:
                rewritten.append(new_norm)
            elif f.startswith(old_norm + "/"):
                rewritten.append(new_norm + f[len(old_norm) :])
            else:
                rewritten.append(f)
        next_folders = _merge_folder_ancestors(rewritten, new_norm)

        updated_exams = 0
        for ex in store["exams"]:
            cur_folder = summarize_exam(ex)["folder"]
            if cur_folder == old_norm or cur_folder.startswith(old_norm + "/"):
                next_folder = new_norm if cur_folder == old_norm else new_norm + cur_folder[len(old_norm) :]
                _, ypath = _resolve_exam_yaml_path(entries, ex["id"])
                if not ypath:
                    continue
                next_yaml = update_exam_folder_in_yaml(ex["rawYaml"], next_folder)
                _write_yaml_atomic(ypath, next_yaml)
                _set_or_touch_entry(entries, ex["id"], ypath, now_ms, pinned=bool(ex.get("pinned", False)))
                updated_exams += 1

        _write_index_atomic(base_version + 1, entries, next_folders)
        return updated_exams, _read_store_unlocked()


def delete_folder_path(path: str, mode: str = "keep_exams") -> tuple[int, dict[str, Any]]:
    norm = _normalize_folder_path(path)
    if not norm:
        raise ValueError("Đường dẫn thư mục không được để trống.")
    if mode not in ("keep_exams", "delete_all"):
        raise ValueError("delete_mode phải là 'keep_exams' hoặc 'delete_all'.")

    now_ms = int(time.time() * 1000)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        store = _read_store_unlocked()
        all_known = set(folders) | {
            anc for e in store["exams"] for anc in _collect_ancestors(summarize_exam(e)["folder"])
        }
        if norm not in all_known:
            raise ValueError(f"Không tìm thấy thư mục '{norm}'.")

        next_folders = [f for f in folders if f != norm and not f.startswith(norm + "/")]
        parent = "/".join(norm.split("/")[:-1])

        affected = 0
        drop_ids: set[str] = set()
        for ex in store["exams"]:
            cur_folder = summarize_exam(ex)["folder"]
            if cur_folder == norm or cur_folder.startswith(norm + "/"):
                _, ypath = _resolve_exam_yaml_path(entries, ex["id"])
                if mode == "delete_all":
                    if ypath:
                        ypath.unlink(missing_ok=True)
                    drop_ids.add(ex["id"])
                    affected += 1
                elif ypath:
                    next_yaml = update_exam_folder_in_yaml(ex["rawYaml"], parent)
                    _write_yaml_atomic(ypath, next_yaml)
                    _set_or_touch_entry(entries, ex["id"], ypath, now_ms, pinned=bool(ex.get("pinned", False)))
                    affected += 1

        if mode == "delete_all" and drop_ids:
            entries = [e for e in entries if e["id"] not in drop_ids]
        elif mode == "keep_exams" and affected > 0 and parent:
            next_folders = _merge_folder_ancestors(next_folders, parent)

        _write_index_atomic(base_version + 1, entries, next_folders)
        return affected, _read_store_unlocked()


def move_exam_to_folder(
    exam_id: str,
    new_folder: str,
    pinned: bool | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    raw_id = str(exam_id or "").strip()
    if not raw_id:
        raise ValueError("Thiếu id đề thi.")
    target_id = _safe_exam_id(raw_id)
    norm_folder = _normalize_folder_path(new_folder)
    now_ms = int(time.time() * 1000)

    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        _, ypath = _resolve_exam_yaml_path(entries, target_id)
        if not ypath:
            raise ValueError(f"Không tìm thấy đề thi có id '{exam_id}'.")

        cur_yaml = ypath.read_text(encoding="utf-8")
        next_yaml = update_exam_folder_in_yaml(cur_yaml, norm_folder)
        _write_yaml_atomic(ypath, next_yaml)

        meta_entry = _set_or_touch_entry(entries, target_id, ypath, now_ms, pinned=pinned)
        next_folders = _merge_folder_ancestors(folders, norm_folder) if norm_folder else folders
        _write_index_atomic(base_version + 1, entries, next_folders)
        next_store = _read_store_unlocked()
        full_entry = {
            "id": target_id,
            "rawYaml": next_yaml,
            "updatedAt": meta_entry["updatedAt"],
            "pinned": meta_entry["pinned"],
        }
        return full_entry, next_store


def upsert_exam(
    *,
    exam_id: str | None = None,
    raw_yaml: str,
    pinned: bool | None = None,
    prepend: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    now_ms = int(time.time() * 1000)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        target_id = _safe_exam_id(exam_id) if (exam_id and str(exam_id).strip()) else f"exam-{now_ms}"
        idx = next((i for i, e in enumerate(entries) if e["id"] == target_id), -1)

        fname = entries[idx]["file"] if idx != -1 else f"{target_id}.yaml"
        normalized_yaml = raw_yaml if raw_yaml.endswith("\n") else raw_yaml + "\n"
        _write_yaml_atomic(EXAMS_DIR / fname, normalized_yaml)

        if idx != -1:
            existing = entries[idx]
            meta_entry = {
                "id": target_id,
                "file": fname,
                "updatedAt": now_ms,
                "pinned": existing["pinned"] if pinned is None else bool(pinned),
            }
            entries[idx] = meta_entry
        else:
            meta_entry = {
                "id": target_id,
                "file": fname,
                "updatedAt": now_ms,
                "pinned": bool(pinned) if pinned is not None else False,
            }
            if prepend:
                entries.insert(0, meta_entry)
            else:
                entries.append(meta_entry)

        _write_index_atomic(base_version + 1, entries, folders)
        next_store = _read_store_unlocked()
        full_entry = {
            "id": target_id,
            "rawYaml": normalized_yaml,
            "updatedAt": meta_entry["updatedAt"],
            "pinned": meta_entry["pinned"],
        }
        return full_entry, next_store


def delete_exam_by_id(exam_id: str) -> tuple[bool, dict[str, Any]]:
    target_id = _safe_exam_id(exam_id)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        target = next((e for e in entries if e["id"] == target_id), None)
        ypath = _exam_yaml_path(target_id, target["file"] if target else None)
        if not target and not ypath.exists():
            return False, _read_store_unlocked()

        ypath.unlink(missing_ok=True)
        next_entries = [e for e in entries if e["id"] != target_id]
        _write_index_atomic(base_version + 1, next_entries, folders)
        return True, _read_store_unlocked()


def toggle_pin_by_id(exam_id: str) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    target_id = _safe_exam_id(exam_id)
    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        idx = next((i for i, e in enumerate(entries) if e["id"] == target_id), -1)
        if idx == -1:
            # Handle auto-discovered YAML not yet in index.json
            ypath = _exam_yaml_path(target_id)
            if not ypath.exists():
                return None, _read_store_unlocked()
            entries.insert(
                0,
                {
                    "id": target_id,
                    "file": ypath.name,
                    "updatedAt": int(ypath.stat().st_mtime * 1000),
                    "pinned": True,
                },
            )
            idx = 0
        else:
            entries[idx] = {**entries[idx], "pinned": not entries[idx]["pinned"]}

        _write_index_atomic(base_version + 1, entries, folders)
        next_store = _read_store_unlocked()
        found = next((e for e in next_store["exams"] if e["id"] == target_id), None)
        return found, next_store


def _format_yaml_scalar(value: str, indent: int) -> str:
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    needs_block = "\n" in text or "\\" in text or ": " in text or "#" in text
    if not needs_block:
        return json.dumps(text, ensure_ascii=False)

    pad = " " * indent
    trimmed = text.rstrip("\n")
    lines = trimmed.split("\n")
    rendered_lines = [f"{pad}{line}" if line != "" else "" for line in lines]
    return "|-\n" + "\n".join(rendered_lines)


def _validate_positive_points(raw: Any, label: str) -> float | None:
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"{label}: points phải là số dương (0 < points <= 100).")
    val = float(raw)
    if not (0 < val <= 100):
        raise ValueError(f"{label}: points phải trong khoảng (0, 100].")
    return round(val, 4)


def _extract_mc_options(opts: Any, loc: str) -> list[tuple[str, str]]:
    if not isinstance(opts, dict):
        raise ValueError(f"{loc}: thiếu options dạng object (A, B, C, D).")
    pairs: list[tuple[str, str]] = []
    for k in ("A", "B", "C", "D"):
        raw_val = opts.get(k)
        val = "" if raw_val is None else str(raw_val).strip()
        if not val:
            raise ValueError(f"{loc}: thiếu options.{k}.")
        pairs.append((k, val))
    return pairs


def _serialize_leaf_question(
    q: dict[str, Any],
    loc: str,
    base_indent: int,
    *,
    is_group_sub: bool = False,
) -> list[str]:
    qtype = str(q.get("type") or "").strip()
    if is_group_sub and not qtype:
        qtype = "multiple_choice"
    if qtype not in ("multiple_choice", "true_false", "short_answer"):
        raise ValueError(f"{loc}: type phải là multiple_choice, true_false hoặc short_answer.")

    qtext = str(q.get("question") or "").strip()
    if not is_group_sub and not qtext:
        raise ValueError(f"{loc}: thiếu nội dung question.")

    p_item = " " * base_indent
    p_field = " " * (base_indent + 2)
    p_nested = " " * (base_indent + 4)
    field_scalar_indent = base_indent + 4
    nested_scalar_indent = base_indent + 6

    out: list[str] = [f"{p_item}- type: {qtype}"]
    if qtext:
        out.append(f"{p_field}question: {_format_yaml_scalar(qtext, field_scalar_indent)}")

    if qtype == "multiple_choice":
        opt_pairs = _extract_mc_options(q.get("options"), loc)
        out.append(f"{p_field}options:")
        for k, val in opt_pairs:
            out.append(f"{p_nested}{k}: {_format_yaml_scalar(val, nested_scalar_indent)}")
        ans = str(q.get("answer") or "").strip().upper()
        if ans not in ("A", "B", "C", "D"):
            raise ValueError(f"{loc}: answer phải là A, B, C hoặc D.")
        out.append(f"{p_field}answer: {json.dumps(ans)}")

    elif qtype == "true_false":
        sts = q.get("statements")
        if not isinstance(sts, list) or not (1 <= len(sts) <= 8):
            raise ValueError(f"{loc}: statements phải có từ 1 đến 8 ý.")
        out.append(f"{p_field}statements:")
        p_st_field = " " * (base_indent + 6)
        st_scalar_indent = base_indent + 8
        for st_idx, st in enumerate(sts, start=1):
            if not isinstance(st, dict):
                raise ValueError(f"{loc}, ý {st_idx}: phải là object.")
            st_text = str(st.get("text") or "").strip()
            if not st_text:
                raise ValueError(f"{loc}, ý {st_idx}: thiếu text.")
            is_true = st.get("is_true")
            if not isinstance(is_true, bool):
                raise ValueError(f"{loc}, ý {st_idx}: is_true phải là boolean.")
            out.append(f"{p_nested}- text: {_format_yaml_scalar(st_text, st_scalar_indent)}")
            out.append(f"{p_st_field}is_true: {'true' if is_true else 'false'}")

    elif qtype == "short_answer":
        acc = q.get("accepted_answers")
        if not isinstance(acc, list) or not (1 <= len(acc) <= 30):
            raise ValueError(f"{loc}: accepted_answers phải có từ 1 đến 30 đáp án.")
        out.append(f"{p_field}accepted_answers:")
        for a_idx, ans_val in enumerate(acc, start=1):
            a_str = "" if ans_val is None else str(ans_val).strip()
            if not a_str:
                raise ValueError(f"{loc}: accepted_answers[{a_idx}] không được rỗng.")
            out.append(f"{p_nested}- {_format_yaml_scalar(a_str, nested_scalar_indent)}")

    q_points = _validate_positive_points(q.get("points"), loc)
    if q_points is not None:
        out.append(f"{p_field}points: {q_points:g}")

    exp = str(q.get("explanation") or "").strip()
    if exp:
        out.append(f"{p_field}explanation: {_format_yaml_scalar(exp, field_scalar_indent)}")

    return out


def validate_and_serialize_exam(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        raise ValueError("Payload đề thi phải là object JSON.")

    meta_in = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    title = str(meta_in.get("title") if "title" in meta_in else payload.get("title") or "").strip()
    if not title:
        raise ValueError("Thiếu tiêu đề đề (title).")

    folder_raw = meta_in.get("folder") if "folder" in meta_in else payload.get("folder")
    folder = _normalize_folder_path(folder_raw)

    time_raw = meta_in.get("time_limit") if "time_limit" in meta_in else payload.get("time_limit")
    time_limit = None
    if time_raw is not None and str(time_raw).strip() != "":
        if isinstance(time_raw, bool) or not isinstance(time_raw, (int, float)) or int(time_raw) != time_raw:
            raise ValueError("meta.time_limit phải là số nguyên (1..600).")
        time_limit = int(time_raw)
        if not (1 <= time_limit <= 600):
            raise ValueError("meta.time_limit phải từ 1 đến 600 phút.")

    sections_in = payload.get("sections")
    if not isinstance(sections_in, list) or len(sections_in) == 0:
        raise ValueError("sections phải là danh sách có ít nhất 1 phần.")

    lines = ["meta:"]
    lines.append(f"  title: {_format_yaml_scalar(title, 4)}")
    if folder:
        lines.append(f"  folder: {_format_yaml_scalar(folder, 4)}")
    if time_limit is not None:
        lines.append(f"  time_limit: {time_limit}")

    lines.append("")
    lines.append("sections:")

    for s_idx, sec in enumerate(sections_in, start=1):
        if not isinstance(sec, dict):
            raise ValueError(f"Phần {s_idx} phải là object.")
        sec_title = str(sec.get("title") or "").strip()
        if not sec_title:
            raise ValueError(f"Phần {s_idx}: thiếu title.")
        sec_points = _validate_positive_points(sec.get("points"), f"Phần {s_idx}")
        questions_in = sec.get("questions")
        if not isinstance(questions_in, list) or len(questions_in) == 0:
            raise ValueError(f"Phần {s_idx}: phải có ít nhất 1 câu hỏi.")

        lines.append(f"  - title: {_format_yaml_scalar(sec_title, 6)}")
        if sec_points is not None:
            lines.append(f"    points: {sec_points:g}")
        lines.append("    questions:")

        for q_idx, q in enumerate(questions_in, start=1):
            loc = f"Phần {s_idx}, Câu {q_idx}"
            if not isinstance(q, dict):
                raise ValueError(f"{loc}: câu hỏi phải là object.")
            qtype = str(q.get("type") or "").strip()
            if qtype == "group":
                g_content = str(q.get("content") or "").strip()
                if not g_content:
                    raise ValueError(f"{loc}: nhóm câu hỏi (group) thiếu nội dung content.")
                g_title = str(q.get("title") or "").strip()
                g_points = _validate_positive_points(q.get("points"), loc)
                sub_qs = q.get("questions")
                if not isinstance(sub_qs, list) or not (1 <= len(sub_qs) <= 50):
                    raise ValueError(f"{loc}: nhóm câu hỏi (group) phải có từ 1 đến 50 câu con trong questions.")

                lines.append("      - type: group")
                if g_title:
                    lines.append(f"        title: {_format_yaml_scalar(g_title, 10)}")
                lines.append(f"        content: {_format_yaml_scalar(g_content, 10)}")
                if g_points is not None:
                    lines.append(f"        points: {g_points:g}")
                lines.append("        questions:")
                for sub_idx, sub_q in enumerate(sub_qs, start=1):
                    sub_loc = f"{loc}, Câu con {sub_idx}"
                    if not isinstance(sub_q, dict):
                        raise ValueError(f"{sub_loc}: câu hỏi con phải là object.")
                    lines.extend(_serialize_leaf_question(sub_q, sub_loc, 10, is_group_sub=True))
            elif qtype in ("multiple_choice", "true_false", "short_answer"):
                lines.extend(_serialize_leaf_question(q, loc, 6, is_group_sub=False))
            else:
                raise ValueError(f"{loc}: type phải là multiple_choice, true_false, short_answer hoặc group.")

    return "\n".join(lines) + "\n"


def validate_raw_yaml_basic(raw_yaml: str) -> str:
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise ValueError("Nội dung YAML không được để trống.")
    for idx, line in enumerate(text.split("\n"), start=1):
        if re.match(r"^ *\t", line):
            raise ValueError(f"Dòng {idx}: Không dùng ký tự Tab để thụt lề trong YAML.")
    if not re.search(r"(?m)^meta\s*:", text):
        raise ValueError("YAML thiếu trường gốc 'meta:'.")
    if not re.search(r"(?m)^sections\s*:", text):
        raise ValueError("YAML thiếu trường gốc 'sections:'.")
    return text if text.endswith("\n") else text + "\n"


_BLOCK_SCALAR_RE = re.compile(r'(?::|^-[ \t]+)[ \t]*[|>][+-]?\d*(?:[ \t]+#.*)?[ \t]*$')
_TYPE_FIELD_RE = re.compile(r'^type\s*:\s*["\']?(multiple_choice|true_false|short_answer|group)["\']?\b')
_QUESTIONS_KEY_RE = re.compile(r'^questions\s*:(?:\s*#.*)?$')


def _count_questions_from_yaml(raw_yaml: str) -> dict[str, int]:
    counts = {"multiple_choice": 0, "true_false": 0, "short_answer": 0}
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")

    block_scalar_indent: int | None = None
    in_sections = False

    sec_q_key_indent: int | None = None
    sec_q_item_indent: int | None = None
    in_top_item = False
    cur_top_type: str | None = None
    cur_top_prop_indent: int | None = None

    sub_q_key_indent: int | None = None
    sub_q_item_indent: int | None = None
    in_sub_item = False
    cur_sub_type: str | None = None
    cur_sub_inferred: str | None = None
    cur_sub_prop_indent: int | None = None

    def flush_sub() -> None:
        nonlocal in_sub_item, cur_sub_type, cur_sub_inferred, cur_sub_prop_indent
        if in_sub_item:
            qtype = cur_sub_type or cur_sub_inferred or "multiple_choice"
            if qtype in counts:
                counts[qtype] += 1
        in_sub_item = False
        cur_sub_type = None
        cur_sub_inferred = None
        cur_sub_prop_indent = None

    def flush_top() -> None:
        nonlocal in_top_item, cur_top_type, cur_top_prop_indent, sub_q_key_indent, sub_q_item_indent
        flush_sub()
        sub_q_key_indent = None
        sub_q_item_indent = None
        if in_top_item and cur_top_type in counts:
            counts[cur_top_type] += 1
        in_top_item = False
        cur_top_type = None
        cur_top_prop_indent = None

    def inspect_sub_prop(prop_text: str) -> None:
        nonlocal cur_sub_type, cur_sub_inferred
        m = _TYPE_FIELD_RE.match(prop_text)
        if m and m.group(1) in counts:
            cur_sub_type = m.group(1)
        elif re.match(r'^statements\s*:', prop_text):
            cur_sub_inferred = "true_false"
        elif re.match(r'^accepted_answers\s*:', prop_text):
            cur_sub_inferred = "short_answer"

    def inspect_top_prop(prop_text: str, prop_indent: int) -> None:
        nonlocal cur_top_type, sub_q_key_indent, sub_q_item_indent
        m = _TYPE_FIELD_RE.match(prop_text)
        if m:
            cur_top_type = m.group(1)
        elif _QUESTIONS_KEY_RE.match(prop_text):
            sub_q_key_indent = prop_indent
            sub_q_item_indent = None

    for raw_line in text.split("\n"):
        stripped = raw_line.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(stripped)

        if block_scalar_indent is not None:
            if indent > block_scalar_indent:
                continue
            block_scalar_indent = None

        starts_block = bool(_BLOCK_SCALAR_RE.search(stripped))
        block_base_indent = indent
        if starts_block and stripped.startswith("- "):
            after_list_dash = stripped[1:].lstrip(" ")
            if ":" in after_list_dash:
                block_base_indent = indent + (len(stripped) - len(after_list_dash))

        if indent == 0:
            if re.match(r'^sections\s*:', stripped):
                in_sections = True
            else:
                flush_top()
                in_sections = False
                sec_q_key_indent = None
                sec_q_item_indent = None
            if starts_block:
                block_scalar_indent = indent
            continue

        if not in_sections:
            if starts_block:
                block_scalar_indent = indent
            continue

        is_list = stripped == "-" or stripped.startswith("- ")

        if sub_q_key_indent is not None:
            if (not is_list and indent <= sub_q_key_indent) or (is_list and indent < sub_q_key_indent):
                flush_sub()
                sub_q_key_indent = None
                sub_q_item_indent = None

        if sec_q_key_indent is not None:
            if (not is_list and indent <= sec_q_key_indent) or (is_list and indent < sec_q_key_indent):
                flush_top()
                sec_q_key_indent = None
                sec_q_item_indent = None

        if sub_q_key_indent is not None:
            if is_list and (sub_q_item_indent is None or indent == sub_q_item_indent):
                flush_sub()
                sub_q_item_indent = indent
                in_sub_item = True
                after_dash = stripped[1:].lstrip(" ")
                if after_dash:
                    cur_sub_prop_indent = indent + (len(stripped) - len(after_dash))
                    inspect_sub_prop(after_dash)
                else:
                    cur_sub_prop_indent = None
            elif in_sub_item and not is_list:
                if cur_sub_prop_indent is None and sub_q_item_indent is not None and indent > sub_q_item_indent:
                    cur_sub_prop_indent = indent
                if cur_sub_prop_indent is not None and indent == cur_sub_prop_indent:
                    inspect_sub_prop(stripped)

        elif sec_q_key_indent is not None:
            if is_list and (sec_q_item_indent is None or indent == sec_q_item_indent):
                flush_top()
                sec_q_item_indent = indent
                in_top_item = True
                after_dash = stripped[1:].lstrip(" ")
                if after_dash:
                    cur_top_prop_indent = indent + (len(stripped) - len(after_dash))
                    inspect_top_prop(after_dash, cur_top_prop_indent)
                else:
                    cur_top_prop_indent = None
            elif in_top_item and not is_list:
                if cur_top_prop_indent is None and sec_q_item_indent is not None and indent > sec_q_item_indent:
                    cur_top_prop_indent = indent
                if cur_top_prop_indent is not None and indent == cur_top_prop_indent:
                    inspect_top_prop(stripped, indent)

        else:
            if not is_list and _QUESTIONS_KEY_RE.match(stripped):
                sec_q_key_indent = indent
                sec_q_item_indent = None

        if starts_block:
            block_scalar_indent = block_base_indent

    flush_top()
    return counts


def summarize_exam(entry: dict[str, Any]) -> dict[str, Any]:
    raw_yaml = entry.get("rawYaml", "")
    title = ""
    folder = ""
    time_limit = None

    m_title = re.search(r'(?m)^meta:\s*\n(?:[ \t]+.*\n)*?[ \t]+title:[ \t]*(.+)$', raw_yaml)
    if m_title:
        val = m_title.group(1).strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        title = val

    m_folder = re.search(r'(?m)^meta:\s*\n(?:[ \t]+.*\n)*?([ \t]+)folder:[ \t]*(.*)$', raw_yaml)
    if m_folder:
        indent_len = len(m_folder.group(1))
        val = m_folder.group(2).strip()
        if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", val):
            after = raw_yaml[m_folder.end() :]
            block_lines: list[str] = []
            for ln in after.splitlines():
                if ln.strip() == "":
                    block_lines.append("")
                    continue
                if len(ln) - len(ln.lstrip(" \t")) > indent_len:
                    block_lines.append(ln.strip())
                else:
                    break
            folder = " ".join(s for s in block_lines if s)
        else:
            if val.startswith('"') and val.endswith('"'):
                try:
                    val = str(json.loads(val))
                except Exception:
                    val = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                val = val[1:-1].replace("''", "'")
            folder = val
    folder = _normalize_folder_path(folder)
    subject = folder.split("/")[0] if folder else ""

    m_limit = re.search(r'(?m)^meta:\s*\n(?:[ \t]+.*\n)*?[ \t]+time_limit:[ \t]*(\d+)', raw_yaml)
    if m_limit:
        time_limit = int(m_limit.group(1))

    breakdown = _count_questions_from_yaml(raw_yaml)
    total = breakdown["multiple_choice"] + breakdown["true_false"] + breakdown["short_answer"]
    return {
        "id": entry["id"],
        "title": title or "(Không rõ tiêu đề)",
        "folder": folder,
        "subject": subject,
        "time_limit": time_limit,
        "pinned": bool(entry.get("pinned", False)),
        "updatedAt": entry.get("updatedAt", 0),
        "question_count": total,
        "breakdown": breakdown,
    }
