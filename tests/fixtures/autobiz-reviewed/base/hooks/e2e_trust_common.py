#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared E2E trust-gate hashing and validation helpers."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


QUALITY_SCAN_NAME = "E2E_QUALITY_SCAN.json"
DIAGNOSTICS_DIR = "e2e-diagnostics"


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    import os
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=".autobiz-e2e-", suffix=".tmp", delete=False
    ) as handle:
        temporary = Path(handle.name)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def load_json_object(path: Path, label: str) -> Dict[str, Any]:
    if not path.is_file():
        raise ValueError(
            "{} 不存在：{}。修复：先生成该机器产物再继续。".format(label, path)
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(
            "{} 不是合法 JSON：{}。修复：重新生成该机器产物。".format(label, exc)
        )
    if not isinstance(payload, dict):
        raise ValueError(
            "{} 根节点必须是 object。修复：重新生成该机器产物。".format(label)
        )
    return payload


def normalize_relative_path(root: Path, raw_path: str, label: str) -> Tuple[str, Path]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError(
            "{} 不能为空。修复：传入工作区内的相对路径。".format(label)
        )
    candidate = Path(raw_path).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    try:
        relative = resolved.relative_to(root.resolve()).as_posix()
    except ValueError:
        raise ValueError(
            "{} 越出工作区：{}。修复：把路径限制在 {} 内。".format(
                label, resolved, root.resolve()
            )
        )
    return relative, resolved


def scan_path(feature_dir: Path) -> Path:
    return feature_dir / QUALITY_SCAN_NAME


def quality_gate_snapshot(feature_dir: Path, scan: Dict[str, Any]) -> Dict[str, Any]:
    path = scan_path(feature_dir)
    counts = scan.get("counts") if isinstance(scan.get("counts"), dict) else {}
    return {
        "scanPath": QUALITY_SCAN_NAME,
        "scanSha256": sha256_path(path),
        "scannedAt": scan.get("scannedAt"),
        "counts": dict(counts),
        "unresolvedBlockers": scan.get("unresolvedBlockers", 0),
        "unresolvedImports": len(scan.get("unresolvedImports", []))
        if isinstance(scan.get("unresolvedImports"), list)
        else 0,
        "passed": scan.get("passed") is True,
    }


def _scan_inputs(scan: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    entries = scan.get("scannedInputs")
    if not isinstance(entries, list):
        return result
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if isinstance(path, str) and path:
            result[path] = entry
    return result


def validate_scan_current(
    feature_dir: Path,
    quality_gate: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    errors: List[str] = []
    path = scan_path(feature_dir)
    try:
        scan = load_json_object(path, QUALITY_SCAN_NAME)
    except ValueError as exc:
        return None, [str(exc)]
    if scan.get("version") != 1:
        errors.append("invalid_quality_scan_version")
    if scan.get("passed") is not True:
        errors.append("quality_gate_not_passed")
    if scan.get("unresolvedBlockers") != 0:
        errors.append("quality_gate_has_unresolved_blockers")
    unresolved_imports = scan.get("unresolvedImports")
    if not isinstance(unresolved_imports, list) or unresolved_imports:
        errors.append("quality_gate_has_unresolved_imports")
    code_workspace = scan.get("codeWorkspace")
    if not isinstance(code_workspace, str) or not code_workspace:
        errors.append("quality_scan_missing_code_workspace")
        return scan, errors
    code_root = Path(code_workspace).expanduser().resolve()
    if not code_root.is_dir():
        errors.append("quality_scan_code_workspace_missing")
        return scan, errors
    inputs = scan.get("scannedInputs")
    if not isinstance(inputs, list) or not inputs:
        errors.append("quality_scan_missing_inputs")
    else:
        seen = set()
        for entry in inputs:
            if not isinstance(entry, dict):
                errors.append("invalid_quality_scan_input")
                continue
            relative = entry.get("path")
            expected = entry.get("sha256")
            if not isinstance(relative, str) or not relative or relative in seen:
                errors.append("invalid_or_duplicate_quality_scan_input")
                continue
            seen.add(relative)
            try:
                _, current_path = normalize_relative_path(code_root, relative, "scanned input")
            except ValueError:
                errors.append("quality_scan_input_outside_workspace:{}".format(relative))
                continue
            if not current_path.is_file():
                errors.append("quality_scan_input_missing:{}".format(relative))
            elif expected != sha256_path(current_path):
                errors.append("quality_scan_input_hash_mismatch:{}".format(relative))
    if quality_gate is not None:
        if quality_gate.get("scanPath") != QUALITY_SCAN_NAME:
            errors.append("quality_gate_scan_path_mismatch")
        if quality_gate.get("scanSha256") != sha256_path(path):
            errors.append("quality_gate_scan_hash_mismatch")
        if quality_gate.get("scannedAt") != scan.get("scannedAt"):
            errors.append("quality_gate_scanned_at_mismatch")
        if quality_gate.get("passed") is not True:
            errors.append("quality_gate_snapshot_not_passed")
    return scan, errors


def _relative_artifact(feature_dir: Path, raw_path: Any, label: str) -> Tuple[Optional[str], Optional[Path], List[str]]:
    errors: List[str] = []
    if not isinstance(raw_path, str) or not raw_path:
        return None, None, ["{}_path_missing".format(label)]
    try:
        relative, resolved = normalize_relative_path(feature_dir, raw_path, label)
    except ValueError:
        return None, None, ["{}_path_outside_feature".format(label)]
    if not relative.startswith(DIAGNOSTICS_DIR + "/"):
        errors.append("{}_path_outside_diagnostics".format(label))
    return relative, resolved, errors


def validate_execution_hash_chain(
    feature_dir: Path,
    quality_gate: Optional[Dict[str, Any]],
    execution: Dict[str, Any],
    evidence: Dict[str, Any],
) -> List[str]:
    scan, errors = validate_scan_current(feature_dir, quality_gate)
    if scan is None:
        return errors
    code_workspace = scan.get("codeWorkspace")
    if not isinstance(code_workspace, str):
        return errors
    code_root = Path(code_workspace).expanduser().resolve()
    if execution.get("codeWorkspace") != str(code_root):
        errors.append("execution_code_workspace_mismatch")
    scanned = _scan_inputs(scan)
    spec_hashes = execution.get("specHashes")
    if not isinstance(spec_hashes, dict) or not spec_hashes:
        errors.append("execution_spec_hashes_missing")
    else:
        for relative, expected in spec_hashes.items():
            if not isinstance(relative, str) or not isinstance(expected, str):
                errors.append("invalid_execution_spec_hash")
                continue
            scan_entry = scanned.get(relative)
            if scan_entry is None:
                errors.append("execution_spec_not_scanned:{}".format(relative))
                continue
            if scan_entry.get("sha256") != expected:
                errors.append("execution_scan_spec_hash_mismatch:{}".format(relative))
            try:
                _, path = normalize_relative_path(code_root, relative, "execution spec")
            except ValueError:
                errors.append("execution_spec_outside_workspace:{}".format(relative))
                continue
            if not path.is_file():
                errors.append("execution_spec_missing:{}".format(relative))
            elif sha256_path(path) != expected:
                errors.append("execution_spec_current_hash_mismatch:{}".format(relative))

    config_source = execution.get("configSource")
    if config_source == "config_file":
        config_path = execution.get("configPath")
        config_hash = execution.get("configSha256")
        if not isinstance(config_path, str) or not isinstance(config_hash, str):
            errors.append("execution_config_hash_missing")
        else:
            scan_entry = scanned.get(config_path)
            if scan_entry is None:
                errors.append("execution_config_not_scanned")
            elif scan_entry.get("sha256") != config_hash:
                errors.append("execution_scan_config_hash_mismatch")
            try:
                _, current_config = normalize_relative_path(code_root, config_path, "config")
            except ValueError:
                errors.append("execution_config_outside_workspace")
            else:
                if not current_config.is_file():
                    errors.append("execution_config_missing")
                elif sha256_path(current_config) != config_hash:
                    errors.append("execution_config_current_hash_mismatch")
    elif config_source == "playwright_defaults":
        if execution.get("configPath") is not None or execution.get("configSha256") is not None:
            errors.append("default_config_must_not_have_hash")
    else:
        errors.append("invalid_execution_config_source")

    report = execution.get("report")
    evidence_run = evidence.get("e2eRun") if isinstance(evidence.get("e2eRun"), dict) else {}
    evidence_report = evidence_run.get("report") if isinstance(evidence_run.get("report"), dict) else {}
    if not isinstance(report, dict):
        errors.append("execution_report_missing")
    else:
        _, report_path, path_errors = _relative_artifact(
            feature_dir, report.get("path"), "report"
        )
        errors.extend(path_errors)
        expected = report.get("sha256")
        if not isinstance(expected, str):
            errors.append("execution_report_hash_missing")
        elif report_path is None or not report_path.is_file():
            errors.append("execution_report_file_missing")
        elif sha256_path(report_path) != expected:
            errors.append("execution_report_current_hash_mismatch")
        if evidence_report.get("path") != report.get("path"):
            errors.append("evidence_report_path_mismatch")
        if evidence_report.get("sha256") != expected:
            errors.append("evidence_report_hash_mismatch")
    return errors


def validate_execution_evidence_chain(
    execution: Dict[str, Any],
    evidence: Dict[str, Any],
    case_id: Any,
    task_id: Any,
    spec_refs: Any,
) -> List[str]:
    """Validate the non-file facts shared by one execution and Evidence record."""

    errors: List[str] = []
    if evidence.get("skill") != "autodev-e2e" or evidence.get("action") != "validation":
        errors.append("execution_evidence_source_invalid")
    if evidence.get("taskId") != task_id:
        errors.append("execution_evidence_task_mismatch")
    if evidence.get("specRefs") != spec_refs:
        errors.append("execution_evidence_spec_refs_mismatch")

    result = execution.get("result")
    process_code = execution.get("processExitCode")
    gate_code = execution.get("gateExitCode")
    if not isinstance(process_code, int) or not isinstance(gate_code, int):
        errors.append("invalid_execution_exit_code")
    elif gate_code == 0 and process_code != 0:
        errors.append("e2e_gate_cannot_relax_process")
    if result == "PASS":
        expected_validation_result = "pass"
        if gate_code != 0 or process_code != 0:
            errors.append("pass_execution_requires_zero_exit_codes")
    elif result == "BLOCKED":
        expected_validation_result = "blocked"
        if gate_code == 0:
            errors.append("nonpass_execution_requires_nonzero_gate")
    elif result in {"FAIL", "FLAKY"}:
        expected_validation_result = "fail"
        if gate_code == 0:
            errors.append("nonpass_execution_requires_nonzero_gate")
    else:
        expected_validation_result = None
        errors.append("invalid_execution_result")

    validation = evidence.get("validation") if isinstance(evidence.get("validation"), dict) else {}
    if validation.get("command") != execution.get("command"):
        errors.append("execution_evidence_command_mismatch")
    if validation.get("exitCode") != gate_code:
        errors.append("execution_evidence_gate_exit_code_mismatch")
    if expected_validation_result is not None and validation.get("result") != expected_validation_result:
        errors.append("execution_evidence_validation_result_mismatch")

    evidence_run = evidence.get("e2eRun") if isinstance(evidence.get("e2eRun"), dict) else {}
    if evidence_run.get("caseId") != case_id:
        errors.append("execution_evidence_case_mismatch")
    for field in (
        "runId",
        "roundIndex",
        "result",
        "processExitCode",
        "specPaths",
        "specHashes",
        "configPath",
        "configSha256",
        "configSource",
        "report",
        "caseBinding",
        "projects",
        "executionAdapter",
        "playwrightVersion",
    ):
        if evidence_run.get(field) != execution.get(field):
            errors.append("evidence_execution_{}_mismatch".format(field))
    return errors


def validate_execution_log_chain(
    execution: Dict[str, Any],
    evidence_id: Any,
    log_record: Dict[str, Any],
    case_id: Any,
    task_id: Any,
    spec_refs: Any,
) -> List[str]:
    """Validate the verdict_run projection against its execution and case."""

    expected = {
        "kind": "verdict_run",
        "runId": execution.get("runId"),
        "caseId": case_id,
        "taskId": task_id,
        "specRefs": spec_refs,
        "specHash": execution.get("specHashes"),
        "command": execution.get("command"),
        "processExitCode": execution.get("processExitCode"),
        "gateExitCode": execution.get("gateExitCode"),
        "result": execution.get("result"),
        "evidenceId": evidence_id,
        "roundIndex": execution.get("roundIndex"),
    }
    return [
        "execution_log_{}_mismatch".format(field)
        for field, value in expected.items()
        if log_record.get(field) != value
    ]


def is_fresh(created_at: Any, started_at: Any) -> bool:
    if not isinstance(created_at, str) or not isinstance(started_at, str):
        return False
    return created_at >= started_at
