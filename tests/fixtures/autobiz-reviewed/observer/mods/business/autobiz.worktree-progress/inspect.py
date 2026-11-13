#!/usr/bin/env python3
"""Read-only AutoBiz scheduler projection. Never imports project/plugin code.

Recorded stage outcomes are not current-HEAD validation or business acceptance.
All filesystem probes stay below the explicitly approved workspace. External
code repositories are displayed as out_of_scope rather than silently inspected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

API = "autobiz.worktree-progress/v1"
LIMIT = 512 * 1024
MAX_ROWS = 24
ACTIVE = {"created", "running", "merging", "verifying", "blocked", "needs_resolution"}
STAGES = ("prepare", "implement", "review", "test")


def identifier(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}", value):
        raise ValueError("invalid_identifier")
    return value


def text(value: Any, maximum: int = 240) -> str:
    return value[:maximum] if isinstance(value, str) else "unknown"


def epoch(value: Any) -> float | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError, TypeError):
        return None


def confined(root: Path, value: str | Path) -> Path:
    raw = Path(value)
    candidate = raw if raw.is_absolute() else root / raw
    # Resolve only after lexical containment; inspect every ancestor to reject
    # links/junctions instead of following arbitrary paths recorded by a manifest.
    candidate = Path(os.path.abspath(candidate))
    if not candidate.is_relative_to(root):
        raise ValueError("out_of_scope")
    current = root
    for part in candidate.relative_to(root).parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("linked_path_rejected")
    if not candidate.resolve().is_relative_to(root):
        raise ValueError("out_of_scope")
    return candidate


def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def read_json(root: Path, path: str | Path) -> tuple[dict[str, Any], bytes]:
    target = confined(root, path)
    before = target.stat()
    if not target.is_file() or before.st_size > LIMIT:
        raise ValueError("file_limit")
    with target.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        data = handle.read(LIMIT + 1)
        after = os.fstat(handle.fileno())
    # Windows path stat and handle stat expose different ctime semantics.
    # Compare ctime only on the same handle, and identity/size/mtime to the path.
    if len(data) > LIMIT or (before.st_ino, before.st_size, before.st_mtime_ns) != (
        opened.st_ino, opened.st_size, opened.st_mtime_ns
    ) or (opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
        after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
    ):
        raise ValueError("file_changed")
    if confined(root, target) != target:
        raise ValueError("file_changed")
    value = json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise ValueError("json_object_required")
    return value, data


def git(root: Path, cwd: str | Path, *arguments: str) -> str:
    directory = confined(root, cwd)
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"})
    result = subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
         "-c", "core.quotePath=false", "-C", str(directory), *arguments],
        cwd=root, env=env, capture_output=True, timeout=3, check=False,
    )
    if result.returncode != 0 or len(result.stdout) > LIMIT:
        raise ValueError("git_unavailable")
    return result.stdout.decode("utf-8", errors="strict").strip()


def inspect_git(root: Path, batch: dict[str, Any], cache: dict[str, dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "unknown", "branch": None, "head": None,
                              "registered": None, "recordedHeadMatches": None, "trackedChanges": None}
    if not isinstance(batch.get("worktreePath"), str):
        return {**result, "reason": "worktree_not_recorded"}
    try:
        worktree = confined(root, batch["worktreePath"])
        repo = confined(root, str(batch.get("gitRoot", "")))
        if not batch.get("gitRoot"):
            raise ValueError("repository_not_recorded")
        if str(repo) not in cache:
            top = git(root, repo, "rev-parse", "--show-toplevel")
            if Path(top).resolve() != repo:
                raise ValueError("repository_root_mismatch")
            records: dict[str, Any] = {}
            for record in git(root, repo, "worktree", "list", "--porcelain", "-z").split("\0\0"):
                fields = dict(part.split(" ", 1) for part in record.split("\0") if " " in part)
                if "worktree" in fields:
                    records[os.path.normcase(os.path.abspath(fields["worktree"]))] = fields
            cache[str(repo)] = records
        registered = os.path.normcase(str(worktree)) in cache[str(repo)]
        if not registered:
            return {**result, "registered": False, "reason": "not_registered_with_repository"}
        if Path(git(root, worktree, "rev-parse", "--show-toplevel")).resolve() != worktree:
            raise ValueError("worktree_root_mismatch")
        head = git(root, worktree, "rev-parse", "--verify", "HEAD")
        branch = git(root, worktree, "rev-parse", "--abbrev-ref", "HEAD")
        dirty = git(root, worktree, "status", "--porcelain=v1", "--untracked-files=no")
        match = batch.get("commitSha") == head if batch.get("commitSha") else None
        return {"status": "observed", "registered": True, "branch": branch, "head": head,
                "recordedHeadMatches": match, "trackedChanges": len(dirty.splitlines()) if dirty else 0,
                "branchMatches": branch == batch.get("branchName") if batch.get("branchName") else None}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {**result, "reason": str(error)[:120] if isinstance(error, ValueError) else "git_probe_failed"}


def task_counts(root: Path, feature: str, batch_id: str, ids: Any) -> dict[str, Any]:
    task_ids = ids if isinstance(ids, list) and all(isinstance(item, str) for item in ids) else []
    result = {"total": len(task_ids), "done": None, "known": 0, "statuses": {}}
    try:
        identifier(batch_id)
        plan, _ = read_json(root, f".autobizdevops/features/{feature}/plans/{batch_id}/plan.json")
        if plan.get("batchId") != batch_id or plan.get("featureId") != feature:
            return result
        tasks = plan.get("tasks")
        if not isinstance(tasks, list) or len(tasks) > 256:
            return result
        statuses = {item["id"]: item.get("status") for item in tasks
                    if isinstance(item, dict) and isinstance(item.get("id"), str)}
        known = [statuses[item] for item in task_ids if item in statuses]
        counts = {status: sum(value == status for value in known)
                  for status in ("todo", "in_progress", "implemented", "done", "failed", "blocked")}
        counts["unknown"] = sum(value not in counts for value in known)
        return {"total": len(task_ids), "done": sum(item == "done" for item in known),
                "known": len(known), "statuses": {key: value for key, value in counts.items() if value}}
    except (OSError, ValueError):
        return result


def stages(root: Path, run_root: Path, batch: dict[str, Any]) -> list[dict[str, Any]]:
    states = batch.get("stageStates")
    states = states if isinstance(states, dict) else {}
    result = []
    for name in STAGES:
        state = states.get(name)
        state = state if isinstance(state, dict) else {}
        evidence = "not_recorded"
        if state.get("evidencePath"):
            try:
                path = confined(root, state["evidencePath"])
                if not path.is_relative_to(run_root):
                    raise ValueError("outside_run")
                value, _ = read_json(root, path)
                recorded = value.pop("digest", None)
                calculated = "sha256:" + hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                                       separators=(",", ":")).encode()).hexdigest()
                evidence = "bytes_match" if (recorded == calculated and
                    value.get("evidenceId") == state.get("latestEvidenceId") and
                    value.get("batchId") == batch.get("batchId") and value.get("stage") == name) else "mismatch"
            except (OSError, ValueError, TypeError):
                evidence = "unavailable"
        result.append({"stage": name, "recordedStatus": text(state.get("status"), 40), "evidence": evidence})
    return result


def collect(workspace: Path, feature: str | None = None, run_id: str | None = None,
            stale_seconds: int = 300, now: float | None = None) -> dict[str, Any]:
    root = workspace.resolve(strict=True)
    started = time.monotonic()
    now = time.time() if now is None else now
    output: dict[str, Any] = {"apiVersion": API, "workspace": str(root),
        "observedAt": datetime.fromtimestamp(now, timezone.utc).isoformat(), "status": "ready",
        "runs": [], "rows": [], "diagnostics": [],
        "limits": "只读快照；阶段状态来自调度记录，证据哈希匹配也不代表当前 HEAD 检查或业务验收通过。"}
    cache: dict[str, dict[str, Any]] = {}
    try:
        features = confined(root, ".autobizdevops/features")
        names = [identifier(feature)] if feature else sorted(item.name for item in features.iterdir() if item.is_dir())
        if len(names) > 32:
            raise ValueError("feature_limit_select_one_feature")
        for name in names:
            identifier(name)
            runs_root = root / ".autobizdevops/features" / name / ".parallel-runs"
            if not runs_root.exists():
                continue
            runs_root = confined(root, runs_root)
            runs = [identifier(run_id)] if run_id else sorted(item.name for item in runs_root.iterdir() if item.is_dir())
            if len(runs) > 32:
                raise ValueError("run_limit_select_one_run")
            active_count = 0
            for run in runs:
                identifier(run)
                path = runs_root / run / "manifest.json"
                try:
                    manifest, raw = read_json(root, path)
                    if manifest.get("schemaVersion") != 2 or manifest.get("runId") != run or manifest.get("featureId") != name:
                        raise ValueError("unsupported_or_mismatched_run_manifest")
                    batches = manifest.get("batches")
                    if not isinstance(batches, dict) or len(batches) > 64:
                        raise ValueError("batch_limit_or_schema")
                    updated = epoch(manifest.get("updatedAt"))
                    age = now - updated if updated is not None else None
                    freshness = "unknown" if age is None or age < -60 else "stale" if age > stale_seconds else "recent"
                    active_count += manifest.get("status") in ACTIVE
                    projected = []
                    for batch_id, batch in batches.items():
                        identifier(batch_id)
                        if not isinstance(batch, dict) or batch.get("batchId") != batch_id:
                            raise ValueError("batch_identity")
                        if len(output["rows"]) + len(projected) >= MAX_ROWS or time.monotonic() - started > 18:
                            raise ValueError("inspection_budget_select_one_run")
                        lease = batch.get("lease")
                        expires = epoch(lease.get("expiresAt")) if isinstance(lease, dict) else None
                        projected.append({"feature": name, "runId": run, "batchId": batch_id,
                            "status": text(batch.get("status"), 40), "activeStage": text(batch.get("activeStage"), 40),
                            "freshness": freshness, "worktreePath": text(batch.get("worktreePath"), 1900),
                            "recordedBranch": text(batch.get("branchName")), "recordedCommit": text(batch.get("commitSha")),
                            "repositoryRef": text(batch.get("repositoryRef")),
                            "taskProgress": task_counts(root, name, batch_id, batch.get("taskIds")),
                            "lease": "none" if lease is None else "unknown" if expires is None else "expired" if expires < now else "recorded_unexpired",
                            "checks": stages(root, path.parent, batch), "git": inspect_git(root, batch, cache)})
                    if read_json(root, path)[1] != raw:
                        raise ValueError("manifest_changed_during_inspection")
                    output["rows"].extend(projected)
                    output["runs"].append({"feature": name, "runId": run, "status": text(manifest.get("status"), 40),
                        "freshness": freshness, "updatedAt": text(manifest.get("updatedAt")),
                        "manifestSha256": hashlib.sha256(raw).hexdigest(),
                        "mergeTrains": [{"id": text(key), "status": text(value.get("status"), 40)}
                            for key, value in (manifest.get("mergeTrains") or {}).items() if isinstance(value, dict)][:32],
                        "validationBatches": [{"id": text(key), "status": text(value.get("status"), 40)}
                            for key, value in (manifest.get("validationBatches") or {}).items() if isinstance(value, dict)][:16]})
                except (OSError, ValueError, TypeError, AttributeError) as error:
                    output["diagnostics"].append({"feature": name, "runId": run, "reason": str(error)[:160]})
            if active_count > 1:
                output["diagnostics"].append({"feature": name, "reason": "multiple_active_runs_do_not_assume_current"})
    except (OSError, ValueError) as error:
        output["diagnostics"].append({"reason": str(error)[:160]})
    output["status"] = "partial" if output["rows"] and output["diagnostics"] else "unknown" if not output["rows"] else "ready"
    output["summary"] = {"batches": len(output["rows"]),
        "recordedMerged": sum(row["status"] == "merged" for row in output["rows"]),
        "stale": sum(row["freshness"] == "stale" for row in output["rows"]),
        "gitObserved": sum(row["git"]["status"] == "observed" for row in output["rows"])}
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--feature")
    parser.add_argument("--run-id")
    args = parser.parse_args()
    print(json.dumps(collect(args.workspace, args.feature, args.run_id), ensure_ascii=False))


if __name__ == "__main__":
    main()
