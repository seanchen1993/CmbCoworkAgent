"""Plugin-owned operation records. These are not native platform approval receipts."""

import hashlib
import json
import os
import stat
from pathlib import Path
import tempfile

MAX_RECORD = 2 * 1024 * 1024
MAX_RECORDS = 512


def linked(path):
    try:
        value = path.lstat()
    except FileNotFoundError:
        return False
    # Python 3.11 has no Path.is_junction. Native lstat metadata still exposes
    # Windows reparse points, so older supported interpreters cannot miss one.
    return (stat.S_ISLNK(value.st_mode)
            or bool(getattr(value, "st_file_attributes", 0) & 0x400)
            or bool(getattr(value, "st_reparse_tag", 0)))


def read_record(path):
    if linked(path) or not path.is_file() or path.stat().st_size > MAX_RECORD:
        raise ValueError("AUTOBIZ_JOURNAL_INVALID")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("AUTOBIZ_JOURNAL_INVALID")
    return value


def write_record(path, value, *, exclusive=False):
    if linked(path) or (path.exists() and path.stat().st_nlink != 1):
        raise ValueError("AUTOBIZ_JOURNAL_INVALID")
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_RECORD:
        raise ValueError("AUTOBIZ_JOURNAL_LIMIT")
    if exclusive:
        with path.open("xb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        return
    descriptor, temporary = tempfile.mkstemp(prefix=".journal-", suffix=".pending", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def operation_id(feature, key):
    return hashlib.sha256(json.dumps([feature, key], separators=(",", ":")).encode()).hexdigest()


def policy_digest(root):
    # Bind the actual complete assembly closure, including transitive original validators,
    # configuration and schemas. Reading a digest from the lock alone would miss edits.
    lock_path = root / "devclaw.business-assembly.json"
    lock = read_record(lock_path)
    rows = lock.get("files")
    if lock.get("apiVersion") != "devclaw.business-assembly/v1" or not isinstance(rows, list) or len(rows) > 512:
        raise ValueError("AUTOBIZ_POLICY_RESOURCE_INVALID")
    names = {"devclaw.business-assembly.json"}
    for row in rows:
        name = row.get("path") if isinstance(row, dict) else None
        if not isinstance(name, str) or "\\" in name or ":" in name or any(part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("AUTOBIZ_POLICY_RESOURCE_INVALID")
        names.add(name)
    files = [root / name for name in sorted(names)]
    value = hashlib.sha256()
    size = 0
    for path in files:
        if linked(path) or not path.is_file() or path.stat().st_size > MAX_RECORD:
            raise ValueError("AUTOBIZ_POLICY_RESOURCE_INVALID")
        for parent in path.relative_to(root).parents:
            if linked(root / parent):
                raise ValueError("AUTOBIZ_POLICY_RESOURCE_INVALID")
        data = path.read_bytes()
        size += len(data)
        if size > 64 * 1024 * 1024:
            raise ValueError("AUTOBIZ_POLICY_RESOURCE_LIMIT")
        value.update(str(path.relative_to(root)).replace("\\", "/").encode())
        value.update(b"\0")
        value.update(hashlib.sha256(data).digest())
    return value.hexdigest()


def request_binding(root, request):
    return {"feature": request["feature"], "requestKey": request["requestKey"],
            "to": request["to"], "expectedStateDigest": request["expectedStateDigest"],
            "policyDigest": policy_digest(root),
            **({"workflowDigest": request["expectedWorkflowDigest"]}
               if "expectedWorkflowDigest" in request else {})}


def assert_no_pending(directory, feature, own_operation):
    paths = list(directory.glob("*.json"))
    if len(paths) > MAX_RECORDS:
        raise ValueError("AUTOBIZ_JOURNAL_LIMIT")
    pending = []
    for path in paths:
        if path.stem == own_operation or path.name.endswith(".physical.json"):
            continue
        row = read_record(path)
        if row.get("request", {}).get("feature") == feature and row.get("phase") not in ("committed", "not-applied"):
            pending.append(row.get("operationId", path.stem))
    return pending
