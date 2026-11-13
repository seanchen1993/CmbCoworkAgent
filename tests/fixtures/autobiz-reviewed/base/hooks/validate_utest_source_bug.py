#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate that a source_bug claim is anchored by current failing test evidence."""

from __future__ import print_function

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import load_json, resolve_feature, resolve_workspace  # noqa: E402
from hooks.utest_plan_contract import (  # noqa: E402
    UTestPlanContractError,
    validate_source_bug,
)


class SourceBugValidationError(ValueError):
    """Raised when a source_bug claim has no trusted failing-test anchor."""


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise SourceBugValidationError(
            "命令参数无效：{}。修复：传入 target/task/command/digest/evidence 五项绑定。".format(
                message
            )
        )


def validate_claim(workspace, feature, task_id, command_id, target_id, task_digest, evidence_id):
    workspace = resolve_workspace(workspace)
    feature = resolve_feature(feature)
    feature_dir = workspace / ".autobizdevops" / "features" / feature
    result_path = feature_dir / "UNIT_TEST_RESULT.json"
    if not result_path.is_file():
        raise SourceBugValidationError(
            "UNIT_TEST_RESULT.json 不存在。修复：先用权威 test command 生成失败 Evidence。"
        )
    data = load_json(result_path)
    try:
        binding = validate_source_bug(
            feature_dir,
            data,
            task_id,
            command_id,
            target_id,
            task_digest,
            evidence_id,
        )
    except UTestPlanContractError as exc:
        raise SourceBugValidationError(str(exc))
    return {
        "ok": True,
        "classification": "source_bug",
        "sourceBugAttestation": binding,
    }


def main(argv=None):
    parser = RepairArgumentParser(description="校验 UTest source_bug 失败测试锚点")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--command-id", required=True)
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--task-digest", required=True)
    parser.add_argument("--evidence-id", required=True)
    try:
        args = parser.parse_args(argv)
        result = validate_claim(
            args.workspace,
            args.feature,
            args.task_id,
            args.command_id,
            args.target_id,
            args.task_digest,
            args.evidence_id,
        )
    except (SourceBugValidationError, ValueError, OSError) as exc:
        print(
            "validate_utest_source_bug_failed: {}。修复：用当前 plan 对应的非零失败测试 Evidence 重试。".format(
                exc
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
