#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Lifecycle operations for plugin-owned native Git worktrees.

The workflow host may be an artifact directory or another repository.  The
plugin therefore creates a real linked Git worktree from each repository
binding and records its path in the scheduler manifest.  Agents only receive
that explicit path; all delivery and cleanup remains deterministic here.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.parallel_runtime import append_event, global_worktrees_root, lease_path, load_manifest, renew_lease, run_dir, run_lock, save_manifest
from hooks.commit_message import CommitMessageError, build_commit_message, normalize_task_card_id
from hooks.plan_write_ownership import is_test_asset_path
from hooks.repository_snapshot import (
    PLATFORM_RUNTIME_DIRECTORY,
    RepositorySnapshotError,
    current_git_branch,
    resolve_git_root,
    working_tree_changed_files,
)


GIT_INDEX_LOCK_RETRY_ATTEMPTS = 4
GIT_INDEX_LOCK_RETRY_DELAY_SECONDS = 3
_GIT_INDEX_LOCK_ERROR_RE = re.compile(
    r"(?:unable to create .*index\.lock.*(?:file exists|exists)|index\.lock.*(?:file exists|exists))",
    re.IGNORECASE,
)


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _git_index_lock_path(worktree: Path) -> Path | None:
    """Resolve this linked worktree's own index lock without mutating Git state."""

    result = _git(worktree, "rev-parse", "--git-path", "index.lock")
    if result.returncode != 0 or not result.stdout.strip():
        return None
    candidate = Path(result.stdout.strip())
    return candidate if candidate.is_absolute() else (worktree / candidate).resolve()


def _git_index_lock_error(result: subprocess.CompletedProcess[str]) -> bool:
    return result.returncode != 0 and bool(
        _GIT_INDEX_LOCK_ERROR_RE.search(f"{result.stderr}\n{result.stdout}")
    )


def _git_index_lock_failure(
    worktree: Path,
    *,
    operation: str,
    result: subprocess.CompletedProcess[str],
    attempts: int,
    forced_cleanup_attempted: bool = False,
) -> dict[str, Any]:
    lock_path = _git_index_lock_path(worktree)
    return {
        "success": False,
        "error": "parallel_git_index_lock_busy",
        "retryable": True,
        "retryAfterSeconds": GIT_INDEX_LOCK_RETRY_DELAY_SECONDS,
        "retryAttempts": attempts,
        "forcedCleanupAttempted": forced_cleanup_attempted,
        "gitOperation": operation,
        "lockPath": str(lock_path) if lock_path is not None else None,
        "lockExists": bool(lock_path and lock_path.exists()),
        "gitError": result.stderr.strip() or result.stdout.strip(),
    }


def _git_with_index_lock_retry(
    worktree: Path,
    *args: str,
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any] | None, dict[str, Any] | None]:
    """Wait for, then recover, this Batch worktree's stale Git index lock.

    Linked worktrees have distinct indexes, so a lock here belongs to this
    specific Batch checkout.  The fixed Workflow assigns exactly one writer
    agent to it.  A lock that survives the bounded grace period is therefore
    stale state from an interrupted Git command and can be removed before a
    final retry of the original operation.
    """

    operation = "git " + " ".join(args)
    result: subprocess.CompletedProcess[str] | None = None
    for attempt in range(1, GIT_INDEX_LOCK_RETRY_ATTEMPTS + 1):
        result = _git(worktree, *args)
        if not _git_index_lock_error(result):
            return result, None, None
        if attempt < GIT_INDEX_LOCK_RETRY_ATTEMPTS:
            time.sleep(GIT_INDEX_LOCK_RETRY_DELAY_SECONDS)
    assert result is not None
    lock_path = _git_index_lock_path(worktree)
    if lock_path is None or not lock_path.is_file():
        return result, _git_index_lock_failure(
            worktree,
            operation=operation,
            result=result,
            attempts=GIT_INDEX_LOCK_RETRY_ATTEMPTS,
        ), None
    try:
        lock_path.unlink()
    except OSError as exc:
        failure = _git_index_lock_failure(
            worktree,
            operation=operation,
            result=result,
            attempts=GIT_INDEX_LOCK_RETRY_ATTEMPTS,
            forced_cleanup_attempted=True,
        )
        failure.update({
            "error": "parallel_git_index_lock_recovery_failed",
            "recoveryError": str(exc),
        })
        return result, failure, None

    recovery = {
        "lockPath": str(lock_path),
        "waitedSeconds": (GIT_INDEX_LOCK_RETRY_ATTEMPTS - 1) * GIT_INDEX_LOCK_RETRY_DELAY_SECONDS,
        "retryAttempts": GIT_INDEX_LOCK_RETRY_ATTEMPTS,
        "gitOperation": operation,
        "action": "removed_stale_index_lock_and_retried",
    }
    result = _git(worktree, *args)
    if not _git_index_lock_error(result):
        return result, None, recovery
    failure = _git_index_lock_failure(
        worktree,
        operation=operation,
        result=result,
        attempts=GIT_INDEX_LOCK_RETRY_ATTEMPTS + 1,
        forced_cleanup_attempted=True,
    )
    failure["indexLockRecovery"] = recovery
    return result, failure, recovery


