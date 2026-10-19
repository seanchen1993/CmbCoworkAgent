"""Plugin-side mandatory Stop check. Reads only the native cwd and returns no business approval."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys


def reject(message):
    raise ValueError(message)


def decode(text):
    return json.loads(text, parse_constant=lambda value: reject("non-finite JSON: " + value))


def read(root, relative):
    path = root.joinpath(relative)
    current = root
    parents = []
    for part in [None, *Path(relative).parts[:-1]]:
        if part is not None:
            current = current / part
        info = current.lstat()
        if current.is_symlink() or not stat.S_ISDIR(info.st_mode):
            reject("linked path")
        parents.append((current, info.st_dev, info.st_ino))
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 524288:
        reject("invalid file")
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            reject("file replaced")
        data = handle.read(524289)
        after = os.fstat(handle.fileno())
    final = path.lstat()
    identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)
    # Windows Python exposes ctime differently through lstat and fstat. Compare each API's
    # complete identity to its own baseline, plus matching file/size/mtime across both APIs.
    shared = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_nlink)
    if len(data) > 524288 or identity(after) != identity(opened) or identity(final) != identity(before) or shared(opened) != shared(before):
        reject("file changed")
    for parent, device, inode in parents:
        info = parent.lstat()
        if parent.is_symlink() or (info.st_dev, info.st_ino) != (device, inode):
            reject("directory changed")
    return data


def same(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return math.isfinite(left) and math.isfinite(right) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    return left == right


def verify(payload):
    # The original plugin hook cwd is its pinned package. workspace_path is the native caller.
    root = Path(payload["workspace_path"])
    if not root.is_absolute() or root.is_symlink() or root.resolve(strict=True) != root:
        reject("native workspace invalid")
    prompt = payload.get("stop_context", {}).get("userMessage", "")
    markers = list(re.finditer(r"VERIFIED_REQUIRED_IDS=", prompt))
    if len(markers) != 1:
        reject("task must explicitly supply VERIFIED_REQUIRED_IDS once")
    required, _ = json.JSONDecoder().raw_decode(prompt[markers[0].end():].lstrip())
    if not isinstance(required, list) or not 1 <= len(required) <= 64 or any(
        not isinstance(item, str) or not re.fullmatch(r"[a-zA-Z0-9][\w.-]{0,79}", item, re.ASCII) for item in required
    ) or len(set(required)) != len(required):
        reject("task IDs invalid")
    raw = read(root, "inputs/verified-context.json")
    bundle = decode(raw.decode("utf-8", errors="strict"))
    report = decode(read(root, "consumed-report.json").decode("utf-8", errors="strict"))
    if bundle.get("apiVersion") != "devclaw.autobiz-context/v1" or not isinstance(bundle.get("producer"), dict):
        reject("bundle invalid")
    files = bundle.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 128:
        reject("outputs missing")
    seen = set()
    artifacts = []
    for file in files:
        identifier = file.get("id")
        if not isinstance(identifier, str) or identifier in seen or not isinstance(file.get("content"), str):
            reject("output invalid or duplicate")
        seen.add(identifier)
        digest = hashlib.sha256(file["content"].encode("utf-8")).hexdigest()
        if digest != file.get("digest"):
            reject("output hash changed")
        if not isinstance(file.get("checkedBy"), dict) or not file.get("outputNodeId"):
            reject("producer check missing")
        checked = file["checkedBy"]
        if not checked.get("nodeId") or not checked.get("checkId") or not re.fullmatch(r"[a-f0-9]{64}", checked.get("contractDigest", "")):
            reject("producer check invalid")
        artifacts.append({"id": identifier, "path": file["path"], "digest": digest,
                          "outputNodeId": file["outputNodeId"], "checkedBy": checked, "value": decode(file["content"])})
    if any(identifier not in seen for identifier in required):
        reject("required output missing")
    expected = {"bundleDigest": hashlib.sha256(raw).hexdigest(), "producer": bundle["producer"],
                "requiredIds": required, "artifacts": artifacts,
                "acceptance": "producer-checked-content; consumer consistency only; business acceptance remains unchanged"}
    if not same(report, expected):
        reject("report does not match actual input, explicit task and producer identity")


try:
    payload = decode(sys.stdin.read(262145))
    verify(payload)
    print(json.dumps({"systemMessage": "VERIFIED_REPORT_STOP_PASSED: byte integrity and consumption only; business acceptance unchanged"}))
except Exception as error:
    print(json.dumps({"decision": "block", "reason": "VERIFIED_REPORT_STOP_REJECTED: " + str(error)}))
    sys.exit(2)
