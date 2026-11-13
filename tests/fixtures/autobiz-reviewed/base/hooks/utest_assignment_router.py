#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build stable UTest assignments from root and Batch plans."""

from __future__ import print_function

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import resolve_feature, resolve_workspace  # noqa: E402
from hooks.utest_plan_contract import (  # noqa: E402
    UTestPlanContractError,
    assignment_task,
    load_utest_plan,
)


PREFERRED_LANES = ("backend", "frontend")


class UTestAssignmentError(Exception):
    """Raised when plan facts cannot form safe assignments."""


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise UTestAssignmentError(
            "命令参数无效：{}。修复：运行 `{} --help` 并传入 workspace/feature。".format(
                message, self.prog
            )
        )


def _prompt_task(task):
    """Project only the plan facts the test engineer needs in its prompt."""
    return {
        "id": task["id"],
        "outcome": task["goal"],
        "implementationPoints": task.get("implementationPoints", []),
        "testPoints": task.get("testPoints", []),
        "verificationIntent": task.get("verificationIntent", task["validationBoundary"]),
        "validationLocations": list(task["validationLocations"]),
    }


def assignment_prompt_payload(assignment):
    """Build the minimal, mechanically rendered subagent context."""
    return {
        "batchPlanPath": assignment["planPath"],
        "batchId": assignment["batchId"],
        "executionLane": assignment["executionLane"],
        "workspaceRef": assignment["workspaceRef"],
        "tasks": [_prompt_task(task) for task in assignment["tasks"]],
    }


def render_assignment_prompt(assignment):
    """Render the minimal, plan-derived content handed to the test engineer."""
    payload = assignment_prompt_payload(assignment)
    return "<UTEST_ASSIGNMENT>\n{}\n</UTEST_ASSIGNMENT>".format(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)
    )


def _plan_for_batch_path(batch_plan_path):
    if not isinstance(batch_plan_path, str) or not batch_plan_path.strip():
        raise UTestAssignmentError(
            "batchPlanPath 缺失。修复：重新运行 router，原样使用 promptContent。"
        )
    requested = Path(batch_plan_path).expanduser()
    path = requested.resolve()
    if not requested.is_absolute() or not path.is_file():
        raise UTestAssignmentError(
            "batchPlanPath 不是现有绝对文件：{}。修复：重新运行 router，原样使用 promptContent。".format(
                batch_plan_path
            )
        )
    for feature_dir in path.parents:
        root_plan = feature_dir / "plan.json"
        if not root_plan.is_file() or root_plan.resolve() == path:
            continue
        try:
            plan = load_utest_plan(feature_dir)
        except UTestPlanContractError:
            continue
        for batch in plan["batches"]:
            candidate = (plan["featureDir"] / batch["planPath"]).resolve()
            if candidate == path:
                return plan, batch
    raise UTestAssignmentError(
        "batchPlanPath 不属于可验证的 Feature plan：{}。修复：重新运行 router，原样使用 promptContent。".format(
            path
        )
    )


def validate_assignment_prompt_payload(payload):
    """Verify a prompt payload against its authoritative Batch plan."""
    if not isinstance(payload, dict):
        raise UTestAssignmentError(
            "UTEST_ASSIGNMENT 顶层不是 object。修复：重新运行 router，原样使用 promptContent。"
        )
    plan, batch = _plan_for_batch_path(payload.get("batchPlanPath"))
    workspace_ref = payload.get("workspaceRef")
    matching_tasks = [
        assignment_task(task)
        for task in batch["tasks"]
        if task["workspaceRef"] == workspace_ref
    ]
    if not matching_tasks:
        raise UTestAssignmentError(
            "UTEST_ASSIGNMENT workspaceRef 不属于该 Batch。修复：重新运行 router，原样使用 promptContent。"
        )
    expected = assignment_prompt_payload(
        {
            "planPath": str((plan["featureDir"] / batch["planPath"]).resolve()),
            "batchId": batch["batchId"],
            "executionLane": batch["executionLane"],
            "workspaceRef": workspace_ref,
            "tasks": matching_tasks,
        }
    )
    if payload != expected:
        raise UTestAssignmentError(
            "UTEST_ASSIGNMENT 与当前 Batch plan 不一致。修复：丢弃人工转述，重新运行 router 并原样使用 promptContent。"
        )
    return expected


def build_assignments(feature_dir):
    try:
        plan = load_utest_plan(feature_dir)
    except UTestPlanContractError as exc:
        raise UTestAssignmentError(str(exc))
    assignments = []
    for batch in plan["batches"]:
        groups = []
        by_workspace = {}
        for task in batch["tasks"]:
            workspace_ref = task["workspaceRef"]
            assignment = by_workspace.get(workspace_ref)
            if assignment is None:
                assignment = {
                    "batchId": batch["batchId"],
                    "executionLane": batch["executionLane"],
                    "workspaceRef": workspace_ref,
                    "taskIds": [],
                    "tasks": [],
                    "planPath": str((plan["featureDir"] / batch["planPath"]).resolve()),
                    "rootOrder": batch["rootOrder"],
                }
                by_workspace[workspace_ref] = assignment
                groups.append(assignment)
            assignment["taskIds"].append(task["id"])
            assignment["tasks"].append(assignment_task(task))
        assignments.extend(groups)

    lane_rank = {lane: index for index, lane in enumerate(PREFERRED_LANES)}
    assignments.sort(
        key=lambda item: (
            lane_rank.get(item["executionLane"], len(PREFERRED_LANES)),
            item["rootOrder"],
        )
    )
    for assignment in assignments:
        assignment.pop("rootOrder", None)
        assignment["promptContent"] = render_assignment_prompt(assignment)
        assignment.pop("tasks", None)
    return assignments


def main(argv=None):
    parser = RepairArgumentParser(description="生成稳定 UTest assignment 顺序")
    parser.add_argument("--workspace")
    parser.add_argument("--feature")
    parser.add_argument("--feature-dir")
    parser.add_argument("--json", action="store_true", help="输出稳定 JSON（默认格式）")
    try:
        args = parser.parse_args(argv)
        if args.feature_dir:
            if args.workspace or args.feature:
                raise UTestAssignmentError(
                    "--feature-dir 不能与 --workspace/--feature 混用。修复：只保留一种定位方式。"
                )
            feature_dir = Path(args.feature_dir)
        else:
            if not args.workspace or not args.feature:
                raise UTestAssignmentError(
                    "缺少 --workspace/--feature。修复：传入插件输出工作区和 Feature。"
                )
            workspace = resolve_workspace(args.workspace)
            feature = resolve_feature(args.feature)
            feature_dir = workspace / ".autobizdevops" / "features" / feature
        result = {"assignments": build_assignments(feature_dir)}
    except UTestAssignmentError as exc:
        print("utest_assignment_router_failed: {}".format(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            "utest_assignment_router_failed: {}。修复：检查 workspace、feature 和计划产物。".format(exc),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
