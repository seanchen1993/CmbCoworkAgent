#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Append-only evidence stream helpers for Autodev feature runs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from hooks.evidence_kernel import (
        EVIDENCE_ARTIFACT_VERSION,
        SUPPORTED_EVIDENCE_ARTIFACT_VERSIONS,
        EvidenceLock,
        check_record_artifacts,
        log_path,
        output_duplicates_record,
        prepare_log,
        pending_path,
        unlink_if_exists,
        write_log,
        write_json_artifact,
        write_pending,
    )
except ImportError:  # pragma: no cover - direct script execution path
    from evidence_kernel import (
        EVIDENCE_ARTIFACT_VERSION,
        SUPPORTED_EVIDENCE_ARTIFACT_VERSIONS,
        EvidenceLock,
        check_record_artifacts,
        log_path,
        output_duplicates_record,
        prepare_log,
        pending_path,
        unlink_if_exists,
        write_log,
        write_json_artifact,
        write_pending,
    )

try:  # Works both as ``python hooks/evidence_store.py`` and as ``hooks.evidence_store``.
    from hooks.paths import get_plugin_output_workspace, resolve_env_feature
except ImportError:  # pragma: no cover - direct script execution path
    from paths import get_plugin_output_workspace, resolve_env_feature


EVIDENCE_VERSION = 1
EVIDENCE_DETAIL_VERSION = 2
SUPPORTED_EVIDENCE_DETAIL_VERSIONS = {1, EVIDENCE_DETAIL_VERSION}
INDEX_VERSION = 1
EVIDENCE_ID_RE = re.compile(r"^ev_(\d{4})$")
DEFAULT_STREAM_RELATIVE_PATH = Path("evidence") / "EVIDENCE.jsonl"
DEFAULT_INDEX_RELATIVE_PATH = Path("evidence") / "EVIDENCE.index.json"
VALIDATION_RESULTS = {"pass", "fail", "blocked", "skipped"}
SMOKE_RESULTS = {"pass", "fail", "blocked", "skipped"}
FILE_CHANGE_OPERATIONS = {"created", "modified", "deleted", "renamed"}
FILE_CHANGE_KINDS = {"source", "test", "config", "docs", "generated", "smoke"}


class EvidenceStoreError(ValueError):
    """Raised when evidence cannot be read, validated, or appended."""


@dataclass(frozen=True)
class EvidenceSnapshot:
    records: tuple[dict[str, Any], ...]
    line_count: int
    last_evidence_id: str
    sha256: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def evidence_dir(target_feature_dir: Path) -> Path:
    return target_feature_dir / "evidence"


def stream_path(target_feature_dir: Path) -> Path:
    return target_feature_dir / DEFAULT_STREAM_RELATIVE_PATH


def index_path(target_feature_dir: Path) -> Path:
    return target_feature_dir / DEFAULT_INDEX_RELATIVE_PATH


def resolve_workspace_arg(workspace: str | None) -> Path:
    if workspace:
        return Path(workspace).expanduser().resolve()
    try:
        return get_plugin_output_workspace()
    except ValueError:
        return Path.cwd().resolve()


def resolve_feature_arg(feature: str) -> str:
    return resolve_env_feature(feature, required=False) or feature


def compute_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    if not path.is_file():
        return digest.hexdigest()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_line(raw: str, line_no: int) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EvidenceStoreError(f"invalid_evidence_json line={line_no}: {exc}") from exc
    if not isinstance(data, dict):
        raise EvidenceStoreError(f"invalid_evidence_record line={line_no}: root_must_be_object")
    return data


def read_records(path: Path) -> tuple[dict[str, Any], ...]:
    if not path.is_file():
        return ()
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, start=1):
            if not raw.strip():
                continue
            records.append(_parse_line(raw, line_no))
    return tuple(records)


