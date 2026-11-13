#!/usr/bin/env python3
"""CLI for resolving and managing conflicted merge candidates."""

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

from hooks.conflict_types import CandidateStatus
from hooks.json_writer_common import resolve_feature, resolve_workspace
from hooks.parallel_runtime import load_manifest, run_lock, save_manifest, utc_now


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _record_key(repository_ref: str, wave: int) -> str:
    return f"{repository_ref}:wave-{wave:03d}"


def resume_candidate(
    workspace: Path,
    feature: str,
    run_id: str,
    *,
    wave: int,
    repository_ref: str,
) -> dict[str, Any]:
    """Resume a conflicted candidate after manual resolution.

    This command:
    1. Checks if candidate worktree conflicts are resolved
    2. Updates manifest status from candidate_conflicted to built
    3. Returns success so workflow can continue with verification
    """
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        train_key = _record_key(repository_ref, wave)
        train = manifest.get("mergeTrains", {}).get(train_key)

        if not train:
            raise ValueError(f"merge_train_not_found:{repository_ref}:wave-{wave}")

        if train.get("status") not in {
            CandidateStatus.CANDIDATE_CONFLICTED.value,
            CandidateStatus.NEEDS_RESOLUTION.value,
        }:
            raise ValueError(
                f"merge_train_not_conflicted:{train.get('status')}:"
                f"expected candidate_conflicted or needs_resolution"
            )

        worktree_path = Path(train.get("worktreePath", ""))
        if not worktree_path.exists():
            raise ValueError(f"candidate_worktree_missing:{worktree_path}")

        # Check if conflicts are resolved
        status_result = _git(worktree_path, "status", "--porcelain")
        if status_result.returncode != 0:
            raise ValueError(f"git_status_failed:{status_result.stderr}")

        # Check for unmerged files
        for line in status_result.stdout.splitlines():
            if line.startswith("U ") or line.startswith("UU "):
                unmerged_file = line[3:].strip()
                raise ValueError(
                    f"unresolved_conflicts_remain:{unmerged_file}:"
                    f"Please resolve all conflicts, git add, and git commit"
                )

        # Get new candidate SHA
        sha_result = _git(worktree_path, "rev-parse", "HEAD")
        if sha_result.returncode != 0:
            raise ValueError(f"git_rev_parse_failed:{sha_result.stderr}")

        new_candidate_sha = sha_result.stdout.strip()

        # Update train status
        train["status"] = CandidateStatus.BUILT.value
        train["candidateSha"] = new_candidate_sha
        train["resolvedAt"] = utc_now()
        train["resolutionMethod"] = "manual"

        # Clear conflict context
        train.pop("conflictContext", None)

        save_manifest(workspace, feature, run_id, manifest)

    return {
        "success": True,
        "repositoryRef": repository_ref,
        "wave": wave,
        "candidateSha": new_candidate_sha,
        "status": CandidateStatus.BUILT.value,
        "message": "Candidate resumed successfully. Ready for verification.",
    }


def discard_candidate(
    workspace: Path,
    feature: str,
    run_id: str,
    *,
    wave: int,
    repository_ref: str,
) -> dict[str, Any]:
    """Discard a conflicted candidate and clean up worktree.

    This allows the workflow to be restarted fresh or the conflicting
    batches to be excluded.
    """
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        train_key = _record_key(repository_ref, wave)
        train = manifest.get("mergeTrains", {}).get(train_key)

        if not train:
            raise ValueError(f"merge_train_not_found:{repository_ref}:wave-{wave}")

        worktree_path = Path(train.get("worktreePath", ""))
        branch_name = train.get("branchName", "")

        # Get repository path
        repo_binding = manifest.get("repositories", {}).get(repository_ref)
        if not repo_binding or not isinstance(repo_binding.get("gitRoot"), str):
            raise ValueError(f"repository_binding_missing:{repository_ref}")

        repo_path = Path(repo_binding["gitRoot"])

        # Remove worktree
        errors = []
        if worktree_path.exists():
            result = _git(repo_path, "worktree", "remove", "--force", str(worktree_path))
            if result.returncode != 0:
                errors.append(f"worktree_remove_failed:{result.stderr}")

        # Prune worktrees
        _git(repo_path, "worktree", "prune")

        # Delete branch if exists
        if branch_name:
            result = _git(repo_path, "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}")
            if result.returncode == 0:
                result = _git(repo_path, "branch", "-D", branch_name)
                if result.returncode != 0:
                    errors.append(f"branch_delete_failed:{result.stderr}")

        # Update manifest
        train["status"] = "discarded"
        train["discardedAt"] = utc_now()
        train.pop("worktreePath", None)
        train.pop("branchName", None)

        save_manifest(workspace, feature, run_id, manifest)

    return {
        "success": True,
        "repositoryRef": repository_ref,
        "wave": wave,
        "status": "discarded",
        "errors": errors,
        "message": "Candidate discarded. Worktree and branch removed.",
    }


def list_conflicted(
    workspace: Path,
    feature: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    """List all conflicted candidates in the current run."""
    from hooks.parallel_runtime import get_active_run

    if run_id is None:
        run_id = get_active_run(workspace, feature)
        if run_id is None:
            return {"conflicted": [], "message": "No active run"}

    manifest = load_manifest(workspace, feature, run_id)
    merge_trains = manifest.get("mergeTrains", {})

    conflicted = []
    for train_key, train in merge_trains.items():
        if train.get("status") in {
            CandidateStatus.CANDIDATE_CONFLICTED.value,
            CandidateStatus.NEEDS_RESOLUTION.value,
        }:
            conflict_ctx = train.get("conflictContext", {})
            conflicted.append({
                "trainKey": train_key,
                "repositoryRef": train.get("repositoryRef"),
                "wave": train.get("wave"),
                "batchIds": train.get("batchIds", []),
                "conflictedFiles": conflict_ctx.get("conflictedFiles", []),
                "worktreePath": conflict_ctx.get("candidateWorktree") or train.get("worktreePath"),
                "attempts": conflict_ctx.get("attempts", 0),
            })

    return {
        "runId": run_id,
        "conflicted": conflicted,
        "count": len(conflicted),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Manage conflicted merge candidates"
    )
    parser.add_argument(
        "command",
        choices=("resume", "discard", "list"),
        help="Command to execute",
    )
    parser.add_argument("--workspace")
    parser.add_argument("--feature", required=True)
    parser.add_argument("--run-id")
    parser.add_argument("--wave", type=int)
    parser.add_argument("--repository-ref")

    args = parser.parse_args(argv)

    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)

        if args.command == "list":
            result = list_conflicted(workspace, feature, args.run_id)
        elif args.command == "resume":
            if not args.wave or not args.repository_ref or not args.run_id:
                raise ValueError("resume requires --wave, --repository-ref, and --run-id")
            result = resume_candidate(
                workspace,
                feature,
                args.run_id,
                wave=args.wave,
                repository_ref=args.repository_ref,
            )
        elif args.command == "discard":
            if not args.wave or not args.repository_ref or not args.run_id:
                raise ValueError("discard requires --wave, --repository-ref, and --run-id")
            result = discard_candidate(
                workspace,
                feature,
                args.run_id,
                wave=args.wave,
                repository_ref=args.repository_ref,
            )
        else:
            raise ValueError(f"unknown_command:{args.command}")

        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    except (ValueError, FileNotFoundError) as exc:
        print(json.dumps({"success": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