def _branch_component(value: str) -> str:
    component = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return component or "workspace"


def _native_worktree_path(
    artifact_workspace: Path,
    feature: str,
    run_id: str,
    repository_ref: str,
    batch_id: str,
) -> Path:
    # Batch IDs are globally unique inside a Run.  Keeping paths outside the
    # Feature's run journal makes the physical worktree identity obvious and
    # keeps a new ``cw-*`` run independent from unfinished cleanup of another.
    _ = feature, repository_ref
    return (global_worktrees_root(artifact_workspace) / _branch_component(run_id) / _branch_component(batch_id)).resolve()


def _can_reclaim_orphaned_branch(
    manifest: dict[str, Any],
    batch_id: str,
    git_root: Path,
    branch_name: str,
    expected_head: str,
) -> bool:
    """Return whether an interrupted ``worktree add -b`` left a safe-to-delete branch.

    Git can create the branch before checkout creation completes.  Reclaiming
    is safe only when no registered worktree checks out the branch, no other
    manifest Batch owns it, and it still points at this Run's frozen base.
    """
    branch_head = _git(git_root, "rev-parse", "--verify", branch_name)
    if branch_head.returncode != 0 or branch_head.stdout.strip() != expected_head:
        return False
    for other_batch_id, other_batch in (manifest.get("batches") or {}).items():
        if (
            str(other_batch_id) != batch_id
            and isinstance(other_batch, dict)
            and str(other_batch.get("branchName") or "") == branch_name
        ):
            return False
    listed = _git(git_root, "worktree", "list", "--porcelain")
    if listed.returncode != 0:
        return False
    return f"branch refs/heads/{branch_name}" not in listed.stdout.splitlines()


def _worktree_git_dir(worktree: Path) -> Path | None:
    """Return the linked worktree metadata directory without changing Git state."""

    result = _git(worktree, "rev-parse", "--git-dir")
    raw = result.stdout.strip()
    if result.returncode != 0 or not raw:
        return None
    path = Path(raw)
    return path.resolve() if path.is_absolute() else (worktree / path).resolve()


def _worktree_readiness(worktree: Path, expected_head: str) -> dict[str, Any]:
    """Validate that a linked worktree finished checkout and matches its base.

    ``git worktree add`` first registers metadata and creates a branch, then
    populates the per-worktree index and checkout.  A host timeout can leave
    the first two steps durable while the latter steps never complete.  Those
    remnants must never be adopted as a usable Batch worktree.
    """

    issues: list[str] = []
    details: dict[str, Any] = {"expectedHead": expected_head}
    head = _git(worktree, "rev-parse", "--verify", "HEAD")
    actual_head = head.stdout.strip() if head.returncode == 0 else None
    details["actualHead"] = actual_head
    if actual_head is None:
        issues.append("head_unavailable")
    elif actual_head != expected_head:
        issues.append("head_mismatch")

    git_dir = _worktree_git_dir(worktree)
    details["gitDir"] = str(git_dir) if git_dir is not None else None
    if git_dir is None:
        issues.append("git_dir_unavailable")
    else:
        index = git_dir / "index"
        index_lock = git_dir / "index.lock"
        initializing_lock = git_dir / "locked"
        lock_reason = None
        if initializing_lock.is_file():
            try:
                lock_reason = initializing_lock.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                lock_reason = "unreadable"
        details.update({
            "indexPath": str(index),
            "indexPresent": index.is_file() and index.stat().st_size > 0,
            "indexLockPresent": index_lock.exists(),
            "initializingLockPresent": initializing_lock.exists(),
            "worktreeLockReason": lock_reason,
        })
        if not details["indexPresent"]:
            issues.append("index_missing")
        if details["indexLockPresent"]:
            issues.append("index_lock_present")
        if details["initializingLockPresent"]:
            issues.append(
                "worktree_initializing_locked"
                if lock_reason == "initializing"
                else "worktree_locked"
            )

    try:
        changed = working_tree_changed_files(worktree)
    except RepositorySnapshotError:
        issues.append("working_tree_unavailable")
        changed = []
    details["changedFileCount"] = len(changed)
    details["changedFileSample"] = changed[:20]
    if changed:
        issues.append("working_tree_dirty")
    details["issues"] = issues
    details["ready"] = not issues
    return details


def _is_recoverable_incomplete_worktree(readiness: dict[str, Any]) -> bool:
    """Return whether a failed readiness check is a pre-checkout remnant.

    A regular dirty worktree can contain an agent's in-flight source changes
    and is intentionally *not* recoverable by deleting it.  Missing index or
    Git's own initialization locks only occur before a worker can safely own
    the checkout, so they can be removed under the plugin's run lock.
    """

    issues = readiness.get("issues")
    if not isinstance(issues, list):
        return False
    return bool({"index_missing", "worktree_initializing_locked"} & set(issues))