def snapshot(target_feature_dir: Path) -> EvidenceSnapshot:
    path = stream_path(target_feature_dir)
    records = read_records(path)
    last_id = ""
    if records:
        last = records[-1].get("evidenceId")
        last_id = last if isinstance(last, str) else ""
    return EvidenceSnapshot(
        records=records,
        line_count=len(records),
        last_evidence_id=last_id,
        sha256=compute_sha256(path),
    )


def next_evidence_id(records: tuple[dict[str, Any], ...]) -> str:
    max_number = 0
    for record in records:
        evidence_id = record.get("evidenceId")
        if isinstance(evidence_id, str):
            match = EVIDENCE_ID_RE.match(evidence_id)
            if match:
                max_number = max(max_number, int(match.group(1)))
    return f"ev_{max_number + 1:04d}"


def load_index(target_feature_dir: Path) -> dict[str, Any] | None:
    path = index_path(target_feature_dir)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise EvidenceStoreError(f"invalid_evidence_index:{path}:{exc}") from exc
    if not isinstance(data, dict):
        raise EvidenceStoreError(f"invalid_evidence_index_root:{path}")
    return data


def write_index(
    target_feature_dir: Path,
    *,
    feature_id: str | None = None,
    verify_existing: bool = True,
) -> None:
    if verify_existing:
        _ensure_index_matches(target_feature_dir)
    snap = snapshot(target_feature_dir)
    payload = {
        "version": INDEX_VERSION,
        "featureId": feature_id or target_feature_dir.name,
        "stream": str(DEFAULT_STREAM_RELATIVE_PATH),
        "lineCount": snap.line_count,
        "lastEvidenceId": snap.last_evidence_id,
        "sha256": snap.sha256,
        "updatedAt": utc_now(),
    }
    path = index_path(target_feature_dir)
    write_json_artifact(path, payload)


