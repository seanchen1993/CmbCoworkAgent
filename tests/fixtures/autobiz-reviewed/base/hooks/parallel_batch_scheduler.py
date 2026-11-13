#!/usr/bin/env python3
"""Plan-aware scheduler commands for parallel Code batch runs.

This process never implements code itself.  It creates and updates the durable
run manifest consumed by the workflow runtime and Task Runner entrypoints.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import feature_dir, resolve_feature, resolve_workspace
from hooks.commit_message import build_commit_message, normalize_task_card_id
from hooks.evidence_kernel import FileLock
from hooks.parallel_runtime import (
    append_event,
    batch_occupies_scheduler_slot,
    batch_write_sets_conflict,
    create_manifest,
    DELIVERY_STAGES,
    get_active_run,
    lease_path,
    list_runs,
    load_manifest,
    parallel_plan_errors,
    plan_digest,
    mergeable_batches,
    stage_recovery_batches,
    ready_batches,
    resource_groups,
    select_runnable_batches,
    run_lock,
    save_manifest,
)
from hooks.plan_json import load_plan_bundle
from hooks.parallel_validation_ownership import validation_ownership_errors
from hooks.parallel_batch_stage import UTEST_STAGE_TIMEOUT_SECONDS
from hooks.repository_snapshot import (
    PLATFORM_RUNTIME_DIRECTORY,
    RepositorySnapshotError,
    current_git_branch,
    git_status_porcelain,
    resolve_git_root,
    working_tree_changed_files,
)
_BOOTSTRAP_IGNORE_RULES = (
    ".cmbdevclaw/large_tool_results/",
    ".autobizdevops/features/*/.parallel-runs/",
)
MAX_AUTOMATIC_BATCH_RECOVERY_ATTEMPTS = 2


def _parse_timestamp_epoch(value: object) -> float | None:
    """Parse one persisted UTC timestamp without making recovery fragile."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _next_open_delivery_stage(batch: dict[str, Any]) -> str | None:
    """Return the first delivery stage that has not reached a durable end state."""
    states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
    return next(
        (
            stage
            for stage in DELIVERY_STAGES
            if not isinstance(states.get(stage), dict)
            or states[stage].get("status") not in {"passed", "skipped", "deferred"}
        ),
        None,
    )


def _lease_staleness_reason_locked(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    batch: dict[str, Any],
    *,
    now: float,
    timeout_seconds: int,
) -> str | None:
    """Return why an active Batch has lost execution authority, if it has.

    This helper runs while the scheduler owns the run lock and takes the
    per-Batch lease lock before inspecting the bearer lease.  A valid lease is
    intentionally left untouched: resuming a workflow must never steal work
    from a worker that is still renewing its lease.  Conversely, a missing, corrupt,
    expired, or over-deadline lease has no safe worker authority
    left and can be deterministically retried by the scheduler.
    """
    path = lease_path(workspace, feature, run_id, batch_id)
    with FileLock(path.with_suffix(".lock")):
        if not path.is_file():
            return "lease_missing"
        try:
            lease = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            if path.exists():
                path.unlink()
            return "lease_invalid"
        if not isinstance(lease, dict):
            if path.exists():
                path.unlink()
            return "lease_invalid"
        try:
            expires_epoch = float(lease.get("expiresEpoch", 0))
        except (TypeError, ValueError):
            expires_epoch = 0
        if expires_epoch <= now:
            if path.exists():
                path.unlink()
            return "lease_expired"

        # Each acquire begins a new implementation or repair attempt. The
        # original Batch startedAt can be hours old by the time Fix begins.
        # Honour the guarded lease's effective TTL for older run manifests.
        started_epoch = _parse_timestamp_epoch(lease.get("startedAt"))
        try:
            lease_ttl = int(lease.get("ttlSeconds", 0))
        except (TypeError, ValueError):
            lease_ttl = 0
        attempt_timeout = max(1, timeout_seconds, lease_ttl)
        if started_epoch is not None and now - started_epoch >= attempt_timeout:
            if path.exists():
                path.unlink()
            return "batch_timeout"
    return None


def _mark_retry_pending_locked(
    workspace: Path,
    feature: str,
    run_id: str,
    manifest: dict[str, Any],
    batch_id: str,
    batch: dict[str, Any],
    *,
    error: str,
    previous_status: str | None = None,
) -> bool:
    """Persist one task-scoped recovery marker without delegating to a worker."""
    previous = previous_status if previous_status is not None else str(batch.get("status") or "")
    previous_recovery = batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}
    retry_attempts = (
        1
        if previous == "blocked" and previous_recovery.get("status") == "retry_exhausted"
        else int(previous_recovery.get("retryAttempts", 0)) + 1
    )
    resume_status = (
        "ready_to_candidate"
        if previous == "ready_to_candidate"
        else "sealed"
        if batch.get("commitSha")
        else "pending"
    )
    implementation_resume = (
        _implementation_resume_details(manifest, batch_id, batch)
        if resume_status == "pending"
        else None
    )
    recovery_kind = (
        "integration_resume"
        if resume_status == "ready_to_candidate"
        else "stage_resume"
        if resume_status == "sealed"
        else "implementation_resume"
        if implementation_resume is not None
        else "retry_dispatch"
    )
    batch.update(
        {
            "status": "retry_pending",
            "error": error,
            "activeStage": None,
            "startedAt": None,
            "completedAt": None,
            "recovery": {
                **previous_recovery,
                "retryAttempts": retry_attempts,
                "lastFailureAt": manifest.get("updatedAt"),
                "lastError": error,
                "resumeStatus": resume_status,
                "kind": recovery_kind,
                "resumeFromStage": (
                    _next_open_delivery_stage(batch)
                    if recovery_kind == "stage_resume"
                    else "implement"
                    if recovery_kind == "implementation_resume"
                    else None
                ),
                # A sealed delivery or a verified dirty implementation
                # Worktree must resume in place.  Only a clean/unbound
                # unsealed retry is safe to provision again.
                "preserveWorktree": recovery_kind in {"stage_resume", "implementation_resume"},
                "reprovision": recovery_kind == "retry_dispatch",
                **({"implementationResume": implementation_resume} if implementation_resume is not None else {}),
                "status": "pending_retry",
            },
        }
    )
    return _clear_retry_lease_locked(workspace, feature, run_id, batch_id, batch)


def _recover_stale_active_batches_locked(
    workspace: Path,
    feature: str,
    run_id: str,
    manifest: dict[str, Any],
) -> list[dict[str, str]]:
    """Move orphaned leased/running Batches into durable retry recovery."""
    now = time.time()
    timeout_seconds = max(1, int(manifest.get("timeoutPerBatch", 3600)))
    recovered: list[dict[str, str]] = []
    for raw_batch_id, batch in manifest.get("batches", {}).items():
        if not isinstance(batch, dict) or batch.get("status") not in {"leased", "running"}:
            continue
        batch_id = str(raw_batch_id)
        reason = _lease_staleness_reason_locked(
            workspace,
            feature,
            run_id,
            batch_id,
            batch,
            now=now,
            timeout_seconds=timeout_seconds,
        )
        if reason is None:
            continue
        _mark_retry_pending_locked(
            workspace,
            feature,
            run_id,
            manifest,
            batch_id,
            batch,
            error=f"parallel_batch_recovery:{reason}",
        )
        recovered.append({"batchId": batch_id, "reason": reason})
    return recovered


