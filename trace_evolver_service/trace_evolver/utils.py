from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable


EXCLUDED_PARTS = {
    "evals",
    "benchmarks",
    "reports",
    "outputs",
    "workspace",
    ".git",
    ".github",
    "node_modules",
    "dist",
    "build",
    "tmp",
    "temp",
    "__pycache__",
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path) -> str:
    digest = hashlib.sha256()
    if not root.exists():
        return digest.hexdigest()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(str(path.relative_to(root)).encode("utf-8"))
        digest.update(sha256_file(path).encode("utf-8"))
    return digest.hexdigest()


def slugify(value: str, fallback: str = "item") -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return normalized[:64] or fallback


def tokenize(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-zA-Z0-9_]+", text.lower()) if len(token) > 1}


def jaccard_similarity(left: Iterable[str], right: Iterable[str]) -> float:
    left_set = set(left)
    right_set = set(right)
    if not left_set and not right_set:
        return 1.0
    if not left_set or not right_set:
        return 0.0
    return len(left_set & right_set) / len(left_set | right_set)


def ensure_absolute(path_str: str) -> Path:
    path = Path(path_str)
    if not path.is_absolute():
        raise ValueError(f"path must be absolute: {path_str}")
    return path


def is_allowed_markdown_path(bundle_root: Path, file_path: Path) -> bool:
    try:
        relative = file_path.resolve().relative_to(bundle_root.resolve())
    except ValueError:
        return False
    if file_path.suffix.lower() != ".md":
        return False
    return not any(part in EXCLUDED_PARTS for part in relative.parts)


def json_dumps(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)


def trim_snippet(text: str, limit: int = 200) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3] + "..."
