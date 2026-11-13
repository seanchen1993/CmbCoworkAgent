#!/usr/bin/env python3
"""Controlled replay: ORIGINAL task_runner starts T001, never finishes/accepts it.

Accepts only a demo.json made by prepare.py and its exact local two-worktree
layout. No arbitrary command/path/Task can be supplied. A lease remains bound to
this local replay; no lease secret is printed or returned to the observer.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def advance(path: Path) -> dict:
    path = path.resolve(strict=True)
    demo = json.loads(path.read_text(encoding="utf-8"))
    workspace = path.parent / "workspace"
    plugin_root = Path(demo["pluginRoot"]).resolve(strict=True)
    if workspace.resolve() != Path(demo["workspace"]).resolve() or demo["feature"] != "alpha":
        raise ValueError("controlled_demo_identity_required")
    run_id = demo["runId"]
    if not isinstance(run_id, str) or any(part in run_id for part in ("/", "\\", ":", "..")):
        raise ValueError("controlled_demo_run_required")
    expected = (workspace / ".autobizdevops/worktrees" / run_id / "B001").resolve(strict=True)
    worktree = Path(demo["worktrees"][0]["worktreePath"]).resolve(strict=True)
    if worktree != expected or not worktree.is_relative_to(workspace.resolve()):
        raise ValueError("controlled_demo_worktree_required")
    if (path.parent / "advance.json").exists():
        raise ValueError("demo_already_advanced_use_a_new_target")
    sys.path.insert(0, str(plugin_root))
    from hooks.init_workspace import init_workspace
    from hooks.parallel_runtime import acquire_lease
    from hooks.task_runner import start_task
    # Establish canonical project metadata through the original initializer.
    init_workspace(workspace)
    file = worktree / "existing.txt"
    content = file.read_bytes()
    if content.decode("utf-8").replace("\r\n", "\n") != "controlled local edit\n":
        raise ValueError("controlled_demo_file_changed_refuse_to_overwrite")
    original = subprocess.run(["git", "show", "HEAD:existing.txt"], cwd=worktree,
                              check=True, capture_output=True).stdout
    if original.decode("utf-8").replace("\r\n", "\n") != "existing\n":
        raise ValueError("controlled_demo_original_head_changed")
    # Undo only the exact fixture edit before the real Task start snapshot.
    file.write_bytes(original)
    lease = acquire_lease(workspace, "alpha", run_id, "B001", ttl_seconds=900)
    result = start_task(workspace, "alpha", "T001", worktree,
                        parallel_run_id=run_id, lease_token=lease["ownerToken"], workspace_ref="default")
    file.write_text("controlled task T001 is in progress\n", encoding="utf-8")
    output = {"workspace": str(workspace), "feature": "alpha", "runId": run_id,
              "taskId": "T001", "taskRunId": result.get("runId"), "taskStatus": result.get("status"),
              "limits": "Original task_runner start only; no implementation finish, Review, UTest, merge or acceptance."}
    (path.parent / "advance.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(advance(args.demo), ensure_ascii=False))