def _close_overdue_utest_stages_locked(
    workspace: Path,
    feature: str,
    run_id: str,
    manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    """Close a UTest stage whose durable wall-clock budget has elapsed.

    The lease is an ownership mechanism, not a quality-stage deadline.  A
    worker can otherwise keep a sealed Batch in ``test`` while it repeatedly
    explores compiler workarounds. Clearing its lease makes later commands
    fail safely; the controlled runner independently clamps each process to
    this same deadline. Timeout is a visible non-blocking UTest deferral,
    with final B-E2E still required before the run can succeed.
    """
    now = time.time()
    stage_timeout = min(
        UTEST_STAGE_TIMEOUT_SECONDS,
        max(1, int(manifest.get("timeoutPerBatch", UTEST_STAGE_TIMEOUT_SECONDS))),
    )
    closed: list[dict[str, Any]] = []
    for raw_batch_id, batch in manifest.get("batches", {}).items():
        if not isinstance(batch, dict):
            continue
        states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
        test = states.get("test") if isinstance(states, dict) else None
        if not isinstance(test, dict) or test.get("status") != "running":
            continue
        started = _parse_timestamp_epoch(test.get("startedAt"))
        if started is None or now - started < stage_timeout:
            continue
        batch_id = str(raw_batch_id)
        issue_index = 1 + sum(
            1
            for item in manifest.get("deferredIssues", [])
            if isinstance(item, dict)
            and item.get("batchId") == batch_id
            and item.get("stage") == "test"
            and item.get("kind") == "utest_stage_timeout"
        )
        issue_id = f"UTEST-TIMEOUT-{batch_id}-{issue_index:03d}"
        message = "utest_stage_timeout:{}s".format(stage_timeout)
        test.update({
            "status": "deferred",
            "completedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "failure": {"type": "environment", "message": message, "nextStage": None},
            "deferredIssueId": issue_id,
            "deferredDisposition": "utest_stage_timeout",
        })
        issues = manifest.setdefault("deferredIssues", [])
        if isinstance(issues, list):
            issues.append({
                "issueId": issue_id,
                "kind": "utest_stage_timeout",
                "batchId": batch_id,
                "stage": "test",
                "failureType": "environment",
                "message": message,
                "disposition": "recorded_deferred",
                "blocksWorkflow": False,
                "status": "open",
                "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            })
        batch["activeStage"] = None
        # The timed-out test has a durable terminal state. Mirror the
        # non-blocking UTest gate outcome so an agent that timed out itself
        # need not wake up just to advance this sealed delivery.
        batch["status"] = "ready_to_candidate"
        _clear_retry_lease_locked(workspace, feature, run_id, batch_id, batch)
        closed.append({"batchId": batch_id, "timeoutSeconds": stage_timeout})
    return closed


def _unresolved_state(manifest: dict[str, Any]) -> tuple[list[str], list[str], set[str]]:
    """Return retained, task-scoped manual work and the Batches it owns."""
    unresolved_batches = sorted(
        str(batch_id)
        for batch_id, batch in manifest.get("batches", {}).items()
        if isinstance(batch, dict) and batch.get("status") in {"needs_resolution", "conflict"}
    )
    unresolved_trains: list[str] = []
    train_batch_ids: set[str] = set()
    for key, train in (manifest.get("mergeTrains") or {}).items():
        if not isinstance(train, dict) or train.get("status") not in {"candidate_conflicted", "needs_resolution"}:
            continue
        unresolved_trains.append(str(key))
        train_batch_ids.update(
            str(batch_id)
            for batch_id in train.get("batchIds", [])
            if isinstance(batch_id, str) and batch_id.strip()
        )
    return unresolved_batches, sorted(unresolved_trains), set(unresolved_batches) | train_batch_ids


def _is_global_resolution_batch(batch: dict[str, Any]) -> bool:
    """A promoted source whose Plan write failed is not an isolatable conflict."""
    resolution = batch.get("resolution")
    return isinstance(resolution, dict) and resolution.get("kind") == "plan_state_update"


def _is_global_resolution_train(train: dict[str, Any]) -> bool:
    """Do not schedule through a train that may already have promoted source."""
    return bool(train.get("planWriterErrors")) or bool(train.get("promotedSha"))


def _scoped_merge_train_keys(
    manifest: dict[str, Any],
    keys: list[str],
    workspace_refs: list[str] | None,
) -> list[str]:
    if not workspace_refs:
        return list(keys)
    allowed = {str(ref).strip() for ref in workspace_refs if str(ref).strip()}
    return [
        key
        for key in keys
        if str(((manifest.get("mergeTrains") or {}).get(key, {}) or {}).get("repositoryRef") or "") in allowed
    ]


def _clear_retry_lease_locked(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    batch: dict[str, Any],
) -> bool:
    """Clear lease authority while the caller owns the run lock.

    ``retry_pending`` means that the worker which held this Batch's lease has
    already yielded control.  Keeping either the lease file or the manifest
    lease metadata would make a resumed ``ready_to_candidate`` delivery
    permanently non-mergeable, or make a resumed ``pending`` delivery reject
    its next worker with ``parallel_batch_lease_held``.  Do this as part of
    the durable state transition rather than depending on a best-effort
    Workflow cleanup prompt.
    """
    path = lease_path(workspace, feature, run_id, batch_id)
    had_lease = path.is_file() or batch.get("lease") is not None
    with FileLock(path.with_suffix(".lock")):
        if path.exists():
            path.unlink()
    batch["lease"] = None
    return had_lease


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run Git using UTF-8 so CJK worktree paths work on Windows."""
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _ensure_git_root(requested: Path, *, allow_bootstrap: bool) -> tuple[Path, bool]:
    """Return a Git root, initializing an explicit code directory when needed."""
    try:
        return resolve_git_root(requested), False
    except RepositorySnapshotError:
        if not allow_bootstrap:
            raise ValueError(f"parallel_code_workspace_git_repository_required:{requested}")
        if not requested.is_dir():
            raise
        init = _git(requested, "init", "-b", "main")
        if init.returncode != 0:
            # Older Git versions do not support `init -b`; retain the same
            # bootstrap behavior with the portable form.
            init = _git(requested, "init")
        if init.returncode != 0:
            raise ValueError(f"parallel_code_workspace_git_init_failed:{init.stderr.strip()}")
        return resolve_git_root(requested), True


def _ensure_runtime_ignores(git_root: Path) -> list[str]:
    """Keep workflow-owned files out of the user's tracked baseline."""
    exclude = git_root / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    additions = [rule for rule in _BOOTSTRAP_IGNORE_RULES if rule not in existing.splitlines()]
    if additions:
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        exclude.write_text(existing + prefix + "\n".join(additions) + "\n", encoding="utf-8")
    return additions


def _git_head(git_root: Path) -> str | None:
    result = _git(git_root, "rev-parse", "--verify", "HEAD")
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def _unstage_platform_runtime(git_root: Path, *, has_head: bool) -> None:
    """Keep already-staged platform artifacts out of an automatic baseline."""
    if has_head:
        staged = _git(git_root, "diff", "--cached", "--quiet", "--", PLATFORM_RUNTIME_DIRECTORY)
        if staged.returncode == 0:
            return
        if staged.returncode != 1:
            raise ValueError(f"parallel_code_workspace_runtime_stage_check_failed:{staged.stderr.strip()}")
        # ``git restore`` arrived after the Git version shipped by several
        # supported Windows images.  ``reset HEAD --`` has the same staging
        # effect here and is supported by Git 2.20.
        command = ["reset", "HEAD", "--", PLATFORM_RUNTIME_DIRECTORY]
    else:
        command = ["rm", "-r", "--cached", "--ignore-unmatch", "--", PLATFORM_RUNTIME_DIRECTORY]
    result = _git(git_root, *command)
    if result.returncode != 0:
        raise ValueError(f"parallel_code_workspace_runtime_unstage_failed:{result.stderr.strip()}")


def _bootstrap_repository(
    git_root: Path,
    feature: str,
    *,
    task_card_id: str,
    initialized: bool,
    ignore_additions: list[str],
    allow_bootstrap: bool,
) -> dict[str, Any]:
    """Optionally create an explicit baseline commit for an unusable source tree."""
    before_head = _git_head(git_root)
    status = git_status_porcelain(git_root)
    if status.returncode != 0:
        raise ValueError("parallel_code_workspace_status_unavailable")
    dirty = bool(status.stdout.strip())
    if before_head and not dirty:
        return {
            "headSha": before_head,
            "performed": bool(initialized or ignore_additions),
            "initialized": initialized,
            "reason": "git_initialized" if initialized else None,
            "commitSha": before_head,
        }

    if not allow_bootstrap:
        reason = "unborn_head" if before_head is None else "dirty_worktree"
        raise ValueError(f"parallel_code_workspace_bootstrap_required:{reason}:{git_root}")

    _unstage_platform_runtime(git_root, has_head=before_head is not None)
    add = _git(git_root, "add", "-A", "--", ".", f":(exclude){PLATFORM_RUNTIME_DIRECTORY}**")
    if add.returncode != 0:
        raise ValueError(f"parallel_code_workspace_bootstrap_stage_failed:{add.stderr.strip()}")
    reason = "unborn_head" if before_head is None else "dirty_worktree"
    message = build_commit_message(task_card_id, f"初始化 {feature} 工作流基线")
    # Use the target repository's normal Git identity and hook chain. This is
    # the same commit path used later by native Batch worktrees; overriding it
    # with a plugin address makes corporate author-domain hooks reject the
    # bootstrap before the Workflow can start.
    commit = _git(
        git_root,
        "commit",
        "--allow-empty",
        "-m",
        message,
    )
    if commit.returncode != 0:
        raise ValueError(f"parallel_code_workspace_bootstrap_commit_failed:{commit.stderr.strip()}")
    head = _git_head(git_root)
    if head is None:
        raise ValueError("parallel_code_workspace_bootstrap_head_unavailable")
    return {
        "headSha": head,
        "performed": True,
        "initialized": initialized,
        "reason": reason,
        "commitSha": head,
    }


def resolve_repository_bindings(
    bundle: Any,
    values: list[str] | None,
    *,
    feature: str = "feature",
    allow_bootstrap: bool = False,
    task_card_id: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Resolve `workspaceRef=/path` arguments into immutable repository bindings."""
    normalized_task_card_id = normalize_task_card_id(task_card_id)
    refs = sorted({
        str(item.get("workspaceRef"))
        for batch in bundle.batches.values()
        for item in batch.get("tasks", [])
        if isinstance(item, dict) and isinstance(item.get("workspaceRef"), str)
    })
    raw = values or []
    parsed: dict[str, Path] = {}
    bare: list[Path] = []
    for value in raw:
        key, separator, path = value.partition("=")
        if separator:
            if not key or not path or key in parsed:
                raise ValueError(f"parallel_code_workspace_invalid:{value}")
            parsed[key] = Path(path).expanduser().resolve()
        elif value:
            bare.append(Path(value).expanduser().resolve())
    if bare:
        if len(bare) != 1 or len(refs) != 1:
            raise ValueError("parallel_code_workspace_mapping_required")
        parsed[refs[0]] = bare[0]
    missing = sorted(set(refs) - set(parsed))
    unexpected = sorted(set(parsed) - set(refs))
    if missing:
        raise ValueError("parallel_code_workspace_missing:" + ",".join(missing))
    if unexpected:
        raise ValueError("parallel_code_workspace_unknown:" + ",".join(unexpected))
    bindings: dict[str, dict[str, Any]] = {}
    for ref in refs:
        requested = parsed[ref]
        try:
            git_root, initialized = _ensure_git_root(requested, allow_bootstrap=allow_bootstrap)
        except (RepositorySnapshotError, ValueError) as exc:
            raise ValueError(f"parallel_code_workspace_invalid:{ref}:{exc}") from exc
        ignore_additions = _ensure_runtime_ignores(git_root)
        bootstrap = _bootstrap_repository(
            git_root,
            feature,
            task_card_id=normalized_task_card_id,
            initialized=initialized,
            ignore_additions=ignore_additions,
            allow_bootstrap=allow_bootstrap,
        )
        head = bootstrap["headSha"]
        branch = current_git_branch(git_root)
        bindings[ref] = {
            "workspaceRef": ref,
            "requestedPath": str(requested),
            "gitRoot": str(git_root),
            "baseSha": head,
            # This moves forward only through merges owned by this run.  It
            # is the expected main HEAD for later dependency waves.
            "headSha": head,
            "baseBranch": branch,
            "bootstrap": bootstrap,
            "runtimeIgnoreAdditions": ignore_additions,
        }
    return bindings


def _git_metadata_path(git_root: Path, argument: str) -> Path:
    """Resolve a Git metadata path returned relative to a worktree root."""
    result = _git(git_root, "rev-parse", argument)
    raw = result.stdout.strip()
    if result.returncode != 0 or not raw:
        raise ValueError(f"parallel_batch_worktree_git_metadata_unavailable:{git_root}")
    path = Path(raw)
    return path.resolve() if path.is_absolute() else (git_root / path).resolve()


def assert_batch_worktree_isolated(
    manifest: dict[str, Any],
    batch_id: str,
    worktree_path: Path | str,
) -> None:
    """Require the plugin-owned linked native worktree assigned to a Batch.

    The plugin provisions a linked worktree before starting the Batch agent and
    this guard verifies Git's own worktree metadata rather than trusting a
    filesystem path supplied by the agent.
    """
    batch = manifest.get("batches", {}).get(batch_id)
    if not isinstance(batch, dict):
        raise ValueError(f"parallel_batch_not_found:{batch_id}")
    repository_ref = str(batch.get("repositoryRef") or batch.get("workspaceRef") or "")
    binding = manifest.get("repositories", {}).get(repository_ref)
    if not isinstance(binding, dict) or not isinstance(binding.get("gitRoot"), str):
        raise ValueError(f"parallel_repository_binding_missing:{repository_ref}")

    source_root = Path(str(binding["gitRoot"])).expanduser().resolve()
    candidate = Path(worktree_path).expanduser().resolve()
    try:
        candidate_root = resolve_git_root(candidate)
    except RepositorySnapshotError as exc:
        raise ValueError(f"parallel_batch_worktree_not_git:{candidate}") from exc

    details = {
        "batchId": batch_id,
        "repositoryRef": repository_ref,
        "sourceGitRoot": str(source_root),
        "worktreePath": str(candidate),
    }
    if candidate_root == source_root:
        raise ValueError(
            "parallel_batch_worktree_not_isolated:"
            + json.dumps({**details, "reason": "source_checkout"}, ensure_ascii=False, separators=(",", ":"))
        )

    source_common = _git_metadata_path(source_root, "--git-common-dir")
    candidate_common = _git_metadata_path(candidate_root, "--git-common-dir")
    source_git_dir = _git_metadata_path(source_root, "--git-dir")
    candidate_git_dir = _git_metadata_path(candidate_root, "--git-dir")
    if candidate_common != source_common or candidate_git_dir == source_git_dir:
        raise ValueError(
            "parallel_batch_worktree_not_isolated:"
            + json.dumps(
                {
                    **details,
                    "reason": "not_linked_to_source_repository",
                    "sourceGitCommonDir": str(source_common),
                    "worktreeGitCommonDir": str(candidate_common),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

    listed = _git(source_root, "worktree", "list", "--porcelain")
    registered = {
        Path(line[len("worktree "):]).resolve()
        for line in listed.stdout.splitlines()
        if line.startswith("worktree ")
    }
    if listed.returncode != 0 or candidate_root not in registered:
        raise ValueError(
            "parallel_batch_worktree_not_isolated:"
            + json.dumps(
                {**details, "reason": "not_registered_with_source_repository"},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )


def _implementation_resume_details(
    manifest: dict[str, Any],
    batch_id: str,
    batch: dict[str, Any],
) -> dict[str, Any] | None:
    """Return safe in-place recovery coordinates for an unsealed Batch.

    A dirty, plugin-owned linked worktree can contain implementation that was
    interrupted between Task Runner start and the first seal.  It is unsafe to
    provision over that checkout, but it is equally unsafe to resume an
    arbitrary dirty directory.  Require the exact Batch binding, branch, and
    frozen repository head before offering the Worktree to Task Runner's
    attribution checks.
    """
    if batch.get("commitSha"):
        return None
    raw_path = batch.get("worktreePath")
    branch_name = batch.get("branchName")
    repository_ref = str(batch.get("repositoryRef") or batch.get("workspaceRef") or "")
    repository = (manifest.get("repositories") or {}).get(repository_ref)
    if not isinstance(raw_path, str) or not raw_path.strip() or not isinstance(branch_name, str) or not branch_name.strip():
        return None
    if not isinstance(repository, dict):
        return None
    expected_head = repository.get("headSha") or repository.get("baseSha")
    if not isinstance(expected_head, str) or not expected_head.strip():
        return None
    worktree = Path(raw_path).expanduser().resolve()
    try:
        assert_batch_worktree_isolated(manifest, batch_id, worktree)
        if current_git_branch(worktree) != branch_name:
            return None
        if _git_head(worktree) != expected_head:
            return None
        changed_files = working_tree_changed_files(worktree)
    except (OSError, RepositorySnapshotError, ValueError):
        return None
    if not changed_files:
        return None
    return {
        "worktreePath": str(worktree),
        "branchName": branch_name,
        "expectedHead": expected_head,
        "changedFileCount": len(changed_files),
        "changedFileSample": changed_files[:20],
    }


def validate_plan_for_parallel(workspace: Path, feature: str) -> dict[str, Any]:
    try:
        bundle = load_plan_bundle(feature_dir(workspace, feature))
    except ValueError as exc:
        return {
            "canParallel": False,
            "requiresPlanRepair": True,
            "reason": f"invalid_plan:{exc}",
            "errors": [str(exc)],
        }
    errors = [*parallel_plan_errors(bundle), *validation_ownership_errors(bundle.root, bundle.batches)]
    if errors:
        return {
            "canParallel": False,
            "requiresPlanRepair": True,
            "reason": errors[0],
            "errors": errors,
        }
    entries = [item for item in bundle.root.get("batches", []) if isinstance(item, dict) and item.get("status") not in {"done", "failed"}]
    if not entries:
        return {"canParallel": False, "reason": "no_pending_batches", "errors": []}
    return {
        "canParallel": True,
        "reason": "parallel_plan_valid" if len(entries) > 1 else "single_batch_workflow_valid",
        "planDigest": plan_digest(bundle),
        "batches": [str(item["id"]) for item in entries],
        "workspaceRefs": sorted({
            str(task.get("workspaceRef"))
            for batch in bundle.batches.values()
            for task in batch.get("tasks", [])
            if isinstance(task, dict) and isinstance(task.get("workspaceRef"), str)
        }),
        "errors": [],
    }


def create_run(
    workspace: Path,
    feature: str,
    *,
    max_parallel: int,
    timeout_seconds: int,
    code_workspaces: list[str] | None = None,
    workflow_workspace: Path | None = None,
    allow_bootstrap: bool = False,
    task_card_id: str | None = None,
) -> dict[str, Any]:
    # Kept as an ignored Python API compatibility parameter for older callers.
    # The CLI and fixed Workflow no longer expose it: platform workspace identity
    # must not constrain one or more business repositories.
    _ = workflow_workspace
    normalized_task_card_id = normalize_task_card_id(task_card_id)
    verdict = validate_plan_for_parallel(workspace, feature)
    if not verdict["canParallel"]:
        raise ValueError(f"parallel_not_available:{verdict['reason']}")
    # The active-run check and manifest creation must be one critical section.
    # Child repository Workflows are launched concurrently and otherwise can
    # both observe an empty run directory and create divergent DAG runs.
    # Reuse the Feature's existing plan lock so an invalid source repository
    # does not create a leftover ``.parallel-runs`` directory just to acquire
    # a scheduler lock.  It also prevents Plan edits racing run creation.
    with FileLock(feature_dir(workspace, feature) / ".plan.lock"):
        if get_active_run(workspace, feature) is not None:
            raise ValueError("parallel_run_already_active")
        bundle = load_plan_bundle(feature_dir(workspace, feature))
        repositories = resolve_repository_bindings(
            bundle,
            code_workspaces,
            feature=feature,
            allow_bootstrap=allow_bootstrap,
            task_card_id=normalized_task_card_id,
        )
        # Load runtime config from workspace
        from hooks.workflow_launcher import _load_runtime_config
        runtime_config = _load_runtime_config(workspace)

        manifest = create_manifest(
            workspace,
            feature,
            max_parallel=max_parallel,
            timeout_seconds=timeout_seconds,
            repositories=repositories,
            runtime_config=runtime_config,  # Pass runtime config
            task_card_id=normalized_task_card_id,
        )
        manifest["isolation"] = {
            "mode": "native_git_worktrees",
            "owner": "plugin",
            "cleanupOwner": "plugin",
            "provisioner": "hooks/worktree_manager.py",
            "workspaceRefs": sorted(repositories),
        }
        manifest["status"] = "running"
        save_manifest(workspace, feature, str(manifest["runId"]), manifest)
        append_event(workspace, feature, str(manifest["runId"]), "run_created", maxParallel=manifest["maxParallel"])
        return schedule(workspace, feature, str(manifest["runId"]))


def _sealed_delivery_error(manifest: dict[str, Any], batch_id: str) -> str | None:
    """Validate a plugin-managed native Worktree before resuming a run."""
    batch = manifest.get("batches", {}).get(batch_id)
    if not isinstance(batch, dict):
        return f"parallel_batch_not_found:{batch_id}"
    commit_sha = batch.get("commitSha")
    if not isinstance(commit_sha, str) or not commit_sha:
        return None
    worktree_path = batch.get("worktreePath")
    branch_name = batch.get("branchName")
    if not isinstance(worktree_path, str) or not worktree_path:
        return f"native_worktree_delivery_missing:{batch_id}:path"
    if not isinstance(branch_name, str) or not branch_name:
        return f"native_worktree_delivery_missing:{batch_id}:branch"
    try:
        assert_batch_worktree_isolated(manifest, batch_id, worktree_path)
    except ValueError:
        return f"native_worktree_delivery_missing:{batch_id}:worktree"
    worktree = Path(worktree_path)
    if current_git_branch(worktree) != branch_name:
        return f"native_worktree_delivery_missing:{batch_id}:branch"
    head = _git(worktree, "rev-parse", "HEAD")
    if head.returncode != 0 or head.stdout.strip() != commit_sha:
        return f"native_worktree_delivery_commit_mismatch:{batch_id}"
    status = git_status_porcelain(worktree)
    if status.returncode != 0:
        return f"native_worktree_delivery_status_unavailable:{batch_id}"
    if status.stdout.strip():
        return f"native_worktree_delivery_dirty:{batch_id}"
    return None


def _source_repository_errors(manifest: dict[str, Any]) -> list[str]:
    """Return source-worktree violations before an active run is reused.

    Each repository binding freezes the expected HEAD.  It moves forward only
    through ``parallel_merge_train.py`` after exact candidate promotion. Direct commits, resets,
    and shared-checkout changes must stop recovery before another Batch runs
    against a different base.
    """
    errors: list[str] = []
    repositories = manifest.get("repositories", {})
    if not isinstance(repositories, dict) or not repositories:
        return ["parallel_repository_bindings_missing"]
    for ref, repository in sorted(repositories.items()):
        if not isinstance(repository, dict) or not isinstance(repository.get("gitRoot"), str):
            errors.append(f"parallel_repository_binding_invalid:{ref}")
            continue
        root = Path(repository["gitRoot"])
        status = git_status_porcelain(root)
        if status.returncode != 0:
            errors.append(f"parallel_repository_status_unavailable:{ref}")
            continue
        if status.stdout.strip():
            errors.append(f"parallel_repository_dirty:{ref}")
            continue
        expected_head = repository.get("headSha") or repository.get("baseSha")
        actual_head = _git_head(root)
        if not isinstance(expected_head, str) or not expected_head.strip() or not actual_head:
            errors.append(f"parallel_repository_head_unavailable:{ref}")
        elif actual_head != expected_head:
            errors.append(
                f"parallel_repository_head_changed:{ref}:expected={expected_head}:actual={actual_head}"
            )
    return errors


def _scoped_batch_ids(manifest: dict[str, Any], batch_ids: list[str], workspace_refs: list[str] | None) -> list[str]:
    if not workspace_refs:
        return list(batch_ids)
    allowed = {str(ref) for ref in workspace_refs if str(ref).strip()}
    return [
        batch_id
        for batch_id in batch_ids
        if str(
            (manifest.get("batches", {}).get(batch_id, {}) or {}).get("workspaceRef")
            or (manifest.get("batches", {}).get(batch_id, {}) or {}).get("repositoryRef")
        ) in allowed
    ]


def _stage_recovery_failure_context(
    batch: dict[str, Any],
    *,
    test_log_path: Path,
) -> dict[str, Any] | None:
    """Return the saved review/UTest finding that caused an implement recovery."""
    states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
    for stage in DELIVERY_STAGES:
        state = states.get(stage)
        failure = state.get("failure") if isinstance(state, dict) else None
        if not isinstance(failure, dict) or failure.get("nextStage") != "implement":
            continue
        message = failure.get("message")
        if not isinstance(message, str) or not message.strip():
            continue
        context: dict[str, Any] = {
            "failedStage": stage,
            "failureType": str(failure.get("type") or "implementation"),
            "message": message,
        }
        if stage == "test":
            context["testLogPath"] = str(test_log_path)
        return context
    return None


def schedule(
    workspace: Path,
    feature: str,
    run_id: str,
    workspace_refs: list[str] | None = None,
    *,
    workflow_view: bool = False,
) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        overdue_utests = _close_overdue_utest_stages_locked(
            workspace, feature, run_id, manifest
        )
        if overdue_utests:
            save_manifest(workspace, feature, run_id, manifest)
            for item in overdue_utests:
                append_event(
                    workspace,
                    feature,
                    run_id,
                    "utest_stage_timeout",
                    batchId=item["batchId"],
                    timeoutSeconds=item["timeoutSeconds"],
                )
        bundle = load_plan_bundle(feature_dir(workspace, feature))
        # A retained per-Batch conflict (or one conflicted Merge Train) owns
        # only the deliveries recorded in that retained state.  Keep those
        # deliveries out of every runnable output so a resume cannot silently
        # recreate their candidate, while allowing unrelated DAG branches to
        # continue.  Dependency release remains enforced by `ready_batches`.
        unresolved_batches, unresolved_trains, withheld_batches = _unresolved_state(manifest)
        batches = manifest.get("batches", {})
        # Recheck an in-place implementation recovery on every dispatch.
        # If it is no longer safe to continue in the old checkout, route the
        # idle, unsealed Batch through provision instead.  Provision archives
        # the old checkout before replacing it; a stale recovery marker must
        # not strand the Batch outside both runnable queues.
        all_implementation_recovery: list[str] = []
        implementation_recovery_details: dict[str, dict[str, Any]] = {}
        recovery_reprovisioned: list[str] = []
        for raw_batch_id, batch in batches.items():
            if not isinstance(batch, dict) or str(raw_batch_id) in withheld_batches:
                continue
            recovery = batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}
            if batch.get("status") != "pending" or recovery.get("kind") != "implementation_resume":
                continue
            batch_id = str(raw_batch_id)
            details = _implementation_resume_details(manifest, str(raw_batch_id), batch)
            if details is None:
                if batch.get("lease") is not None or batch.get("commitSha"):
                    all_implementation_recovery.append(batch_id)
                    continue
                batch["recovery"] = {
                    **recovery,
                    "kind": "retry_dispatch",
                    "resumeFromStage": None,
                    "preserveWorktree": False,
                    "reprovision": True,
                }
                batch["recovery"].pop("implementationResume", None)
                recovery_reprovisioned.append(batch_id)
                continue
            all_implementation_recovery.append(batch_id)
            implementation_recovery_details[batch_id] = details
        implementation_recovery_ids = set(all_implementation_recovery)
        ready = [
            batch_id
            for batch_id in ready_batches(manifest)
            if batch_id not in withheld_batches and batch_id not in implementation_recovery_ids
        ]
        # ``resource_groups`` treats ``None`` as "all batches" for callers
        # that intentionally omit a scope.  The scheduler has already built
        # an explicit readiness set, however, and an empty set must remain
        # empty: otherwise a retained conflict can be accidentally re-added
        # as a runnable group.
        groups = resource_groups(manifest, ready) if ready else []
        if workspace_refs:
            known_refs = {
                str(batch.get("workspaceRef") or batch.get("repositoryRef"))
                for batch in manifest.get("batches", {}).values()
                if isinstance(batch, dict)
            }
            requested_refs = {str(ref).strip() for ref in workspace_refs if str(ref).strip()}
            unknown_refs = sorted(requested_refs - known_refs)
            if unknown_refs:
                raise ValueError("parallel_workspace_refs_unknown:" + ",".join(unknown_refs))
        scoped_ready = _scoped_batch_ids(manifest, ready, workspace_refs)
        scoped_groups = [
            _scoped_batch_ids(manifest, group, workspace_refs)
            for group in groups
        ]
        scoped_groups = [group for group in scoped_groups if group]
        mergeable = [batch_id for batch_id in mergeable_batches(manifest) if batch_id not in withheld_batches]
        def unresolved_dependency(batch: dict[str, Any]) -> str | None:
            return next(
                (
                    str(dependency_id)
                    for dependency_id in batch.get("dependencies", [])
                    if not isinstance(batches.get(dependency_id), dict)
                    or batches[dependency_id].get("status") != "merged"
                    or not batches[dependency_id].get("mergeCommitSha")
                ),
                None,
            )

        implementation_recovery: list[str] = []
        excluded_implementation_recovery: list[dict[str, str]] = []
        for batch_id in all_implementation_recovery:
            batch = batches[batch_id]
            if batch_id not in implementation_recovery_details:
                excluded_implementation_recovery.append({
                    "batchId": batch_id,
                    "reason": "worktree_verification_failed",
                })
                continue
            if batch.get("lease") is not None:
                excluded_implementation_recovery.append({"batchId": batch_id, "reason": "lease_held"})
                continue
            dependency = unresolved_dependency(batch)
            if dependency is not None:
                excluded_implementation_recovery.append({
                    "batchId": batch_id,
                    "reason": f"dependency_unmerged:{dependency}",
                })
                continue
            implementation_recovery.append(batch_id)

        all_stage_recovery = [
            batch_id
            for batch_id in stage_recovery_batches(manifest)
            if batch_id not in withheld_batches
        ]
        scoped_all_stage_recovery = set(_scoped_batch_ids(manifest, all_stage_recovery, workspace_refs))
        scoped_all_implementation_recovery = set(
            _scoped_batch_ids(manifest, all_implementation_recovery, workspace_refs)
        )
        stage_recovery: list[str] = []
        excluded_stage_recovery: list[dict[str, str]] = []
        for batch_id in all_stage_recovery:
            batch = batches.get(batch_id, {})
            if batch.get("lease") is not None:
                excluded_stage_recovery.append({"batchId": batch_id, "reason": "lease_held"})
                continue
            dependency = unresolved_dependency(batch)
            if dependency is not None:
                excluded_stage_recovery.append({
                    "batchId": batch_id,
                    "reason": f"dependency_unmerged:{dependency}",
                })
                continue
            stage_recovery.append(batch_id)
        scoped_mergeable = _scoped_batch_ids(manifest, mergeable, workspace_refs)
        scoped_implementation_recovery = _scoped_batch_ids(manifest, implementation_recovery, workspace_refs)
        scoped_stage_recovery = _scoped_batch_ids(manifest, stage_recovery, workspace_refs)
        scoped_excluded_implementation_recovery = [
            item
            for item in excluded_implementation_recovery
            if item["batchId"] in scoped_all_implementation_recovery
        ]
        scoped_excluded_stage_recovery = [
            item
            for item in excluded_stage_recovery
            if item["batchId"] in scoped_all_stage_recovery
        ]
        scoped_unresolved_batches = _scoped_batch_ids(manifest, unresolved_batches, workspace_refs)
        scoped_unresolved_trains = _scoped_merge_train_keys(manifest, unresolved_trains, workspace_refs)
        max_parallel = int(manifest.get("maxParallel", 1))
        selected: list[list[str]] = []
        allowed_refs = {str(ref) for ref in workspace_refs or []}
        active = sum(
            1
            for item in manifest.get("batches", {}).values()
            if batch_occupies_scheduler_slot(item)
        )
        active_outside_scope = sum(
            1
            for item in manifest.get("batches", {}).values()
            if batch_occupies_scheduler_slot(item)
            and str(item.get("workspaceRef") or item.get("repositoryRef")) not in allowed_refs
        ) if workspace_refs else 0
        slots = max(0, max_parallel - active)
        active_batch_ids = sorted(
            str(batch_id)
            for batch_id, item in manifest.get("batches", {}).items()
            if batch_occupies_scheduler_slot(item)
        )
        runnable = select_runnable_batches(
            manifest,
            _scoped_batch_ids(manifest, ready, workspace_refs),
            active_batch_ids,
            slots,
        )
        if runnable:
            # Keep the nested response shape for fixed-workflow compatibility;
            # it is now one dynamic dispatch batch, not a completion barrier.
            selected.append(runnable)
        selected_ids = set(runnable)
        dispatch_exclusions: list[dict[str, str]] = []
        optimistic = (
            isinstance(manifest.get("runtimeConfig"), dict)
            and manifest["runtimeConfig"].get("parallelSchedulingMode") == "optimistic"
        )
        for batch_id in scoped_ready:
            if batch_id in selected_ids:
                continue
            batch = batches.get(batch_id, {})
            stage = str(batch.get("executionStage", "parallel")) if isinstance(batch, dict) else "parallel"
            selected_stage_batch = next(
                (batches.get(selected_id, {}) for selected_id in runnable),
                {},
            )
            selected_stage = (
                str(selected_stage_batch.get("executionStage", "parallel"))
                if isinstance(selected_stage_batch, dict)
                else "parallel"
            )
            if slots <= 0:
                reason = "max_parallel_capacity"
            elif stage == "parallel" and selected_stage != "parallel":
                reason = f"execution_stage_order:{runnable[0]}"
            elif stage != "parallel":
                reason = "critical_stage_waiting_for_active_workers" if active else "critical_stage_frontier"
            elif optimistic:
                reason = "max_parallel_capacity"
            else:
                conflict = next(
                    (
                        other
                        for other in [*active_batch_ids, *runnable]
                        if batch_write_sets_conflict(manifest, batch_id, other)
                    ),
                    None,
                )
                reason = f"write_set_conflict:{conflict}" if conflict else "not_selected_by_scheduler"
            dispatch_exclusions.append({"batchId": batch_id, "reason": reason})
        out_of_scope_ready = sorted(set(ready) - set(scoped_ready))
        dispatch_exclusions.extend(
            {"batchId": batch_id, "reason": "workspace_scope_excluded"}
            for batch_id in out_of_scope_ready
        )
        ready_ids = set(ready)
        allowed_scope = {str(ref) for ref in workspace_refs or []}
        for raw_batch_id, batch in batches.items():
            batch_id = str(raw_batch_id)
            if not isinstance(batch, dict) or batch.get("status") != "pending" or batch_id in ready_ids:
                continue
            workspace_ref = str(batch.get("workspaceRef") or batch.get("repositoryRef") or "")
            if allowed_scope and workspace_ref not in allowed_scope:
                continue
            dependency = next(
                (
                    str(dependency_id)
                    for dependency_id in batch.get("dependencies", [])
                    if not isinstance(batches.get(dependency_id), dict)
                    or batches[dependency_id].get("status") != "merged"
                    or not batches[dependency_id].get("mergeCommitSha")
                ),
                None,
            )
            if dependency is not None:
                dispatch_exclusions.append({
                    "batchId": batch_id,
                    "reason": f"dependency_unmerged:{dependency}",
                })
        manifest["scheduledAt"] = manifest.get("updatedAt")
        save_manifest(workspace, feature, run_id, manifest)
        for batch_id in recovery_reprovisioned:
            append_event(
                workspace, feature, run_id,
                "batch_implementation_recovery_reprovision_scheduled",
                batchId=batch_id,
                reason="worktree_verification_failed",
            )
        result = {
            "runId": run_id,
            "status": manifest.get("status"),
            "readyBatches": scoped_ready,
            "allReadyBatches": ready,
            "mergeableBatches": scoped_mergeable,
            "allMergeableBatches": mergeable,
            "implementationRecoveryBatches": [
                {
                    "batchId": batch_id,
                    "worktreePath": implementation_recovery_details[batch_id]["worktreePath"],
                    "branchName": implementation_recovery_details[batch_id]["branchName"],
                    "recoveryKind": "implementation_resume",
                    "resumeFromStage": "implement",
                    "preserveWorktree": True,
                    "reprovision": False,
                    "changedFileCount": implementation_recovery_details[batch_id]["changedFileCount"],
                    "changedFileSample": implementation_recovery_details[batch_id]["changedFileSample"],
                }
                for batch_id in scoped_implementation_recovery
            ],
            "allImplementationRecoveryBatches": all_implementation_recovery,
            "excludedImplementationRecoveryBatches": scoped_excluded_implementation_recovery,
            "stageRecoveryBatches": [
                {
                    "batchId": batch_id,
                    "worktreePath": batch.get("worktreePath"),
                    "branchName": batch.get("branchName"),
                    "commitSha": batch.get("commitSha"),
                    "recoveryKind": "stage_resume",
                    "preserveWorktree": True,
                    "reprovision": False,
                    "nextStage": "implement" if failure_context is not None else next_stage,
                    **(
                        {"failureContext": failure_context}
                        if failure_context is not None
                        else {}
                    ),
                }
                for batch_id in scoped_stage_recovery
                for batch in [manifest["batches"][batch_id]]
                for next_stage in [
                    _next_open_delivery_stage(batch)
                ]
                for failure_context in [
                    _stage_recovery_failure_context(
                        batch,
                        test_log_path=feature_dir(workspace, feature) / "test-output.log",
                    )
                ]
            ],
            "allStageRecoveryBatches": all_stage_recovery,
            "excludedStageRecoveryBatches": scoped_excluded_stage_recovery,
            "blockedBatches": sorted(
                str(batch_id)
                for batch_id, batch in manifest.get("batches", {}).items()
                if isinstance(batch, dict) and batch.get("status") == "blocked"
            ),
            "retryPendingBatches": sorted(
                str(batch_id)
                for batch_id, batch in manifest.get("batches", {}).items()
                if isinstance(batch, dict) and batch.get("status") == "retry_pending"
            ),
            "unresolvedBatches": scoped_unresolved_batches,
            "allUnresolvedBatches": unresolved_batches,
            "unresolvedMergeTrains": scoped_unresolved_trains,
            "allUnresolvedMergeTrains": unresolved_trains,
            "recoveryRequired": bool(scoped_unresolved_batches or scoped_unresolved_trains),
            "parallelGroups": scoped_groups,
            "allParallelGroups": groups,
            "scheduledGroups": selected,
            "workspaceRefs": sorted(set(workspace_refs or [])),
            "waitingForRepositories": bool(workspace_refs and not selected and not scoped_mergeable and (
                groups or mergeable or active_outside_scope
            )),
            "maxParallel": max_parallel,
            "activeWorkers": active,
            "dispatchDiagnostics": {
                "maxParallel": max_parallel,
                "occupiedSlots": active,
                "availableSlots": slots,
                "activeBatchIds": active_batch_ids,
                "eligibleBatchIds": scoped_ready,
                "selectedBatchIds": runnable,
                "recoveryBatchIds": sorted(set(scoped_stage_recovery + scoped_implementation_recovery + scoped_mergeable)),
                "notSelected": dispatch_exclusions,
            },
            "batchWorkspaces": {
                batch_id: {
                    "workspaceRef": item.get("workspaceRef"),
                    "componentRoots": item.get("componentRoots", []),
                    "executionStage": item.get("executionStage", "parallel"),
                    "deliveryKind": item.get("deliveryKind"),
                    "atomicGroupId": item.get("atomicGroupId"),
                    "batchRationale": item.get("batchRationale"),
                    "requestedPath": (manifest.get("repositories", {}).get(str(item.get("repositoryRef")), {}) or {}).get("requestedPath"),
                    "worktreePath": item.get("worktreePath"),
                    "branchName": item.get("branchName"),
                }
                for batch_id, item in manifest.get("batches", {}).items()
                if isinstance(item, dict)
            },
            "batchTaskIds": {
                batch_id: list(item.get("taskIds", []))
                for batch_id, item in manifest.get("batches", {}).items()
                if isinstance(item, dict)
            },
            "isolation": manifest.get("isolation"),
        }
        return _workflow_status_view(result, manifest) if workflow_view else result


def mark_batch(workspace: Path, feature: str, run_id: str, batch_id: str, status: str, **details: Any) -> dict[str, Any]:
    # ``merged`` is written only by the Merge Train after exact candidate promotion and
    # plan-state update. Worker-facing status changes may never unlock deps.
    if status == "merged":
        raise ValueError(f"parallel_batch_merge_owner_required:{batch_id}")
    allowed = {"pending", "leased", "running", "compile_failed", "sealed", "ready_to_candidate", "needs_resolution", "retry_pending", "failed", "blocked", "cancelled"}
    if status not in allowed:
        raise ValueError(f"parallel_batch_status_invalid:{status}")
    retry_lease_cleared = False
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = manifest.get("batches", {}).get(batch_id)
        if not isinstance(batch, dict):
            raise ValueError(f"parallel_batch_not_found:{batch_id}")
        previous = batch.get("status")
        terminal = {"merged", "failed", "blocked", "cancelled"}
        # `failed` was emitted by older workers before retry_pending existed.
        # Permit it (and a retry-exhausted block) to re-enter the controlled
        # recovery path; only a real merged/cancelled delivery stays immutable.
        retrying_terminal = previous in {"failed", "blocked"} and status == "retry_pending"
        if previous in terminal and previous != status and not retrying_terminal:
            raise ValueError(f"parallel_batch_terminal:{batch_id}:{previous}")
        if status in {"running", "sealed", "ready_to_candidate"}:
            candidate = details.get("worktreePath") or batch.get("worktreePath")
            if not isinstance(candidate, str) or not candidate.strip():
                raise ValueError(f"parallel_batch_worktree_path_required:{batch_id}")
            assert_batch_worktree_isolated(manifest, batch_id, candidate)
            expected_branch = details.get("branchName") or batch.get("branchName")
            if not isinstance(expected_branch, str) or not expected_branch.strip():
                raise ValueError(f"parallel_batch_worktree_branch_required:{batch_id}")
            if current_git_branch(Path(candidate)) != expected_branch:
                raise ValueError(f"parallel_batch_worktree_branch_mismatch:{batch_id}")
        for key in ("worktreePath", "branchName", "commitSha", "mergeCommitSha", "error"):
            if key in details:
                batch[key] = details[key]
        if status == "retry_pending":
            retry_lease_cleared = _mark_retry_pending_locked(
                workspace,
                feature,
                run_id,
                manifest,
                batch_id,
                batch,
                error=str(details.get("error") or batch.get("error") or "batch_execution_failed"),
                previous_status=str(previous or ""),
            )
        else:
            batch["status"] = status
        if status == "running" and not batch.get("startedAt"):
            batch["startedAt"] = details.get("startedAt") or manifest.get("updatedAt")
        if status in terminal:
            batch["completedAt"] = details.get("completedAt") or manifest.get("updatedAt")
        statuses = [item.get("status") for item in manifest.get("batches", {}).values() if isinstance(item, dict)]
        if statuses and all(item == "merged" for item in statuses):
            manifest["status"] = "succeeded"
        elif status == "needs_resolution":
            manifest["status"] = "needs_resolution"
        elif status in {"failed", "blocked"}:
            manifest["status"] = "blocked"
        save_manifest(workspace, feature, run_id, manifest)
        if retry_lease_cleared:
            append_event(
                workspace,
                feature,
                run_id,
                "lease_reclaimed",
                batchId=batch_id,
                force=True,
                reason="retry_pending",
            )
        append_event(workspace, feature, run_id, "batch_status_changed", batchId=batch_id, previous=previous, status=status)
        return manifest


def resume_run(
    workspace: Path,
    feature: str,
    run_id: str,
    workspace_refs: list[str] | None = None,
) -> dict[str, Any]:
    """Idempotently resume only batches that do not already own a result."""
    stale_recovered: list[dict[str, str]] = []
    # A Git merge may have committed successfully immediately before the Plan
    # writer failed. Recover that metadata before evaluating the normal
    # needs-resolution gate, so an interrupted workflow can resume unattended.
    initial = load_manifest(workspace, feature, run_id)
    promoted_train_batch_ids = {
        str(batch_id)
        for train in (initial.get("mergeTrains") or {}).values()
        if isinstance(train, dict)
        and (
            train.get("status") == "promoting"
            or (
                train.get("status") == "needs_resolution"
                and (
                    bool(train.get("promotedSha"))
                    or bool(train.get("planWriterErrors"))
                    or (isinstance(train.get("resolution"), dict) and train["resolution"].get("kind") == "promoted_plan_state_update")
                )
            )
        )
        for batch_id in (train.get("batchIds") or [])
        if isinstance(batch_id, str)
    }
    interrupted_recovery_errors: list[str] = []
    try:
        from hooks.task_runner import recover_interrupted_parallel_runs

        for batch_id, batch in (initial.get("batches") or {}).items():
            if not isinstance(batch, dict):
                continue
            # A sealed/candidate delivery cannot still have a legitimate
            # implementation worker.  Include train-recovery batches so an
            # old started run cannot make Plan recovery fail again.
            if str(batch_id) not in promoted_train_batch_ids and batch.get("status") not in {
                "retry_pending", "sealed", "ready_to_candidate", "needs_resolution"
            }:
                continue
            worktree_path = batch.get("worktreePath")
            if not isinstance(worktree_path, str) or not worktree_path.strip():
                continue
            recovered = recover_interrupted_parallel_runs(
                workspace,
                feature,
                run_id,
                str(batch_id),
                Path(worktree_path),
                workspace_ref=str(batch.get("workspaceRef") or batch.get("repositoryRef") or "") or None,
            )
            for item in recovered["recovered"]:
                append_event(
                    workspace,
                    feature,
                    run_id,
                    "interrupted_task_run_recovered",
                    batchId=str(batch_id),
                    **item,
                )
    except (OSError, ValueError) as exc:
        interrupted_recovery_errors.append(f"parallel_interrupted_task_run_recovery_failed:{exc}")
    if interrupted_recovery_errors:
        return {
            "runId": run_id,
            "status": "needs_resolution",
            "scheduledGroups": [],
            "mergeableBatches": mergeable_batches(load_manifest(workspace, feature, run_id)),
            "recoveryRequired": True,
            "errors": interrupted_recovery_errors,
        }
    recovery_trains = [
        (str(train.get("repositoryRef") or ""), int(train.get("wave")))
        for train in (initial.get("mergeTrains") or {}).values()
        if isinstance(train, dict)
        and isinstance(train.get("wave"), int)
        and isinstance(train.get("repositoryRef"), str)
        and (
            train.get("status") == "promoting"
            or (
                train.get("status") == "needs_resolution"
                and (
                    (isinstance(train.get("resolution"), dict) and train["resolution"].get("kind") == "promoted_plan_state_update")
                    # Compatibility for the historical record written before
                    # train-level Plan recovery had a structured resolution.
                    or bool(train.get("promotedSha"))
                    or bool(train.get("planWriterErrors"))
                )
            )
        )
    ]
    if recovery_trains:
        from hooks.parallel_merge_train import recover_promoted_plan

        recovery_errors: list[str] = []
        for repository_ref, wave in recovery_trains:
            recovered = recover_promoted_plan(
                workspace,
                feature,
                run_id,
                repository_ref=repository_ref,
                wave=wave,
            )
            if not recovered.get("success"):
                recovery_errors.append(str(recovered.get("error") or f"parallel_merge_train_plan_recovery_failed:{repository_ref}:{wave}"))
        if recovery_errors:
            return {
                "runId": run_id,
                "status": "needs_resolution",
                "scheduledGroups": [],
                "mergeableBatches": mergeable_batches(load_manifest(workspace, feature, run_id)),
                "recoveryRequired": True,
                "errors": recovery_errors,
            }
        initial = load_manifest(workspace, feature, run_id)
    recovery_batches = [
        str(batch_id)
        for batch_id, batch in initial.get("batches", {}).items()
        if isinstance(batch, dict)
        and batch.get("status") == "needs_resolution"
        and isinstance(batch.get("resolution"), dict)
        and batch["resolution"].get("kind") == "plan_state_update"
    ]
    if recovery_batches:
        from hooks.batch_merger import recover_plan_state_after_merge

        recovery_errors: list[str] = []
        for batch_id in recovery_batches:
            recovered = recover_plan_state_after_merge(workspace, feature, run_id, batch_id)
            if not recovered.get("success"):
                recovery_errors.append(str(recovered.get("error") or f"parallel_plan_recovery_failed:{batch_id}"))
        if recovery_errors:
            return {
                "runId": run_id,
                "status": "needs_resolution",
                "scheduledGroups": [],
                "mergeableBatches": mergeable_batches(load_manifest(workspace, feature, run_id)),
                "recoveryRequired": True,
                "errors": recovery_errors,
            }
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        if manifest.get("status") in {"cleaned", "rolled_back"}:
            return {"runId": run_id, "status": manifest.get("status"), "skipped": "terminal_run"}
        # Older runs (and an interrupted Workflow cleanup) can have reached
        # ``retry_pending`` before their lease handoff completed.  Repair that
        # invariant before deciding whether the preserved delivery is sealed,
        # mergeable, or ready to be scheduled again.
        retry_leases_cleared: list[str] = []
        for batch_id, batch in manifest.get("batches", {}).items():
            if not isinstance(batch, dict) or batch.get("status") != "retry_pending":
                continue
            if _clear_retry_lease_locked(workspace, feature, run_id, str(batch_id), batch):
                retry_leases_cleared.append(str(batch_id))
        # Persist lease metadata removal before running any later recovery
        # checks.  The lease file and manifest are separate atomic files, so a
        # process crash can never make their unlink/write one filesystem
        # transaction; this immediate durable boundary minimizes that window,
        # while the same loop reconciles the remaining one-sided state on the
        # next resume.
        if retry_leases_cleared:
            save_manifest(workspace, feature, run_id, manifest)
        for batch_id in retry_leases_cleared:
            append_event(
                workspace,
                feature,
                run_id,
                "lease_reclaimed",
                batchId=batch_id,
                force=True,
                reason="retry_resume_repair",
            )
        # This is deliberately scheduler-owned rather than a best-effort
        # Workflow cleanup.  If a model/worker dies before it can write its
        # own retry marker, its expired execution authority cannot keep the
        # whole run's concurrency slots occupied forever.
        stale_recovered = _recover_stale_active_batches_locked(
            workspace,
            feature,
            run_id,
            manifest,
        )
        active_stale_recovered = len(stale_recovered)
        for item in stale_recovered:
            append_event(
                workspace,
                feature,
                run_id,
                "batch_stale_lease_recovered",
                batchId=item["batchId"],
                reason=item["reason"],
            )
        invalid_deliveries: list[str] = []
        for batch_id, batch in manifest.get("batches", {}).items():
            if not isinstance(batch, dict):
                continue
            if batch.get("status") == "merged" and not (
                isinstance(batch.get("mergeCommitSha"), str) and batch["mergeCommitSha"].strip()
            ):
                delivery_error = f"parallel_batch_merge_evidence_required:{batch_id}"
                batch.update({"status": "blocked", "error": delivery_error})
                invalid_deliveries.append(delivery_error)
        invalid_deliveries.extend(_source_repository_errors(manifest))
        for batch_id, batch in manifest.get("batches", {}).items():
            if (
                isinstance(batch, dict)
                and batch.get("status") == "needs_resolution"
                and _is_global_resolution_batch(batch)
            ):
                invalid_deliveries.append(f"parallel_plan_state_recovery_required:{batch_id}")
        for train_key, train in (manifest.get("mergeTrains") or {}).items():
            if (
                isinstance(train, dict)
                and train.get("status") in {"candidate_conflicted", "needs_resolution"}
                and _is_global_resolution_train(train)
            ):
                invalid_deliveries.append(f"parallel_merge_train_plan_recovery_required:{train_key}")
        if invalid_deliveries:
            manifest["status"] = "blocked"
            save_manifest(workspace, feature, run_id, manifest)
            append_event(
                workspace,
                feature,
                run_id,
                "run_resume_blocked_integrity",
                errors=invalid_deliveries,
            )
            return {
                "runId": run_id,
                "status": "blocked",
                "scheduledGroups": [],
                "mergeableBatches": mergeable_batches(manifest),
                "recoveryRequired": True,
                "errors": invalid_deliveries,
            }
        if manifest.get("status") in {"succeeded", "succeeded_with_issues", "verifying"}:
            return {"runId": run_id, "status": manifest.get("status"), "skipped": "terminal_run"}
        # Ordinary delivery and candidate conflicts stay durable in their
        # own records.  They are intentionally not a global resume gate:
        # `schedule` filters those exact Batch IDs while independent work
        # continues.  Plan-state recovery and shared-source integrity cases
        # were handled above as genuine global blockers.
        invalid_deliveries = []
        for batch_id, batch in manifest.get("batches", {}).items():
            if not isinstance(batch, dict):
                continue
            if batch.get("mergeCommitSha"):
                batch["status"] = "merged"
                continue
            # Keep task-scoped terminal/recovery states intact.  In
            # particular, a retry-exhausted Batch with a retained commit must
            # not be silently resurrected as `sealed` on the next resume.
            # Valid active leases are also left to their actual worker.
            if batch.get("status") in {
                "retry_pending",
                "blocked",
                "failed",
                "cancelled",
                "needs_resolution",
                "conflict",
                "leased",
                "running",
            }:
                continue
            # A delivery that has already completed every stage remains a
            # Merge Train candidate across an interrupted Workflow. Validate
            # its immutable delivery before retaining that state.
            if batch.get("status") == "ready_to_candidate":
                # A candidate should have released its worker authority before
                # it becomes mergeable.  Recover a stale residual lease before
                # delivery validation so a crashed handoff cannot strand this
                # Batch outside both normal work and Merge Train recovery.
                # Check the lease file as well as the manifest metadata: an
                # interrupted prior write may have persisted only one side.
                if batch.get("lease") is not None or lease_path(workspace, feature, run_id, str(batch_id)).is_file():
                    reason = _lease_staleness_reason_locked(
                        workspace,
                        feature,
                        run_id,
                        str(batch_id),
                        batch,
                        now=time.time(),
                        timeout_seconds=max(1, int(manifest.get("timeoutPerBatch", 3600))),
                    )
                    if reason is not None:
                        _mark_retry_pending_locked(
                            workspace,
                            feature,
                            run_id,
                            manifest,
                            str(batch_id),
                            batch,
                            error=f"parallel_batch_recovery:{reason}",
                            previous_status="ready_to_candidate",
                        )
                        stale_recovered.append({"batchId": str(batch_id), "reason": reason})
                        continue
                delivery_error = _sealed_delivery_error(manifest, str(batch_id))
                if delivery_error:
                    batch.update({"status": "blocked", "error": delivery_error})
                    invalid_deliveries.append(delivery_error)
                continue
            if batch.get("commitSha"):
                delivery_error = _sealed_delivery_error(manifest, str(batch_id))
                if delivery_error:
                    batch.update({"status": "blocked", "error": delivery_error})
                    invalid_deliveries.append(delivery_error)
                else:
                    batch["status"] = "sealed"
            elif batch.get("status") == "sealed":
                # A compile result may enter sealed before `seal`.  It
                # must not be resumed as a merge candidate without a delivery
                # SHA, otherwise the workflow reports an empty successful
                # merge and leaves downstream dependencies blocked forever.
                delivery_error = f"parallel_batch_seal_required:{batch_id}"
                batch.update({"status": "blocked", "error": delivery_error})
                invalid_deliveries.append(delivery_error)
        if invalid_deliveries:
            manifest["status"] = "blocked"
            save_manifest(workspace, feature, run_id, manifest)
            append_event(
                workspace,
                feature,
                run_id,
                "run_resume_blocked_missing_delivery",
                errors=invalid_deliveries,
            )
            return {
                "runId": run_id,
                "status": "blocked",
                "scheduledGroups": [],
                "mergeableBatches": mergeable_batches(manifest),
                "recoveryRequired": True,
                "errors": invalid_deliveries,
            }
        retry_resumed: list[str] = []
        retry_exhausted: list[str] = []
        for batch_id, batch in manifest.get("batches", {}).items():
            if not isinstance(batch, dict) or batch.get("status") != "retry_pending":
                continue
            recovery = batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}
            retry_attempts = int(recovery.get("retryAttempts", 0))
            if retry_attempts >= MAX_AUTOMATIC_BATCH_RECOVERY_ATTEMPTS:
                batch["status"] = "blocked"
                batch["activeStage"] = None
                batch["recovery"] = {
                    **recovery,
                    "status": "retry_exhausted",
                    "maxAutomaticAttempts": MAX_AUTOMATIC_BATCH_RECOVERY_ATTEMPTS,
                }
                retry_exhausted.append(str(batch_id))
                continue
            implementation_resume = (
                _implementation_resume_details(manifest, str(batch_id), batch)
                if not batch.get("commitSha")
                else None
            )
            # A Merge Train retry must retain its ready-to-candidate state;
            # otherwise its completed stage evidence would be stranded.  A
            # sealed draft goes through per-Batch stage recovery, while an
            # implementation failure before any seal restarts as normal
            # pending work in the same native Worktree.
            batch["status"] = (
                "ready_to_candidate"
                if recovery.get("resumeStatus") == "ready_to_candidate"
                else "sealed"
                if batch.get("commitSha")
                else "pending"
            )
            batch["recovery"] = {
                **recovery,
                "kind": (
                    "implementation_resume"
                    if implementation_resume is not None
                    else "integration_resume"
                    if recovery.get("resumeStatus") == "ready_to_candidate"
                    else "stage_resume"
                    if batch.get("commitSha")
                    else "retry_dispatch"
                ),
                "resumeFromStage": (
                    "implement" if implementation_resume is not None
                    else recovery.get("resumeFromStage") if batch.get("commitSha")
                    else None
                ),
                "preserveWorktree": (
                    True
                    if implementation_resume is not None
                    else bool(batch.get("commitSha"))
                ),
                "reprovision": (
                    False
                    if implementation_resume is not None
                    else not bool(batch.get("commitSha"))
                ),
                **({"implementationResume": implementation_resume} if implementation_resume is not None else {}),
                "status": "rescheduled",
                "rescheduledAt": manifest.get("updatedAt"),
            }
            if implementation_resume is None:
                batch["recovery"].pop("implementationResume", None)
            retry_resumed.append(str(batch_id))
        # Persist the recovery contract for every sealed delivery that still
        # has a stage to finish.  This is intentionally distinct from a
        # `retry_dispatch`: its existing Worktree and commit are the only
        # valid execution context for Review/UTest continuation.
        for batch_id in stage_recovery_batches(manifest):
            batch = manifest["batches"].get(batch_id)
            if not isinstance(batch, dict):
                continue
            recovery = batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}
            batch["recovery"] = {
                **recovery,
                "kind": "stage_resume",
                "resumeFromStage": _next_open_delivery_stage(batch),
                "preserveWorktree": True,
                "reprovision": False,
            }
        manifest["status"] = "running"
        save_manifest(workspace, feature, run_id, manifest)
        for item in stale_recovered[active_stale_recovered:]:
            append_event(
                workspace,
                feature,
                run_id,
                "batch_stale_lease_recovered",
                batchId=item["batchId"],
                reason=item["reason"],
            )
        append_event(workspace, feature, run_id, "run_resumed")
    for batch_id in retry_resumed:
        append_event(workspace, feature, run_id, "batch_retry_rescheduled", batchId=batch_id)
    for batch_id in retry_exhausted:
        append_event(workspace, feature, run_id, "batch_retry_exhausted", batchId=batch_id)
    result = schedule(workspace, feature, run_id, workspace_refs=workspace_refs)
    result["reclaimedStaleBatches"] = stale_recovered
    result["rescheduledRetryBatches"] = retry_resumed
    result["retryExhaustedBatches"] = retry_exhausted
    return result


def manual_resume_run(
    workspace: Path,
    feature: str,
    run_id: str,
    workspace_refs: list[str] | None = None,
) -> dict[str, Any]:
    """Explicitly re-admit retryable Batches after an operator intervention.

    Automatic retries deliberately stop after a small bounded budget.  A user
    asking the Code workflow to continue is a separate admission decision, not
    another automatic retry: retain the failed Worktree and evidence, reset the
    automatic counter, then let ``resume_run`` perform its normal integrity
    checks and scheduling.  This never revives merge conflicts, cancellation,
    or generic blocked states because those need a more specific repair path.
    """
    manually_queued: list[str] = []
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        if manifest.get("status") in {"cleaned", "rolled_back"}:
            return {
                "runId": run_id,
                "status": manifest.get("status"),
                "manualRetryBatches": [],
                "skipped": "terminal_run",
            }
        for raw_batch_id, batch in manifest.get("batches", {}).items():
            if not isinstance(batch, dict):
                continue
            batch_id = str(raw_batch_id)
            recovery = batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}
            retryable = (
                batch.get("status") in {"retry_pending", "failed"}
                or (
                    batch.get("status") == "blocked"
                    and recovery.get("status") == "retry_exhausted"
                )
            )
            if not retryable:
                continue
            batch["recovery"] = {
                **recovery,
                "retryAttempts": 0,
                "manualRetryAttempts": int(recovery.get("manualRetryAttempts", 0)) + 1,
                "lastManualRetryAt": manifest.get("updatedAt"),
                "status": "manual_retry_queued",
            }
            _mark_retry_pending_locked(
                workspace,
                feature,
                run_id,
                manifest,
                batch_id,
                batch,
                error=str(batch.get("error") or recovery.get("lastError") or "operator_requested_retry"),
                previous_status=str(batch.get("status") or ""),
            )
            manually_queued.append(batch_id)
        if manually_queued:
            manifest["status"] = "running"
            save_manifest(workspace, feature, run_id, manifest)
    for batch_id in manually_queued:
        append_event(workspace, feature, run_id, "batch_manual_retry_queued", batchId=batch_id)
    result = resume_run(workspace, feature, run_id, workspace_refs=workspace_refs)
    result["manualRetryBatches"] = manually_queued
    return result


def ensure_run(
    workspace: Path,
    feature: str,
    *,
    max_parallel: int,
    timeout_seconds: int,
    code_workspaces: list[str] | None = None,
    allow_bootstrap: bool = False,
    workspace_refs: list[str] | None = None,
    task_card_id: str | None = None,
) -> dict[str, Any]:
    """Create one scheduler run or safely resume the existing durable run."""
    active_run_id = get_active_run(workspace, feature)
    if active_run_id is None:
        try:
            result = create_run(
                workspace,
                feature,
                max_parallel=max_parallel,
                timeout_seconds=timeout_seconds,
                code_workspaces=code_workspaces,
                allow_bootstrap=allow_bootstrap,
                task_card_id=task_card_id,
            )
            if workspace_refs:
                result = schedule(workspace, feature, str(result["runId"]), workspace_refs=workspace_refs)
            result["reused"] = False
            return result
        except ValueError as exc:
            # Another concurrent ensure may have created the durable run after
            # the initial active-run read. Re-read it and take the normal
            # idempotent reuse path instead of creating a second run.
            if str(exc) != "parallel_run_already_active":
                raise
            active_run_id = get_active_run(workspace, feature)
            if active_run_id is None:
                raise
    # Resume is also the scheduler-owned recovery boundary for retained
    # per-Batch conflicts.  It preserves their worktrees and excludes their
    # Batches from output, but must still release independent DAG branches.
    # `resume_run` retains the stricter global plan/source-integrity gates.
    result = resume_run(workspace, feature, active_run_id, workspace_refs=workspace_refs)
    result["reused"] = True
    return result


def _emit(ok: bool, **payload: Any) -> int:
    print(json.dumps({"ok": ok, **payload}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


_WORKFLOW_STATUS_FIELDS = (
    "runId", "status", "scheduledGroups", "readyBatches", "allReadyBatches",
    "mergeableBatches", "implementationRecoveryBatches", "stageRecoveryBatches",
    "retryPendingBatches", "blockedBatches", "parallelGroups", "allParallelGroups",
    "maxParallel", "activeWorkers", "dispatchDiagnostics", "batchTaskIds",
)
_WORKFLOW_WORKSPACE_FIELDS = (
    "workspaceRef", "componentRoots", "executionStage", "requestedPath",
    "worktreePath", "branchName",
)
_WORKFLOW_ISSUE_FIELDS = (
    "issueId", "kind", "batchId", "stage", "failureType", "message",
    "disposition", "blocksWorkflow", "status", "evidenceId", "batchCommit",
    "createdAt",
)


def _workflow_status_view(scheduled: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """Project only fields consumed by the fixed Workflow across the agent boundary."""
    batches = manifest.get("batches")
    batches = batches if isinstance(batches, dict) else {}
    trains = manifest.get("mergeTrains")
    trains = trains if isinstance(trains, dict) else {}
    issues = manifest.get("deferredIssues")
    issues = issues if isinstance(issues, list) else []
    result = {key: scheduled[key] for key in _WORKFLOW_STATUS_FIELDS if key in scheduled}
    result["dispatchDiagnostics"] = {
        "activeBatchIds": (scheduled.get("dispatchDiagnostics") or {}).get("activeBatchIds", [])
    }
    result["batchWorkspaces"] = {
        batch_id: {key: workspace.get(key) for key in _WORKFLOW_WORKSPACE_FIELDS}
        for batch_id, workspace in scheduled.get("batchWorkspaces", {}).items()
        if isinstance(workspace, dict)
    }
    result["manifest"] = {
        "batches": {
            batch_id: {
                "status": batch.get("status"),
                "dependencies": batch.get("dependencies", []),
                "error": batch.get("error"),
                "worktreePath": batch.get("worktreePath"),
                "branchName": batch.get("branchName"),
                "commitSha": batch.get("commitSha"),
                "mergeCommitSha": batch.get("mergeCommitSha"),
                "recovery": {
                    key: (batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}).get(key)
                    for key in ("status", "retryAttempts", "lastError")
                },
            }
            for batch_id, batch in batches.items()
            if isinstance(batch, dict)
        },
        "mergeTrains": {
            train_id: {
                key: train.get(key)
                for key in (
                    "status", "batchIds", "repositoryRef", "wave", "error",
                    "worktreePath", "cleanupErrors",
                )
            } | {
                "conflictContext": {
                    "conflictedFiles": (train.get("conflictContext") if isinstance(train.get("conflictContext"), dict) else {}).get("conflictedFiles")
                }
            }
            for train_id, train in trains.items()
            if isinstance(train, dict)
            and train.get("status") in {"candidate_conflicted", "needs_resolution", "failed", "stale", "built"}
        },
        "deferredIssues": [
            {key: issue[key] for key in _WORKFLOW_ISSUE_FIELDS if key in issue}
            for issue in issues
            if isinstance(issue, dict)
        ],
    }
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Schedule parallel Code batch runs")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "create", "ensure", "status", "resume", "manual-resume", "list"):
        item = subparsers.add_parser(name)
        item.add_argument("--workspace")
        item.add_argument("--feature", required=True)
        if name in {"status", "resume", "manual-resume"}:
            item.add_argument("--run-id", required=True)
        if name in {"create", "ensure"}:
            item.add_argument("--max-parallel", type=int, default=5)
            item.add_argument("--timeout-seconds", type=int, default=4 * 60 * 60)
            item.add_argument("--code-workspace", action="append", required=True, help="workspaceRef=/path; single-ref runs may pass /path")
            item.add_argument("--allow-bootstrap", action="store_true", help="explicitly allow Git initialization or a baseline commit for a dirty source repository")
            item.add_argument("--task-card-id", required=True, help="task card selected before the workflow starts")
        if name in {"status", "resume", "manual-resume", "ensure"}:
            item.add_argument("--workspace-ref", action="append", dest="workspace_refs", help="only schedule batches for these workspaceRef values")
        if name == "status":
            item.add_argument("--workflow-view", action="store_true", help="emit only fields consumed by the fixed Code Workflow")
    mark = subparsers.add_parser("mark-batch")
    mark.add_argument("--workspace")
    mark.add_argument("--feature", required=True)
    mark.add_argument("--run-id", required=True)
    mark.add_argument("--batch-id", required=True)
    mark.add_argument("--status", required=True)
    mark.add_argument("--commit-sha")
    mark.add_argument("--merge-commit-sha")
    mark.add_argument("--worktree-path")
    mark.add_argument("--branch-name")
    mark.add_argument("--error")
    args = parser.parse_args(argv)
    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
        if args.command == "validate":
            return _emit(True, **validate_plan_for_parallel(workspace, feature))
        if args.command == "create":
            return _emit(
                True,
                **create_run(
                    workspace,
                    feature,
                    max_parallel=args.max_parallel,
                    timeout_seconds=args.timeout_seconds,
                    code_workspaces=args.code_workspace,
                    allow_bootstrap=args.allow_bootstrap,
                    task_card_id=args.task_card_id,
                ),
            )
        if args.command == "ensure":
            return _emit(
                True,
                **ensure_run(
                    workspace,
                    feature,
                    max_parallel=args.max_parallel,
                    timeout_seconds=args.timeout_seconds,
                    code_workspaces=args.code_workspace,
                    allow_bootstrap=args.allow_bootstrap,
                    workspace_refs=args.workspace_refs,
                    task_card_id=args.task_card_id,
                ),
            )
        if args.command == "status":
            if args.workflow_view:
                return _emit(True, **schedule(workspace, feature, args.run_id, workspace_refs=args.workspace_refs, workflow_view=True))
            return _emit(True, manifest=load_manifest(workspace, feature, args.run_id), **schedule(workspace, feature, args.run_id, workspace_refs=args.workspace_refs))
        if args.command == "resume":
            return _emit(True, **resume_run(workspace, feature, args.run_id, workspace_refs=args.workspace_refs))
        if args.command == "manual-resume":
            return _emit(True, **manual_resume_run(workspace, feature, args.run_id, workspace_refs=args.workspace_refs))
        if args.command == "list":
            return _emit(True, runs=list_runs(workspace, feature))
        details = {key: value for key, value in vars(args).items() if key in {"commit_sha", "merge_commit_sha", "worktree_path", "branch_name", "error"} and value is not None}
        detail_names = {
            "commit_sha": "commitSha",
            "merge_commit_sha": "mergeCommitSha",
            "worktree_path": "worktreePath",
            "branch_name": "branchName",
            "error": "error",
        }
        details = {detail_names[key]: value for key, value in details.items()}
        return _emit(True, manifest=mark_batch(workspace, feature, args.run_id, args.batch_id, args.status, **details))
    except (ValueError, OSError) as exc:
        return _emit(False, error=str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
