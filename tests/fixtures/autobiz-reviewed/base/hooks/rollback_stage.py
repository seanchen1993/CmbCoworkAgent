#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rollback a feature to a selected workflow stage state."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.artifact_paths import has_glob, resolve_exact_relative_path  # noqa: E402
from board_core.contracts import (  # noqa: E402
    BoardConfigError,
    artifact_dicts,
    load_record_workflow_contracts,
)
from board_core.state_store import (  # noqa: E402
    StateRecords,
    get_state_json_path,
    load_state_json_records_result,
    render_state_md,
    state_json_content_from_records_preserving_raw,
    write_state_records_preserving_raw,
)
from board_core.workflow import find_effective_current_node  # noqa: E402
from hooks.evidence_kernel import FileLock  # noqa: E402
from hooks.json_writer_common import atomic_write_json  # noqa: E402
from hooks.plan_writer import (  # noqa: E402
    PlanWriterInputError,
    _load as load_plan_writer_data,
    _md_path,
    _path as plan_path,
    _plan_lock,
    _render_plan_md,
    _write as write_plan_writer_data,
)
from hooks.paths import (  # noqa: E402
    STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR,
    contains_workspace_argument,
    get_feature_active_dir,
    get_features_archive_dir,
    get_plugin_output_workspace,
    resolve_env_feature,
)
from hooks.parallel_batch_lifecycle import cleanup_feature_runs_for_code_rollback  # noqa: E402
from hooks.repository_snapshot import (  # noqa: E402
    capture_untracked_files,
    capture_repository_snapshot,
    resolve_repositories,
)
from hooks.state_checkpoint import append_checkpoint_hook_logs, safe_feature_slug  # noqa: E402


NON_FILESYSTEM_ARTIFACT_TYPES = frozenset({"external", "virtual"})
ROLLBACK_ROOT = Path(".autobizdevops") / "rollback"
ROLLBACK_STATE_TARGET_IN_PROGRESS = "target_in_progress"
ROLLBACK_STATE_PREVIOUS_DONE = "previous_done"
ROLLBACK_STATE_MODES = (
    ROLLBACK_STATE_TARGET_IN_PROGRESS,
    ROLLBACK_STATE_PREVIOUS_DONE,
)
_PLATFORM_RUNTIME_EXCLUDE = ":(exclude).cmbdevclaw/**"
_PLATFORM_RUNTIME_PREFIX = ".cmbdevclaw/"
_WORKFLOW_ARTIFACT_RUNTIME_DIRECTORY = Path(".cmbdevclaw") / "workflows"
_GIT_OBJECT_ID_LENGTHS = frozenset({40, 64})
CODE_SESSION_BASELINE_VERSION = 2
# ``UI_CONTEXT.json`` is a user-confirmed, feature-wide source of truth.  It
# is listed as an early-stage output for historical workflow compatibility,
# but later stages consume it as an input as well.  A rollback must never make
# a confirmed UI boundary disappear merely because it rolls back the stage
# that first wrote it.
ROLLBACK_PRESERVED_ARTIFACTS = frozenset({"UI_CONTEXT.json"})
# These paths are implementation-owned scratch state rather than workflow
# deliverables.  Keep the list narrow: a Feature may contain user-provided
# files, so rollback must not use a broad ``*.tmp`` or ``*.lock`` sweep.
FEATURE_TRANSIENT_ROLLBACK_PATHS = (
    ".tmp",
    ".autobiz-*.tmp",
    ".plan.lock",
    ".plan-write-transaction.json",
    "UNIT_TEST_REPORT.md.tmp",
    ".ARTIFACT_CATALOG.json.*.tmp",
    ".sync-status.json.*.tmp",
    "frontend-html/.*.tmp",
)


@dataclass(frozen=True)
class RollbackPlan:
    ok: bool
    workspace: Path
    feature: str
    requested_stage: str
    # The CLI requires this choice explicitly. The library default keeps
    # existing Python callers compatible with the historical previous-done
    # behavior.
    state_mode: str = ROLLBACK_STATE_PREVIOUS_DONE
    state_options: tuple[dict[str, str], ...] = ()
    target_node_id: str | None = None
    previous_node_id: str | None = None
    old_checkpoint: str | None = None
    new_checkpoint: str | None = None
    feature_dir: Path | None = None
    active_feature_dir: Path | None = None
    artifact_paths: tuple[Path, ...] = ()
    old_records: StateRecords = field(default_factory=dict)
    records: StateRecords = field(default_factory=dict)
    raw_records: dict[str, Any] = field(default_factory=dict)
    workflow_profile: str = "standard"
    workflow_decisions: dict[str, str] = field(default_factory=dict)
    rollback_id: str = ""
    code_in_scope: bool = False
    code_source: str = "keep"
    planned_source_files: tuple[str, ...] = ()
    source_conflicts: tuple[str, ...] = ()
    code_reset_tasks: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class RollbackResult:
    ok: bool
    plan: RollbackPlan
    deleted_artifacts: tuple[str, ...] = ()
    archived_workflow_runtime: str | None = None
    restored_active_dir: bool = False
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class CodeSourcePlan:
    ok: bool
    repositories: dict[str, Path] = field(default_factory=dict)
    baseline: dict[str, Any] = field(default_factory=dict)
    expected_files: dict[str, dict[str, str | None]] = field(default_factory=dict)
    owned_paths: dict[str, tuple[str, ...]] = field(default_factory=dict)
    planned_files: tuple[str, ...] = ()
    conflicts: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class CodeResetPlan:
    present: bool
    data: dict[str, Any] = field(default_factory=dict)
    task_ids: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()


def _failed_plan(
    *,
    workspace: Path,
    feature: str,
    stage: str,
    errors: list[str] | tuple[str, ...],
    **values: Any,
) -> RollbackPlan:
    return RollbackPlan(
        ok=False,
        workspace=workspace,
        feature=feature,
        requested_stage=stage,
        errors=tuple(errors),
        **values,
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _rollback_root(workspace: Path) -> Path:
    return workspace.resolve() / ROLLBACK_ROOT


def _session_root(workspace: Path, feature: str) -> Path:
    if not safe_feature_slug(feature):
        raise ValueError(f"feature 不是安全的相对路径: {feature}")
    return _rollback_root(workspace) / "baselines" / feature


def _active_session_path(workspace: Path, feature: str) -> Path:
    return _session_root(workspace, feature) / "active.json"


def _load_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"JSON 文件无法读取: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON 根节点必须是 object: {path}")
    return value


def _load_active_code_session(workspace: Path, feature: str) -> dict[str, Any] | None:
    path = _active_session_path(workspace, feature)
    if not path.is_file():
        return None
    value = _load_json_object(path)
    if value.get("featureId") != feature or not isinstance(value.get("repositories"), dict):
        raise ValueError(f"Code Session 基线格式无效: {path}")
    return value


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _store_baseline_object(session_root: Path, content: bytes) -> str:
    digest = _sha256(content)
    target = session_root / "objects" / digest
    if target.is_file():
        return digest
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=target.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(target)
    return digest


def _baseline_entry(session_root: Path, path: Path) -> dict[str, Any]:
    mode = stat.S_IMODE(path.lstat().st_mode)
    if path.is_symlink():
        kind = "symlink"
        content = os.readlink(path).encode("utf-8", "surrogateescape")
    elif path.is_file():
        kind = "file"
        content = path.read_bytes()
    else:
        raise ValueError(f"Code Session 不支持的文件类型: {path}")
    return {
        "kind": kind,
        "mode": mode,
        "storage": "baseline_object",
        "objectSha256": _store_baseline_object(session_root, content),
    }


