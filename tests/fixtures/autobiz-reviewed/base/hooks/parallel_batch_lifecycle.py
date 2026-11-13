#!/usr/bin/env python3
"""Lifecycle operations for durable parallel Code runs."""

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

from hooks.json_writer_common import resolve_feature, resolve_workspace
from hooks.commit_message import build_commit_message, normalize_task_card_id
from hooks.parallel_runtime import (
    append_event,
    batch_occupies_scheduler_slot,
    get_active_run,
    lease_path,
    list_runs,
    load_manifest,
    reclaim_lease,
    run_dir,
    run_lock,
    save_manifest,
)
from hooks.worktree_manager import remove_parallel_worktree
from hooks.repository_snapshot import git_status_porcelain


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def detect_external_changes(repo_path: Path, base_sha: str, *, allow_paths: tuple[str, ...] = ()) -> dict[str, Any]:
    """Detect modifications made to the main checkout during a run."""
    head = _git(repo_path, "rev-parse", "HEAD").stdout.strip()
    status_result = git_status_porcelain(repo_path)
    if status_result.returncode != 0:
        raise ValueError(f"parallel_external_changes_status_unavailable:{repo_path}")
    status = [line for line in status_result.stdout.splitlines() if line]
    changed = [line[3:] if len(line) > 3 else line for line in status]
    unexpected = [
        path for path in changed
        if not any(path == prefix or path.startswith(prefix.rstrip("/") + "/") for prefix in allow_paths)
    ]
    commits = _git(repo_path, "diff", "--name-only", f"{base_sha}..HEAD").stdout.splitlines() if base_sha and head else []
    return {
        "clean": not unexpected and not commits,
        "baseSha": base_sha,
        "headSha": head,
        "workingTreeChanges": changed,
        "unexpectedWorkingTreeChanges": unexpected,
        "commitsSinceBase": commits,
    }


def reclaim_stale_leases(workspace: Path, feature: str, run_id: str, *, force: bool = False) -> list[str]:
    manifest = load_manifest(workspace, feature, run_id)
    reclaimed: list[str] = []
    for batch_id, item in manifest.get("batches", {}).items():
        if isinstance(item, dict) and item.get("status") == "leased":
            if reclaim_lease(workspace, feature, run_id, batch_id, force=force):
                reclaimed.append(batch_id)
    return reclaimed


