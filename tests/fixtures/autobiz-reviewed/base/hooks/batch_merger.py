#!/usr/bin/env python3
"""Deterministic, guarded merging of parallel Code batch worktrees."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import resolve_feature, resolve_workspace  # noqa: E402
from hooks.commit_message import build_commit_message, normalize_task_card_id  # noqa: E402
from hooks.parallel_runtime import (  # noqa: E402
    append_event,
    lease_path,
    load_manifest,
    run_lock,
    save_manifest,
    utc_now,
)
from hooks.repository_snapshot import current_git_branch, git_status_porcelain, resolve_git_root  # noqa: E402
from hooks.plan_writer import mark_parallel_batch_tasks_merged  # noqa: E402


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _merge_probe(repo: Path, target_sha: str, source_branch: str) -> dict[str, Any]:
    """Detect conflicts without writing an unreferenced tree object."""
    base = _git(repo, "merge-base", target_sha, source_branch)
    if base.returncode != 0 or not base.stdout.strip():
        return {"success": False, "error": base.stderr.strip() or "merge_base_failed", "conflicts": []}
    probe = _git(repo, "merge-tree", "--trivial-merge", base.stdout.strip(), target_sha, source_branch)
    if probe.returncode != 0:
        return {"success": False, "error": probe.stderr.strip() or "merge_probe_failed", "conflicts": []}
    output = "\n".join(part for part in (probe.stdout, probe.stderr) if part)
    markers = ("changed in both", "added in both", "removed in both", "CONFLICT", "<<<<<<<")
    conflicts = [line.strip() for line in output.splitlines() if any(marker in line for marker in markers)]
    return {"success": not conflicts, "error": "merge_conflict" if conflicts else None, "conflicts": conflicts}


def _abort_git_operation(repo: Path, operation: str) -> tuple[bool, str | None]:
    result = _git(repo, operation, "--abort")
    if result.returncode == 0:
        return True, None
    return False, result.stderr.strip() or result.stdout.strip() or f"{operation}_abort_failed"


def _worktree_records(repo: Path) -> list[dict[str, str]]:
    result = _git(repo, "worktree", "list", "--porcelain")
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in result.stdout.splitlines() + [""]:
        if line.startswith("worktree "):
            if current:
                records.append(current)
            current = {"path": line[9:]}
        elif line.startswith("branch "):
            branch = line[7:]
            current["branch"] = branch[len("refs/heads/"):] if branch.startswith("refs/heads/") else branch
        elif line == "" and current:
            records.append(current)
            current = {}
    return records


def _resolve_branch(repo: Path, name: str) -> tuple[Path | None, str | None]:
    requested_path = Path(name).expanduser()
    if requested_path.exists() and requested_path.is_dir():
        branch = current_git_branch(requested_path) or ""
        if branch:
            return requested_path.resolve(), branch
    records = _worktree_records(repo)
    for record in records:
        path = Path(record.get("path", ""))
        branch = record.get("branch")
        if path.name == name or str(path) == name:
            return path, branch
    branch_candidates = [f"worktree/{name}", name]
    for branch in branch_candidates:
        if _git(repo, "rev-parse", "--verify", branch).returncode == 0:
            return None, branch
    return None, None


def _rebase_native_delivery(
    repo: Path,
    worktree_name: str,
    target_sha: str,
) -> dict[str, Any]:
    """Rebase a retained plugin-managed native worktree before merging it to the source.

    This runs from the shared workflow owner, because isolated agents are
    intentionally forbidden from merge/rebase operations by the platform.
    On conflict the delivery is restored with rebase --abort; the workflow
    leaves the retained delivery untouched for explicit recovery.
    """
    worktree_path, branch = _resolve_branch(repo, worktree_name)
    if worktree_path is None or not worktree_path.exists() or not branch:
        return {
            "success": False,
            "needsResolution": False,
            "error": f"native_worktree_not_found:{worktree_name}",
            "conflicts": [],
        }
    dirty = _dirty(worktree_path)
    if dirty:
        conflicts = _git(worktree_path, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        return {
            "success": False,
            "needsResolution": bool(conflicts),
            "error": "native_rebase_conflict" if conflicts else "native_worktree_dirty",
            "conflicts": conflicts,
            "worktreePath": str(worktree_path),
            "branch": branch,
        }
    result = _git(worktree_path, "rebase", target_sha)
    if result.returncode != 0:
        conflicts = _git(worktree_path, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        # Restore the original delivery so this retained checkout stays clean
        # for explicit recovery or discard by the lifecycle hook.
        aborted, abort_error = _abort_git_operation(worktree_path, "rebase")
        return {
            "success": False,
            # A failed abort leaves Git in an indeterminate rebase state. It
            # must be blocked for inspection rather than handed to the normal
            # automatic conflict resolver.
            "needsResolution": bool(conflicts) and aborted,
            "error": (
                "native_rebase_conflict"
                if conflicts and aborted
                else f"native_rebase_abort_failed:{abort_error}"
                if not aborted
                else result.stderr.strip() or "native_rebase_failed"
            ),
            "conflicts": conflicts,
            "worktreePath": str(worktree_path),
            "branch": branch,
            "abortError": abort_error,
            "abortSucceeded": aborted,
        }
    return {
        "success": True,
        "needsResolution": False,
        "error": None,
        "conflicts": [],
        "worktreePath": str(worktree_path),
        "branch": branch,
        "commitSha": _git(worktree_path, "rev-parse", "HEAD").stdout.strip(),
    }


def _dirty(repo: Path) -> list[str]:
    result = git_status_porcelain(repo)
    if result.returncode != 0:
        raise ValueError(f"git_status_failed:{repo}")
    return [line for line in result.stdout.splitlines() if line]


def preflight_merge(repo_path: Path, *, base_sha: str | None = None) -> dict[str, Any]:
    repo = resolve_git_root(repo_path)
    dirty = _dirty(repo)
    if dirty:
        return {"ok": False, "error": "main_worktree_dirty", "changes": dirty}
    head = _git(repo, "rev-parse", "HEAD").stdout.strip()
    if base_sha and head != base_sha:
        return {"ok": False, "error": "main_head_changed", "expected": base_sha, "actual": head}
    return {"ok": True, "head": head}


def merge_worktree_to_main(
    repo_path: Path,
    worktree_name: str,
    target_branch: str | None = None,
    *,
    base_sha: str | None = None,
    task_card_id: str | None = None,
    commit_summary: str | None = None,
) -> dict[str, Any]:
    try:
        repo = resolve_git_root(repo_path)
        preflight = preflight_merge(repo, base_sha=base_sha)
        if not preflight.get("ok"):
            return {"success": False, "mergedFiles": [], "conflicts": [], "error": preflight.get("error"), "details": preflight}
        worktree_path, branch = _resolve_branch(repo, worktree_name)
        if worktree_path is not None and not worktree_path.exists():
            return {"success": False, "mergedFiles": [], "conflicts": [], "error": f"worktree_not_found:{worktree_name}"}
        if not branch:
            return {"success": False, "mergedFiles": [], "conflicts": [], "error": f"worktree_branch_not_found:{worktree_name}"}
        if _git(repo, "rev-parse", "--verify", branch).returncode != 0:
            return {"success": False, "mergedFiles": [], "conflicts": [], "error": f"worktree_branch_not_found:{branch}"}
        changed = _git(repo, "diff", "--name-only", "HEAD", branch).stdout.splitlines()
        target = target_branch or current_git_branch(repo) or ""
        merge_args = [
            "merge",
            "--no-ff",
            "-m",
            build_commit_message(task_card_id, commit_summary or f"合并工作树 {branch}"),
            branch,
        ]
        if target and target != "HEAD":
            if current_git_branch(repo) != target:
                return {"success": False, "mergedFiles": [], "conflicts": [], "error": f"target_branch_mismatch:{target}"}
        result = _git(repo, *merge_args)
        if result.returncode != 0:
            conflicts = _git(repo, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
            aborted, abort_error = _abort_git_operation(repo, "merge")
            return {
                "success": False,
                "mergedFiles": [],
                "conflicts": conflicts,
                "error": "merge_conflict" if conflicts and aborted else f"merge_abort_failed:{abort_error}" if not aborted else result.stderr.strip() or "merge_failed",
                "abortError": abort_error,
                "abortSucceeded": aborted,
            }
        sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
        return {"success": True, "mergedFiles": changed, "conflicts": [], "commitSha": sha, "error": None, "branch": branch}
    except (OSError, ValueError) as exc:
        return {"success": False, "mergedFiles": [], "conflicts": [], "error": str(exc)}


def _batch_repository(manifest: dict[str, Any], batch_id: str) -> tuple[str, Path, str | None]:
    batch = manifest.get("batches", {}).get(batch_id)
    if not isinstance(batch, dict):
        raise ValueError(f"parallel_batch_not_found:{batch_id}")
    ref = str(batch.get("repositoryRef") or batch.get("workspaceRef") or "")
    repository = manifest.get("repositories", {}).get(ref)
    if isinstance(repository, dict) and isinstance(repository.get("gitRoot"), str):
        return ref, Path(repository["gitRoot"]), repository.get("baseSha") if isinstance(repository.get("baseSha"), str) else None
    raise ValueError(f"parallel_repository_binding_missing:{ref}")


def merge_run(
    workspace: Path,
    feature: str,
    run_id: str,
    *,
    batch_ids: list[str] | None = None,
    conflict_mode: str = "native-rebase",
) -> dict[str, Any]:
    if conflict_mode != "native-rebase":
        raise ValueError("parallel_conflict_mode_native_rebase_required")
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        task_card_id = normalize_task_card_id(manifest.get("taskCardId"))
        from hooks.parallel_runtime import mergeable_batches, ready_batches
        mergeable = set(mergeable_batches(manifest))
        if batch_ids:
            ids = list(batch_ids)
            invalid = [bid for bid in ids if bid not in mergeable]
            if invalid:
                return {
                    "success": False,
                    "merged": [],
                    "failed": [{"batchId": bid, "error": "parallel_batch_not_mergeable"} for bid in invalid],
                    "totalConflicts": 0,
                    "mergeableBatches": sorted(mergeable),
                }
        else:
            # Merge the current frontier now. Downstream batches are released
            # only by the next scheduler call after these commits land.
            remaining = set(mergeable)
            ids = []
            while remaining:
                layer = sorted(
                    bid for bid in remaining
                    if all(dep not in remaining for dep in manifest["batches"][bid].get("dependencies", []))
                )
                if not layer:
                    manifest["status"] = "blocked"
                    save_manifest(workspace, feature, run_id, manifest)
                    return {"success": False, "merged": [], "failed": [{"error": "merge_dependency_cycle_or_unready_dependency"}], "totalConflicts": 0}
                ids.extend(layer)
                remaining.difference_update(layer)
            if not ids:
                pending = [
                    str(batch_id)
                    for batch_id, batch in manifest.get("batches", {}).items()
                    if isinstance(batch, dict) and batch.get("status") != "merged"
                ]
                if pending:
                    manifest["status"] = "blocked"
                    save_manifest(workspace, feature, run_id, manifest)
                    return {
                        "success": False,
                        "merged": [],
                        "failed": [{"error": "parallel_merge_frontier_empty", "pendingBatches": pending}],
                        "totalConflicts": 0,
                        "mergeableBatches": [],
                    }
                return {"success": True, "merged": [], "failed": [], "totalConflicts": 0}
        unsealed = [bid for bid in ids if not manifest["batches"].get(bid, {}).get("commitSha")]
        if unsealed:
            manifest["status"] = "blocked"
            save_manifest(workspace, feature, run_id, manifest)
            return {"success": False, "merged": [], "failed": [{"batchId": bid, "error": "parallel_batch_not_sealed"} for bid in unsealed], "totalConflicts": 0}
        # Several workspaceRefs may deliberately point at component directories
        # in one monorepo.  Merge safety and base-SHA tracking are physical
        # repository concerns, so group them by resolved Git root, not ref.
        repositories: dict[str, dict[str, Any]] = {}
        for batch_id in ids:
            ref, root, base_sha = _batch_repository(manifest, batch_id)
            key = str(root.resolve())
            binding = manifest.get("repositories", {}).get(ref)
            expected_sha = binding.get("headSha") if isinstance(binding, dict) else None
            if not isinstance(expected_sha, str) or not expected_sha:
                expected_sha = base_sha
            record = repositories.setdefault(key, {"root": root, "headSha": expected_sha, "refs": []})
            if record["headSha"] != expected_sha:
                manifest["status"] = "blocked"
                save_manifest(workspace, feature, run_id, manifest)
                return {
                    "success": False,
                    "merged": [],
                    "failed": [{"repositoryRef": ref, "error": "parallel_repository_head_sha_mismatch"}],
                    "totalConflicts": 0,
                }
            record["refs"].append(ref)
        for record in repositories.values():
            root = record["root"]
            preflight = preflight_merge(root, base_sha=record["headSha"])
            if not preflight.get("ok"):
                manifest["status"] = "blocked"
                save_manifest(workspace, feature, run_id, manifest)
                return {
                    "success": False,
                    "merged": [],
                    "failed": [{"repositoryRefs": sorted(set(record["refs"])), "error": preflight.get("error"), "details": preflight}],
                    "totalConflicts": 0,
                }
        manifest["status"] = "merging"
        save_manifest(workspace, feature, run_id, manifest)
        merged: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for batch_id in ids:
            batch = manifest["batches"][batch_id]
            ref, root, base_sha = _batch_repository(manifest, batch_id)
            root_key = str(root.resolve())
            record = repositories[root_key]
            # The worker lease is deliberately released during the seal
            # handoff. Refuse a delivery if a lease record reappears while the
            # merge barrier is running; otherwise an active or stale worker
            # could race the shared checkout.
            if batch.get("lease") is not None or lease_path(workspace, feature, run_id, batch_id).is_file():
                failed.append({
                    "batchId": batch_id,
                    "repositoryRef": ref,
                    "error": "parallel_merge_lease_not_released",
                })
                break
            worktree_path, source_branch = _resolve_branch(root, str(batch.get("worktreePath") or batch_id))
            if not source_branch:
                failed.append({
                    "batchId": batch_id,
                    "repositoryRef": ref,
                    "error": "worktree_branch_not_found",
                })
                break
            rebased = _rebase_native_delivery(
                root,
                str(batch.get("worktreePath") or batch_id),
                str(record["headSha"]),
            )
            if not rebased.get("success"):
                if rebased.get("needsResolution"):
                    for merged_item in merged:
                        merged_batch = manifest["batches"][merged_item["batchId"]]
                        merged_batch.update({"status": "merged", "mergeCommitSha": merged_item["commitSha"]})
                    resolution = {
                        "mode": "native_rebase",
                        "worktreePath": rebased.get("worktreePath"),
                        "branchName": rebased.get("branch"),
                        "targetSha": record["headSha"],
                        "conflicts": rebased.get("conflicts", []),
                    }
                    batch["status"] = "needs_resolution"
                    batch["resolution"] = resolution
                    manifest["status"] = "needs_resolution"
                    save_manifest(workspace, feature, run_id, manifest)
                    append_event(
                        workspace,
                        feature,
                        run_id,
                        "native_rebase_conflict_detected",
                        batchId=batch_id,
                        conflicts=resolution["conflicts"],
                    )
                    return {
                        "success": False,
                        "needsResolution": True,
                        "merged": merged,
                        "failed": [{
                            "batchId": batch_id,
                            "repositoryRef": ref,
                            "error": "native_rebase_conflict",
                            "conflicts": resolution["conflicts"],
                            "resolution": resolution,
                            "needsResolution": True,
                        }],
                        "totalConflicts": len(resolution["conflicts"]),
                    }
                failed.append({
                    "batchId": batch_id,
                    "repositoryRef": ref,
                    "worktree": batch.get("worktreePath"),
                    "error": rebased.get("error"),
                    "conflicts": rebased.get("conflicts", []),
                })
                break
            source_branch = str(rebased["branch"])
            batch["commitSha"] = rebased.get("commitSha")
            probe = _merge_probe(root, record["headSha"], source_branch)
            if not probe.get("success"):
                failed.append({
                    "batchId": batch_id,
                    "repositoryRef": ref,
                    "worktree": batch.get("worktreePath"),
                    "error": "post_rebase_merge_probe_failed",
                    "conflicts": probe.get("conflicts", []),
                    "probeError": probe.get("error"),
                })
                break
            result = merge_worktree_to_main(
                root,
                str(batch.get("worktreePath") or batch_id),
                base_sha=record["headSha"],
                task_card_id=task_card_id,
                commit_summary=f"合并 Batch {batch_id}",
            )
            if not result.get("success"):
                failed.append({
                    "batchId": batch_id,
                    "repositoryRef": ref,
                    "worktree": batch.get("worktreePath"),
                    "error": result.get("error"),
                    "conflicts": result.get("conflicts", []),
                })
                break
            plan_result = mark_parallel_batch_tasks_merged(
                workspace,
                feature,
                batch_id,
                merge_commit_sha=str(result.get("commitSha") or ""),
                delivery_run_id=run_id,
            )
            if not plan_result.ok:
                resolution = {
                    "kind": "plan_state_update",
                    "mergeCommitSha": result.get("commitSha"),
                    "deliveryRunId": run_id,
                    "repositoryRef": ref,
                    "repositoryHeadSha": result.get("commitSha"),
                    "planWriterErrors": plan_result.errors or [],
                }
                record["headSha"] = result.get("commitSha")
                for binding in manifest.get("repositories", {}).values():
                    if isinstance(binding, dict) and isinstance(binding.get("gitRoot"), str) and str(Path(binding["gitRoot"]).resolve()) == root_key:
                        binding["headSha"] = result.get("commitSha")
                failed.append({
                    "batchId": batch_id,
                    "repositoryRef": ref,
                    "worktree": batch.get("worktreePath"),
                    "error": "parallel_merge_plan_state_update_failed",
                    "planWriterErrors": plan_result.errors or [],
                    "sourceMerged": True,
                    "needsPlanRecovery": True,
                    "resolution": resolution,
                })
                batch.update(
                    {
                        "status": "needs_resolution",
                        "mergeCommitSha": result.get("commitSha"),
                        "error": "parallel_merge_plan_state_update_failed",
                        "resolution": resolution,
                    }
                )
                break
            record["headSha"] = result.get("commitSha")
            for binding in manifest.get("repositories", {}).values():
                if isinstance(binding, dict) and isinstance(binding.get("gitRoot"), str) and str(Path(binding["gitRoot"]).resolve()) == root_key:
                    binding["headSha"] = result.get("commitSha")
            merged.append({
                "batchId": batch_id,
                "repositoryRef": ref,
                "gitRoot": root_key,
                "commitSha": result.get("commitSha"),
                "mergedFiles": result.get("mergedFiles", []),
            })
        result = {
            "success": not failed,
            "merged": merged,
            "failed": failed,
            "totalConflicts": sum(len(item.get("conflicts", [])) for item in failed),
        }
        for item in merged:
            batch = manifest["batches"][item["batchId"]]
            batch.update({"status": "merged", "mergeCommitSha": item["commitSha"]})
        if result["success"]:
            all_merged = all(
                isinstance(item, dict) and item.get("status") == "merged"
                for item in manifest.get("batches", {}).values()
            )
            manifest["status"] = "verifying" if all_merged else "running"
        else:
            for item in failed:
                if item.get("batchId") in manifest.get("batches", {}) and not item.get("sourceMerged"):
                    manifest["batches"][item["batchId"]].update({"status": "conflict", "error": item.get("error")})
            manifest["status"] = "needs_resolution" if any(item.get("sourceMerged") for item in failed) else "blocked"
        save_manifest(workspace, feature, run_id, manifest)
        append_event(workspace, feature, run_id, "merge_completed", result=result)
        result["nextReadyBatches"] = ready_batches(manifest)
        result["mergeableBatches"] = mergeable_batches(manifest)
        return result


def resolve_merge_conflict(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
) -> dict[str, Any]:
    """Accept a semantically resolved delivery after strict integration checks.

    The resolver agent owns only the retained plugin worktree.  This hook
    never edits source files: it verifies that the agent rebased onto the
    current repository head, that the branch is clean and conflict-free, then
    moves the batch back to the normal merge barrier.
    """
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = manifest.get("batches", {}).get(batch_id)
        if not isinstance(batch, dict):
            return {"success": False, "error": f"parallel_batch_not_found:{batch_id}"}
        resolution = batch.get("resolution")
        if batch.get("status") != "needs_resolution" or not isinstance(resolution, dict):
            return {"success": False, "error": "parallel_batch_not_waiting_for_resolution", "batchId": batch_id}
        worktree_name = resolution.get("worktreePath") or batch.get("worktreePath")
        branch_name = resolution.get("branchName") or batch.get("branchName")
        target_sha = resolution.get("targetSha")
        if not all(isinstance(value, str) and value.strip() for value in (worktree_name, branch_name, target_sha)):
            return {"success": False, "error": "parallel_resolution_contract_incomplete", "batchId": batch_id}
        ref, root, _ = _batch_repository(manifest, batch_id)
        current_head = _git(root, "rev-parse", "HEAD").stdout.strip()
        if current_head != target_sha:
            return {
                "success": False,
                "error": "parallel_resolution_target_head_changed",
                "batchId": batch_id,
                "targetSha": target_sha,
                "actual": current_head,
            }
        worktree_path, actual_branch = _resolve_branch(root, worktree_name)
        if worktree_path is None or not worktree_path.exists() or actual_branch != branch_name:
            return {"success": False, "error": "parallel_resolution_worktree_mismatch", "batchId": batch_id}
        if _dirty(worktree_path):
            return {"success": False, "error": "parallel_resolution_worktree_dirty", "batchId": batch_id}
        if current_git_branch(worktree_path) != branch_name:
            return {"success": False, "error": "parallel_resolution_branch_mismatch", "batchId": batch_id}
        head_sha = _git(worktree_path, "rev-parse", "HEAD").stdout.strip()
        if not head_sha or head_sha == target_sha:
            return {"success": False, "error": "parallel_resolution_missing_delivery_commit", "batchId": batch_id}
        if _git(worktree_path, "merge-base", "--is-ancestor", target_sha, head_sha).returncode != 0:
            return {"success": False, "error": "parallel_resolution_not_rebased", "batchId": batch_id}
        probe = _merge_probe(root, target_sha, branch_name)
        if not probe.get("success"):
            return {
                "success": False,
                "error": "parallel_resolution_still_conflicts",
                "batchId": batch_id,
                "conflicts": probe.get("conflicts", []),
            }
        batch.update({
            "status": "ready_to_merge",
            "commitSha": head_sha,
            "error": None,
        })
        batch.pop("resolution", None)
        remaining = any(
            isinstance(item, dict) and item.get("status") == "needs_resolution"
            for item in manifest.get("batches", {}).values()
        )
        manifest["status"] = "needs_resolution" if remaining else "running"
        save_manifest(workspace, feature, run_id, manifest)
        append_event(
            workspace,
            feature,
            run_id,
            "native_rebase_conflict_resolved",
            batchId=batch_id,
            repositoryRef=ref,
            worktreePath=str(worktree_path),
            branchName=branch_name,
            targetSha=target_sha,
            commitSha=head_sha,
            resolvedAt=utc_now(),
        )
        return {
            "success": True,
            "batchId": batch_id,
            "repositoryRef": ref,
            "worktreePath": str(worktree_path),
            "branchName": branch_name,
            "targetSha": target_sha,
            "commitSha": head_sha,
        }


def recover_plan_state_after_merge(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
) -> dict[str, Any]:
    """Repair Plan metadata after Git merged but the Plan writer failed."""
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = manifest.get("batches", {}).get(batch_id)
        if not isinstance(batch, dict):
            return {"success": False, "error": f"parallel_batch_not_found:{batch_id}"}
        resolution = batch.get("resolution")
        if batch.get("status") != "needs_resolution" or not isinstance(resolution, dict) or resolution.get("kind") != "plan_state_update":
            return {"success": False, "error": "parallel_batch_not_waiting_for_plan_recovery", "batchId": batch_id}
        commit_sha = str(resolution.get("mergeCommitSha") or batch.get("mergeCommitSha") or "")
        if not commit_sha:
            return {"success": False, "error": "parallel_plan_recovery_commit_missing", "batchId": batch_id}
        ref, root, _ = _batch_repository(manifest, batch_id)
        current_head = _git(root, "rev-parse", "HEAD").stdout.strip()
        if current_head != commit_sha:
            return {
                "success": False,
                "error": "parallel_plan_recovery_head_changed",
                "batchId": batch_id,
                "expected": commit_sha,
                "actual": current_head,
            }
        plan_result = mark_parallel_batch_tasks_merged(
            workspace,
            feature,
            batch_id,
            merge_commit_sha=commit_sha,
            delivery_run_id=str(resolution.get("deliveryRunId") or run_id),
        )
        if not plan_result.ok:
            resolution["planWriterErrors"] = plan_result.errors or []
            batch["resolution"] = resolution
            save_manifest(workspace, feature, run_id, manifest)
            return {
                "success": False,
                "error": "parallel_merge_plan_state_update_failed",
                "batchId": batch_id,
                "planWriterErrors": plan_result.errors or [],
            }
        batch.update({"status": "merged", "mergeCommitSha": commit_sha, "error": None})
        batch.pop("resolution", None)
        root_key = str(root.resolve())
        for binding in manifest.get("repositories", {}).values():
            if isinstance(binding, dict) and str(Path(binding.get("gitRoot", "")).resolve()) == root_key:
                binding["headSha"] = commit_sha
        all_merged = all(
            isinstance(item, dict) and item.get("status") == "merged"
            for item in manifest.get("batches", {}).values()
        )
        manifest["status"] = "verifying" if all_merged else "running"
        save_manifest(workspace, feature, run_id, manifest)
        append_event(
            workspace,
            feature,
            run_id,
            "plan_state_recovered_after_merge",
            batchId=batch_id,
            repositoryRef=ref,
            commitSha=commit_sha,
        )
        return {"success": True, "batchId": batch_id, "repositoryRef": ref, "commitSha": commit_sha, "status": manifest["status"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Merge parallel Code batches")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("command", nargs="?", choices=("merge", "resolve", "recover-plan"), default="merge")
    parser.add_argument("--workspace")
    parser.add_argument("--feature")
    parser.add_argument("--run-id")
    parser.add_argument("--batch-id", action="append", dest="batch_ids")
    parser.add_argument(
        "--conflict-mode",
        choices=("native-rebase",),
        default="native-rebase",
    )
    args = parser.parse_args(argv)
    try:
        if not args.feature:
            raise ValueError("feature_required")
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
        if args.run_id and args.command == "recover-plan":
            if not args.batch_ids or len(args.batch_ids) != 1:
                raise ValueError("recover_plan_requires_one_batch_id")
            result = recover_plan_state_after_merge(workspace, feature, args.run_id, args.batch_ids[0])
        elif args.run_id and args.command == "resolve":
            if not args.batch_ids or len(args.batch_ids) != 1:
                raise ValueError("resolve_requires_one_batch_id")
            result = resolve_merge_conflict(workspace, feature, args.run_id, args.batch_ids[0])
        elif args.run_id:
            result = merge_run(
                workspace,
                feature,
                args.run_id,
                batch_ids=args.batch_ids,
                conflict_mode=args.conflict_mode,
            )
        else:
            raise ValueError("run_id_required_for_native_merge")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("success") else 1
    except (ValueError, OSError) as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