def _git_bytes(repository: Path, *args: str) -> bytes:
    completed = subprocess.run(
        ["git", "-C", str(repository), *args],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip().replace("\n", " ")
        raise ValueError(f"Code Session Git 命令失败: {repository}:{' '.join(args)}:{detail}")
    return completed.stdout


def _nul_paths(raw: bytes) -> set[str]:
    return {
        value.decode("utf-8", "surrogateescape")
        for value in raw.split(b"\0")
        if value
    }


def _head_blob_entries(repository: Path, head_commit: object) -> dict[str, tuple[int, str]]:
    if not isinstance(head_commit, str) or head_commit.startswith("unborn:"):
        return {}
    raw = _git_bytes(
        repository,
        "ls-tree",
        "-r",
        "-z",
        head_commit,
    )
    entries: dict[str, tuple[int, str]] = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, separator, encoded_path = record.partition(b"\t")
        fields = metadata.split()
        if not separator or len(fields) != 3 or fields[1] != b"blob":
            raise ValueError(f"Code Session 不支持的 Git tree 条目: {repository}")
        try:
            mode = int(fields[0], 8)
            blob_sha = fields[2].decode("ascii")
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError(f"Code Session Git tree 条目无效: {repository}") from exc
        if len(blob_sha) not in _GIT_OBJECT_ID_LENGTHS or any(char not in "0123456789abcdef" for char in blob_sha.lower()):
            raise ValueError(f"Code Session Git blob SHA 无效: {repository}")
        relative = encoded_path.decode("utf-8", "surrogateescape")
        if relative.startswith(_PLATFORM_RUNTIME_PREFIX):
            continue
        entries[relative] = (mode, blob_sha)
    return entries


def _index_paths(repository: Path) -> set[str]:
    raw = _git_bytes(
        repository,
        "ls-files",
        "--stage",
        "-z",
        "--",
        ".",
        _PLATFORM_RUNTIME_EXCLUDE,
    )
    paths: set[str] = set()
    for record in raw.split(b"\0"):
        if not record:
            continue
        _metadata, separator, encoded_path = record.partition(b"\t")
        if not separator:
            raise ValueError(f"Code Session Git index 条目无效: {repository}")
        paths.add(encoded_path.decode("utf-8", "surrogateescape"))
    return paths


def _dirty_against_head_paths(repository: Path, head_commit: object) -> set[str]:
    if not isinstance(head_commit, str) or head_commit.startswith("unborn:"):
        return _index_paths(repository)
    return _nul_paths(
        _git_bytes(
            repository,
            "diff",
            "--name-only",
            "-z",
            head_commit,
            "--",
            ".",
            _PLATFORM_RUNTIME_EXCLUDE,
        )
    )


def _git_blob_baseline_entry(mode: int, blob_sha: str) -> dict[str, Any]:
    if mode == 0o120000:
        kind = "symlink"
    elif mode in {0o100644, 0o100755}:
        kind = "file"
    else:
        raise ValueError(f"Code Session 不支持的 Git 文件模式: {mode:o}")
    return {
        "kind": kind,
        "mode": mode & 0o7777,
        "storage": "git_blob",
        "gitSha": blob_sha,
    }


def _capture_repository_baseline_entries(
    *,
    session_root: Path,
    repository: Path,
    head_commit: object,
) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """Use HEAD blobs for clean files and persist only local working content.

    A Code Session must be able to restore pre-existing staged, unstaged, and
    untracked changes.  Those contents may stop being reachable from Git after
    the user changes the index, so only files that match HEAD are referenced
    directly from Git's immutable object store.
    """

    head_entries = _head_blob_entries(repository, head_commit)
    dirty_paths = _dirty_against_head_paths(repository, head_commit)
    index_paths = _index_paths(repository)
    untracked_paths = set(capture_untracked_files(repository))
    files: dict[str, dict[str, Any]] = {}
    git_blob_files = 0
    object_files = 0

    for relative, (mode, blob_sha) in sorted(head_entries.items()):
        candidate = repository / relative
        if relative not in dirty_paths:
            files[relative] = _git_blob_baseline_entry(mode, blob_sha)
            git_blob_files += 1
        elif candidate.exists() or candidate.is_symlink():
            files[relative] = _baseline_entry(session_root, candidate)
            object_files += 1

    # Index-only paths are staged additions or unmerged entries.  Their
    # contents cannot be recovered safely from the baseline commit, so retain
    # the current working-tree version just as the legacy baseline did.
    for relative in sorted((index_paths - set(head_entries)) | untracked_paths):
        if relative in files:
            continue
        candidate = repository / relative
        if candidate.exists() or candidate.is_symlink():
            files[relative] = _baseline_entry(session_root, candidate)
            object_files += 1

    return files, {"gitBlobFiles": git_blob_files, "objectFiles": object_files}


def _rollback_feature_lock(workspace: Path, feature: str) -> FileLock:
    return FileLock(_rollback_root(workspace) / "locks" / f"{feature}.lock")


def _rollback_history_lock(workspace: Path) -> FileLock:
    return FileLock(_rollback_root(workspace) / "history.lock")


def capture_code_session_baseline(
    *,
    workspace: Path,
    feature: str,
    code_workspaces: list[Path],
) -> dict[str, Any]:
    """Capture one baseline while serializing the Feature's Code Session."""

    with _rollback_feature_lock(workspace, feature):
        return _capture_code_session_baseline_locked(
            workspace=workspace,
            feature=feature,
            code_workspaces=code_workspaces,
        )


def _capture_code_session_baseline_locked(
    *,
    workspace: Path,
    feature: str,
    code_workspaces: list[Path],
) -> dict[str, Any]:
    """Capture the one baseline used for a whole Code stage."""

    repositories = resolve_repositories(code_workspaces)
    root = _session_root(workspace, feature)
    active = _load_active_code_session(workspace, feature)
    if active is not None and active.get("status") == "active" and active.get("version") != CODE_SESSION_BASELINE_VERSION:
        raise ValueError("当前 Code Session 基线版本不受支持；请先完成回退清理后重新捕获基线")
    if active is None or active.get("status") != "active":
        active = {
            "version": CODE_SESSION_BASELINE_VERSION,
            "featureId": feature,
            "sessionId": f"code-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}",
            "status": "active",
            "createdAt": _utc_now(),
            "repositories": {},
        }
    repository_records = active["repositories"]
    for repository_id, repository in repositories.items():
        existing = repository_records.get(repository_id)
        if isinstance(existing, dict):
            if Path(str(existing.get("path", ""))).resolve() != repository.resolve():
                raise ValueError(f"Code Session 仓库 ID 冲突: {repository_id}")
            continue
        snapshot = capture_repository_snapshot(repository, include_files=False)
        files, storage = _capture_repository_baseline_entries(
            session_root=root,
            repository=repository,
            head_commit=snapshot.get("headCommit"),
        )
        repository_records[repository_id] = {
            "path": str(repository.resolve()),
            "headCommit": snapshot.get("headCommit"),
            "indexTree": snapshot.get("indexTree"),
            "files": files,
            "storage": storage,
            "capturedAt": _utc_now(),
        }
    active["updatedAt"] = _utc_now()
    atomic_write_json(_active_session_path(workspace, feature), active)
    atomic_write_json(root / str(active["sessionId"]) / "manifest.json", active)
    return active


def _run_repository_files(state: dict[str, Any], field: str) -> dict[str, dict[str, str | None]]:
    values = state.get(field)
    result: dict[str, dict[str, str | None]] = {}
    for item in values if isinstance(values, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        snapshot = item.get("snapshot")
        files = snapshot.get("files") if isinstance(snapshot, dict) else None
        if isinstance(files, dict):
            result[str(item["id"])] = files
    return result


def _safe_repository_relative_path(raw: str) -> str | None:
    candidate = Path(raw)
    if not raw.strip() or candidate.is_absolute() or ".." in candidate.parts:
        return None
    return candidate.as_posix()


def _code_owned_final_files(
    feature_dir: Path,
    *,
    require_final_snapshots: bool = True,
) -> tuple[
    dict[str, dict[str, str | None]], dict[str, set[str]], tuple[str, ...]
]:
    expected: dict[str, dict[str, str | None]] = {}
    owned: dict[str, set[str]] = {}
    errors: list[str] = []
    run_paths = sorted(
        (feature_dir / ".task-runs").glob("T*/*.json"),
        key=lambda path: path.stat().st_mtime_ns if path.exists() else 0,
    )
    for path in run_paths:
        try:
            state = _load_json_object(path)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        status = state.get("status")
        if require_final_snapshots and status not in {"implemented", "done", "failed", "aborted"}:
            errors.append(f"存在未结束的 Code task run: {state.get('taskId', path.parent.name)}:{path.stem}")
            continue
        if status == "aborted":
            changes = state.get("fileChangesAtAbort")
            repositories = _run_repository_files(state, "abortRepositories")
        else:
            changes = state.get("fileChanges")
            repositories = _run_repository_files(state, "finalRepositories")
        if not repositories and not require_final_snapshots:
            repositories = _run_repository_files(state, "repositories")
        if not isinstance(changes, list) or not repositories:
            if require_final_snapshots and isinstance(changes, list) and changes:
                errors.append(f"Code task run 缺少最终源码快照: {path.name}")
            continue
        default_repository = next(iter(repositories)) if len(repositories) == 1 else None
        for change in changes:
            if not isinstance(change, dict):
                continue
            for field_name in ("path", "fromPath"):
                raw = change.get(field_name)
                if not isinstance(raw, str) or not raw:
                    continue
                repository_id = change.get("repository")
                relative = raw
                prefix, separator, suffix = raw.partition(":")
                if separator and prefix in repositories:
                    repository_id, relative = prefix, suffix
                relative = _safe_repository_relative_path(relative)
                if relative is None:
                    errors.append(f"task run 源码路径越界: {path.name}:{raw}")
                    continue
                if not isinstance(repository_id, str):
                    repository_id = default_repository
                if repository_id not in repositories:
                    errors.append(f"task run 无法定位源码仓库: {path.name}:{raw}")
                    continue
                owned.setdefault(repository_id, set()).add(relative)
                expected.setdefault(repository_id, {})[relative] = repositories[repository_id].get(relative)
    return expected, owned, tuple(errors)


def _source_plan_labels(owned: dict[str, set[str]]) -> tuple[str, ...]:
    return tuple(
        f"{repository_id}:{relative}"
        for repository_id in sorted(owned)
        for relative in sorted(owned[repository_id])
    )


def prepare_code_source_restore(workspace: Path, feature: str, feature_dir: Path) -> CodeSourcePlan:
    try:
        baseline = _load_active_code_session(workspace, feature)
    except ValueError as exc:
        return CodeSourcePlan(ok=False, errors=(str(exc),))
    if baseline is None:
        return CodeSourcePlan(
            ok=False,
            errors=("当前 Feature 没有 Code Session 基线；只能使用 --code-source keep",),
        )
    if baseline.get("version") != CODE_SESSION_BASELINE_VERSION:
        return CodeSourcePlan(
            ok=False,
            errors=("当前 Code Session 基线版本不受支持；请先完成回退清理后重新捕获基线",),
        )
    expected, owned, run_errors = _code_owned_final_files(
        feature_dir,
        require_final_snapshots=True,
    )
    if run_errors:
        return CodeSourcePlan(ok=False, errors=run_errors)
    baseline_repositories = baseline.get("repositories")
    if not isinstance(baseline_repositories, dict):
        return CodeSourcePlan(ok=False, errors=("Code Session repositories 格式无效",))
    repositories: dict[str, Path] = {}
    conflicts: list[str] = []
    planned: list[str] = []
    for repository_id, paths in owned.items():
        record = baseline_repositories.get(repository_id)
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            return CodeSourcePlan(ok=False, errors=(f"Code Session 缺少仓库: {repository_id}",))
        repository = Path(record["path"]).resolve()
        if not repository.is_dir():
            return CodeSourcePlan(ok=False, errors=(f"Code Session 仓库不存在: {repository}",))
        try:
            current_files = capture_repository_snapshot(repository).get("files", {})
        except ValueError as exc:
            return CodeSourcePlan(ok=False, errors=(str(exc),))
        repositories[repository_id] = repository
        for relative in sorted(paths):
            label = f"{repository_id}:{relative}"
            planned.append(label)
            if current_files.get(relative) != expected.get(repository_id, {}).get(relative):
                conflicts.append(label)
    return CodeSourcePlan(
        ok=not conflicts,
        repositories=repositories,
        baseline=baseline,
        expected_files=expected,
        owned_paths={key: tuple(sorted(value)) for key, value in owned.items()},
        planned_files=tuple(sorted(planned)),
        conflicts=tuple(sorted(conflicts)),
        errors=(
            ("源码已在 Code Session 最终快照后发生变化；请改用 --code-source keep 或先手工处理冲突",)
            if conflicts
            else ()
        ),
    )


def _prepare_code_execution_reset(workspace: Path, feature: str) -> CodeResetPlan:
    if not plan_path(workspace, feature).is_file():
        return CodeResetPlan(present=False)
    try:
        data = copy.deepcopy(load_plan_writer_data(workspace, feature))
    except (OSError, ValueError, PlanWriterInputError) as exc:
        return CodeResetPlan(present=True, errors=(f"Code 执行状态无法读取: {exc}",))
    task_ids: list[str] = []
    for task in data.get("tasks", []):
        if not isinstance(task, dict):
            continue
        task_id = task.get("id")
        if isinstance(task_id, str):
            task_ids.append(task_id)
        task["status"] = "todo"
        for field_name in (
            "evidenceIds",
            "implementationEvidenceIds",
            "validationEvidenceIds",
            "completionEvidenceIds",
        ):
            task[field_name] = []
        task["latestImplementationEvidenceId"] = None
        task["latestPassEvidenceId"] = None
        task["implementationRevision"] = 0
        task.pop("pendingRevalidation", None)
    batch_plans = data.get("_batchPlans")
    for batch in batch_plans.values() if isinstance(batch_plans, dict) else []:
        if not isinstance(batch, dict):
            continue
        batch["startedAt"] = None
        batch["completedAt"] = None
    # Rebuild the batch projection from the preserved task contracts. Keeping
    # old assignments here can resurrect stale batches after a plan rebuild.
    data["batches"] = []
    data["_batchAssignments"] = {}
    data["_batchPlans"] = {}
    data["status"] = "todo"
    data["activeBatchId"] = None
    data["nextBatchId"] = None
    return CodeResetPlan(present=True, data=data, task_ids=tuple(task_ids))


def _execute_code_execution_reset(workspace: Path, feature: str, reset: CodeResetPlan) -> None:
    if not reset.present:
        return
    if reset.errors:
        raise ValueError("；".join(reset.errors))
    with _plan_lock(workspace, feature):
        result = write_plan_writer_data(
            workspace,
            feature,
            copy.deepcopy(reset.data),
            plan_markdown=_render_plan_md(reset.data),
        )
    if not result.ok:
        raise ValueError("Code 执行状态重置失败: " + json.dumps(result.errors, ensure_ascii=False))
    root = _load_json_object(plan_path(workspace, feature))
    referenced_batches = {
        str(entry.get("id"))
        for entry in root.get("batches", [])
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }
    plans_dir = plan_path(workspace, feature).parent / "plans"
    if plans_dir.is_dir():
        for entry in plans_dir.iterdir():
            if entry.is_dir() and entry.name.startswith("B") and entry.name[1:].isdigit():
                if entry.name not in referenced_batches:
                    _remove_path(entry)


def _checkpoint_base(checkpoint: str) -> str:
    for suffix in ("_in_progress", "_done"):
        if checkpoint.endswith(suffix):
            return checkpoint[: -len(suffix)]
    return checkpoint


def _node_aliases(node: dict, stage_labels: dict[str, str]) -> set[str]:
    aliases: set[str] = set()
    for value in (node.get("id"), node.get("label"), node.get("skill")):
        if isinstance(value, str) and value.strip():
            aliases.add(value.strip().casefold())

    node_id = node.get("id")
    if isinstance(node_id, str) and "." in node_id:
        aliases.add(node_id.rsplit(".", 1)[-1].casefold())

    for checkpoint in node.get("checkpoints", []):
        if not isinstance(checkpoint, str) or not checkpoint:
            continue
        aliases.add(checkpoint.casefold())
        aliases.add(_checkpoint_base(checkpoint).casefold())
        label = stage_labels.get(checkpoint)
        if isinstance(label, str) and label.strip():
            aliases.add(label.strip().casefold())
    return aliases


def _resolve_target_node(
    nodes: list[dict],
    stage: str,
    stage_labels: dict[str, str],
) -> tuple[dict | None, tuple[str, ...]]:
    query = stage.strip().casefold()
    matches = [
        node
        for node in nodes
        if query and query in _node_aliases(node, stage_labels)
    ]
    if len(matches) == 1:
        return matches[0], ()
    if len(matches) > 1:
        node_ids = ", ".join(str(node.get("id", "")) for node in matches)
        return None, (f"阶段 '{stage}' 匹配多个节点: {node_ids}；请改用完整 node id",)

    available = ", ".join(
        str(node.get("id", ""))
        for node in nodes
        if not node.get("skipped")
    )
    return None, (f"未知阶段: {stage}；可用 node id: {available}",)


def _done_checkpoint(node: dict) -> str | None:
    return next(
        (
            checkpoint
            for checkpoint in node.get("checkpoints", [])
            if isinstance(checkpoint, str) and checkpoint.endswith("_done")
        ),
        None,
    )


def _in_progress_checkpoint(node: dict) -> str | None:
    return next(
        (
            checkpoint
            for checkpoint in node.get("checkpoints", [])
            if isinstance(checkpoint, str) and checkpoint.endswith("_in_progress")
        ),
        None,
    )


def _rollback_state_options(
    target_node: dict,
    previous_node: dict | None,
) -> tuple[dict[str, str], ...]:
    """Return the valid explicit state choices for a target stage.

    Artifact deletion is deliberately independent from this choice: both
    modes remove the target stage and all subsequent stage artifacts.
    """

    options: list[dict[str, str]] = []
    target_checkpoint = _in_progress_checkpoint(target_node)
    target_node_id = str(target_node.get("id", ""))
    if target_checkpoint is not None:
        options.append(
            {
                "mode": ROLLBACK_STATE_TARGET_IN_PROGRESS,
                "checkpoint": target_checkpoint,
                "description": f"回退至目标阶段 {target_node_id} 的 in_progress 状态",
            }
        )

    if previous_node is not None:
        previous_checkpoint = _done_checkpoint(previous_node)
        previous_node_id = str(previous_node.get("id", ""))
        if previous_checkpoint is not None:
            options.append(
                {
                    "mode": ROLLBACK_STATE_PREVIOUS_DONE,
                    "checkpoint": previous_checkpoint,
                    "description": f"回退至前置阶段 {previous_node_id} 的 done 状态",
                }
            )
    return tuple(options)


def _archive_feature_dir(workspace: Path, feature: str, iteration: object) -> Path | None:
    archive_dir = get_features_archive_dir(workspace)
    iteration_text = str(iteration or "").strip()
    if iteration_text and iteration_text != "—":
        exact = archive_dir / f"{feature}-iter{iteration_text}"
        if exact.is_dir():
            return exact

    if not archive_dir.is_dir():
        return None
    matches = sorted(
        entry
        for entry in archive_dir.iterdir()
        if entry.is_dir() and entry.name.startswith(f"{feature}-iter")
    )
    if len(matches) == 1:
        return matches[0]
    return None


def _resolve_feature_dir(
    workspace: Path,
    feature: str,
    record: dict[str, Any],
) -> tuple[Path | None, tuple[str, ...]]:
    active_dir = get_feature_active_dir(workspace, feature)
    if active_dir.is_dir():
        return active_dir, ()

    if record.get("checkpoint") != "archived":
        return None, (f"Feature 产物目录不存在: {active_dir}",)

    archived_dir = _archive_feature_dir(workspace, feature, record.get("iteration"))
    if archived_dir is None:
        return None, (f"Feature 归档目录无法唯一定位: {feature}",)
    return archived_dir, ()


def _validate_artifact_path(path: str) -> str | None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        return f"产物路径必须位于 Feature 目录内: {path}"
    if not path.strip() or candidate == Path("."):
        return f"产物路径不能为空或 Feature 根目录: {path}"
    return None


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_existing_candidate(feature_dir: Path, candidate: Path) -> tuple[Path | None, str | None]:
    try:
        relative = candidate.relative_to(feature_dir)
    except ValueError:
        return None, f"产物路径越出 Feature 目录: {candidate}"
    if not relative.parts:
        return None, f"拒绝删除 Feature 根目录: {candidate}"

    resolved_root = feature_dir.resolve()
    resolved_parent = candidate.parent.resolve()
    if not _is_within(resolved_parent, resolved_root):
        return None, f"产物父目录通过符号链接越出 Feature 目录: {candidate}"
    return candidate, None


def _rollback_runtime_paths(node: dict) -> tuple[str, ...]:
    config = node.get("rollback")
    if not isinstance(config, dict):
        return ()
    values = config.get("archive", [])
    return tuple(item for item in values if isinstance(item, str))


def _artifact_candidates(
    feature_dir: Path,
    nodes: list[dict],
) -> tuple[tuple[Path, ...], tuple[str, ...]]:
    candidates: set[Path] = set()
    errors: list[str] = []

    for node in nodes:
        for artifact in artifact_dicts(node, "outputs"):
            kind = str(artifact.get("artifactType", "file")).strip().casefold()
            if kind in NON_FILESYSTEM_ARTIFACT_TYPES:
                continue
            artifact_path = artifact.get("path")
            if not isinstance(artifact_path, str):
                errors.append(f"{node.get('id', '<unknown>')} 的产物 path 必须是字符串")
                continue
            path_error = _validate_artifact_path(artifact_path)
            if path_error:
                errors.append(path_error)
                continue

            if has_glob(artifact_path):
                matches = sorted(feature_dir.glob(artifact_path))
            else:
                exact = resolve_exact_relative_path(feature_dir, artifact_path)
                matches = [exact] if exact is not None else []

            for match in matches:
                if match is None or not (match.exists() or match.is_symlink()):
                    continue
                safe_match, candidate_error = _safe_existing_candidate(feature_dir, match)
                if candidate_error:
                    errors.append(candidate_error)
                elif safe_match is not None:
                    candidates.add(safe_match)

        for runtime_path in _rollback_runtime_paths(node):
            path_error = _validate_artifact_path(runtime_path)
            if path_error:
                errors.append(path_error)
                continue
            if has_glob(runtime_path):
                matches = sorted(feature_dir.glob(runtime_path))
            else:
                exact = resolve_exact_relative_path(feature_dir, runtime_path)
                matches = [exact] if exact is not None else []
            for match in matches:
                if match is None or not (match.exists() or match.is_symlink()):
                    continue
                safe_match, candidate_error = _safe_existing_candidate(feature_dir, match)
                if candidate_error:
                    errors.append(candidate_error)
                elif safe_match is not None:
                    candidates.add(safe_match)

    # A planner crash can leave these Feature-owned files even when no
    # workflow node declares them as outputs.  They are included in every
    # rollback so returning to an earlier stage cannot inherit stale draft or
    # transaction state.
    for runtime_path in FEATURE_TRANSIENT_ROLLBACK_PATHS:
        if has_glob(runtime_path):
            matches = sorted(feature_dir.glob(runtime_path))
        else:
            exact = resolve_exact_relative_path(feature_dir, runtime_path)
            matches = [exact] if exact is not None else []
        for match in matches:
            if match is None or not (match.exists() or match.is_symlink()):
                continue
            safe_match, candidate_error = _safe_existing_candidate(feature_dir, match)
            if candidate_error:
                errors.append(candidate_error)
            elif safe_match is not None:
                candidates.add(safe_match)

    candidates = {
        candidate
        for candidate in candidates
        if candidate.relative_to(feature_dir).as_posix() not in ROLLBACK_PRESERVED_ARTIFACTS
    }

    ordered = sorted(
        candidates,
        key=lambda path: (len(path.relative_to(feature_dir).parts), path.as_posix()),
    )
    top_level: list[Path] = []
    for candidate in ordered:
        if any(parent == candidate or parent in candidate.parents for parent in top_level):
            continue
        top_level.append(candidate)
    return tuple(top_level), tuple(errors)


def prepare_stage_rollback(
    *,
    workspace: Path,
    feature: str,
    stage: str,
    updated_at: str | None = None,
    code_source: str = "keep",
    state_mode: str = ROLLBACK_STATE_PREVIOUS_DONE,
    rollback_id: str | None = None,
) -> RollbackPlan:
    workspace = workspace.resolve()
    feature = feature.strip()
    stage = stage.strip()
    state_mode = state_mode.strip()
    if not feature:
        return _failed_plan(workspace=workspace, feature=feature, stage=stage, errors=["feature 不能为空"])
    if not safe_feature_slug(feature):
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"feature 不是安全的相对路径: {feature}"],
        )
    if not stage:
        return _failed_plan(workspace=workspace, feature=feature, stage=stage, errors=["stage 不能为空"])
    if code_source not in {"keep", "restore"}:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"code_source 必须是 keep 或 restore: {code_source}"],
        )
    if state_mode not in ROLLBACK_STATE_MODES:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[
                "state_mode 必须是 "
                f"{ROLLBACK_STATE_TARGET_IN_PROGRESS} 或 {ROLLBACK_STATE_PREVIOUS_DONE}: {state_mode}"
            ],
            state_mode=state_mode,
        )

    state_result = load_state_json_records_result(workspace)
    if not state_result.exists:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"state.json 不存在: {get_state_json_path(workspace)}"],
        )
    if state_result.fatal_errors:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=state_result.fatal_errors,
            raw_records=state_result.raw_records,
        )
    if state_result.record_errors.get(feature):
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=state_result.record_errors[feature],
            raw_records=state_result.raw_records,
        )

    record = state_result.records.get(feature)
    if record is None:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"Feature '{feature}' 不存在"],
            raw_records=state_result.raw_records,
        )

    try:
        contracts = load_record_workflow_contracts(ROOT, record, workspace=workspace)
    except BoardConfigError as exc:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"workflow 配置无法编译: {exc}"],
            raw_records=state_result.raw_records,
        )

    nodes = list(contracts.nodes)
    target_node, target_errors = _resolve_target_node(nodes, stage, contracts.stage_labels)
    if target_errors or target_node is None:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=target_errors,
            old_checkpoint=record.get("checkpoint"),
            raw_records=state_result.raw_records,
        )
    target_node_id = str(target_node.get("id", ""))
    if target_node.get("skipped"):
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"阶段 {target_node_id} 已跳过，不能作为回退目标"],
            target_node_id=target_node_id,
            old_checkpoint=record.get("checkpoint"),
            raw_records=state_result.raw_records,
        )

    active_nodes = [node for node in nodes if not node.get("skipped")]
    active_index = {
        str(node.get("id", "")): index
        for index, node in enumerate(active_nodes)
    }
    target_index = active_index[target_node_id]

    current_index, current_node_id = find_effective_current_node(
        nodes,
        str(record.get("checkpoint", "")),
        record.get("needsFixFromCheckpoint"),
        stage=record.get("stage"),
        stage_labels=contracts.stage_labels,
    )
    if current_index < 0 or current_node_id not in active_index:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[f"当前 checkpoint 无法映射到有效阶段: {record.get('checkpoint', '')}"],
            target_node_id=target_node_id,
            old_checkpoint=record.get("checkpoint"),
            raw_records=state_result.raw_records,
        )
    if target_index > active_index[current_node_id]:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[
                f"阶段 {target_node_id} 尚未到达；当前阶段为 {current_node_id}"
            ],
            target_node_id=target_node_id,
            old_checkpoint=record.get("checkpoint"),
            raw_records=state_result.raw_records,
        )

    previous_node = active_nodes[target_index - 1] if target_index > 0 else None
    previous_node_id = (
        str(previous_node.get("id", "")) if previous_node is not None else None
    )
    state_options = _rollback_state_options(target_node, previous_node)
    option_by_mode = {option["mode"]: option for option in state_options}
    selected_option = option_by_mode.get(state_mode)
    if selected_option is None:
        available = ", ".join(option["mode"] for option in state_options) or "无"
        reason = (
            f"阶段 {target_node_id} 不支持 state_mode={state_mode}；"
            f"可选值: {available}"
        )
        if state_mode == ROLLBACK_STATE_PREVIOUS_DONE and target_index == 0:
            reason = (
                f"阶段 {target_node_id} 是首个有效阶段，不能回退到前置 done；"
                f"请确认使用 {ROLLBACK_STATE_TARGET_IN_PROGRESS}"
            )
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=[reason],
            state_mode=state_mode,
            state_options=state_options,
            target_node_id=target_node_id,
            previous_node_id=previous_node_id,
            old_checkpoint=record.get("checkpoint"),
            raw_records=state_result.raw_records,
        )
    new_checkpoint = selected_option["checkpoint"]

    feature_dir, feature_dir_errors = _resolve_feature_dir(workspace, feature, record)
    if feature_dir_errors or feature_dir is None:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=feature_dir_errors,
            target_node_id=target_node_id,
            previous_node_id=previous_node_id,
            old_checkpoint=record.get("checkpoint"),
            new_checkpoint=new_checkpoint,
            raw_records=state_result.raw_records,
        )

    artifact_paths, artifact_errors = _artifact_candidates(
        feature_dir,
        active_nodes[target_index:],
    )
    if artifact_errors:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=artifact_errors,
            target_node_id=target_node_id,
            previous_node_id=previous_node_id,
            old_checkpoint=record.get("checkpoint"),
            new_checkpoint=new_checkpoint,
            feature_dir=feature_dir,
            raw_records=state_result.raw_records,
        )

    code_in_scope = any(
        str(node.get("id", "")) == "dev.code"
        for node in active_nodes[target_index:]
    )
    code_reset = _prepare_code_execution_reset(workspace, feature) if code_in_scope else CodeResetPlan(False)
    if code_reset.errors:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=code_reset.errors,
            target_node_id=target_node_id,
            previous_node_id=previous_node_id,
            old_checkpoint=record.get("checkpoint"),
            new_checkpoint=new_checkpoint,
            feature_dir=feature_dir,
            code_in_scope=code_in_scope,
            code_source=code_source,
            code_reset_tasks=code_reset.task_ids,
            raw_records=state_result.raw_records,
        )
    source_impact = CodeSourcePlan(ok=True)
    if code_in_scope:
        _, owned_source_paths, source_impact_errors = _code_owned_final_files(
            feature_dir,
            require_final_snapshots=False,
        )
        if source_impact_errors:
            return _failed_plan(
                workspace=workspace,
                feature=feature,
                stage=stage,
                errors=source_impact_errors,
                target_node_id=target_node_id,
                previous_node_id=previous_node_id,
                old_checkpoint=record.get("checkpoint"),
                new_checkpoint=new_checkpoint,
                feature_dir=feature_dir,
                code_in_scope=code_in_scope,
                code_source=code_source,
                code_reset_tasks=code_reset.task_ids,
                raw_records=state_result.raw_records,
            )
        source_impact = CodeSourcePlan(
            ok=True,
            owned_paths={key: tuple(sorted(value)) for key, value in owned_source_paths.items()},
            planned_files=_source_plan_labels(owned_source_paths),
        )
    source_plan = (
        prepare_code_source_restore(workspace, feature, feature_dir)
        if code_in_scope and code_source == "restore"
        else source_impact
    )
    if not source_plan.ok:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=(*source_plan.errors, *source_plan.conflicts),
            target_node_id=target_node_id,
            previous_node_id=previous_node_id,
            old_checkpoint=record.get("checkpoint"),
            new_checkpoint=new_checkpoint,
            feature_dir=feature_dir,
            code_in_scope=code_in_scope,
            code_source=code_source,
            planned_source_files=source_plan.planned_files,
            source_conflicts=source_plan.conflicts,
            code_reset_tasks=code_reset.task_ids,
            raw_records=state_result.raw_records,
        )

    new_record = dict(record)
    new_record["checkpoint"] = new_checkpoint
    new_record["stage"] = contracts.stage_labels.get(new_checkpoint, "")
    new_record["updated_at"] = updated_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    new_record.pop("needsFixFromCheckpoint", None)
    new_records = {
        slug: dict(existing)
        for slug, existing in state_result.records.items()
    }
    new_records[feature] = new_record
    try:
        state_json_content_from_records_preserving_raw(
            new_records,
            raw_records=state_result.raw_records,
            workspace=workspace,
        )
        render_state_md(new_records, workspace=workspace)
    except ValueError as exc:
        return _failed_plan(
            workspace=workspace,
            feature=feature,
            stage=stage,
            errors=str(exc).splitlines(),
            target_node_id=target_node_id,
            previous_node_id=previous_node_id,
            old_checkpoint=record.get("checkpoint"),
            new_checkpoint=new_checkpoint,
            feature_dir=feature_dir,
            raw_records=state_result.raw_records,
        )

    return RollbackPlan(
        ok=True,
        workspace=workspace,
        feature=feature,
        requested_stage=stage,
        state_mode=state_mode,
        state_options=state_options,
        target_node_id=target_node_id,
        previous_node_id=previous_node_id,
        old_checkpoint=str(record.get("checkpoint", "")),
        new_checkpoint=new_checkpoint,
        feature_dir=feature_dir,
        active_feature_dir=get_feature_active_dir(workspace, feature),
        artifact_paths=artifact_paths,
        old_records={
            slug: dict(existing)
            for slug, existing in state_result.records.items()
        },
        records=new_records,
        raw_records=state_result.raw_records,
        workflow_profile=str(record.get("workflowProfile", "standard")),
        workflow_decisions=dict(record.get("workflowDecisions") or {}),
        rollback_id=rollback_id or f"rollback-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}",
        code_in_scope=code_in_scope,
        code_source=code_source,
        planned_source_files=source_plan.planned_files,
        code_reset_tasks=code_reset.task_ids,
    )