def validate_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if record.get("version") != EVIDENCE_VERSION:
        errors.append("invalid_evidence_version")
    for field in ["evidenceId", "featureId", "checkpoint", "nodeId", "skill", "taskId", "action", "createdAt"]:
        value = record.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"missing_{field}")
    evidence_id = record.get("evidenceId")
    if isinstance(evidence_id, str) and not EVIDENCE_ID_RE.match(evidence_id):
        errors.append(f"invalid_evidence_id:{evidence_id}")
    validation = record.get("validation")
    if validation is not None and not isinstance(validation, dict):
        errors.append("invalid_validation_object")
    if record.get("action") == "validation":
        if not isinstance(validation, dict):
            errors.append("validation_missing")
        else:
            command = validation.get("command")
            if not isinstance(command, str) or not command.strip():
                errors.append("validation.command_missing")
            exit_code = validation.get("exitCode")
            if not isinstance(exit_code, int):
                errors.append("validation.exitCode_missing")
            raw_result = validation.get("result")
            result = raw_result.strip().lower() if isinstance(raw_result, str) else ""
            if result not in VALIDATION_RESULTS:
                errors.append("validation.result_invalid")
            if isinstance(exit_code, int) and result:
                if exit_code == 0 and result != "pass":
                    errors.append("validation.result_exitCode_mismatch")
                if exit_code != 0 and result == "pass":
                    errors.append("validation.result_exitCode_mismatch")
            output_tail_path = validation.get("outputTailPath")
            if result == "fail" and (not isinstance(output_tail_path, str) or not output_tail_path.strip()):
                errors.append("validation.outputTailPath_missing")
    if record.get("action") == "smoke":
        smoke = record.get("smoke")
        if not isinstance(smoke, dict):
            errors.append("smoke_missing")
        else:
            test_id = smoke.get("testId")
            if not isinstance(test_id, str) or not test_id.strip():
                errors.append("smoke.testId_missing")
            command = smoke.get("command")
            if not isinstance(command, str) or not command.strip():
                errors.append("smoke.command_missing")
            exit_code = smoke.get("exitCode")
            if not isinstance(exit_code, int):
                errors.append("smoke.exitCode_missing")
            raw_result = smoke.get("result")
            result = raw_result.strip().lower() if isinstance(raw_result, str) else ""
            if result not in SMOKE_RESULTS:
                errors.append("smoke.result_invalid")
            if result == "pass" and isinstance(exit_code, int) and exit_code != 0:
                errors.append("smoke.result_exitCode_mismatch")
            output_tail_path = smoke.get("outputTailPath")
            if result in {"fail", "blocked"} and (not isinstance(output_tail_path, str) or not output_tail_path.strip()):
                errors.append("smoke.outputTailPath_missing")
    changed_files = record.get("changedFiles")
    if changed_files is not None and not _string_list(changed_files):
        errors.append("invalid_changedFiles")
    transient_validation_files = record.get("transientValidationFiles")
    if transient_validation_files is not None and not _string_list(transient_validation_files):
        errors.append("invalid_transientValidationFiles")
    spec_refs = record.get("specRefs")
    if spec_refs is not None and not _string_list(spec_refs):
        errors.append("invalid_specRefs")
    design_refs = record.get("designRefs")
    if design_refs is not None and not _string_list(design_refs):
        errors.append("invalid_designRefs")
    errors.extend(validate_detail_fields(record))
    return errors


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_detail_fields(record: dict[str, Any]) -> list[str]:
    """Validate opt-in detailed evidence fields.

    Migration rule: records without ``detailVersion`` keep the existing schema.
    Records with ``detailVersion: 1`` opt in to stricter implementation detail
    checks so humans can audit what changed without weakening code_done.
    """

    if "detailVersion" not in record:
        return []
    detail_version = record.get("detailVersion")
    if detail_version not in SUPPORTED_EVIDENCE_DETAIL_VERSIONS:
        return ["invalid_evidence_detail_version"]
    if record.get("action") != "validation":
        return []

    errors: list[str] = []
    if detail_version == 2 and record.get("artifactVersion") not in SUPPORTED_EVIDENCE_ARTIFACT_VERSIONS:
        errors.append("invalid_evidence_detail_artifactVersion")
    if not _non_empty_string(record.get("summary")):
        errors.append("missing_evidence_detail_summary")

    implementation = record.get("implementation")
    if not isinstance(implementation, dict):
        errors.append("missing_evidence_detail_implementation")
        implementation = {}

    file_changes = record.get("fileChanges")
    if not isinstance(file_changes, list):
        errors.append("missing_evidence_detail_fileChanges")
        file_changes = []

    projected_changed_files: set[str] = set()
    for index, change in enumerate(file_changes):
        context = f"fileChanges[{index}]"
        if not isinstance(change, dict):
            errors.append(f"invalid_evidence_detail_fileChange:{context}")
            continue

        path = change.get("path")
        operation = change.get("operation")
        kind = change.get("kind")
        summary = change.get("summary")
        if not _non_empty_string(path):
            errors.append(f"invalid_evidence_detail_fileChange_path:{context}")
        if operation not in FILE_CHANGE_OPERATIONS:
            errors.append(f"invalid_evidence_detail_fileChange_operation:{context}")
        if kind not in FILE_CHANGE_KINDS:
            errors.append(f"invalid_evidence_detail_fileChange_kind:{context}")
        if not _non_empty_string(summary):
            errors.append(f"invalid_evidence_detail_fileChange_summary:{context}")
        symbols = change.get("symbols")
        if symbols is not None and not _string_list(symbols):
            errors.append(f"invalid_evidence_detail_fileChange_symbols:{context}")
        reason = change.get("reason")
        if reason is not None and not isinstance(reason, str):
            errors.append(f"invalid_evidence_detail_fileChange_reason:{context}")

        if _non_empty_string(path):
            projected_changed_files.add(str(path))
        if operation == "renamed":
            from_path = change.get("fromPath")
            if not _non_empty_string(from_path):
                errors.append(f"invalid_evidence_detail_fileChange_fromPath:{context}")
            else:
                projected_changed_files.add(str(from_path))

    changed_files = record.get("changedFiles")
    if not _string_list(changed_files):
        errors.append("missing_evidence_detail_changedFiles")
    else:
        if set(changed_files) != projected_changed_files:
            errors.append("invalid_evidence_detail_changedFiles_projection")

    no_code_change = implementation.get("noCodeChange") is True
    transient_validation_files = record.get("transientValidationFiles") or []
    if not file_changes and not no_code_change and not transient_validation_files:
        errors.append("missing_evidence_detail_noCodeChange")
    if no_code_change:
        if isinstance(changed_files, list) and changed_files:
            errors.append("invalid_evidence_detail_noCodeChange_changedFiles")
        if file_changes:
            errors.append("invalid_evidence_detail_noCodeChange_fileChanges")
        what_changed = implementation.get("whatChanged")
        if isinstance(what_changed, list) and what_changed:
            errors.append("invalid_evidence_detail_noCodeChange_whatChanged")
        elif what_changed is not None and not _string_list(what_changed):
            errors.append("invalid_evidence_detail_whatChanged")
        if not _non_empty_string(implementation.get("why")):
            errors.append("missing_evidence_detail_noCodeChange_why")

    if detail_version == 2:
        errors.extend(_validate_v2_detail_fields(
            record,
            file_changes,
            no_code_change,
            bool(transient_validation_files),
        ))

    return errors