def cleanup_run(workspace: Path, feature: str, run_id: str, *, force: bool = False) -> dict[str, Any]:
    """Close a run and remove every plugin-owned execution resource.

    ``force`` is used by the feature rollback path.  It revokes outstanding
    leases as well as removing native worktrees and their temporary branches,
    including a branch recorded by a manifest whose worktree was already
    removed outside this lifecycle manager.
    """
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        if manifest.get("status") not in {"succeeded", "failed", "blocked", "cancelled", "rolled_back"} and not force:
            raise ValueError("parallel_run_not_terminal")
        targets = [
            (batch_id, str(item.get("worktreePath") or ""), str(item.get("branchName") or ""), str(item.get("status") or ""))
            for batch_id, item in manifest.get("batches", {}).items()
            if isinstance(item, dict)
        ]

    removed: list[str] = []
    removed_branches: list[str] = []
    retained: list[str] = []
    released_leases: list[str] = []
    errors: list[str] = []
    for batch_id, path, branch, status in targets:
        try:
            if reclaim_lease(workspace, feature, run_id, batch_id, force=True):
                released_leases.append(batch_id)
        except (OSError, ValueError) as exc:
            errors.append(f"{batch_id}:lease_release_failed:{exc}")

        if not path and not branch:
            continue
        result = remove_parallel_worktree(
            workspace,
            feature,
            run_id,
            batch_id,
            # A cancelled/failed delivery is intentionally discarded by
            # terminal cleanup, including its unmerged temporary branch.
            force=force or status != "merged",
        )
        if result.get("success"):
            if result.get("retained"):
                retained.append(path)
            else:
                if path:
                    removed.append(path)
                if result.get("branchRemoved") and isinstance(result.get("branchName"), str):
                    removed_branches.append(result["branchName"])
        else:
            errors.append(f"{batch_id}:{result.get('error', 'worktree_remove_failed')}")

    # Validation and Merge-Train worktrees are also plugin-owned lifecycle
    # resources.  They never appear as delivery Batches, so clean them from
    # their explicit manifest records during rollback/terminal cleanup.
    with run_lock(workspace, feature, run_id):
        latest = load_manifest(workspace, feature, run_id)
        validation_records = [
            (str(ref), str(path), str(item.get("status") or "pending"))
            for item in (latest.get("validationBatches", {}) or {}).values()
            if isinstance(item, dict)
            for ref, path in ((item.get("worktrees") or {}).items() if isinstance(item.get("worktrees"), dict) else [])
        ]
        candidate_records = [
            (str(item.get("repositoryRef") or ""), str(item.get("worktreePath") or ""), str(item.get("branchName") or ""))
            for item in (latest.get("mergeTrains", {}) or {}).values()
            if isinstance(item, dict)
        ]
        repositories = latest.get("repositories", {}) if isinstance(latest.get("repositories"), dict) else {}
    for ref, path, validation_status in validation_records:
        if not force and validation_status != "verified":
            retained.append(path)
            continue
        binding = repositories.get(ref)
        if not isinstance(binding, dict) or not isinstance(binding.get("gitRoot"), str) or not path:
            continue
        repo = Path(binding["gitRoot"])
        if Path(path).exists():
            removed_validation = _git(repo, "worktree", "remove", "--force", path)
            if removed_validation.returncode != 0:
                errors.append(f"validation:{ref}:worktree_remove_failed:{removed_validation.stderr.strip()}")
            else:
                removed.append(path)
        _git(repo, "worktree", "prune")
    for ref, path, branch in candidate_records:
        candidate_status = next(
            (
                str(item.get("status") or "pending")
                for item in (latest.get("mergeTrains", {}) or {}).values()
                if isinstance(item, dict)
                and str(item.get("repositoryRef") or "") == ref
                and str(item.get("worktreePath") or "") == path
                and str(item.get("branchName") or "") == branch
            ),
            "pending",
        )
        if not force and candidate_status not in {"promoted", "stale"}:
            if path:
                retained.append(path)
            continue
        binding = repositories.get(ref)
        if not isinstance(binding, dict) or not isinstance(binding.get("gitRoot"), str):
            continue
        repo = Path(binding["gitRoot"])
        if path and Path(path).exists():
            removed_candidate = _git(repo, "worktree", "remove", "--force", path)
            if removed_candidate.returncode != 0:
                errors.append(f"candidate:{ref}:worktree_remove_failed:{removed_candidate.stderr.strip()}")
            else:
                removed.append(path)
        _git(repo, "worktree", "prune")
        if branch and _git(repo, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
            removed_branch = _git(repo, "branch", "-D", branch)
            if removed_branch.returncode != 0:
                errors.append(f"candidate:{ref}:branch_remove_failed:{removed_branch.stderr.strip()}")
            else:
                removed_branches.append(branch)

    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        manifest["cleanup"] = {
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "removedWorktrees": removed,
            "removedBranches": removed_branches,
            "retainedWorktrees": retained,
            "releasedLeases": released_leases,
            "errors": errors,
        }
        manifest["status"] = "cleaned" if not errors else "cleanup_failed"
        save_manifest(workspace, feature, run_id, manifest)
        append_event(
            workspace,
            feature,
            run_id,
            "run_cleaned",
            removedWorktrees=removed,
            removedBranches=removed_branches,
            retainedWorktrees=retained,
            releasedLeases=released_leases,
            errors=errors,
        )
        return {
            "runId": run_id,
            "status": manifest["status"],
            "removedWorktrees": removed,
            "removedBranches": removed_branches,
            "retainedWorktrees": retained,
            "releasedLeases": released_leases,
            "errors": errors,
        }


def cleanup_merged_batches(
    workspace: Path,
    feature: str,
    run_id: str,
    *,
    batch_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Release completed delivery worktrees without closing the active run.

    A Batch is eligible only after its commit has been merged and the manifest
    records that outcome.  That keeps the native worktree available for real
    rebase conflicts and Plan-state recovery, while preventing already
    delivered branches from blocking a later Workflow attempt.
    """
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batches = manifest.get("batches") if isinstance(manifest.get("batches"), dict) else {}
        requested = (
            list(batch_ids)
            if batch_ids is not None
            else sorted(
                batch_id
                for batch_id, batch in batches.items()
                if isinstance(batch, dict) and batch.get("status") == "merged"
            )
        )
        targets: list[str] = []
        skipped: list[dict[str, str]] = []
        errors: list[str] = []
        for batch_id in requested:
            batch = batches.get(batch_id)
            if not isinstance(batch, dict):
                errors.append(f"{batch_id}:parallel_batch_not_found")
                continue
            if batch.get("status") != "merged":
                skipped.append({"batchId": batch_id, "status": str(batch.get("status") or "unknown")})
                continue
            targets.append(batch_id)

    cleaned: list[str] = []
    released_leases: list[str] = []
    for batch_id in targets:
        try:
            if reclaim_lease(workspace, feature, run_id, batch_id, force=True):
                released_leases.append(batch_id)
        except (OSError, ValueError) as exc:
            errors.append(f"{batch_id}:lease_release_failed:{exc}")
            continue

        result = remove_parallel_worktree(
            workspace,
            feature,
            run_id,
            batch_id,
            force=False,
        )
        if result.get("success"):
            cleaned.append(batch_id)
        else:
            errors.append(f"{batch_id}:{result.get('error', 'worktree_remove_failed')}")

    completed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        cleanup = manifest.setdefault("mergedBatchCleanup", {})
        if not isinstance(cleanup, dict):
            cleanup = {}
            manifest["mergedBatchCleanup"] = cleanup
        for batch_id in cleaned:
            cleanup[batch_id] = {
                "at": completed_at,
                "status": "cleaned",
                "leaseReleased": batch_id in released_leases,
            }
        for item in skipped:
            cleanup[item["batchId"]] = {
                "at": completed_at,
                "status": "skipped",
                "batchStatus": item["status"],
            }
        save_manifest(workspace, feature, run_id, manifest)
        append_event(
            workspace,
            feature,
            run_id,
            "merged_batch_worktrees_cleaned",
            cleanedBatchIds=cleaned,
            releasedLeases=released_leases,
            skipped=skipped,
            errors=errors,
        )
    return {
        "success": not errors,
        "runId": run_id,
        "cleanedBatchIds": cleaned,
        "releasedLeases": released_leases,
        "skipped": skipped,
        "errors": errors,
    }


def cleanup_feature_runs_for_code_rollback(workspace: Path, feature: str) -> list[dict[str, Any]]:
    """Synchronously dismantle every recorded run before Code state is reset.

    The Code-stage rollback moves ``.parallel-runs`` into its rollback
    history.  Cleaning the run directories first is therefore essential: once
    that manifest is archived, the plugin can no longer reliably identify
    native worktrees, temporary branches, or lease files to release.
    """
    results: list[dict[str, Any]] = []
    for manifest in list_runs(workspace, feature):
        run_id = manifest.get("runId")
        if not isinstance(run_id, str) or not run_id:
            # Non-runtime files under the artifact directory have no plugin
            # ownership information and are handled by artifact archival.
            continue
        result = cleanup_run(workspace, feature, run_id, force=True)
        if result.get("status") != "cleaned" or result.get("errors"):
            raise ValueError(
                f"parallel_run_cleanup_failed:{run_id}:"
                + ";".join(str(item) for item in result.get("errors", []))
            )
        results.append(result)
    return results


def rollback_run(workspace: Path, feature: str, run_id: str, *, mode: str = "partial", confirm: bool = False) -> dict[str, Any]:
    if mode not in {"full", "partial"}:
        raise ValueError("rollback_mode_invalid")
    # Rollback is never a recovery mechanism for a promoted candidate whose
    # Plan write failed.  It can erase the very manifest evidence needed to
    # reconcile Git's already-durable HEAD, so require an explicit operator
    # acknowledgement for every rollback and reject that recovery state.
    if not confirm:
        raise ValueError("rollback_requires_confirm")
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        promoted_plan_recovery = any(
            isinstance(train, dict)
            and train.get("status") in {"promoting", "needs_resolution"}
            and (
                bool(train.get("promotedSha"))
                or bool(train.get("planWriterErrors"))
                or (
                    isinstance(train.get("resolution"), dict)
                    and train["resolution"].get("kind") == "promoted_plan_state_update"
                )
            )
            for train in (manifest.get("mergeTrains") or {}).values()
        )
        if promoted_plan_recovery:
            raise ValueError("rollback_promoted_plan_recovery_required")
        reverted: list[str] = []
        if mode == "full":
            task_card_id = normalize_task_card_id(manifest.get("taskCardId"))
            commits_by_repository: dict[str, dict[str, Any]] = {}
            for item in manifest.get("batches", {}).values():
                if isinstance(item, dict) and isinstance(item.get("mergeCommitSha"), str):
                    ref = str(item.get("repositoryRef") or item.get("workspaceRef") or "")
                    repository = manifest.get("repositories", {}).get(ref)
                    if not isinstance(repository, dict) or not isinstance(repository.get("gitRoot"), str):
                        raise ValueError(f"parallel_repository_binding_missing:{ref}")
                    root = Path(repository["gitRoot"])
                    key = str(root.resolve())
                    record = commits_by_repository.setdefault(key, {"root": root, "refs": [], "commits": []})
                    record["refs"].append(ref)
                    record["commits"].append(str(item["mergeCommitSha"]))
            for record in commits_by_repository.values():
                root = record["root"]
                commits = record["commits"]
                refs = sorted(set(record["refs"]))
                for commit in reversed(commits):
                    result = _git(root, "revert", "--no-commit", commit)
                    if result.returncode != 0:
                        _git(root, "revert", "--abort")
                        raise ValueError(f"rollback_revert_failed:{','.join(refs)}:{commit}:{result.stderr.strip()}")
                    revert_commit = _git(
                        root,
                        "commit",
                        "-m",
                        build_commit_message(task_card_id, f"回滚工作流 {feature} {commit}"),
                    )
                    if revert_commit.returncode != 0:
                        _git(root, "revert", "--abort")
                        raise ValueError(
                            f"rollback_revert_commit_failed:{','.join(refs)}:{commit}:"
                            f"{revert_commit.stderr.strip() or revert_commit.stdout.strip()}"
                        )
                    reverted.append(f"{','.join(refs)}:{commit}")
        else:
            # Partial rollback preserves successful work and only abandons the
            # scheduler state; no commits are rewritten.
            for item in manifest.get("batches", {}).values():
                if isinstance(item, dict) and item.get("status") not in {"merged", "succeeded"}:
                    item["status"] = "cancelled"
        manifest["status"] = "rolled_back"
        manifest["rollback"] = {"mode": mode, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "reverted": reverted}
        save_manifest(workspace, feature, run_id, manifest)
        append_event(workspace, feature, run_id, "run_rolled_back", mode=mode)
        return {"runId": run_id, "status": manifest["status"], "mode": mode, "reverted": reverted}


def monitor_run(workspace: Path, feature: str, run_id: str) -> dict[str, Any]:
    manifest = load_manifest(workspace, feature, run_id)
    batches = manifest.get("batches", {})
    now = time.time()
    counts: dict[str, int] = {}
    active_batch_ids: list[str] = []
    timeline: list[dict[str, Any]] = []
    def epoch(value: Any) -> float | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None

    for batch_id, item in batches.items():
        if not isinstance(item, dict):
            continue
        status = str(item.get("status"))
        counts[status] = counts.get(status, 0) + 1
        if batch_occupies_scheduler_slot(item):
            active_batch_ids.append(str(batch_id))
        started = item.get("startedAt")
        completed = item.get("completedAt")
        started_epoch = epoch(started)
        completed_epoch = epoch(completed)
        duration = None
        if started_epoch is not None:
            duration = round(max(0.0, (completed_epoch if completed_epoch is not None else now) - started_epoch), 3)
        timeline.append({"batchId": batch_id, "status": status, "startedAt": started, "completedAt": completed, "durationSeconds": duration})
    return {"runId": run_id, "status": manifest.get("status"), "counts": counts, "activeWorkers": len(active_batch_ids), "activeBatchIds": sorted(active_batch_ids), "timeline": timeline, "updatedAt": manifest.get("updatedAt"), "nowEpoch": now}


def auto_cleanup_old_runs(workspace: Path, feature: str, *, keep_days: int = 7) -> list[dict[str, Any]]:
    """Mark old successful runs cleaned and remove plugin-owned native worktrees."""
    cutoff = time.time() - max(0, keep_days) * 24 * 60 * 60
    cleaned: list[dict[str, Any]] = []
    for manifest in list_runs(workspace, feature):
        if manifest.get("status") != "succeeded":
            continue
        try:
            created = datetime.fromisoformat(str(manifest.get("createdAt", "")).replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if created > cutoff:
            continue
        cleaned.append(cleanup_run(workspace, feature, str(manifest["runId"])))
    return cleaned


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage parallel Code run lifecycle")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("monitor", "reclaim-leases", "cleanup", "cleanup-merged", "rollback", "external-changes", "auto-cleanup"):
        p = sub.add_parser(name)
        p.add_argument("--workspace")
        p.add_argument("--feature", required=True)
        if name not in {"external-changes", "auto-cleanup"}:
            p.add_argument("--run-id", required=True)
        if name == "external-changes":
            p.add_argument("--repo-path")
        if name in {"cleanup", "reclaim-leases"}:
            p.add_argument("--force", action="store_true")
        if name == "cleanup-merged":
            p.add_argument("--batch-id", action="append")
        if name == "rollback":
            p.add_argument("--mode", choices=("full", "partial"), default="partial")
            p.add_argument("--confirm", action="store_true")
        if name == "external-changes":
            p.add_argument("--base-sha", required=True)
        if name == "auto-cleanup":
            p.add_argument("--keep-days", type=int, default=7)
    args = parser.parse_args(argv)
    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
        if args.command == "monitor":
            result = monitor_run(workspace, feature, args.run_id)
        elif args.command == "reclaim-leases":
            result = {"reclaimed": reclaim_stale_leases(workspace, feature, args.run_id, force=args.force)}
        elif args.command == "cleanup":
            result = cleanup_run(workspace, feature, args.run_id, force=args.force)
        elif args.command == "cleanup-merged":
            result = cleanup_merged_batches(
                workspace,
                feature,
                args.run_id,
                batch_ids=args.batch_id,
            )
        elif args.command == "rollback":
            result = rollback_run(workspace, feature, args.run_id, mode=args.mode, confirm=args.confirm)
        elif args.command == "auto-cleanup":
            result = {"cleaned": auto_cleanup_old_runs(workspace, feature, keep_days=args.keep_days)}
        else:
            if not args.repo_path:
                raise ValueError("repo_path_required_for_external_changes")
            result = detect_external_changes(Path(args.repo_path), args.base_sha)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