def _is_recoverable_stale_base(
    batch: dict[str, Any],
    worktree: Path,
    expected_path: Path,
    readiness: dict[str, Any],
) -> bool:
    """Recreate an idle Batch checkout whose HEAD no longer matches the run."""
    issues = readiness.get("issues")
    actual_head = readiness.get("actualHead")
    expected_head = readiness.get("expectedHead")
    if (
        worktree != expected_path
        or not isinstance(issues, list)
        or "head_mismatch" not in issues
        or set(issues) - {"head_mismatch", "working_tree_dirty"}
        or batch.get("status") not in {"pending", "retry_pending"}
        or batch.get("lease") is not None
        or batch.get("commitSha")
        or not isinstance(actual_head, str)
        or not isinstance(expected_head, str)
    ):
        return False
    return True


def _is_recoverable_retry_checkout(
    batch: dict[str, Any],
    worktree: Path,
    expected_path: Path,
    readiness: dict[str, Any],
) -> bool:
    """Replace a retry's unusable checkout only after its exact ownership is verified.

    Fresh provision has no retry marker and keeps its existing behavior.  A
    valid dirty checkout should already have been selected for in-place
    implementation recovery; a retry_dispatch marker means that verification
    failed and the old contents must be archived before a new provision.
    """
    recovery = batch.get("recovery") if isinstance(batch.get("recovery"), dict) else {}
    issues = readiness.get("issues")
    return bool(
        recovery.get("kind") == "retry_dispatch"
        and worktree == expected_path
        and isinstance(issues, list)
        and issues
        and not set(issues) - {"head_mismatch", "working_tree_dirty"}
        and batch.get("status") in {"pending", "retry_pending"}
        and batch.get("lease") is None
        and not batch.get("commitSha")
        and isinstance(readiness.get("actualHead"), str)
        and isinstance(readiness.get("expectedHead"), str)
    )


