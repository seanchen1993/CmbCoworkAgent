#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared filesystem primitives for evidence artifacts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, BinaryIO, ContextManager


LEGACY_SIDECAR_ARTIFACT_VERSION = 1
EVIDENCE_ARTIFACT_VERSION = 2
SUPPORTED_EVIDENCE_ARTIFACT_VERSIONS = {
    LEGACY_SIDECAR_ARTIFACT_VERSION,
    EVIDENCE_ARTIFACT_VERSION,
}
MAX_LOG_BYTES = 1_000_000
TRUNCATION_MARKER = b"\n... [LOG TRUNCATED] ...\n"
SECRET_PATTERNS = (
    re.compile(r"(?im)^(\s*(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+"),
    re.compile(r"(?im)(authorization\s*:\s*bearer\s+)\S+"),
)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sidecar_path(target_feature_dir: Path, evidence_id: str) -> Path:
    return target_feature_dir / "evidence" / f"{evidence_id}.json"


def log_path(target_feature_dir: Path, evidence_id: str) -> Path:
    return target_feature_dir / "evidence" / f"{evidence_id}.log"


def pending_path(target_feature_dir: Path, evidence_id: str) -> Path:
    return target_feature_dir / "evidence" / ".pending" / f"{evidence_id}.json"


def unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as handle:
        tmp_path = Path(handle.name)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    tmp_path.replace(path)


def write_json_artifact(path: Path, payload: dict[str, Any]) -> None:
    content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    _atomic_write_bytes(path, content)


def write_sidecar(target_feature_dir: Path, record: dict[str, Any]) -> Path:
    evidence_id = record.get("evidenceId")
    if not isinstance(evidence_id, str) or not evidence_id:
        raise ValueError("invalid_evidence_id_for_sidecar")
    path = sidecar_path(target_feature_dir, evidence_id)
    content = json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    _atomic_write_bytes(path, content)
    return path


def write_pending(target_feature_dir: Path, record: dict[str, Any]) -> Path:
    evidence_id = record.get("evidenceId")
    if not isinstance(evidence_id, str) or not evidence_id:
        raise ValueError("invalid_evidence_id_for_pending")
    path = pending_path(target_feature_dir, evidence_id)
    content = json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    _atomic_write_bytes(path, content)
    return path


def _redact_output(output: str) -> tuple[str, bool]:
    redacted = output
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(r"\1[REDACTED]", redacted)
    return redacted, redacted != output


def _truncate_output(content: bytes) -> tuple[bytes, bool]:
    if len(content) <= MAX_LOG_BYTES:
        return content, False
    available = MAX_LOG_BYTES - len(TRUNCATION_MARKER)
    head_size = available // 2
    tail_size = available - head_size
    return content[:head_size] + TRUNCATION_MARKER + content[-tail_size:], True


def prepare_log(output: str) -> tuple[bytes, dict[str, Any]]:
    original = output.encode("utf-8")
    redacted_output, was_redacted = _redact_output(output)
    stored, was_truncated = _truncate_output(redacted_output.encode("utf-8"))
    return stored, {
        "outputSha256": sha256_bytes(stored),
        "outputBytes": len(stored),
        "emptyOutput": len(stored) == 0,
        "outputRedacted": was_redacted,
        "outputTruncated": was_truncated,
        "originalOutputSha256": sha256_bytes(original),
        "originalOutputBytes": len(original),
    }


def write_log(
    target_feature_dir: Path,
    evidence_id: str,
    output: str,
    *,
    prepared: tuple[bytes, dict[str, Any]] | None = None,
) -> tuple[Path, dict[str, Any]]:
    path = log_path(target_feature_dir, evidence_id)
    content, metadata = prepared or prepare_log(output)
    _atomic_write_bytes(path, content)
    return path, {
        "outputTailPath": f"evidence/{evidence_id}.log",
        **metadata,
    }


def output_duplicates_record(output: str, record: dict[str, Any]) -> bool:
    try:
        parsed = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(parsed, dict) and parsed == record


def check_record_artifacts(target_feature_dir: Path, record: dict[str, Any]) -> list[str]:
    artifact_version = record.get("artifactVersion")
    if artifact_version not in SUPPORTED_EVIDENCE_ARTIFACT_VERSIONS:
        return []
    evidence_id = record.get("evidenceId")
    if not isinstance(evidence_id, str) or not evidence_id:
        return ["invalid_evidence_id_for_artifacts"]

    errors: list[str] = []
    if artifact_version == LEGACY_SIDECAR_ARTIFACT_VERSION:
        sidecar = sidecar_path(target_feature_dir, evidence_id)
        if not sidecar.is_file():
            errors.append(f"missing_evidence_sidecar:{evidence_id}")
        else:
            try:
                sidecar_record = json.loads(sidecar.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                errors.append(f"invalid_evidence_sidecar:{evidence_id}")
            else:
                if sidecar_record != record:
                    errors.append(f"sidecar_record_mismatch:{evidence_id}")

    container_name = "smoke" if record.get("action") == "smoke" else "validation"
    container = record.get(container_name)
    if not isinstance(container, dict):
        return errors
    output_path = container.get("outputTailPath")
    if not isinstance(output_path, str) or not output_path:
        return errors
    expected_output_path = f"evidence/{evidence_id}.log"
    if output_path != expected_output_path:
        errors.append(f"evidence_log_path_mismatch:{evidence_id}")
        return errors
    output_file = target_feature_dir / output_path
    if not output_file.is_file():
        errors.append(f"missing_evidence_log:{evidence_id}")
        return errors
    content = output_file.read_bytes()
    if container.get("outputSha256") != sha256_bytes(content):
        errors.append(f"evidence_log_hash_mismatch:{evidence_id}")
    if container.get("outputBytes") != len(content):
        errors.append(f"evidence_log_size_mismatch:{evidence_id}")
    try:
        log_text = content.decode("utf-8")
    except UnicodeDecodeError:
        log_text = ""
    if output_duplicates_record(log_text, record):
        errors.append(f"evidence_log_duplicates_record:{evidence_id}")
    return errors


class FileLock(ContextManager["FileLock"]):
    """Cross-platform exclusive lock backed by one local file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.handle: BinaryIO | None = None

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        self.handle.seek(0, os.SEEK_END)
        if self.handle.tell() == 0:
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(self.handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self.handle is None:
            return
        self.handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()
        self.handle = None


class EvidenceLock(FileLock):
    """Exclusive lock for one feature evidence stream."""

    def __init__(self, target_feature_dir: Path) -> None:
        super().__init__(target_feature_dir / "evidence" / ".lock")