def _restore_moved_artifacts(feature_dir: Path, backup_dir: Path, paths: list[Path]) -> None:
    for original in reversed(paths):
        relative = original.relative_to(feature_dir)
        backup = backup_dir / relative
        if not (backup.exists() or backup.is_symlink()):
            continue
        original.parent.mkdir(parents=True, exist_ok=True)
        backup.replace(original)


def _prune_empty_parents(feature_dir: Path, deleted_paths: tuple[Path, ...]) -> None:
    directories = sorted(
        {
            parent
            for path in deleted_paths
            for parent in path.parents
            if parent != feature_dir and _is_within(parent, feature_dir)
        },
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for directory in directories:
        try:
            directory.rmdir()
        except OSError:
            pass


def _copy_path(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        target.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, target, symlinks=True)
    else:
        shutil.copy2(source, target, follow_symlinks=False)


def _remove_path(path: Path) -> None:
    if not (path.exists() or path.is_symlink()):
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _feature_workflow_runtime_dir(workspace: Path, feature: str) -> Path:
    """Return the Feature-owned Workflow host runtime directory.

    The feature is validated by ``prepare_stage_rollback`` before execution,
    allowing a Code rollback to archive only its copied script and platform
    sidecars without touching another Feature's Workflow state.
    """
    return workspace / _WORKFLOW_ARTIFACT_RUNTIME_DIRECTORY / feature


def _prune_empty_runtime_parents(workspace: Path, path: Path) -> None:
    """Remove empty runtime parents, stopping before the artifact root."""
    current = path.parent
    while current != workspace:
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def prune_rollback_history(
    *,
    workspace: Path,
    feature: str | None = None,
    keep: int = 10,
    apply: bool = False,
) -> dict[str, Any]:
    """Preview or remove old committed rollback history entries.

    Retention is per Feature. Unknown or malformed history is never removed.
    """

    workspace = workspace.resolve()
    if keep < 0:
        return {"ok": False, "errors": ["keep 必须大于等于 0"]}
    if feature is not None and not safe_feature_slug(feature):
        return {"ok": False, "errors": [f"feature 不是安全的相对路径: {feature}"]}

    history_root = _rollback_root(workspace) / "history"
    planned: list[str] = []
    deleted: list[str] = []
    errors: list[str] = []
    grouped: dict[str, list[tuple[Path, dict[str, Any]]]] = {}
    with _rollback_history_lock(workspace):
        if history_root.is_dir():
            for entry in sorted(history_root.iterdir()):
                if not entry.is_dir() or entry.is_symlink():
                    continue
                manifest_path = entry / "manifest.json"
                try:
                    manifest = _load_json_object(manifest_path)
                except ValueError as exc:
                    errors.append(str(exc))
                    continue
                if manifest.get("status") != "committed":
                    continue
                entry_feature = manifest.get("feature")
                if not isinstance(entry_feature, str) or not safe_feature_slug(entry_feature):
                    errors.append(f"history manifest 的 feature 无效: {manifest_path}")
                    continue
                if feature is not None and entry_feature != feature:
                    continue
                grouped.setdefault(entry_feature, []).append((entry, manifest))

        for entry_feature, records in grouped.items():
            records.sort(
                key=lambda item: (
                    str(item[1].get("committedAt", "")),
                    item[0].stat().st_mtime_ns,
                    item[0].name,
                ),
                reverse=True,
            )
            for entry, _ in records[keep:]:
                relative = entry.relative_to(workspace).as_posix()
                planned.append(relative)
                if apply:
                    try:
                        _remove_path(entry)
                        deleted.append(relative)
                    except OSError as exc:
                        errors.append(f"history 清理失败: {entry}: {exc}")

    return {
        "ok": not errors,
        "feature": feature,
        "keepHistory": keep,
        "dryRun": not apply,
        "planned": sorted(planned),
        "deleted": sorted(deleted),
        "errors": errors,
    }


def _plan_backup_paths(workspace: Path, feature: str) -> tuple[Path, ...]:
    feature_dir = plan_path(workspace, feature).parent
    return (
        plan_path(workspace, feature),
        _md_path(workspace, feature),
        feature_dir / "plans",
    )


def _backup_plan_bundle(workspace: Path, feature: str, backup_dir: Path) -> tuple[str, ...]:
    feature_dir = plan_path(workspace, feature).parent
    backed_up: list[str] = []
    for source in _plan_backup_paths(workspace, feature):
        if not (source.exists() or source.is_symlink()):
            continue
        relative = source.relative_to(feature_dir)
        _copy_path(source, backup_dir / relative)
        backed_up.append(relative.as_posix())
    return tuple(backed_up)


def _restore_plan_bundle(
    workspace: Path,
    feature: str,
    backup_dir: Path,
    backed_up: tuple[str, ...],
) -> None:
    feature_dir = plan_path(workspace, feature).parent
    for target in _plan_backup_paths(workspace, feature):
        _remove_path(target)
    for relative in backed_up:
        source = backup_dir / relative
        if source.exists() or source.is_symlink():
            _copy_path(source, feature_dir / relative)


def _backup_source_files(plan: CodeSourcePlan, backup_dir: Path) -> dict[str, Any]:
    manifest: dict[str, Any] = {"repositories": {}}
    for repository_id, paths in plan.owned_paths.items():
        repository = plan.repositories[repository_id]
        entries: dict[str, Any] = {}
        for relative in paths:
            source = repository / relative
            if not (source.exists() or source.is_symlink()):
                entries[relative] = {"kind": "absent"}
                continue
            mode = stat.S_IMODE(source.lstat().st_mode)
            target = backup_dir / repository_id / relative
            if source.is_symlink():
                entries[relative] = {"kind": "symlink", "target": os.readlink(source), "mode": mode}
            elif source.is_file():
                _copy_path(source, target)
                entries[relative] = {"kind": "file", "mode": mode}
            else:
                raise ValueError(f"源码恢复不支持目录路径: {repository_id}:{relative}")
        manifest["repositories"][repository_id] = {
            "path": str(repository),
            "files": entries,
        }
    atomic_write_json(backup_dir / "manifest.json", manifest)
    return manifest


def _restore_source_backup(backup_dir: Path, manifest: dict[str, Any]) -> None:
    repositories = manifest.get("repositories")
    if not isinstance(repositories, dict):
        return
    for repository_id, record in repositories.items():
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            continue
        repository = Path(record["path"])
        files = record.get("files")
        for relative, entry in files.items() if isinstance(files, dict) else []:
            if not isinstance(entry, dict):
                continue
            target = repository / relative
            _remove_path(target)
            kind = entry.get("kind")
            if kind == "file":
                _copy_path(backup_dir / str(repository_id) / relative, target)
                target.chmod(int(entry.get("mode", 0o644)))
            elif kind == "symlink":
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(str(entry.get("target", "")))


def _execute_source_restore(workspace: Path, feature: str, plan: CodeSourcePlan) -> tuple[str, ...]:
    root = _session_root(workspace, feature)
    baseline_repositories = plan.baseline.get("repositories")
    if not isinstance(baseline_repositories, dict):
        raise ValueError("Code Session repositories 格式无效")
    restored: list[str] = []
    for repository_id, paths in plan.owned_paths.items():
        repository = plan.repositories[repository_id]
        record = baseline_repositories.get(repository_id)
        files = record.get("files") if isinstance(record, dict) else None
        if not isinstance(files, dict):
            raise ValueError(f"Code Session 缺少仓库文件基线: {repository_id}")
        for relative in paths:
            target = repository / relative
            _remove_path(target)
            entry = files.get(relative)
            if isinstance(entry, dict):
                storage = entry.get("storage")
                if storage == "git_blob":
                    blob_sha = entry.get("gitSha")
                    if not isinstance(blob_sha, str) or len(blob_sha) not in _GIT_OBJECT_ID_LENGTHS or any(
                        char not in "0123456789abcdef" for char in blob_sha.lower()
                    ):
                        raise ValueError(f"Code Session Git blob 引用无效: {repository_id}:{relative}")
                    object_content = _git_bytes(repository, "cat-file", "blob", blob_sha)
                elif storage == "baseline_object":
                    object_path = root / "objects" / str(entry.get("objectSha256", ""))
                    if not object_path.is_file():
                        raise ValueError(f"Code Session 基线对象缺失: {repository_id}:{relative}")
                    object_content = object_path.read_bytes()
                else:
                    raise ValueError(f"Code Session 基线存储类型无效: {repository_id}:{relative}")
                target.parent.mkdir(parents=True, exist_ok=True)
                if entry.get("kind") == "symlink":
                    target.symlink_to(object_content.decode("utf-8", "surrogateescape"))
                else:
                    target.write_bytes(object_content)
                    try:
                        target.chmod(int(entry.get("mode", 0o644)))
                    except OSError:
                        pass
            restored.append(f"{repository_id}:{relative}")
    return tuple(restored)


def _mark_code_session_rolled_back(workspace: Path, feature: str, rollback_id: str) -> None:
    active = _load_active_code_session(workspace, feature)
    if active is None:
        return
    active["status"] = "rolled_back"
    active["rollbackId"] = rollback_id
    active["rolledBackAt"] = _utc_now()
    root = _session_root(workspace, feature)
    atomic_write_json(_active_session_path(workspace, feature), active)
    atomic_write_json(root / str(active.get("sessionId", "unknown")) / "manifest.json", active)


def execute_stage_rollback(plan: RollbackPlan) -> RollbackResult:
    if not plan.ok:
        return RollbackResult(ok=False, plan=plan, errors=plan.errors)
    with _rollback_feature_lock(plan.workspace, plan.feature):
        with _rollback_history_lock(plan.workspace):
            return _execute_stage_rollback_locked(plan)


def _execute_stage_rollback_locked(plan: RollbackPlan) -> RollbackResult:
    if not plan.ok:
        return RollbackResult(ok=False, plan=plan, errors=plan.errors)
    if plan.feature_dir is None or plan.active_feature_dir is None:
        return RollbackResult(ok=False, plan=plan, errors=("回退计划缺少 Feature 目录",))

    feature_dir = plan.feature_dir
    active_feature_dir = plan.active_feature_dir
    transaction_dir = _rollback_root(plan.workspace) / "transactions" / plan.rollback_id
    history_dir = _rollback_root(plan.workspace) / "history" / plan.rollback_id
    if transaction_dir.exists() or history_dir.exists():
        return RollbackResult(ok=False, plan=plan, errors=(f"回退事务已存在: {plan.rollback_id}",))
    artifact_backup_dir = transaction_dir / "artifacts"
    plan_backup_dir = transaction_dir / "plan"
    source_backup_dir = transaction_dir / "source"
    transaction_dir.mkdir(parents=True, exist_ok=False)
    plan_backup_paths: tuple[str, ...] = ()
    source_backup_manifest: dict[str, Any] | None = None
    active_session_backup = transaction_dir / "active-session.json"
    active_session_path = _active_session_path(plan.workspace, plan.feature)
    workflow_runtime_dir = _feature_workflow_runtime_dir(plan.workspace, plan.feature)
    workflow_runtime_backup = transaction_dir / "workflow-runtime"
    if active_session_path.is_file():
        _copy_path(active_session_path, active_session_backup)
    atomic_write_json(
        transaction_dir / "manifest.json",
        {
            "version": 1,
            "rollbackId": plan.rollback_id,
            "feature": plan.feature,
            "targetStage": plan.target_node_id,
            "stateMode": plan.state_mode,
            "oldCheckpoint": plan.old_checkpoint,
            "newCheckpoint": plan.new_checkpoint,
            "status": "prepared",
        },
    )
    atomic_write_json(transaction_dir / "state-before.json", plan.old_records)
    moved_artifacts: list[Path] = []
    moved_workflow_runtime = False
    moved_to_active = False
    restored_source_files: tuple[str, ...] = ()
    parallel_cleanup: list[dict[str, Any]] = []
    try:
        # ``.parallel-runs`` is an artifact of Code, but it owns native Git
        # worktrees outside the Feature directory.  Never archive/reset it
        # until the lifecycle manager has removed those worktrees, temporary
        # branches, and leases and verified the cleanup completed.
        if plan.code_in_scope:
            parallel_cleanup = cleanup_feature_runs_for_code_rollback(plan.workspace, plan.feature)
            # The launcher materializes the fixed script below a
            # Feature-owned artifact path. Archive that script with platform
            # journals, sidecars, and lock files created alongside it. Never
            # remove the shared .cmbdevclaw root because another Feature may
            # still have an active Workflow there.
            if workflow_runtime_dir.exists() or workflow_runtime_dir.is_symlink():
                workflow_runtime_backup.parent.mkdir(parents=True, exist_ok=True)
                workflow_runtime_dir.replace(workflow_runtime_backup)
                moved_workflow_runtime = True
        plan_backup_paths = _backup_plan_bundle(plan.workspace, plan.feature, plan_backup_dir)
        source_plan = (
            prepare_code_source_restore(plan.workspace, plan.feature, feature_dir)
            if plan.code_in_scope and plan.code_source == "restore"
            else CodeSourcePlan(ok=True)
        )
        if not source_plan.ok:
            raise ValueError("；".join((*source_plan.errors, *source_plan.conflicts)))
        if source_plan.ok and source_plan.planned_files:
            source_backup_manifest = _backup_source_files(source_plan, source_backup_dir)
        for original in plan.artifact_paths:
            relative = original.relative_to(feature_dir)
            backup = artifact_backup_dir / relative
            backup.parent.mkdir(parents=True, exist_ok=True)
            original.replace(backup)
            moved_artifacts.append(original)

        if feature_dir != active_feature_dir:
            if active_feature_dir.exists():
                raise FileExistsError(f"活跃 Feature 目录已存在: {active_feature_dir}")
            active_feature_dir.parent.mkdir(parents=True, exist_ok=True)
            feature_dir.replace(active_feature_dir)
            moved_to_active = True

        if plan.code_in_scope:
            reset = _prepare_code_execution_reset(plan.workspace, plan.feature)
            _execute_code_execution_reset(plan.workspace, plan.feature, reset)
            # ``_execute_code_execution_reset`` needs the plan lock and may
            # recreate it after the pre-reset artifact archive.  A lock file
            # is never workflow state, so remove that fresh handle only after
            # the reset has released it.
            _remove_path(get_feature_active_dir(plan.workspace, plan.feature) / ".plan.lock")
            if plan.code_source == "restore":
                restored_source_files = _execute_source_restore(plan.workspace, plan.feature, source_plan)

        write_state_records_preserving_raw(
            plan.workspace,
            plan.records,
            raw_records=plan.raw_records,
        )
        atomic_write_json(transaction_dir / "state-after.json", plan.records)
        if plan.code_in_scope:
            _mark_code_session_rolled_back(plan.workspace, plan.feature, plan.rollback_id)
        atomic_write_json(
            transaction_dir / "manifest.json",
            {
                "version": 1,
                "rollbackId": plan.rollback_id,
                "feature": plan.feature,
                "targetStage": plan.target_node_id,
                "stateMode": plan.state_mode,
                "oldCheckpoint": plan.old_checkpoint,
                "newCheckpoint": plan.new_checkpoint,
                "status": "committed",
                "committedAt": _utc_now(),
                "codeSource": plan.code_source,
                "plannedSourceFiles": list(plan.planned_source_files),
                "deletedArtifacts": [path.relative_to(feature_dir).as_posix() for path in plan.artifact_paths],
                "restoredSourceFiles": list(restored_source_files),
                "codeResetTasks": list(plan.code_reset_tasks),
                "parallelRunCleanup": parallel_cleanup,
                "archivedWorkflowRuntime": (
                    str(workflow_runtime_dir.relative_to(plan.workspace))
                    if moved_workflow_runtime
                    else None
                ),
            },
        )
    except (Exception, KeyboardInterrupt) as exc:
        error_text = str(exc) or exc.__class__.__name__
        recovery_errors: list[str] = []
        if moved_to_active and active_feature_dir.exists() and not feature_dir.exists():
            try:
                active_feature_dir.replace(feature_dir)
            except (Exception, KeyboardInterrupt) as recovery_exc:
                recovery_errors.append(f"Feature 目录恢复失败: {recovery_exc}")
        try:
            _restore_moved_artifacts(feature_dir, artifact_backup_dir, moved_artifacts)
        except (Exception, KeyboardInterrupt) as recovery_exc:
            recovery_errors.append(f"产物恢复失败: {recovery_exc}")
        if moved_workflow_runtime and (workflow_runtime_backup.exists() or workflow_runtime_backup.is_symlink()):
            try:
                workflow_runtime_dir.parent.mkdir(parents=True, exist_ok=True)
                workflow_runtime_backup.replace(workflow_runtime_dir)
            except (Exception, KeyboardInterrupt) as recovery_exc:
                recovery_errors.append(f"Workflow 运行态恢复失败: {recovery_exc}")
        if source_backup_manifest is not None:
            try:
                _restore_source_backup(source_backup_dir, source_backup_manifest)
            except (Exception, KeyboardInterrupt) as recovery_exc:
                recovery_errors.append(f"源码恢复失败: {recovery_exc}")
        if plan_backup_paths:
            try:
                _restore_plan_bundle(plan.workspace, plan.feature, plan_backup_dir, plan_backup_paths)
            except (Exception, KeyboardInterrupt) as recovery_exc:
                recovery_errors.append(f"Plan 恢复失败: {recovery_exc}")
        try:
            write_state_records_preserving_raw(
                plan.workspace,
                plan.old_records,
                raw_records=plan.raw_records,
            )
        except (Exception, KeyboardInterrupt) as recovery_exc:
            recovery_errors.append(f"状态恢复失败: {recovery_exc}")
        try:
            if active_session_backup.is_file():
                _copy_path(active_session_backup, active_session_path)
            elif active_session_path.exists():
                active_session_path.unlink()
        except (Exception, KeyboardInterrupt) as recovery_exc:
            recovery_errors.append(f"Code Session 恢复失败: {recovery_exc}")
        recovery_summary = (
            "；".join(recovery_errors)
            if recovery_errors
            else "产物与状态已恢复"
        )
        atomic_write_json(
            transaction_dir / "manifest.json",
            {
                "version": 1,
                "rollbackId": plan.rollback_id,
                "feature": plan.feature,
                "targetStage": plan.target_node_id,
                "stateMode": plan.state_mode,
                "status": "recovered",
                "error": error_text,
                "recovery": recovery_summary,
            },
        )
        return RollbackResult(
            ok=False,
            plan=plan,
            errors=(f"回退执行失败: {error_text}；{recovery_summary}",),
        )

    history_dir.parent.mkdir(parents=True, exist_ok=True)
    transaction_dir.replace(history_dir)
    effective_feature_dir = active_feature_dir if moved_to_active else feature_dir
    effective_deleted_paths = tuple(
        effective_feature_dir / path.relative_to(feature_dir)
        for path in plan.artifact_paths
    )
    _prune_empty_parents(effective_feature_dir, effective_deleted_paths)
    if moved_workflow_runtime:
        _prune_empty_runtime_parents(plan.workspace, workflow_runtime_dir)
    deleted = tuple(
        path.relative_to(effective_feature_dir).as_posix()
        for path in effective_deleted_paths
    )
    append_checkpoint_hook_logs(
        plan.workspace,
        [(plan.feature, plan.old_checkpoint, plan.new_checkpoint)],
        event_id="stage-rollback",
        label="阶段回退",
        errors=[],
        event_status="success",
        exit_code=0,
        message=(
            f"{plan.old_checkpoint} -> {plan.new_checkpoint}: "
            f"rollback {plan.target_node_id}; state_mode={plan.state_mode}; deleted={len(deleted)}"
        ),
        workflow_profiles={plan.feature: plan.workflow_profile},
        workflow_decisions={plan.feature: plan.workflow_decisions},
    )
    return RollbackResult(
        ok=True,
        plan=plan,
        deleted_artifacts=deleted,
        archived_workflow_runtime=(
            str(workflow_runtime_dir.relative_to(plan.workspace))
            if moved_workflow_runtime
            else None
        ),
        restored_active_dir=moved_to_active,
        errors=(),
    )


def _result_payload(
    result: RollbackResult,
    *,
    dry_run: bool,
    confirmation_required: bool = False,
) -> dict[str, Any]:
    plan = result.plan
    planned_artifacts = (
        [
            path.relative_to(plan.feature_dir).as_posix()
            for path in plan.artifact_paths
        ]
        if plan.feature_dir is not None
        else []
    )
    return {
        "ok": result.ok,
        "feature": plan.feature,
        "requestedStage": plan.requested_stage,
        "targetNodeId": plan.target_node_id,
        "previousNodeId": plan.previous_node_id,
        "stateMode": None if confirmation_required else plan.state_mode,
        "stateOptions": list(plan.state_options),
        "confirmationRequired": confirmation_required,
        "oldCheckpoint": plan.old_checkpoint,
        "newCheckpoint": None if confirmation_required else plan.new_checkpoint,
        "dryRun": dry_run,
        "plannedArtifacts": planned_artifacts,
        "deletedArtifacts": list(result.deleted_artifacts),
        "archivedWorkflowRuntime": result.archived_workflow_runtime,
        "restoredActiveDir": result.restored_active_dir,
        "rollbackId": plan.rollback_id,
        "codeInScope": plan.code_in_scope,
        "codeSource": plan.code_source,
        "plannedSourceFiles": list(plan.planned_source_files),
        "sourceConflicts": list(plan.source_conflicts),
        "codeResetTasks": list(plan.code_reset_tasks),
        "errors": list(result.errors or plan.errors),
    }


def main(argv: list[str] | None = None) -> int:
    raw_args = list(sys.argv[1:] if argv is None else argv)
    if contains_workspace_argument(raw_args):
        print(STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR, file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="独立执行 Feature 阶段回退、Code Session 基线捕获和产物清理",
        allow_abbrev=False,
    )
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument(
        "--capture-code-session",
        action="store_true",
        help="在 Code 开始前捕获整个 Code Session 基线",
    )
    operation.add_argument(
        "--prune-history",
        action="store_true",
        help="清理旧的已提交回退 history；默认保留每个 Feature 最近 10 次",
    )
    parser.add_argument("--feature", "-f", help="feature slug；必须与 FEATURE_ID 一致")
    target = parser.add_mutually_exclusive_group()
    target.add_argument(
        "--stage",
        "-s",
        dest="stage",
        help="阶段 node id、skill、label 或 checkpoint 前缀，如 dev.specs / specs",
    )
    target.add_argument(
        "--to-stage",
        dest="stage_alias",
        help="--stage 的明确别名；指定重新进入的 workflow 阶段",
    )
    parser.add_argument(
        "--code-workspace",
        action="append",
        default=[],
        help="Code Session 基线对应的 Git 工作区；仅用于 --capture-code-session",
    )
    parser.add_argument(
        "--code-source",
        choices=("keep", "restore"),
        default="keep",
        help="回退范围包含 Code 时是否恢复业务源码，默认 keep",
    )
    parser.add_argument(
        "--state-mode",
        choices=ROLLBACK_STATE_MODES,
        help=(
            "确认回退后的状态：target_in_progress=目标阶段 in_progress；"
            "previous_done=前一阶段 done。必须在 --apply 前明确指定"
        ),
    )
    parser.add_argument(
        "--keep-history",
        type=int,
        default=10,
        help="--prune-history 每个 Feature 保留的最近记录数，默认 10",
    )
    parser.add_argument("--dry-run", action="store_true", help="只展示回退计划，不删除或写状态")
    parser.add_argument("--apply", action="store_true", help="确认后执行回退；与 --dry-run 二选一")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(raw_args)

    if args.dry_run and args.apply:
        parser.error("--dry-run 与 --apply 不能同时使用")
    if args.capture_code_session and (args.dry_run or args.apply):
        parser.error("--capture-code-session 不能与 --dry-run/--apply 同时使用")

    try:
        workspace = get_plugin_output_workspace()
        feature = resolve_env_feature(args.feature, required=not args.prune_history)
    except ValueError as exc:
        if args.json:
            print(json.dumps({"ok": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        else:
            print(f"阶段回退失败: {exc}", file=sys.stderr)
        return 1

    if args.prune_history:
        if not args.dry_run and not args.apply:
            parser.error("--prune-history 必须显式提供 --dry-run 或 --apply")
        payload = prune_rollback_history(
            workspace=workspace,
            feature=feature,
            keep=args.keep_history,
            apply=args.apply,
        )
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        elif payload["ok"]:
            action = "将清理" if args.dry_run else "已清理"
            paths = payload["planned"] if args.dry_run else payload["deleted"]
            print(f"{action} {len(paths)} 条回退 history（保留最近 {args.keep_history} 次）")
            for path in paths:
                print(f"  - {path}")
        else:
            print("history 清理失败:", file=sys.stderr)
            for error in payload["errors"]:
                print(f"  - {error}", file=sys.stderr)
        return 0 if payload["ok"] else 1

    if args.capture_code_session:
        if not args.code_workspace:
            payload = {"ok": False, "errors": ["--capture-code-session 必须提供至少一个 --code-workspace"]}
            if args.json:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            else:
                print(f"Code Session 捕获失败: {payload['errors'][0]}", file=sys.stderr)
            return 1
        try:
            session = capture_code_session_baseline(
                workspace=workspace,
                feature=feature,
                code_workspaces=[Path(item).expanduser().resolve() for item in args.code_workspace],
            )
            payload = {
                "ok": True,
                "mode": "capture-code-session",
                "feature": feature,
                "sessionId": session.get("sessionId"),
                "status": session.get("status"),
                "repositories": sorted(session.get("repositories", {})),
            }
            if args.json:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            else:
                print(f"Code Session 基线已捕获: feature={feature} session={session.get('sessionId')}")
            return 0
        except (OSError, ValueError) as exc:
            payload = {"ok": False, "mode": "capture-code-session", "errors": [str(exc)]}
            if args.json:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            else:
                print(f"Code Session 捕获失败: {exc}", file=sys.stderr)
            return 1

    stage = (args.stage_alias or args.stage or "").strip()
    if not stage:
        parser.error("回退操作必须提供 --to-stage/--stage")
    if not args.dry_run and not args.apply:
        parser.error("回退执行必须显式提供 --dry-run 或 --apply")
    if args.apply and args.state_mode is None:
        payload = {
            "ok": False,
            "feature": feature,
            "requestedStage": stage,
            "confirmationRequired": True,
            "errors": [
                "必须先确认回退后的状态；请使用 --state-mode target_in_progress "
                "或 --state-mode previous_done"
            ],
        }
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"阶段回退失败: {payload['errors'][0]}", file=sys.stderr)
        return 1

    preview_without_confirmation = args.dry_run and args.state_mode is None
    requested_state_mode = args.state_mode or ROLLBACK_STATE_TARGET_IN_PROGRESS
    plan = prepare_stage_rollback(
        workspace=workspace,
        feature=feature,
        stage=stage,
        code_source=args.code_source,
        state_mode=requested_state_mode,
    )
    # ops.archive has no *_in_progress checkpoint. Build its preview from the
    # other valid mode, but do not expose it as a user-confirmed selection.
    if preview_without_confirmation and not plan.ok:
        plan = prepare_stage_rollback(
            workspace=workspace,
            feature=feature,
            stage=stage,
            code_source=args.code_source,
            state_mode=ROLLBACK_STATE_PREVIOUS_DONE,
        )
    if args.dry_run or not plan.ok:
        result = RollbackResult(ok=plan.ok, plan=plan, errors=plan.errors)
    else:
        result = execute_stage_rollback(plan)

    if args.json:
        print(
            json.dumps(
                _result_payload(
                    result,
                    dry_run=args.dry_run,
                    confirmation_required=preview_without_confirmation,
                ),
                ensure_ascii=False,
                indent=2,
            )
        )
    elif not result.ok:
        print("阶段回退失败:", file=sys.stderr)
        for error in result.errors or plan.errors:
            print(f"  - {error}", file=sys.stderr)
    elif args.dry_run:
        checkpoint = "待确认" if preview_without_confirmation else plan.new_checkpoint
        print(
            f"DRY_RUN stage rollback: feature={feature} stage={plan.target_node_id} "
            f"checkpoint={plan.old_checkpoint}->{checkpoint}"
        )
        if preview_without_confirmation:
            for option in plan.state_options:
                print(f"  - state-mode {option['mode']}: {option['description']}")
        for path in plan.artifact_paths:
            print(f"  - {path.relative_to(plan.feature_dir).as_posix()}")
    else:
        print(
            f"stage rolled back: feature={feature} stage={plan.target_node_id} "
            f"checkpoint={plan.old_checkpoint}->{plan.new_checkpoint}"
        )
        for path in result.deleted_artifacts:
            print(f"  - deleted {path}")
        if result.archived_workflow_runtime:
            print(f"  - archived {result.archived_workflow_runtime}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