def _archive_stale_worktree_state(
    artifact_workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    git_root: Path,
    worktree: Path,
    readiness: dict[str, Any],
) -> str:
    """Preserve old HEAD and Git-visible changes before replacing a checkout."""
    commands = (
        ("diff", "--name-only", "-z", "--no-renames", "HEAD"),
        ("diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"),
        ("diff", "--name-only", "-z", "--no-renames"),
        ("ls-files", "--others", "--exclude-standard", "-z"),
    )
    changed: set[str] = set()
    for args in commands:
        result = subprocess.run(["git", *args], cwd=worktree, capture_output=True)
        if result.returncode != 0:
            raise ValueError("parallel_worktree_recovery_archive_scan_failed:" + os.fsdecode(result.stderr))
        changed.update(os.fsdecode(raw) for raw in result.stdout.split(b"\0") if raw)
    if "working_tree_dirty" in readiness.get("issues", []) and not changed:
        raise ValueError("parallel_worktree_recovery_archive_empty")
    patches: dict[str, bytes] = {}
    for name, args in (
        ("tracked.patch", ("diff", "--binary", "--no-ext-diff", "HEAD")),
        ("staged.patch", ("diff", "--binary", "--no-ext-diff", "--cached", "HEAD")),
        ("unstaged.patch", ("diff", "--binary", "--no-ext-diff")),
    ):
        diff = subprocess.run(["git", *args], cwd=worktree, capture_output=True)
        if diff.returncode != 0:
            raise ValueError("parallel_worktree_recovery_archive_diff_failed:" + os.fsdecode(diff.stderr))
        patches[name] = diff.stdout

    archive_id = uuid.uuid4().hex
    archive = run_dir(artifact_workspace, feature, run_id) / "recovery-worktrees" / f"{batch_id}-{archive_id}"
    files_root = archive / "files"
    saved: list[str] = []
    deleted: list[str] = []
    for raw in sorted(changed):
        relative = Path(raw)
        if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
            raise ValueError("parallel_worktree_recovery_archive_path_invalid:" + raw)
        source = worktree / relative
        if not source.exists() and not source.is_symlink():
            deleted.append(raw)
            continue
        destination = files_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir() and not source.is_symlink():
            shutil.copytree(source, destination, symlinks=True)
        else:
            shutil.copy2(source, destination, follow_symlinks=False)
        saved.append(raw)
    archive.mkdir(parents=True, exist_ok=True)
    for name, data in patches.items():
        (archive / name).write_bytes(data)
    recovery_ref = (
        f"refs/autodev/recovery/{_branch_component(run_id)}/"
        f"{_branch_component(batch_id)}/{archive_id}"
    )
    saved_head = _git(git_root, "update-ref", recovery_ref, str(readiness["actualHead"]))
    if saved_head.returncode != 0:
        raise ValueError("parallel_worktree_recovery_ref_failed:" + saved_head.stderr.strip())
    (archive / "recovery.json").write_text(json.dumps({
        "runId": run_id,
        "batchId": batch_id,
        "originalWorktree": str(worktree),
        "oldHead": readiness.get("actualHead"),
        "expectedHead": readiness.get("expectedHead"),
        "recoveryRef": recovery_ref,
        "savedPaths": saved,
        "deletedPaths": deleted,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return str(archive)


def _discard_incomplete_worktree(
    git_root: Path,
    worktree: Path,
    branch_name: str,
) -> dict[str, Any]:
    """Remove an exact plugin-owned incomplete worktree through Git.

    ``locked=initializing`` is Git's interrupted-creation marker.  Unlock it
    through Git rather than deleting metadata by hand, then force-remove only
    this already verified Batch checkout and its temporary branch.
    """

    unlock = _git(git_root, "worktree", "unlock", str(worktree))
    # ``unlock`` returns non-zero when no lock exists, which is harmless.
    removed = _git(git_root, "worktree", "remove", "--force", str(worktree))
    if removed.returncode != 0:
        return {
            "success": False,
            "error": "parallel_worktree_incomplete_remove_failed:" + (removed.stderr.strip() or removed.stdout.strip()),
            "unlockError": unlock.stderr.strip() or unlock.stdout.strip() or None,
        }
    pruned = _git(git_root, "worktree", "prune")
    if pruned.returncode != 0:
        return {
            "success": False,
            "error": "parallel_worktree_incomplete_prune_failed:" + (pruned.stderr.strip() or pruned.stdout.strip()),
        }
    branch_removed = False
    if branch_name:
        exists = _git(git_root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}")
        if exists.returncode == 0:
            deleted = _git(git_root, "branch", "-D", branch_name)
            if deleted.returncode != 0:
                return {
                    "success": False,
                    "error": "parallel_worktree_incomplete_branch_remove_failed:" + (deleted.stderr.strip() or deleted.stdout.strip()),
                }
            branch_removed = True
    return {
        "success": True,
        "worktreePath": str(worktree),
        "branchName": branch_name,
        "branchRemoved": branch_removed,
    }


def provision_parallel_worktree(
    artifact_workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
) -> dict[str, Any]:
    """Create or reuse the native Git worktree assigned to one Batch.

    Provisioning is idempotent for a live Batch.  If an interruption occurs
    after ``git worktree add`` but before the manifest is saved, the expected
    worktree is safely rebound only after Git metadata and branch checks prove
    it belongs to this Batch.  Other stale paths and branches are rejected
    rather than overwritten.
    """
    with run_lock(artifact_workspace, feature, run_id):
        try:
            manifest, batch, repository_ref, git_root = _parallel_binding(
                artifact_workspace, feature, run_id, batch_id
            )
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        status = str(batch.get("status") or "pending")
        if status in {"merged", "succeeded", "cancelled"}:
            return {"success": False, "error": f"parallel_batch_not_provisionable:{batch_id}:{status}"}

        head = str(
            (manifest.get("repositories", {}).get(repository_ref, {}) or {}).get("headSha")
            or (manifest.get("repositories", {}).get(repository_ref, {}) or {}).get("baseSha")
            or ""
        )
        if not head or _git(git_root, "rev-parse", "--verify", head).returncode != 0:
            return {"success": False, "error": f"parallel_repository_head_unavailable:{repository_ref}"}
        branch_name = "autodev/{}/{}/{}".format(
            _branch_component(feature), _branch_component(run_id), _branch_component(batch_id)
        )
        target = _native_worktree_path(artifact_workspace, feature, run_id, repository_ref, batch_id)
        lease_held = batch.get("lease") is not None or lease_path(
            artifact_workspace, feature, run_id, batch_id
        ).is_file()
        recovered_incomplete = False
        recovery_archive_path: str | None = None

        raw_path = batch.get("worktreePath")
        if isinstance(raw_path, str) and raw_path.strip():
            existing = Path(raw_path).expanduser().resolve()
            try:
                from hooks.parallel_batch_scheduler import assert_batch_worktree_isolated

                assert_batch_worktree_isolated(manifest, batch_id, existing)
                expected = str(batch.get("branchName") or "")
                if current_git_branch(existing) == expected:
                    readiness = _worktree_readiness(existing, head)
                    if readiness["ready"]:
                        return {
                            "success": True,
                            "batchId": batch_id,
                            "repositoryRef": repository_ref,
                            "worktreePath": str(existing),
                            "branchName": expected,
                            "reused": True,
                        }
                    recoverable_stale_base = (
                        expected == branch_name
                        and _is_recoverable_stale_base(batch, existing, target, readiness)
                    )
                    recoverable_retry = (
                        expected == branch_name
                        and _is_recoverable_retry_checkout(batch, existing, target, readiness)
                    )
                    if lease_held or not (
                        _is_recoverable_incomplete_worktree(readiness)
                        or recoverable_stale_base or recoverable_retry
                    ):
                        return {
                            "success": False,
                            "error": f"parallel_worktree_incomplete:{batch_id}",
                            "readiness": readiness,
                        }
                    if recoverable_stale_base or recoverable_retry:
                        try:
                            recovery_archive_path = _archive_stale_worktree_state(
                                artifact_workspace, feature, run_id, batch_id, git_root, existing, readiness
                            )
                            batch["recoveryArchivePath"] = recovery_archive_path
                        except (OSError, ValueError) as exc:
                            return {
                                "success": False,
                                "error": f"parallel_worktree_recovery_archive_failed:{batch_id}:{exc}",
                                "readiness": readiness,
                            }
                    discarded = _discard_incomplete_worktree(git_root, existing, expected)
                    if not discarded["success"]:
                        return {
                            "success": False,
                            "error": discarded["error"],
                            "readiness": readiness,
                        }
                    batch["worktreePath"] = None
                    batch["branchName"] = None
                    batch.pop("worktreeOwner", None)
                    recovered_incomplete = True
                else:
                    return {"success": False, "error": f"parallel_worktree_stale:{batch_id}"}
            except (ValueError, OSError):
                pass
        if target.exists():
            candidate = target
            # ``git worktree add`` and ``save_manifest`` are separate durable
            # operations.  A timeout or process termination between them
            # leaves a valid linked worktree with no manifest binding.  Never
            # overwrite an occupied directory: adopt it only when Git proves
            # it is precisely the checkout that this Batch would create.
            try:
                from hooks.parallel_batch_scheduler import assert_batch_worktree_isolated

                assert_batch_worktree_isolated(manifest, batch_id, candidate)
                if resolve_git_root(candidate) != candidate:
                    raise ValueError("not_worktree_root")
                if current_git_branch(candidate) != branch_name:
                    raise ValueError("unexpected_branch")
            except (ValueError, OSError):
                return {"success": False, "error": f"parallel_worktree_path_occupied:{candidate}"}
            readiness = _worktree_readiness(candidate, head)
            recoverable_stale_base = _is_recoverable_stale_base(batch, candidate, target, readiness)
            recoverable_retry = _is_recoverable_retry_checkout(batch, candidate, target, readiness)
            if readiness["ready"]:
                batch.update({
                    "worktreePath": str(candidate),
                    "branchName": branch_name,
                    "worktreeOwner": "plugin",
                })
                save_manifest(artifact_workspace, feature, run_id, manifest)
                reconciled = True
            elif not lease_held and (
                _is_recoverable_incomplete_worktree(readiness)
                or recoverable_stale_base or recoverable_retry
            ):
                if recoverable_stale_base or recoverable_retry:
                    try:
                        recovery_archive_path = _archive_stale_worktree_state(
                            artifact_workspace, feature, run_id, batch_id, git_root, candidate, readiness
                        )
                        batch["recoveryArchivePath"] = recovery_archive_path
                    except (OSError, ValueError) as exc:
                        return {
                            "success": False,
                            "error": f"parallel_worktree_recovery_archive_failed:{batch_id}:{exc}",
                            "readiness": readiness,
                        }
                discarded = _discard_incomplete_worktree(git_root, candidate, branch_name)
                if not discarded["success"]:
                    return {
                        "success": False,
                        "error": discarded["error"],
                        "readiness": readiness,
                    }
                recovered_incomplete = True
                reconciled = False
            else:
                return {
                    "success": False,
                    "error": f"parallel_worktree_incomplete:{batch_id}",
                    "readiness": readiness,
                }
        else:
            reconciled = False
        reclaimed_orphaned_branch = False
        if not reconciled and _git(git_root, "show-ref", "--verify", f"refs/heads/{branch_name}").returncode == 0:
            if not _can_reclaim_orphaned_branch(manifest, batch_id, git_root, branch_name, head):
                return {"success": False, "error": f"parallel_worktree_branch_occupied:{branch_name}"}
            removed = _git(git_root, "branch", "-D", branch_name)
            if removed.returncode != 0:
                return {"success": False, "error": f"parallel_worktree_orphaned_branch_reclaim_failed:{removed.stderr.strip()}"}
            reclaimed_orphaned_branch = True
        if not reconciled:
            target.parent.mkdir(parents=True, exist_ok=True)
            created = _git(git_root, "worktree", "add", "-b", branch_name, str(target), head)
            if created.returncode != 0:
                return {"success": False, "error": f"parallel_worktree_create_failed:{created.stderr.strip()}"}
            readiness = _worktree_readiness(target, head)
            if not readiness["ready"]:
                discarded = _discard_incomplete_worktree(git_root, target, branch_name)
                return {
                    "success": False,
                    "error": (
                        f"parallel_worktree_create_incomplete:{batch_id}"
                        if discarded["success"]
                        else discarded["error"]
                    ),
                    "readiness": readiness,
                }
            batch.update({
                "worktreePath": str(target),
                "branchName": branch_name,
                "worktreeOwner": "plugin",
            })
            save_manifest(artifact_workspace, feature, run_id, manifest)
    append_event(
        artifact_workspace,
        feature,
        run_id,
        "worktree_reconciled" if reconciled else "worktree_provisioned",
        batchId=batch_id,
        repositoryRef=repository_ref,
        path=str(candidate) if reconciled else str(target),
        branch=branch_name,
        owner="plugin",
        reclaimedOrphanedBranch=reclaimed_orphaned_branch,
        recoveredIncomplete=recovered_incomplete,
        recoveryArchivePath=recovery_archive_path,
    )
    return {
        "success": True,
        "batchId": batch_id,
        "repositoryRef": repository_ref,
        "worktreePath": str(candidate) if reconciled else str(target),
        "branchName": branch_name,
        "reused": reconciled,
        "recoveredIncomplete": recovered_incomplete,
    }


def _parallel_binding(
    artifact_workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
) -> tuple[dict[str, Any], dict[str, Any], str, Path]:
    manifest = load_manifest(artifact_workspace, feature, run_id)
    batch = manifest.get("batches", {}).get(batch_id)
    if not isinstance(batch, dict):
        raise ValueError(f"parallel_batch_not_found:{batch_id}")
    repository_ref = str(batch.get("repositoryRef") or batch.get("workspaceRef") or "")
    repository = manifest.get("repositories", {}).get(repository_ref)
    if not isinstance(repository, dict) or not isinstance(repository.get("gitRoot"), str):
        raise ValueError(f"parallel_repository_binding_missing:{repository_ref}")
    return manifest, batch, repository_ref, Path(repository["gitRoot"]).resolve()


def _unstage_platform_runtime(worktree: Path) -> dict[str, Any] | None:
    """Keep platform workflow journals out of the delivery commit.

    Dynamic Workflow writes its own state under ``.cmbdevclaw`` while the
    Batch agent runs.  A previous command may already have staged that state,
    so an exclude pathspec on ``git add`` alone is insufficient.
    """
    staged, lock_failure, _ = _git_with_index_lock_retry(
        worktree,
        "diff",
        "--cached",
        "--name-only",
        "--",
        PLATFORM_RUNTIME_DIRECTORY,
    )
    if lock_failure is not None:
        return lock_failure
    if staged.returncode != 0:
        return {"success": False, "error": f"parallel_batch_staged_runtime_check_failed:{staged.stderr.strip()}"}
    paths = [line.strip() for line in staged.stdout.splitlines() if line.strip()]
    if not paths:
        return None
    reset, lock_failure, _ = _git_with_index_lock_retry(worktree, "reset", "--", *paths)
    if lock_failure is not None:
        return lock_failure
    if reset.returncode != 0:
        return {"success": False, "error": f"parallel_batch_unstage_runtime_failed:{reset.stderr.strip()}"}
    return None


def seal_parallel_batch(
    artifact_workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    repo_path: Path | None,
    owner_token: str,
    *,
    purpose: str = "implementation",
) -> dict[str, Any]:
    """Commit a Batch worktree for Review or after UTest changes."""
    if purpose not in {"review", "implementation"}:
        return {"success": False, "error": f"parallel_batch_seal_purpose_invalid:{purpose}"}
    try:
        renew_lease(artifact_workspace, feature, run_id, batch_id, owner_token)
    except ValueError:
        return {"success": False, "error": f"parallel_batch_lease_invalid:{batch_id}"}
    with run_lock(artifact_workspace, feature, run_id):
        index_lock_recoveries: list[dict[str, Any]] = []
        try:
            manifest, batch, repository_ref, git_root = _parallel_binding(artifact_workspace, feature, run_id, batch_id)
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        try:
            task_card_id = normalize_task_card_id(manifest.get("taskCardId"))
        except CommitMessageError as exc:
            return {"success": False, "error": str(exc)}
        review_draft = purpose == "review"
        ready_for_review = batch.get("status") in {"running", "leased", "sealed"}
        ready_for_delivery = batch.get("status") in {"sealed", "leased"}
        if not (ready_for_review if review_draft else ready_for_delivery):
            return {"success": False, "error": f"parallel_batch_not_ready_to_seal:{batch_id}"}
        raw_worktree = batch.get("worktreePath")
        if not isinstance(raw_worktree, str) or not raw_worktree.strip():
            return {"success": False, "error": f"parallel_worktree_missing:{batch_id}"}
        worktree = Path(raw_worktree).resolve()
        try:
            # ``git rev-parse --show-toplevel`` returns the linked worktree,
            # not the primary checkout.  Compare the request to the stored
            # worktree first; assert_batch_worktree_isolated below verifies it
            # belongs to the primary repository's Git worktree registry.
            if repo_path is not None and resolve_git_root(repo_path) != worktree:
                return {"success": False, "error": f"parallel_repository_binding_mismatch:{repository_ref}"}
        except RepositorySnapshotError as exc:
            return {"success": False, "error": f"parallel_repository_binding_mismatch:{repository_ref}:{exc}"}
        try:
            # Keep the isolation rule in one place.  It validates Git's live
            # worktree registry rather than a plugin-owned filesystem layout.
            from hooks.parallel_batch_scheduler import assert_batch_worktree_isolated

            assert_batch_worktree_isolated(manifest, batch_id, worktree)
        except ValueError:
            return {"success": False, "error": f"parallel_worktree_invalid:{batch_id}"}
        if current_git_branch(worktree) != batch.get("branchName"):
            return {"success": False, "error": f"parallel_worktree_branch_mismatch:{batch_id}"}
        runtime_error = _unstage_platform_runtime(worktree)
        if runtime_error:
            return runtime_error
        status, lock_failure, lock_recovery = _git_with_index_lock_retry(
            worktree,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            ".",
            f":(exclude){PLATFORM_RUNTIME_DIRECTORY}**",
        )
        if lock_failure is not None:
            return lock_failure
        if lock_recovery is not None:
            index_lock_recoveries.append(lock_recovery)
        if status.returncode != 0:
            return {"success": False, "error": f"parallel_worktree_status_failed:{status.stderr.strip()}"}
        changed = [line[3:] for line in status.stdout.splitlines() if len(line) > 3]
        stage_states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
        is_utest_reseal = (
            isinstance(stage_states.get("test"), dict)
            and stage_states["test"].get("status") == "running"
            and isinstance(stage_states.get("review"), dict)
            and stage_states["review"].get("status") == "passed"
        )
        if is_utest_reseal:
            non_test_changes = [path for path in changed if not is_test_asset_path(path)]
            if non_test_changes:
                return {
                    "success": False,
                    "error": "parallel_utest_production_change_forbidden",
                    "files": non_test_changes,
                }
        forbidden = [path for path in changed if path.startswith((".autobizdevops/", ".parallel-runs/"))]
        if forbidden:
            return {"success": False, "error": "parallel_batch_artifact_changes_forbidden", "files": forbidden}
        if changed:
            staged, lock_failure, lock_recovery = _git_with_index_lock_retry(
                worktree,
                "add",
                "-A",
                "--",
                ".",
                f":(exclude){PLATFORM_RUNTIME_DIRECTORY}**",
            )
            if lock_failure is not None:
                return lock_failure
            if lock_recovery is not None:
                index_lock_recoveries.append(lock_recovery)
            if staged.returncode != 0:
                return {"success": False, "error": f"parallel_batch_stage_failed:{staged.stderr.strip()}"}
            committed, lock_failure, lock_recovery = _git_with_index_lock_retry(
                worktree,
                "commit",
                "-m",
                build_commit_message(task_card_id, f"实现 {feature} {batch_id}"),
                "--",
                ".",
                f":(exclude){PLATFORM_RUNTIME_DIRECTORY}**",
            )
            if lock_failure is not None:
                return lock_failure
            if lock_recovery is not None:
                index_lock_recoveries.append(lock_recovery)
            if committed.returncode != 0:
                return {"success": False, "error": f"parallel_batch_commit_failed:{committed.stderr.strip()}"}
        sha = _git(worktree, "rev-parse", "HEAD")
        if sha.returncode != 0 or not sha.stdout.strip():
            return {"success": False, "error": "parallel_batch_commit_sha_unavailable"}
        previous_commit_sha = batch.get("commitSha")
        batch["status"] = "sealed"
        batch["commitSha"] = sha.stdout.strip()
        seal_purpose = "review" if review_draft else "utest" if is_utest_reseal else "implementation"
        batch["lastSeal"] = {
            "commitSha": sha.stdout.strip(),
            "previousCommitSha": previous_commit_sha if isinstance(previous_commit_sha, str) and previous_commit_sha else None,
            "changedFiles": list(changed),
            "purpose": seal_purpose,
            "indexLockRecoveries": index_lock_recoveries,
        }
        save_manifest(artifact_workspace, feature, run_id, manifest)
    append_event(artifact_workspace, feature, run_id, "batch_sealed", batchId=batch_id, commitSha=sha.stdout.strip(), changedFiles=changed)
    return {
        "success": True,
        "batchId": batch_id,
        "commitSha": sha.stdout.strip(),
        "previousCommitSha": previous_commit_sha if isinstance(previous_commit_sha, str) and previous_commit_sha else None,
        "changedFiles": changed,
        "purpose": seal_purpose,
        "indexLockRecoveries": index_lock_recoveries,
    }


def remove_parallel_worktree(
    artifact_workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    *,
    force: bool = False,
) -> dict[str, Any]:
    """Remove a plugin-owned native Worktree after delivery or failure."""
    with run_lock(artifact_workspace, feature, run_id):
        try:
            manifest, batch, repository_ref, git_root = _parallel_binding(artifact_workspace, feature, run_id, batch_id)
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        raw_path = batch.get("worktreePath")
        worktree = (
            Path(raw_path).expanduser().resolve()
            if isinstance(raw_path, str) and raw_path.strip()
            else None
        )
        isolation = manifest.get("isolation") if isinstance(manifest.get("isolation"), dict) else {}
        if isolation.get("mode") != "native_git_worktrees":
            return {"success": False, "error": f"parallel_worktree_cleanup_owner_unknown:{batch_id}"}
        branch = str(batch.get("branchName") or "")

        # A damaged manifest can have lost ``branchName`` while its linked
        # checkout still exists. Resolve it before removal so the temporary
        # branch is not orphaned. A missing path plus a missing branch is
        # already clean and remains a harmless idempotent call.
        if not branch and worktree is not None and worktree.exists():
            current = _git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
            if current.returncode == 0:
                branch = current.stdout.strip()
        if worktree is None and not branch:
            return {"success": True, "worktreePath": None, "branchName": None, "error": None}

    removed = False
    if worktree is not None and worktree.exists():
        args = ["worktree", "remove"]
        if force:
            args.append("--force")
        args.append(str(worktree))
        result = _git(git_root, *args)
        if result.returncode != 0:
            return {"success": False, "error": f"parallel_worktree_remove_failed:{result.stderr.strip()}"}
        removed = True
    pruned = _git(git_root, "worktree", "prune")
    if pruned.returncode != 0:
        return {"success": False, "error": f"parallel_worktree_prune_failed:{pruned.stderr.strip()}"}
    branch_removed = False
    if branch and branch != str((manifest.get("repositories", {}).get(repository_ref, {}) or {}).get("baseBranch") or ""):
        exists = _git(git_root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}")
        if exists.returncode == 0:
            delete = _git(git_root, "branch", "-D" if force else "-d", branch)
            if delete.returncode != 0:
                return {"success": False, "error": f"parallel_worktree_branch_remove_failed:{delete.stderr.strip()}"}
            branch_removed = True
    with run_lock(artifact_workspace, feature, run_id):
        manifest, batch, _repository_ref, _git_root = _parallel_binding(artifact_workspace, feature, run_id, batch_id)
        removed_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        batch["removedWorktreePath"] = str(worktree) if worktree is not None else None
        batch["removedBranchName"] = branch or None
        batch["worktreePath"] = None
        batch["branchName"] = None
        batch["worktreeRemovedAt"] = removed_at
        save_manifest(artifact_workspace, feature, run_id, manifest)
    append_event(
        artifact_workspace,
        feature,
        run_id,
        "worktree_removed",
        batchId=batch_id,
        path=str(worktree) if worktree is not None else None,
        branch=branch or None,
        owner="plugin",
        requestedForce=force,
        removed=removed,
        branchRemoved=branch_removed,
    )
    return {
        "success": True,
        "worktreePath": str(worktree) if worktree is not None else None,
        "branchName": branch or None,
        "removed": removed,
        "branchRemoved": branch_removed,
        "error": None,
    }


def list_worktrees(repo_path: Path) -> dict[str, Any]:
    try:
        root = resolve_git_root(repo_path)
    except RepositorySnapshotError as exc:
        return {"worktrees": [], "error": str(exc)}
    result = _git(root, "worktree", "list", "--porcelain")
    if result.returncode != 0:
        return {"worktrees": [], "error": result.stderr.strip()}
    worktrees: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line:
            if current:
                worktrees.append(current)
                current = {}
        elif line.startswith("worktree "):
            current["path"] = line[9:]
        elif line.startswith("branch "):
            current["branch"] = line[7:]
        elif line.startswith("HEAD "):
            current["commit"] = line[5:]
    if current:
        worktrees.append(current)
    return {"worktrees": worktrees, "error": None}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="管理插件托管原生 Git Worktree 的 Batch 交付")
    parser.add_argument("--json", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)
    provision = commands.add_parser("provision")
    provision.add_argument("--artifact-workspace", required=True)
    provision.add_argument("--feature", required=True)
    provision.add_argument("--run-id", required=True)
    provision.add_argument("--batch-id", required=True)
    seal = commands.add_parser("seal")
    seal.add_argument("--repo")
    seal.add_argument("--artifact-workspace", required=True)
    seal.add_argument("--feature", required=True)
    seal.add_argument("--run-id", required=True)
    seal.add_argument("--batch-id", required=True)
    seal.add_argument("--owner-token", required=True)
    seal.add_argument("--purpose", choices=("review", "implementation"), default="implementation")
    listed = commands.add_parser("list")
    listed.add_argument("--repo", required=True)
    args = parser.parse_args(argv)

    if args.command == "provision":
        result = provision_parallel_worktree(Path(args.artifact_workspace), args.feature, args.run_id, args.batch_id)
    elif args.command == "seal":
        result = seal_parallel_batch(
            Path(args.artifact_workspace),
            args.feature,
            args.run_id,
            args.batch_id,
            Path(args.repo) if args.repo else None,
            args.owner_token,
            purpose=args.purpose,
        )
    else:
        result = list_worktrees(Path(args.repo))

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result.get("success"):
        print("success")
    else:
        print(f"failed: {result.get('error', 'unknown')}")
    return 0 if result.get("success") or args.command == "list" else 1


if __name__ == "__main__":
    raise SystemExit(main())