def _validate_v2_detail_fields(
    record: dict[str, Any],
    file_changes: list[Any],
    no_code_change: bool,
    has_transient_validation_files: bool,
) -> list[str]:
    errors: list[str] = []
    if not _non_empty_string(record.get("runId")):
        errors.append("missing_evidence_detail_runId")
    completion_mode = record.get("completionMode")
    if completion_mode not in {"implemented", "verified_existing"}:
        errors.append("invalid_evidence_detail_completionMode")
    checked_criteria = record.get("checkedCriteria")
    if not _string_list(checked_criteria):
        errors.append("invalid_evidence_detail_checkedCriteria")
    supporting_files = record.get("supportingFiles")
    if not _string_list(supporting_files):
        errors.append("invalid_evidence_detail_supportingFiles")
        supporting_files = []
    validation = record.get("validation")
    if isinstance(validation, dict):
        if not _non_empty_string(validation.get("commandId")):
            errors.append("missing_evidence_detail_validation_commandId")
        if not _string_list(validation.get("argv")) or not validation.get("argv"):
            errors.append("missing_evidence_detail_validation_argv")
        if not _non_empty_string(validation.get("cwd")):
            errors.append("missing_evidence_detail_validation_cwd")
        if not _non_empty_string(validation.get("kind")):
            errors.append("missing_evidence_detail_validation_kind")
        if not isinstance(validation.get("required"), bool):
            errors.append("missing_evidence_detail_validation_required")
        if not _non_empty_string(validation.get("outputTailPath")):
            errors.append("missing_evidence_detail_validation_outputTailPath")
        output_sha = validation.get("outputSha256")
        if not isinstance(output_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", output_sha):
            errors.append("missing_evidence_detail_validation_outputSha256")
        if not isinstance(validation.get("outputBytes"), int) or validation.get("outputBytes") < 0:
            errors.append("missing_evidence_detail_validation_outputBytes")
        if not isinstance(validation.get("emptyOutput"), bool):
            errors.append("missing_evidence_detail_validation_emptyOutput")
    if completion_mode == "verified_existing":
        if not no_code_change or file_changes:
            errors.append("invalid_verified_existing_file_changes")
        if record.get("action") == "validation" and not supporting_files:
            errors.append("missing_verified_existing_supportingFiles")
    if completion_mode == "implemented" and (
        no_code_change or (not file_changes and not has_transient_validation_files)
    ):
        errors.append("invalid_implemented_file_changes")
    return errors


def _ensure_index_matches(target_feature_dir: Path, *, allow_missing_for_empty_stream: bool = False) -> None:
    existing = load_index(target_feature_dir)
    if existing is None:
        if allow_missing_for_empty_stream and not read_records(stream_path(target_feature_dir)):
            return
        if stream_path(target_feature_dir).is_file() and stream_path(target_feature_dir).stat().st_size > 0:
            raise EvidenceStoreError("missing_evidence_index_for_nonempty_stream")
        return
    snap = snapshot(target_feature_dir)
    mismatches: list[str] = []
    if existing.get("lineCount") != snap.line_count:
        mismatches.append("lineCount")
    if existing.get("lastEvidenceId") != snap.last_evidence_id:
        mismatches.append("lastEvidenceId")
    if existing.get("sha256") != snap.sha256:
        mismatches.append("sha256")
    if mismatches:
        raise EvidenceStoreError("evidence_stream_rewritten_or_truncated:" + ",".join(mismatches))


def _recover_pending_appends(target_feature_dir: Path) -> None:
    pending_dir = evidence_dir(target_feature_dir) / ".pending"
    if not pending_dir.is_dir():
        return
    pending_files = sorted(pending_dir.glob("ev_*.json"))
    if len(pending_files) > 1:
        raise EvidenceStoreError("multiple_pending_evidence_records")
    for path in pending_files:
        try:
            pending = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise EvidenceStoreError(f"invalid_pending_evidence:{path.name}") from exc
        evidence_id = pending.get("evidenceId") if isinstance(pending, dict) else None
        if not isinstance(evidence_id, str) or not EVIDENCE_ID_RE.fullmatch(evidence_id):
            raise EvidenceStoreError(f"invalid_pending_evidence:{path.name}")
        _repair_partial_pending_tail(target_feature_dir, pending)
        records = read_records(stream_path(target_feature_dir))
        by_id = {
            str(record.get("evidenceId")): record
            for record in records
            if isinstance(record.get("evidenceId"), str)
        }
        streamed = by_id.get(evidence_id)
        if streamed is None:
            unlink_if_exists(log_path(target_feature_dir, evidence_id))
            path.unlink()
            continue
        if streamed != pending:
            raise EvidenceStoreError(f"pending_evidence_stream_mismatch:{evidence_id}")
        if not records or records[-1].get("evidenceId") != evidence_id:
            raise EvidenceStoreError(f"pending_evidence_not_stream_tail:{evidence_id}")
        existing_index = load_index(target_feature_dir)
        current = snapshot(target_feature_dir)
        index_matches_current = bool(
            existing_index
            and existing_index.get("lineCount") == current.line_count
            and existing_index.get("lastEvidenceId") == current.last_evidence_id
            and existing_index.get("sha256") == current.sha256
        )
        if existing_index is None:
            if len(records) != 1:
                raise EvidenceStoreError(f"pending_evidence_missing_prior_index:{evidence_id}")
        elif not index_matches_current:
            stream_bytes = stream_path(target_feature_dir).read_bytes()
            lines = stream_bytes.splitlines(keepends=True)
            prefix_sha = hashlib.sha256(b"".join(lines[:-1])).hexdigest()
            prior_id = records[-2].get("evidenceId") if len(records) > 1 else ""
            if not (
                existing_index.get("lineCount") == len(records) - 1
                and existing_index.get("lastEvidenceId") == prior_id
                and existing_index.get("sha256") == prefix_sha
            ):
                raise EvidenceStoreError(f"pending_evidence_prior_index_mismatch:{evidence_id}")
        artifact_errors = check_record_artifacts(target_feature_dir, streamed)
        if artifact_errors:
            raise EvidenceStoreError(";".join(artifact_errors))
        write_index(
            target_feature_dir,
            feature_id=str(streamed.get("featureId") or target_feature_dir.name),
            verify_existing=False,
        )
        path.unlink()


def _repair_partial_pending_tail(target_feature_dir: Path, pending: dict[str, Any]) -> None:
    path = stream_path(target_feature_dir)
    if not path.is_file() or path.stat().st_size <= 0:
        return
    evidence_id = str(pending.get("evidenceId", ""))
    expected_line = json.dumps(pending, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n"
    stream_bytes = path.read_bytes()
    existing_index = load_index(target_feature_dir)

    if existing_index is None:
        if evidence_id != "ev_0001":
            return
        committed_prefix = b""
        tail = stream_bytes
    else:
        line_count = existing_index.get("lineCount")
        if not isinstance(line_count, int) or line_count < 0:
            raise EvidenceStoreError("invalid_evidence_index_lineCount")
        lines = stream_bytes.splitlines(keepends=True)
        if len(lines) < line_count:
            raise EvidenceStoreError(f"pending_evidence_committed_prefix_missing:{evidence_id}")
        committed_prefix = b"".join(lines[:line_count])
        if hashlib.sha256(committed_prefix).hexdigest() != existing_index.get("sha256"):
            raise EvidenceStoreError(f"pending_evidence_committed_prefix_mismatch:{evidence_id}")
        committed_records = _records_from_bytes(committed_prefix)
        committed_last = (
            str(committed_records[-1].get("evidenceId", "")) if committed_records else ""
        )
        if len(committed_records) != line_count or committed_last != existing_index.get("lastEvidenceId"):
            raise EvidenceStoreError(f"pending_evidence_committed_prefix_mismatch:{evidence_id}")
        tail = stream_bytes[len(committed_prefix) :]
        if existing_index.get("lastEvidenceId") == evidence_id:
            return
        if evidence_id != f"ev_{line_count + 1:04d}":
            raise EvidenceStoreError(f"pending_evidence_id_not_next:{evidence_id}")

    if not tail:
        return
    if not expected_line.startswith(tail):
        raise EvidenceStoreError(f"pending_evidence_partial_tail_mismatch:{evidence_id}")
    if tail == expected_line:
        return
    with path.open("ab") as handle:
        handle.write(expected_line[len(tail) :])
        handle.flush()
        os.fsync(handle.fileno())


def _records_from_bytes(content: bytes) -> tuple[dict[str, Any], ...]:
    records: list[dict[str, Any]] = []
    for line_no, raw in enumerate(content.decode("utf-8").splitlines(), start=1):
        if raw.strip():
            records.append(_parse_line(raw, line_no))
    return tuple(records)


def append_evidence(
    target_feature_dir: Path,
    record: dict[str, Any],
    *,
    output_tail: str | None = None,
) -> dict[str, Any]:
    """Append a single evidence record and refresh the integrity index.

    The JSONL stream is only opened in append mode. If an integrity index exists
    and no longer matches the stream, append is refused so truncation/rewrite is
    noticed before new evidence is added.
    """

    if output_tail is not None and output_duplicates_record(output_tail, record):
        raise EvidenceStoreError("evidence_log_duplicates_record")
    if "evidenceId" in record:
        raise EvidenceStoreError("evidence_id_must_be_allocated_by_store")

    with EvidenceLock(target_feature_dir):
        _recover_pending_appends(target_feature_dir)
        _ensure_index_matches(target_feature_dir, allow_missing_for_empty_stream=True)
        records = read_records(stream_path(target_feature_dir))
        payload = dict(record)
        payload.setdefault("version", EVIDENCE_VERSION)
        payload["artifactVersion"] = EVIDENCE_ARTIFACT_VERSION
        payload.setdefault("featureId", target_feature_dir.name)
        payload.setdefault("createdAt", utc_now())
        payload.setdefault("specRefs", [])
        payload.setdefault("designRefs", [])
        payload.setdefault("changedFiles", [])
        if payload.get("action") == "validation":
            payload.setdefault("validation", {})
        payload["evidenceId"] = next_evidence_id(records)

        evidence_id = payload["evidenceId"]
        if isinstance(evidence_id, str) and any(item.get("evidenceId") == evidence_id for item in records):
            raise EvidenceStoreError(f"duplicate_evidence_id:{evidence_id}")

        prepared_log: tuple[bytes, dict[str, Any]] | None = None
        if output_tail is not None:
            if not isinstance(evidence_id, str):
                raise EvidenceStoreError("invalid_evidence_id_for_tail")
            prepared_log = prepare_log(output_tail)
            output_metadata = {
                "outputTailPath": f"evidence/{evidence_id}.log",
                **prepared_log[1],
            }
            tail_container_name = "smoke" if payload.get("action") == "smoke" else "validation"
            tail_container = payload.get(tail_container_name)
            if not isinstance(tail_container, dict):
                tail_container = {}
                payload[tail_container_name] = tail_container
            tail_container.update(output_metadata)

        if output_tail is not None and output_duplicates_record(output_tail, payload):
            raise EvidenceStoreError("evidence_log_duplicates_record")

        errors = validate_record(payload)
        if errors:
            raise EvidenceStoreError(";".join(errors))

        write_pending(target_feature_dir, payload)
        if output_tail is not None and isinstance(evidence_id, str):
            write_log(target_feature_dir, evidence_id, output_tail, prepared=prepared_log)

        path = stream_path(target_feature_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        write_index(
            target_feature_dir,
            feature_id=str(payload.get("featureId") or target_feature_dir.name),
            verify_existing=False,
        )
        unlink_if_exists(pending_path(target_feature_dir, str(evidence_id)))
        return payload


def _cmd_append(args: argparse.Namespace) -> int:
    try:
        feature = resolve_feature_arg(args.feature)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    target = feature_dir(resolve_workspace_arg(args.workspace), feature)
    try:
        record = json.loads(Path(args.record).read_text(encoding="utf-8")) if args.record else {}
    except json.JSONDecodeError as exc:
        print(f"invalid record JSON: {exc}", file=sys.stderr)
        return 1
    if not isinstance(record, dict):
        print("record must be JSON object", file=sys.stderr)
        return 1

    if args.action:
        record["action"] = args.action
    if args.checkpoint:
        record["checkpoint"] = args.checkpoint
    if args.node_id:
        record["nodeId"] = args.node_id
    if args.skill:
        record["skill"] = args.skill
    if args.task_id:
        record["taskId"] = args.task_id
    if args.command:
        validation = record.get("validation") if isinstance(record.get("validation"), dict) else {}
        validation["command"] = args.command
        record["validation"] = validation
    if args.exit_code is not None:
        validation = record.get("validation") if isinstance(record.get("validation"), dict) else {}
        validation["exitCode"] = args.exit_code
        validation["result"] = "pass" if args.exit_code == 0 else "fail"
        record["validation"] = validation
    if not record.get("action") and (args.command or args.exit_code is not None):
        record["action"] = "validation"
    if record.get("skill") == "autodev-code" and record.get("action") == "validation":
        print("code_validation_requires_task_runner", file=sys.stderr)
        return 1
    if record.get("skill") == "autodev-e2e" and record.get("action") == "validation":
        print(
            "e2e_validation_requires_e2e_runner。修复：使用 "
            "`${pluginPath}/hooks/run_e2e_command.py run ... -- playwright test ...` "
            "产生真实退出码、Playwright JSON report 与 Evidence。",
            file=sys.stderr,
        )
        return 1
    tail = Path(args.output_tail).read_text(encoding="utf-8", errors="ignore") if args.output_tail else None
    try:
        appended = append_evidence(target, record, output_tail=tail)
    except EvidenceStoreError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(appended, ensure_ascii=False))
    return 0


def _cmd_append_smoke(args: argparse.Namespace) -> int:
    try:
        feature = resolve_feature_arg(args.feature)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    target = feature_dir(resolve_workspace_arg(args.workspace), feature)
    result = args.result or ("pass" if args.exit_code == 0 else "fail")
    record = {
        "featureId": feature,
        "checkpoint": args.checkpoint,
        "nodeId": args.node_id,
        "skill": args.skill,
        "taskId": args.task_id,
        "action": "smoke",
        "specRefs": args.spec_ref or [],
        "designRefs": args.design_ref or [],
        "changedFiles": args.changed_file or [],
        "smoke": {
            "testId": args.test_id,
            "command": args.command,
            "exitCode": args.exit_code,
            "result": result,
        },
    }
    tail = Path(args.output_tail).read_text(encoding="utf-8", errors="ignore") if args.output_tail else None
    try:
        appended = append_evidence(target, record, output_tail=tail)
    except EvidenceStoreError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(appended, ensure_ascii=False))
    return 0


def _cmd_index(args: argparse.Namespace) -> int:
    try:
        feature = resolve_feature_arg(args.feature)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    target = feature_dir(resolve_workspace_arg(args.workspace), feature)
    try:
        write_index(target, feature_id=feature, verify_existing=True)
    except EvidenceStoreError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"EVIDENCE_INDEX_UPDATED path={index_path(target)}")
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    try:
        feature = resolve_feature_arg(args.feature)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    target = feature_dir(resolve_workspace_arg(args.workspace), feature)
    record = next(
        (item for item in read_records(stream_path(target)) if item.get("evidenceId") == args.evidence_id),
        None,
    )
    if record is None:
        print(f"evidence_not_found:{args.evidence_id}", file=sys.stderr)
        return 1
    print(json.dumps(record, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Append or index Autodev evidence")
    subparsers = parser.add_subparsers(dest="command", required=True)

    append = subparsers.add_parser("append")
    append.add_argument("--workspace", help="project plugin workspace; defaults to PLUGIN_WORKSPACE/PROJECT_DIR")
    append.add_argument("--feature", required=True)
    append.add_argument("--record", help="JSON object file to append")
    append.add_argument("--action")
    append.add_argument("--checkpoint")
    append.add_argument("--node-id")
    append.add_argument("--skill")
    append.add_argument("--task-id")
    append.add_argument("--command")
    append.add_argument("--exit-code", type=int)
    append.add_argument("--output-tail", help="File whose text should be stored as evidence/<id>.log")
    append.set_defaults(func=_cmd_append)

    append_smoke = subparsers.add_parser("append-smoke")
    append_smoke.add_argument("--workspace", help="project plugin workspace; defaults to PLUGIN_WORKSPACE/PROJECT_DIR")
    append_smoke.add_argument("--feature", required=True)
    append_smoke.add_argument("--test-id", required=True)
    append_smoke.add_argument("--checkpoint", required=True)
    append_smoke.add_argument("--node-id", required=True)
    append_smoke.add_argument("--skill", required=True)
    append_smoke.add_argument("--task-id", required=True)
    append_smoke.add_argument("--command", required=True)
    append_smoke.add_argument("--exit-code", type=int, required=True)
    append_smoke.add_argument("--result", choices=sorted(SMOKE_RESULTS))
    append_smoke.add_argument("--spec-ref", action="append")
    append_smoke.add_argument("--design-ref", action="append")
    append_smoke.add_argument("--changed-file", action="append")
    append_smoke.add_argument("--output-tail", help="File whose text should be stored as evidence/<id>.log")
    append_smoke.set_defaults(func=_cmd_append_smoke)

    index = subparsers.add_parser("index")
    index.add_argument("--workspace", help="project plugin workspace; defaults to PLUGIN_WORKSPACE/PROJECT_DIR")
    index.add_argument("--feature", required=True)
    index.set_defaults(func=_cmd_index)

    show = subparsers.add_parser("show")
    show.add_argument("--workspace", help="project plugin workspace; defaults to PLUGIN_WORKSPACE/PROJECT_DIR")
    show.add_argument("--feature", required=True)
    show.add_argument("--evidence-id", required=True)
    show.set_defaults(func=_cmd_show)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
