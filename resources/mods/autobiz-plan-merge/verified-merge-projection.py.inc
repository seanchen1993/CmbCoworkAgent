def _verified_parallel_batch_merge(
    workspace: Path | None,
    feature: str | None,
    batch_id: str,
    previous: dict[str, Any],
    batch_tasks: list[dict[str, Any]],
) -> bool:
    """Project completion only from the original Git/Plan promotion saga.

    This is a read-only check. It never creates receipts, changes a runtime
    manifest or treats task status / caller-supplied SHA as merge authority.
    """
    if workspace is None or feature is None or not batch_tasks:
        return False
    if any(normalize_status(task.get("status")) != "done" for task in batch_tasks):
        return False
    commit = previous.get("mergeCommitSha")
    run_id = previous.get("deliveryRunId")
    merged_at = previous.get("mergedAt")
    if (not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit)
            or not isinstance(run_id, str)
            or not re.fullmatch(r"cw-\d{8}-\d{6}-\d{3}(?:-\d{3})?", run_id)
            or not isinstance(merged_at, str)):
        return False
    import subprocess
    try:
        timestamp = datetime.fromisoformat(merged_at.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            return False
        from hooks.parallel_runtime import load_manifest, manifest_path
        from hooks.parallel_evidence_aggregate import _evidence_errors

        path = manifest_path(workspace, feature, run_id)
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
            return False
        manifest = load_manifest(workspace, feature, run_id)
        if manifest.get("featureId") != feature or manifest.get("schemaVersion") != 2:
            return False
        batch = manifest.get("batches", {}).get(batch_id)
        if not isinstance(batch, dict) or batch.get("batchId") != batch_id:
            return False
        task_ids = sorted(str(task.get("id")) for task in batch_tasks)
        if sorted(batch.get("taskIds") or []) != task_ids:
            return False
        if batch.get("status") not in {"ready_to_candidate", "merged"}:
            return False
        if batch.get("status") == "merged" and batch.get("mergeCommitSha") != commit:
            return False
        states = batch.get("stageStates")
        if not isinstance(states, dict) or any(
                not isinstance(states.get(stage), dict) or states[stage].get("status") != "passed"
                for stage in ("prepare", "implement", "review", "test")):
            return False
        if _evidence_errors(manifest, batch_id, batch):
            return False
        repository_ref = batch.get("repositoryRef") or batch.get("workspaceRef")
        binding = manifest.get("repositories", {}).get(repository_ref)
        if not isinstance(binding, dict) or not isinstance(binding.get("gitRoot"), str):
            return False
        delivery = batch.get("commitSha")
        if not isinstance(delivery, str) or not re.fullmatch(r"[0-9a-f]{40}", delivery):
            return False
        matching_train = False
        for train in (manifest.get("mergeTrains") or {}).values():
            if (not isinstance(train, dict) or train.get("repositoryRef") != repository_ref
                    or batch_id not in (train.get("batchIds") or [])
                    or train.get("candidateSha") != commit or train.get("promotedSha") != commit
                    or (train.get("deliveryCommits") or {}).get(batch_id) != delivery):
                continue
            if train.get("status") == "promoted":
                matching_train = True
            elif train.get("status") == "needs_resolution":
                resolution = train.get("resolution")
                matching_train = (isinstance(resolution, dict)
                    and resolution.get("kind") == "promoted_plan_state_update"
                    and resolution.get("deliveryRunId") == run_id
                    and resolution.get("repositoryRef") == repository_ref
                    and resolution.get("candidateSha") == commit
                    and resolution.get("promotedSha") == commit
                    and batch_id in (resolution.get("batchIds") or []))
            if matching_train:
                break
        if not matching_train:
            return False
        repo = Path(binding["gitRoot"])
        if not repo.is_absolute() or repo.is_symlink():
            return False
        def read_git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                text=True, encoding="utf-8", timeout=15, check=False)
        root = read_git("rev-parse", "--show-toplevel")
        head = read_git("rev-parse", "HEAD")
        if (root.returncode or head.returncode or Path(root.stdout.strip()).resolve() != repo.resolve()
                or head.stdout.strip() != binding.get("headSha")):
            return False
        # A later legitimate wave may advance HEAD: the earlier merge must
        # still be its ancestor and retain its exact original train receipt.
        if read_git("merge-base", "--is-ancestor", commit, "HEAD").returncode:
            return False
        if read_git("merge-base", "--is-ancestor", delivery, commit).returncode:
            return False
        return True
    except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return False


