from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
ASSETS_DIR = BASE_DIR / "assets"
INDEX_FILE = DATA_DIR / "index.json"
EXAMS_DIR = DATA_DIR / "exams"
LEGACY_STORE_FILE = DATA_DIR / "exams.json"
LOCK_FILE = DATA_DIR / ".store.lock"
DEFAULT_PORT = 8765

_UNSET: Any = object()
_MAX_SUMMARY_CACHE = 1024
_SUMMARY_CACHE_LOCK = threading.Lock()
# Keyed by (exam_id, mtime_ns, size) -> immutable summary fields from YAML
_SUMMARY_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}


def _tmp_suffix() -> str:
    return f"{os.getpid()}.{threading.get_ident()}"


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
    tmp_path = DATA_DIR / f".yaml.tmp.{_tmp_suffix()}"
    try:
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(str(tmp_path), str(path))
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


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
    tmp_path = DATA_DIR / f".index.json.tmp.{_tmp_suffix()}"
    try:
        tmp_path.write_text(json.dumps(index_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(str(tmp_path), str(INDEX_FILE))
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def _compute_effective_version(
    base_version: int,
    exams: list[Any],
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
            time.sleep(0.02)
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


def _iter_exam_files_unlocked(
    index_entries: list[dict[str, Any]],
) -> list[tuple[str, Path, int, bool, os.stat_result]]:
    """Return ordered (exam_id, ypath, updatedAt, pinned, stat_result) for indexed + auto-discovered exams."""
    out: list[tuple[str, Path, int, bool, os.stat_result]] = []
    seen_files: set[str] = set()
    seen_ids: set[str] = set()

    for entry in index_entries:
        ypath = _exam_yaml_path(entry["id"], entry.get("file"))
        try:
            st = ypath.stat()
        except OSError:
            continue
        seen_files.add(ypath.name.lower())
        seen_ids.add(entry["id"])
        out.append((entry["id"], ypath, entry["updatedAt"], entry["pinned"], st))

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
            except OSError:
                continue
            seen_files.add(ypath.name.lower())
            seen_ids.add(eid)
            out.append((eid, ypath, int(st.st_mtime * 1000), False, st))

    return out


def _read_store_unlocked() -> dict[str, Any]:
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        _migrate_legacy_unlocked()

    base_version, index_entries, folders = _read_index_unlocked()
    exams: list[dict[str, Any]] = []
    file_stats: list[tuple[str, int, int]] = []

    for eid, ypath, updated_at, pinned, st in _iter_exam_files_unlocked(index_entries):
        try:
            raw_yaml = ypath.read_text(encoding="utf-8")
        except OSError:
            continue
        file_stats.append((ypath.name, st.st_mtime_ns, st.st_size))
        exams.append(
            {
                "id": eid,
                "rawYaml": raw_yaml,
                "updatedAt": updated_at,
                "pinned": pinned,
            }
        )

    version = _compute_effective_version(base_version, exams, file_stats, folders)
    return {"version": version, "exams": exams, "folders": folders}


def read_store_version() -> int:
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        with _store_lock():
            _migrate_legacy_unlocked()

    base_version, index_entries, folders = _read_index_unlocked()
    file_stats = [
        (ypath.name, st.st_mtime_ns, st.st_size)
        for _, ypath, _, _, st in _iter_exam_files_unlocked(index_entries)
    ]
    return _compute_effective_version(base_version, file_stats, file_stats, folders)


def read_store() -> dict[str, Any]:
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        with _store_lock():
            _migrate_legacy_unlocked()
    return _read_store_unlocked()


def get_exam_by_id(exam_id: str) -> dict[str, Any] | None:
    """O(1) single-exam reader: avoids reading all YAML files when fetching/editing 1 exam."""
    raw_id = str(exam_id or "").strip()
    if not raw_id:
        return None
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        with _store_lock():
            _migrate_legacy_unlocked()

    _, entries, _ = _read_index_unlocked()
    # Match exact id first, then safe id
    target_id = raw_id if any(e["id"] == raw_id for e in entries) else _safe_exam_id(raw_id)
    idx, ypath = _resolve_exam_yaml_path(entries, target_id)
    if not ypath or not ypath.exists():
        return None
    try:
        st = ypath.stat()
        raw_yaml = ypath.read_text(encoding="utf-8")
    except OSError:
        return None

    if idx != -1:
        updated_at = entries[idx]["updatedAt"]
        pinned = entries[idx]["pinned"]
    else:
        updated_at = int(st.st_mtime * 1000)
        pinned = False

    return {
        "id": target_id,
        "file": ypath.name,
        "rawYaml": raw_yaml,
        "updatedAt": updated_at,
        "pinned": pinned,
        "_mtime_ns": st.st_mtime_ns,
        "_size": st.st_size,
    }


def read_exam_summaries() -> tuple[int, list[dict[str, Any]], list[str]]:
    """Fast stat-cached summary reader for list_exams and list_folders (zero YAML disk read on cache hit)."""
    if LEGACY_STORE_FILE.exists() and not INDEX_FILE.exists():
        with _store_lock():
            _migrate_legacy_unlocked()

    base_version, index_entries, folders = _read_index_unlocked()
    summaries: list[dict[str, Any]] = []
    file_stats: list[tuple[str, int, int]] = []

    for eid, ypath, updated_at, pinned, st in _iter_exam_files_unlocked(index_entries):
        cache_key = (eid, st.st_mtime_ns, st.st_size)
        with _SUMMARY_CACHE_LOCK:
            cached_core = _SUMMARY_CACHE.get(cache_key)

        if cached_core is None:
            try:
                raw_yaml = ypath.read_text(encoding="utf-8")
            except OSError:
                continue
            parsed_core = _summarize_yaml_core(raw_yaml)
            with _SUMMARY_CACHE_LOCK:
                if len(_SUMMARY_CACHE) >= _MAX_SUMMARY_CACHE:
                    _SUMMARY_CACHE.pop(next(iter(_SUMMARY_CACHE)), None)
                _SUMMARY_CACHE[cache_key] = parsed_core
            cached_core = parsed_core

        file_stats.append((ypath.name, st.st_mtime_ns, st.st_size))
        summaries.append(
            {
                "id": eid,
                **cached_core,
                "pinned": bool(pinned),
                "updatedAt": updated_at,
            }
        )

    version = _compute_effective_version(base_version, file_stats, file_stats, folders)
    return version, summaries, folders


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


def update_exam_meta_in_yaml(
    raw_yaml: str,
    *,
    title: Any = _UNSET,
    folder: Any = _UNSET,
    time_limit: Any = _UNSET,
) -> str:
    """Surgically update meta.title, meta.folder, and/or meta.time_limit without touching sections."""
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]

    meta_start = next((i for i, ln in enumerate(lines) if re.match(r"^meta\s*:(?:\s+#.*)?\s*$", ln)), None)
    if meta_start is None:
        raise ValueError("YAML thiếu trường gốc 'meta:'.")

    meta_end = meta_start + 1
    while meta_end < len(lines):
        ln = lines[meta_end]
        if ln.strip() == "" or ln.startswith((" ", "\t")) or ln.lstrip().startswith("#"):
            meta_end += 1
        else:
            break

    norm_title: str | None = None
    if title is not _UNSET:
        norm_title = str(title or "").strip()
        if not norm_title:
            raise ValueError("meta.title không được để trống.")

    norm_folder: str | None = None
    if folder is not _UNSET:
        norm_folder = _normalize_folder_path(folder)

    norm_limit: int | None = None
    if time_limit is not _UNSET:
        if time_limit is None or time_limit == 0 or (isinstance(time_limit, str) and time_limit.strip() in ("", "0")):
            norm_limit = None
        else:
            if isinstance(time_limit, bool) or not isinstance(time_limit, (int, float)) or int(time_limit) != time_limit:
                raise ValueError("meta.time_limit phải là số nguyên (1..600, hoặc 0 để xóa giới hạn).")
            norm_limit = int(time_limit)
            if not (1 <= norm_limit <= 600):
                raise ValueError("meta.time_limit phải từ 1 đến 600 phút.")

    title_re = re.compile(r"^([ \t]+)title\s*:(.*)$")
    folder_re = re.compile(r"^([ \t]+)folder\s*:(.*)$")
    limit_re = re.compile(r"^([ \t]+)time_limit\s*:(.*)$")

    new_meta_lines: list[str] = []
    replaced_title = False
    replaced_folder = False
    replaced_limit = False

    i = meta_start + 1
    while i < meta_end:
        ln = lines[i]
        m_title = title_re.match(ln)
        if m_title and title is not _UNSET:
            indent_str = m_title.group(1)
            rest = m_title.group(2).strip()
            end_i = _skip_block_scalar_lines(lines, i, meta_end, len(indent_str)) if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", rest) else i + 1
            if norm_title and not replaced_title:
                new_meta_lines.append(f"{indent_str}title: {_format_yaml_scalar(norm_title, len(indent_str) + 2)}")
                replaced_title = True
            i = end_i
            continue

        m_folder = folder_re.match(ln)
        if m_folder and folder is not _UNSET:
            indent_str = m_folder.group(1)
            rest = m_folder.group(2).strip()
            end_i = _skip_block_scalar_lines(lines, i, meta_end, len(indent_str)) if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", rest) else i + 1
            if norm_folder and not replaced_folder:
                new_meta_lines.append(f"{indent_str}folder: {_format_yaml_scalar(norm_folder, len(indent_str) + 2)}")
                replaced_folder = True
            i = end_i
            continue

        m_limit = limit_re.match(ln)
        if m_limit and time_limit is not _UNSET:
            indent_str = m_limit.group(1)
            rest = m_limit.group(2).strip()
            end_i = _skip_block_scalar_lines(lines, i, meta_end, len(indent_str)) if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", rest) else i + 1
            if norm_limit is not None and not replaced_limit:
                new_meta_lines.append(f"{indent_str}time_limit: {norm_limit}")
                replaced_limit = True
            i = end_i
            continue

        new_meta_lines.append(ln)
        i += 1

    def _find_after_title_idx() -> tuple[int, str]:
        for idx, mln in enumerate(new_meta_lines):
            mt = title_re.match(mln)
            if mt:
                ind = mt.group(1)
                rst = mt.group(2).strip()
                end_t = _skip_block_scalar_lines(new_meta_lines, idx, len(new_meta_lines), len(ind)) if re.match(r"^[|>][+-]?\d*(?:\s+#.*)?$", rst) else idx + 1
                return end_t, ind
        return 0, "  "

    if title is not _UNSET and norm_title and not replaced_title:
        new_meta_lines.insert(0, f"  title: {_format_yaml_scalar(norm_title, 4)}")

    if folder is not _UNSET and norm_folder and not replaced_folder:
        ins_at, ind = _find_after_title_idx()
        new_meta_lines.insert(ins_at, f"{ind}folder: {_format_yaml_scalar(norm_folder, len(ind) + 2)}")

    if time_limit is not _UNSET and norm_limit is not None and not replaced_limit:
        # Insert before trailing blank lines inside meta
        ins_at = len(new_meta_lines)
        while ins_at > 0 and new_meta_lines[ins_at - 1].strip() == "":
            ins_at -= 1
        _, ind = _find_after_title_idx()
        new_meta_lines.insert(ins_at, f"{ind}time_limit: {norm_limit}")

    result_lines = lines[: meta_start + 1] + new_meta_lines + lines[meta_end:]
    return "\n".join(result_lines) + "\n"


def update_exam_folder_in_yaml(raw_yaml: str, new_folder: str) -> str:
    return update_exam_meta_in_yaml(raw_yaml, folder=new_folder)


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
        exam_folders = {ex["id"]: _parse_meta_fields(ex["rawYaml"])["folder"] for ex in store["exams"]}
        all_known = set(folders) | {
            anc for fpath in exam_folders.values() for anc in _collect_ancestors(fpath)
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
            cur_folder = exam_folders[ex["id"]]
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
        exam_folders = {ex["id"]: _parse_meta_fields(ex["rawYaml"])["folder"] for ex in store["exams"]}
        all_known = set(folders) | {
            anc for fpath in exam_folders.values() for anc in _collect_ancestors(fpath)
        }
        if norm not in all_known:
            raise ValueError(f"Không tìm thấy thư mục '{norm}'.")

        next_folders = [f for f in folders if f != norm and not f.startswith(norm + "/")]
        parent = "/".join(norm.split("/")[:-1])

        affected = 0
        drop_ids: set[str] = set()
        for ex in store["exams"]:
            cur_folder = exam_folders[ex["id"]]
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


def patch_exams_meta(
    exam_ids: list[str],
    *,
    folder: Any = _UNSET,
    pinned: bool | None = None,
    title: Any = _UNSET,
    time_limit: Any = _UNSET,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Batch-update folder, pinned, title, and/or time_limit for 1..N exams under a single store lock."""
    cleaned_ids = [str(eid or "").strip() for eid in exam_ids if str(eid or "").strip()]
    if not cleaned_ids:
        raise ValueError("Thiếu id đề thi.")
    if title is not _UNSET and len(cleaned_ids) > 1:
        raise ValueError("Chỉ được đổi 'title' khi cập nhật đúng 1 đề thi.")

    needs_yaml_edit = folder is not _UNSET or title is not _UNSET or time_limit is not _UNSET
    norm_folder = _normalize_folder_path(folder) if folder is not _UNSET else None
    now_ms = int(time.time() * 1000)

    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        resolved: list[tuple[str, Path]] = []
        seen: set[str] = set()
        for raw_id in cleaned_ids:
            tid = raw_id if any(e["id"] == raw_id for e in entries) else _safe_exam_id(raw_id)
            if tid in seen:
                continue
            seen.add(tid)
            _, ypath = _resolve_exam_yaml_path(entries, tid)
            if not ypath:
                raise ValueError(f"Không tìm thấy đề thi có id '{raw_id}'.")
            resolved.append((tid, ypath))

        updated_items: list[dict[str, Any]] = []
        for tid, ypath in resolved:
            cur_yaml = ypath.read_text(encoding="utf-8")
            if needs_yaml_edit:
                next_yaml = update_exam_meta_in_yaml(
                    cur_yaml,
                    title=title,
                    folder=folder,
                    time_limit=time_limit,
                )
                _write_yaml_atomic(ypath, next_yaml)
            else:
                next_yaml = cur_yaml

            meta_entry = _set_or_touch_entry(entries, tid, ypath, now_ms, pinned=pinned)
            updated_items.append(
                {
                    "id": tid,
                    "rawYaml": next_yaml,
                    "updatedAt": meta_entry["updatedAt"],
                    "pinned": meta_entry["pinned"],
                }
            )

        next_folders = _merge_folder_ancestors(folders, norm_folder) if norm_folder else folders
        _write_index_atomic(base_version + 1, entries, next_folders)
        next_store = _read_store_unlocked()
        return updated_items, next_store


def move_exam_to_folder(
    exam_id: str,
    new_folder: str,
    pinned: bool | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    updated_items, next_store = patch_exams_meta([exam_id], folder=new_folder, pinned=pinned)
    return updated_items[0], next_store


def upsert_exam(
    *,
    exam_id: str | None = None,
    raw_yaml: str,
    pinned: bool | None = None,
    prepend: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    now_ms = int(time.time() * 1000)
    normalized_yaml = raw_yaml if raw_yaml.endswith("\n") else raw_yaml + "\n"
    exam_folder = _parse_meta_fields(normalized_yaml)["folder"]

    with _store_lock():
        _migrate_legacy_unlocked()
        base_version, entries, folders = _read_index_unlocked()
        target_id = _safe_exam_id(exam_id) if (exam_id and str(exam_id).strip()) else f"exam-{now_ms}"
        idx = next((i for i, e in enumerate(entries) if e["id"] == target_id), -1)

        fname = entries[idx]["file"] if idx != -1 else f"{target_id}.yaml"
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

        next_folders = _merge_folder_ancestors(folders, exam_folder) if exam_folder else folders
        _write_index_atomic(base_version + 1, entries, next_folders)
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


_BLOCK_SCALAR_RE = re.compile(r'(?::|^-[ \t]+)[ \t]*[|>][+-]?\d*(?:[ \t]+#.*)?[ \t]*$')
_TYPE_FIELD_RE = re.compile(r'^type\s*:\s*["\']?(multiple_choice|true_false|short_answer|group)["\']?\b')
_QUESTIONS_KEY_RE = re.compile(r'^questions\s*:(?:\s*#.*)?$')


def validate_raw_yaml_basic(raw_yaml: str) -> str:
    """Validate OTDO YAML structure (tabs, meta.title, sections, options object, answer A..D, boolean is_true)."""
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise ValueError("Nội dung YAML không được để trống.")

    lines = text.split("\n")
    for idx, line in enumerate(lines, start=1):
        if re.match(r"^ *\t", line):
            raise ValueError(f"Dòng {idx}: Không dùng ký tự Tab để thụt lề trong YAML.")

    if not re.search(r"(?m)^meta\s*:", text):
        raise ValueError("YAML thiếu trường gốc 'meta:'.")
    if not re.search(r"(?m)^sections\s*:", text):
        raise ValueError("YAML thiếu trường gốc 'sections:'.")

    meta = _parse_meta_fields(text)
    if not meta["title"]:
        raise ValueError("YAML thiếu 'meta.title' hoặc tiêu đề rỗng.")

    block_scalar_indent: int | None = None
    options_indent: int | None = None

    for idx, raw_line in enumerate(lines, start=1):
        stripped = raw_line.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(stripped)

        if block_scalar_indent is not None:
            if indent > block_scalar_indent:
                continue
            block_scalar_indent = None

        if options_indent is not None:
            if indent > options_indent:
                if stripped == "-" or stripped.startswith("- "):
                    raise ValueError(
                        f"Dòng {idx}: 'options' phải là object gồm 4 khóa A, B, C, D — không được dùng danh sách ('- ...')."
                    )
            else:
                options_indent = None

        starts_block = bool(_BLOCK_SCALAR_RE.search(stripped))
        block_base_indent = indent
        if starts_block and stripped.startswith("- "):
            after_list_dash = stripped[1:].lstrip(" ")
            if ":" in after_list_dash:
                block_base_indent = indent + (len(stripped) - len(after_list_dash))

        prop = stripped[1:].lstrip(" ") if (stripped == "-" or stripped.startswith("- ")) else stripped

        if re.match(r"^options\s*:(?:\s*#.*)?$", prop):
            options_indent = indent + (len(stripped) - len(prop)) if stripped.startswith("-") else indent
        elif re.match(r"^answer\s*:", prop) and not starts_block:
            ans_raw = prop.split(":", 1)[1].strip()
            ans_clean = _unquote_inline_scalar(ans_raw).strip()
            if ans_clean not in ("A", "B", "C", "D"):
                raise ValueError(f"Dòng {idx}: 'answer' phải là A, B, C hoặc D (nhận được {ans_raw!r}).")
        elif re.match(r"^is_true\s*:", prop) and not starts_block:
            bool_raw = prop.split(":", 1)[1].strip()
            if "#" in bool_raw and not bool_raw.startswith(('"', "'")):
                bool_raw = bool_raw.split("#", 1)[0].strip()
            if bool_raw not in ("true", "false"):
                raise ValueError(
                    f"Dòng {idx}: 'is_true' phải là boolean true hoặc false không bọc ngoặc kép (nhận được {bool_raw!r})."
                )

        if starts_block:
            block_scalar_indent = block_base_indent

    counts = _count_questions_from_yaml(text)
    if counts["multiple_choice"] + counts["true_false"] + counts["short_answer"] == 0:
        raise ValueError("YAML phải có ít nhất 1 câu hỏi hợp lệ trong 'sections'.")

    return text if text.endswith("\n") else text + "\n"


def _unquote_inline_scalar(val: str) -> str:
    s = val.strip()
    if not s:
        return ""
    if s.startswith('"') and s.endswith('"') and len(s) >= 2:
        try:
            return str(json.loads(s))
        except Exception:
            return s[1:-1]
    if s.startswith("'") and s.endswith("'") and len(s) >= 2:
        return s[1:-1].replace("''", "'")
    if " #" in s:
        s = s.split(" #", 1)[0].rstrip()
    return s


def _extract_scalar_at(lines: list[str], start_idx: int, limit_idx: int, key_indent_len: int, inline_rest: str) -> tuple[str, int]:
    rest = inline_rest.strip()
    m_block = re.match(r"^([|>])[+-]?\d*(?:\s+#.*)?$", rest)
    if not m_block:
        return _unquote_inline_scalar(rest), start_idx + 1

    style = m_block.group(1)
    j = start_idx + 1
    raw_block: list[str] = []
    min_indent: int | None = None
    while j < limit_idx:
        ln = lines[j]
        if ln.strip() == "":
            raw_block.append("")
            j += 1
            continue
        ind = len(ln) - len(ln.lstrip(" "))
        if ind > key_indent_len:
            raw_block.append(ln)
            if min_indent is None or ind < min_indent:
                min_indent = ind
            j += 1
        else:
            break

    while raw_block and raw_block[-1] == "":
        raw_block.pop()

    cut = min_indent or (key_indent_len + 2)
    dedented = [ln[cut:] if len(ln) >= cut else "" for ln in raw_block]
    if style == ">":
        return " ".join(part.strip() for part in dedented if part.strip()), j
    return "\n".join(dedented), j


def _parse_meta_fields(raw_yaml: str) -> dict[str, Any]:
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    meta_start = next((i for i, ln in enumerate(lines) if re.match(r"^meta\s*:(?:\s+#.*)?\s*$", ln)), None)
    if meta_start is None:
        return {"title": "", "folder": "", "time_limit": None}

    meta_end = meta_start + 1
    while meta_end < len(lines):
        ln = lines[meta_end]
        if ln.strip() == "" or ln.startswith((" ", "\t")) or ln.lstrip().startswith("#"):
            meta_end += 1
        else:
            break

    title = ""
    folder = ""
    time_limit: int | None = None

    i = meta_start + 1
    while i < meta_end:
        ln = lines[i]
        stripped = ln.lstrip(" \t")
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        key_indent = len(ln) - len(stripped)
        m = re.match(r"^(title|folder|time_limit)\s*:(.*)$", stripped)
        if not m:
            if _BLOCK_SCALAR_RE.search(stripped):
                _, i = _extract_scalar_at(lines, i, meta_end, key_indent, stripped.split(":", 1)[1])
            else:
                i += 1
            continue

        key, rest = m.group(1), m.group(2)
        val, next_i = _extract_scalar_at(lines, i, meta_end, key_indent, rest)
        if key == "title":
            title = val.strip()
        elif key == "folder":
            folder = _normalize_folder_path(val)
        elif key == "time_limit":
            m_int = re.match(r"^(\d+)$", val.strip())
            if m_int:
                time_limit = int(m_int.group(1))
        i = next_i

    return {"title": title, "folder": folder, "time_limit": time_limit}


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
        elif re.match(r"^statements\s*:", prop_text):
            cur_sub_inferred = "true_false"
        elif re.match(r"^accepted_answers\s*:", prop_text):
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
            if re.match(r"^sections\s*:", stripped):
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


def _summarize_yaml_core(raw_yaml: str) -> dict[str, Any]:
    meta = _parse_meta_fields(raw_yaml)
    folder = meta["folder"]
    subject = folder.split("/")[0] if folder else ""
    breakdown = _count_questions_from_yaml(raw_yaml)
    total = breakdown["multiple_choice"] + breakdown["true_false"] + breakdown["short_answer"]
    return {
        "title": meta["title"] or "(Không rõ tiêu đề)",
        "folder": folder,
        "subject": subject,
        "time_limit": meta["time_limit"],
        "question_count": total,
        "breakdown": breakdown,
    }


def summarize_exam(entry: dict[str, Any]) -> dict[str, Any]:
    core = _summarize_yaml_core(entry.get("rawYaml", ""))
    return {
        "id": entry["id"],
        **core,
        "pinned": bool(entry.get("pinned", False)),
        "updatedAt": entry.get("updatedAt", 0),
    }


def _short_preview(text: str, max_len: int = 90) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    return compact if len(compact) <= max_len else compact[: max_len - 1].rstrip() + "…"


def extract_exam_outline(raw_yaml: str) -> list[dict[str, Any]]:
    """Extract section boundaries, points, and per-item question previews + YAML line numbers."""
    text = str(raw_yaml or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    n_lines = len(lines)

    sec_root = next((i for i, ln in enumerate(lines) if re.match(r"^sections\s*:(?:\s+#.*)?\s*$", ln)), None)
    if sec_root is None:
        return []

    sec_end_limit = sec_root + 1
    while sec_end_limit < n_lines:
        ln = lines[sec_end_limit]
        if ln.strip() == "" or ln.startswith((" ", "\t")) or ln.lstrip().startswith("#"):
            sec_end_limit += 1
        else:
            break

    # Discover top-level section items under sections:
    sec_starts: list[int] = []
    sec_item_indent: int | None = None
    block_indent: int | None = None
    for idx in range(sec_root + 1, sec_end_limit):
        ln = lines[idx]
        stripped = ln.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        ind = len(ln) - len(stripped)
        if block_indent is not None:
            if ind > block_indent:
                continue
            block_indent = None
        is_list = stripped == "-" or stripped.startswith("- ")
        if is_list and (sec_item_indent is None or ind == sec_item_indent):
            sec_item_indent = ind
            sec_starts.append(idx)
        if _BLOCK_SCALAR_RE.search(stripped):
            base_ind = ind
            if is_list:
                after = stripped[1:].lstrip(" ")
                if ":" in after:
                    base_ind = ind + (len(stripped) - len(after))
            block_indent = base_ind

    sections_out: list[dict[str, Any]] = []
    for s_pos, s_start in enumerate(sec_starts):
        s_limit = sec_starts[s_pos + 1] if s_pos + 1 < len(sec_starts) else sec_end_limit
        # Trim trailing blank lines for cleaner line range
        s_end_inclusive = s_limit - 1
        while s_end_inclusive > s_start and lines[s_end_inclusive].strip() == "":
            s_end_inclusive -= 1

        sec_title = ""
        sec_points: float | None = None
        q_key_line: int | None = None
        q_key_indent: int | None = None

        i = s_start
        while i < s_limit:
            ln = lines[i]
            stripped = ln.lstrip(" ")
            if not stripped or stripped.startswith("#"):
                i += 1
                continue
            ind = len(ln) - len(stripped)
            prop = stripped[1:].lstrip(" ") if (i == s_start and stripped.startswith("-")) else stripped
            prop_ind = ind + (len(stripped) - len(prop)) if (i == s_start and stripped.startswith("-")) else ind

            m_prop = re.match(r"^(title|points|questions)\s*:(.*)$", prop)
            if m_prop and (q_key_indent is None or prop_ind <= q_key_indent):
                k_name, rest = m_prop.group(1), m_prop.group(2)
                if k_name == "title":
                    val, i = _extract_scalar_at(lines, i, s_limit, prop_ind, rest)
                    sec_title = val.strip()
                    continue
                if k_name == "points":
                    val, i = _extract_scalar_at(lines, i, s_limit, prop_ind, rest)
                    try:
                        sec_points = float(val.strip())
                    except ValueError:
                        pass
                    continue
                if k_name == "questions":
                    q_key_line = i
                    q_key_indent = prop_ind
                    break
            i += 1

        q_items_out: list[dict[str, Any]] = []
        if q_key_line is not None and q_key_indent is not None:
            q_starts: list[int] = []
            q_item_indent: int | None = None
            b_ind: int | None = None
            for qi in range(q_key_line + 1, s_limit):
                ln = lines[qi]
                st = ln.lstrip(" ")
                if not st or st.startswith("#"):
                    continue
                ind = len(ln) - len(st)
                if b_ind is not None:
                    if ind > b_ind:
                        continue
                    b_ind = None
                if ind <= q_key_indent and not (st == "-" or st.startswith("- ")):
                    break
                is_l = st == "-" or st.startswith("- ")
                if is_l and (q_item_indent is None or ind == q_item_indent) and ind > q_key_indent:
                    q_item_indent = ind
                    q_starts.append(qi)
                if _BLOCK_SCALAR_RE.search(st):
                    bi = ind
                    if is_l:
                        af = st[1:].lstrip(" ")
                        if ":" in af:
                            bi = ind + (len(st) - len(af))
                    b_ind = bi

            for q_pos, q_start in enumerate(q_starts):
                q_lim = q_starts[q_pos + 1] if q_pos + 1 < len(q_starts) else s_limit
                q_type = "multiple_choice"
                q_preview_src = ""
                q_answer: str | None = None
                q_pts: float | None = None
                sub_count = 0

                k = q_start
                q_prop_indent: int | None = None
                while k < q_lim:
                    ln = lines[k]
                    st = ln.lstrip(" ")
                    if not st or st.startswith("#"):
                        k += 1
                        continue
                    ind = len(ln) - len(st)
                    prop = st[1:].lstrip(" ") if (k == q_start and st.startswith("-")) else st
                    p_ind = ind + (len(st) - len(prop)) if (k == q_start and st.startswith("-")) else ind
                    if q_prop_indent is None and p_ind > (q_item_indent or 0):
                        q_prop_indent = p_ind

                    if q_prop_indent is not None and p_ind == q_prop_indent:
                        mp = re.match(r"^(type|question|title|content|answer|points|questions)\s*:(.*)$", prop)
                        if mp:
                            pk, prest = mp.group(1), mp.group(2)
                            if pk == "questions" and q_type == "group":
                                # Count sub-items inside group
                                sub_ind: int | None = None
                                sb_ind: int | None = None
                                for ski in range(k + 1, q_lim):
                                    sln = lines[ski]
                                    sst = sln.lstrip(" ")
                                    if not sst or sst.startswith("#"):
                                        continue
                                    sind = len(sln) - len(sst)
                                    if sb_ind is not None:
                                        if sind > sb_ind:
                                            continue
                                        sb_ind = None
                                    if sind <= p_ind and not sst.startswith("-"):
                                        break
                                    if (sst == "-" or sst.startswith("- ")) and (sub_ind is None or sind == sub_ind) and sind > p_ind:
                                        sub_ind = sind
                                        sub_count += 1
                                    if _BLOCK_SCALAR_RE.search(sst):
                                        sbi = sind
                                        if sst.startswith("- "):
                                            saf = sst[1:].lstrip(" ")
                                            if ":" in saf:
                                                sbi = sind + (len(sst) - len(saf))
                                        sb_ind = sbi
                                k += 1
                                continue
                            val, k = _extract_scalar_at(lines, k, q_lim, p_ind, prest)
                            if pk == "type" and val.strip():
                                q_type = val.strip()
                            elif pk in ("question", "title", "content") and not q_preview_src and val.strip():
                                q_preview_src = val.strip()
                            elif pk == "answer":
                                q_answer = val.strip()
                            elif pk == "points":
                                try:
                                    q_pts = float(val.strip())
                                except ValueError:
                                    pass
                            continue
                    if _BLOCK_SCALAR_RE.search(prop):
                        _, k = _extract_scalar_at(lines, k, q_lim, p_ind, prop.split(":", 1)[1] if ":" in prop else "")
                    else:
                        k += 1

                item_info: dict[str, Any] = {
                    "index": q_pos + 1,
                    "type": q_type,
                    "line": q_start + 1,
                    "preview": _short_preview(q_preview_src),
                }
                if q_pts is not None:
                    item_info["points"] = q_pts
                if q_answer:
                    item_info["answer"] = q_answer
                if q_type == "group":
                    item_info["sub_question_count"] = sub_count
                q_items_out.append(item_info)

        sec_info: dict[str, Any] = {
            "section_index": s_pos + 1,
            "title": sec_title,
            "start_line": s_start + 1,
            "end_line": s_end_inclusive + 1,
            "item_count": len(q_items_out),
            "questions": q_items_out,
        }
        if sec_points is not None:
            sec_info["points"] = sec_points
        sections_out.append(sec_info)

    return sections_out
