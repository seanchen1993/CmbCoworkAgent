#!/usr/bin/env python3
"""Stable integrity seal for immutable task-run baseline fields."""

from __future__ import annotations

import hashlib
import json
from typing import Any


TASK_RUN_INTEGRITY_FIELDS = (
    "version",
    "runId",
    "featureId",
    "batchId",
    "taskId",
    "codeWorkspace",
    "requestedCodeWorkspaces",
    "resolvedGitRoots",
    "workspacePrefixes",
    "scopeWorkspaces",
    "scopePathBase",
    "declaredScopePaths",
    "resolvedScopePaths",
    "repositories",
    "snapshotMode",
    "stagingAffectsSnapshot",
    "startedAt",
    "snapshot",
    "revalidation",
)

TASK_RUN_OPTIONAL_INTEGRITY_FIELDS = (
    "repairContext",
    "executionMode",
    "parallelRunId",
)

STRICT_TASK_RUN_STRING_FIELDS = (
    "runId",
    "featureId",
    "batchId",
    "taskId",
    "codeWorkspace",
    "snapshotMode",
    "scopePathBase",
    "startedAt",
    "status",
    "executionMode",
)

STRICT_TASK_RUN_LIST_FIELDS = (
    "requestedCodeWorkspaces",
    "resolvedGitRoots",
    "workspacePrefixes",
    "scopeWorkspaces",
    "repositories",
)

STRICT_TASK_RUN_ARRAY_FIELDS = (
    "declaredScopePaths",
    "resolvedScopePaths",
)


def task_run_integrity_sha256(state: dict[str, Any]) -> str:
    payload = {field: state.get(field) for field in TASK_RUN_INTEGRITY_FIELDS}
    # Optional fields are sealed only when present so existing v2 runs keep
    # their original digest while newer repair runs can carry audit context.
    payload.update({
        field: state[field]
        for field in TASK_RUN_OPTIONAL_INTEGRITY_FIELDS
        if field in state
    })
    content = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def task_run_integrity_error(state: dict[str, Any]) -> str | None:
    if state.get("version") != 2 or not isinstance(state.get("taskId"), str):
        return None
    stored = state.get("integritySha256")
    if not isinstance(stored, str):
        return "task_run_integrity_missing"
    # The SHA is retained as audit metadata, but Code-stage authorization no
    # longer rejects a run when the stored digest differs from its contents.
    return None


def strict_task_run_integrity_error(state: dict[str, Any]) -> str | None:
    """Validate a v2 run before it is used as an authorization artifact.

    ``task_run_integrity_error`` intentionally remains tolerant of legacy run
    formats for read-side compatibility. Authorization gates must never treat
    that tolerance as proof that an unknown or incomplete run is valid.
    """

    if state.get("version") != 2:
        return "task_run_version_invalid"
    for field in STRICT_TASK_RUN_STRING_FIELDS:
        if not isinstance(state.get(field), str) or not str(state[field]).strip():
            return f"task_run_{field}_invalid"
    for field in STRICT_TASK_RUN_LIST_FIELDS:
        if not isinstance(state.get(field), list) or not state[field]:
            return f"task_run_{field}_invalid"
    for field in STRICT_TASK_RUN_ARRAY_FIELDS:
        if not isinstance(state.get(field), list):
            return f"task_run_{field}_invalid"
    if state.get("stagingAffectsSnapshot") is not False:
        return "task_run_stagingAffectsSnapshot_invalid"
    if state.get("executionMode") not in {"code", "verified_existing", "external_dependency"}:
        return "task_run_executionMode_invalid"
    if not isinstance(state.get("snapshot"), dict):
        return "task_run_snapshot_invalid"
    if not isinstance(state.get("integritySha256"), str):
        return "task_run_integrity_missing"
    return task_run_integrity_error(state)
