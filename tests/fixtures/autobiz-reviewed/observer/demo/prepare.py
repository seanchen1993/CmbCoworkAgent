#!/usr/bin/env python3
"""Create a NEW controlled local demo using an explicitly chosen real plugin kernel.

Does not import repository tests, edit existing repositories or synthesize a run
manifest. Templates declare two todo tasks only; original production APIs validate
them and create the durable run, native Git worktrees and preparation evidence.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def prepare(target: Path, plugin_root: Path) -> dict:
    target, plugin_root = target.resolve(), plugin_root.resolve(strict=True)
    if not (plugin_root / "hooks/parallel_batch_scheduler.py").is_file():
        raise ValueError("explicit_real_autobiz_plugin_root_required")
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError("demo_target_must_be_new_or_empty")
    target.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(plugin_root))
    from hooks.parallel_batch_scheduler import create_run
    from hooks.parallel_batch_stage import start_stage, complete_stage
    from hooks.parallel_runtime import load_manifest
    from hooks.worktree_manager import provision_parallel_worktree

    workspace = target / "workspace"
    feature_dir = workspace / ".autobizdevops/features/alpha"
    feature_dir.mkdir(parents=True)
    templates = Path(__file__).resolve().parent / "templates"
    for source, relative in (("plan.json", "plan.json"), ("B001.plan.json", "plans/B001/plan.json"),
                             ("B002.plan.json", "plans/B002/plan.json")):
        path = feature_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((templates / source).read_bytes())
    repo = workspace / "repositories/default"
    repo.mkdir(parents=True)
    def git(*args: str, cwd: Path = repo) -> str:
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                              encoding="utf-8").stdout.strip()
    git("init", "-b", "main")
    git("config", "user.email", "local-demo@example.invalid")
    git("config", "user.name", "Controlled local worktree demo")
    (repo / "existing.txt").write_text("existing\n", encoding="utf-8")
    git("add", "existing.txt")
    git("commit", "-m", "Initialize controlled local demo")
    created = create_run(workspace, "alpha", max_parallel=2, timeout_seconds=600,
                         code_workspaces=[str(repo)], task_card_id="Z990692-294")
    run_id = created["runId"]
    worktrees = []
    for batch_id in ("B001", "B002"):
        result = provision_parallel_worktree(workspace, "alpha", run_id, batch_id)
        if not result.get("success"):
            raise ValueError(json.dumps(result))
        worktrees.append(result)
    head = git("rev-parse", "HEAD", cwd=Path(worktrees[0]["worktreePath"]))
    start_stage(workspace, "alpha", run_id, "B001", "prepare")
    complete_stage(workspace, "alpha", run_id, "B001", "prepare", metadata={"batchCommit": head})
    start_stage(workspace, "alpha", run_id, "B001", "implement")
    Path(worktrees[0]["worktreePath"], "existing.txt").write_text("controlled local edit\n", encoding="utf-8")
    manifest = load_manifest(workspace, "alpha", run_id)
    result = {"workspace": str(workspace), "pluginRoot": str(plugin_root), "feature": "alpha",
              "runId": run_id, "worktrees": worktrees, "runStatus": manifest["status"],
              "limits": "Controlled original scheduler/stage APIs and real Git worktrees. No full model Code execution, Review, UTest, merge or business acceptance."}
    (target / "demo.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--plugin-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.target, args.plugin_root), ensure_ascii=False))
