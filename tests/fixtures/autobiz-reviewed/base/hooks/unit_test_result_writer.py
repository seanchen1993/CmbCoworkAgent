#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Write plan-bound UNIT_TEST_RESULT.json without caller-authored verdicts."""

from __future__ import print_function

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import (  # noqa: E402
    WriterResult,
    artifact_path,
    atomic_write_json,
    fail,
    load_json,
    render_result,
    resolve_feature,
    resolve_workspace,
    with_result_data,
)
from hooks.utest_plan_contract import (  # noqa: E402
    UTestPlanContractError,
    derive_scenario_coverage,
    derive_check_matrix,
    derive_unverified_checks,
    derive_verdict,
    expand_plan_targets,
    load_utest_plan,
    plan_scenario_refs,
    public_target,
    read_evidence_records,
    result_for_evidence,
    validate_result_against_plan,
)


FILE_NAME = "UNIT_TEST_RESULT.json"
RESULTS = {"PASS", "PASS_WITH_WARNINGS", "FAIL", "BLOCKED", "SKIP"}
VERDICTS = {"PASS", "PASS_WITH_WARNINGS", "FAIL", "BLOCKED"}


def _path(workspace, feature):
    return artifact_path(workspace, feature, FILE_NAME)


def _feature_dir(workspace, feature):
    return workspace / ".autobizdevops" / "features" / feature


def _write(workspace, feature, data):
    changed = atomic_write_json(_path(workspace, feature), data)
    return WriterResult(ok=True, path=_path(workspace, feature), changed=changed)


def _evidence_by_id(feature_dir):
    return {
        record.get("evidenceId"): record
        for record in read_evidence_records(feature_dir)
        if isinstance(record.get("evidenceId"), str)
    }


def _initial_from_plan(feature_dir):
    plan = load_utest_plan(feature_dir)
    plan_targets = expand_plan_targets(plan)
    targets = [public_target(target) for target in plan_targets]
    evidence_by_id = {}
    checks = derive_check_matrix(targets, plan_targets)
    return {
        "version": 1,
        "verdict": derive_verdict(targets, plan_targets),
        "targets": targets,
        "scenarioCoverage": derive_scenario_coverage(
            plan_targets,
            targets,
            evidence_by_id,
            scenario_refs=plan_scenario_refs(plan),
        ),
        "checks": checks,
        "unverifiedChecks": derive_unverified_checks(checks),
    }


def ensure_plan_result(workspace, feature, create=True):
    """Load the result only when its complete target set matches the current plan."""
    workspace = resolve_workspace(workspace)
    feature = resolve_feature(feature)
    path = _path(workspace, feature)
    feature_dir = _feature_dir(workspace, feature)
    if not path.is_file():
        if not create:
            raise ValueError(
                "{} 不存在。修复：运行 unit_test_result_writer.py init --from-plan。".format(
                    FILE_NAME
                )
            )
        data = _initial_from_plan(feature_dir)
        return data, _write(workspace, feature, data)
    data = load_json(path)
    errors = validate_result_against_plan(feature_dir, data)
    if errors:
        raise ValueError(
            "{} 与当前 TASK 测试契约不一致：{}。修复：不要手改结果；恢复可信 Evidence 后按 plan 重建。".format(
                FILE_NAME, ",".join(errors)
            )
        )
    return data, WriterResult(ok=True, path=path, changed=False)


def _refresh_derived(feature_dir, data, plan, plan_targets, evidence_by_id):
    del feature_dir
    data["verdict"] = derive_verdict(data["targets"], plan_targets)
    data["scenarioCoverage"] = derive_scenario_coverage(
        plan_targets,
        data["targets"],
        evidence_by_id,
        scenario_refs=plan_scenario_refs(plan),
    )
    data["checks"] = derive_check_matrix(
        data["targets"], plan_targets, data.get("runtimeBlock")
    )
    data["unverifiedChecks"] = derive_unverified_checks(data["checks"])


def record_runtime_block(workspace, feature, payload):
    """Record an inspector-owned block and derive the closed check matrix."""
    workspace = resolve_workspace(workspace)
    feature = resolve_feature(feature)
    feature_dir = _feature_dir(workspace, feature)
    data, _ = ensure_plan_result(workspace, feature, create=True)
    data["runtimeBlock"] = {
        "reasonCode": str(payload.get("status", "environment_inspection_failed")),
        "requiredAction": str(payload.get("requiredAction", "inspect_environment")),
    }
    plan = load_utest_plan(feature_dir)
    plan_targets = expand_plan_targets(plan)
    _refresh_derived(feature_dir, data, plan, plan_targets, _evidence_by_id(feature_dir))
    errors = validate_result_against_plan(feature_dir, data)
    if errors:
        raise ValueError(
            "UTest blocked matrix 派生失败：{}。修复：重建 plan-bound result。".format(
                ",".join(errors)
            )
        )
    return data, _write(workspace, feature, data)


def record_execution(
    workspace,
    feature,
    *,
    target_id,
    task_id,
    command_id,
    task_digest,
    evidence_id,
    result=None,
    command=None,
    spec_refs=None,
    covers=None
):
    """Bind one existing Evidence row to its canonical plan target."""
    workspace = resolve_workspace(workspace)
    feature = resolve_feature(feature)
    feature_dir = _feature_dir(workspace, feature)
    plan = load_utest_plan(feature_dir)
    plan_targets = expand_plan_targets(plan)
    expected = next(
        (
            target
            for target in plan_targets
            if target["taskId"] == task_id and target["commandId"] == command_id
        ),
        None,
    )
    if expected is None:
        raise ValueError(
            "task_id/command_id 未映射当前 UTest target。修复：使用 router 生成的任务绑定。"
        )
    for label, actual, wanted in (
        ("target_id", target_id, expected["targetId"]),
        ("task_digest", task_digest, expected["taskDigest"]),
        ("spec_refs", spec_refs, expected["specRefs"]),
        ("covers", covers, expected["covers"]),
    ):
        if actual is not None and actual != wanted:
            raise ValueError(
                "{} 与当前 assignment 不一致。修复：重新运行 router 并使用当前任务绑定。".format(
                    label
                )
            )
    data, _ = ensure_plan_result(workspace, feature, create=True)
    target = next(
        (
            item
            for item in data["targets"]
            if isinstance(item, dict) and item.get("targetId") == expected["targetId"]
        ),
        None,
    )
    if target is None:
        raise ValueError(
            "target 缺失。修复：从当前 plan TASK 重新初始化 UNIT_TEST_RESULT.json。"
        )
    if target.get("taskDigest") != expected["taskDigest"]:
        raise ValueError(
            "target taskDigest 与当前 plan 不一致。修复：不要把旧 target 用于新计划重跑。"
        )
    evidence_by_id = _evidence_by_id(feature_dir)
    evidence = evidence_by_id.get(evidence_id)
    if evidence is None:
        raise ValueError(
            "Evidence 不存在：{}。修复：传入本次 runner 追加的 evidenceId。".format(
                evidence_id
            )
        )
    validation = evidence.get("validation")
    if not isinstance(validation, dict):
        raise ValueError(
            "Evidence validation 缺失。修复：使用 run_utest_command.py 生成测试 Evidence。"
        )
    for label, actual, wanted in (
        ("Evidence taskId", evidence.get("taskId"), expected["taskId"]),
        ("Evidence taskDigest", evidence.get("taskDigest"), expected["taskDigest"]),
        ("Evidence specRefs", evidence.get("specRefs"), expected["specRefs"]),
        ("Evidence covers", evidence.get("covers"), expected["covers"]),
        ("Evidence commandId", validation.get("commandId"), expected["commandId"]),
    ):
        if actual != wanted:
            raise ValueError(
                "{} 与当前 assignment 不一致。修复：丢弃旧转述，重新运行 router。".format(
                    label
                )
            )
    if command is not None and command != validation.get("command"):
        raise ValueError(
            "command 与 Evidence 不一致。修复：使用本次 runner 记录的真实测试命令。"
        )
    derived_result = result_for_evidence(evidence)
    if result is not None and result != derived_result:
        raise ValueError(
            "result 不能自由自报。修复：使用 Evidence exitCode/result 派生值 {}。".format(
                derived_result
            )
        )
    if evidence_id not in target["evidenceIds"]:
        target["evidenceIds"].append(evidence_id)
    target["result"] = derived_result
    target["command"] = validation.get("command")
    data.pop("runtimeBlock", None)
    _refresh_derived(feature_dir, data, plan, plan_targets, evidence_by_id)
    errors = validate_result_against_plan(feature_dir, data)
    if errors:
        raise ValueError(
            "结果派生失败：{}。修复：检查 plan/Evidence 绑定后重试。".format(
                ",".join(errors)
            )
        )
    return with_result_data(_write(workspace, feature, data), target=target)


record_test_execution = record_execution


def _resolve(args):
    return resolve_workspace(args.workspace), resolve_feature(args.feature)


def _cmd_init(args):
    workspace, feature = _resolve(args)
    feature_dir = _feature_dir(workspace, feature)
    data = _initial_from_plan(feature_dir)
    path = _path(workspace, feature)
    if path.is_file() and not args.force:
        existing = load_json(path)
        errors = validate_result_against_plan(feature_dir, existing)
        if errors:
            return render_result(
                fail("unit_test_result_plan_mismatch", ",".join(errors))
            )
        return render_result(WriterResult(ok=True, path=path, changed=False))
    return render_result(
        with_result_data(_write(workspace, feature, data), reset=bool(args.force))
    )


def _cmd_plan_authority_only(args):
    del args
    return render_result(
        fail(
            "unit_test_targets_are_plan_authoritative",
            "修复：用 init --from-plan 初始化，并由 run_utest_command.py 记录执行。",
        )
    )


def _cmd_record_execution(args):
    workspace, feature = _resolve(args)
    return render_result(
        record_execution(
            workspace,
            feature,
            target_id=args.target_id,
            task_id=args.task_id,
            command_id=args.command_id,
            task_digest=args.task_digest,
            evidence_id=args.evidence_id,
            result=args.result,
            command=args.command,
            spec_refs=args.spec_ref,
            covers=args.cover,
        )
    )


def _cmd_derive(args):
    workspace, feature = _resolve(args)
    data, _ = ensure_plan_result(workspace, feature, create=False)
    plan = load_utest_plan(_feature_dir(workspace, feature))
    plan_targets = expand_plan_targets(plan)
    _refresh_derived(
        _feature_dir(workspace, feature),
        data,
        plan,
        plan_targets,
        _evidence_by_id(_feature_dir(workspace, feature)),
    )
    return render_result(_write(workspace, feature, data))


def _cmd_validate(args):
    workspace, feature = _resolve(args)
    path = _path(workspace, feature)
    if not path.is_file():
        return render_result(fail("missing_unit_test_result", "修复：运行 init --from-plan。"))
    data = load_json(path)
    errors = [
        {"reason": reason}
        for reason in validate_result_against_plan(_feature_dir(workspace, feature), data)
    ]
    if data.get("version") != 1:
        errors.append({"reason": "invalid_unit_test_result_version"})
    return render_result(WriterResult(ok=not errors, path=path, errors=errors))


def _cmd_show(args):
    workspace, feature = _resolve(args)
    data, _ = ensure_plan_result(workspace, feature, create=False)
    return render_result(
        WriterResult(
            ok=True,
            path=_path(workspace, feature),
            data={
                "summary": {
                    "verdict": data.get("verdict"),
                    "targets": len(data.get("targets", [])),
                    "scenarioCoverage": len(data.get("scenarioCoverage", [])),
                }
            },
        )
    )


def _common(parser):
    parser.add_argument("--workspace")
    parser.add_argument("--feature")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write plan-bound UNIT_TEST_RESULT.json")
    sub = parser.add_subparsers(dest="subcommand")

    init = sub.add_parser("init")
    _common(init)
    init.add_argument("--force", action="store_true")
    init.add_argument("--from-plan", action="store_true")
    init.set_defaults(func=_cmd_init)

    add = sub.add_parser("add-target")
    _common(add)
    add.add_argument("--target-id")
    add.add_argument("--task-id", required=True)
    add.add_argument("--spec-ref", action="append")
    add.add_argument("--evidence-id", action="append")
    add.add_argument("--result", default="BLOCKED", choices=sorted(RESULTS))
    add.add_argument("--command", required=True)
    add.set_defaults(func=_cmd_plan_authority_only, writer_command="add-target")

    update = sub.add_parser("update-target")
    _common(update)
    update.add_argument("--target-id", required=True)
    update.set_defaults(func=_cmd_plan_authority_only)

    execution = sub.add_parser("record-execution")
    _common(execution)
    execution.add_argument("--target-id", required=True)
    execution.add_argument("--task-id", required=True)
    execution.add_argument("--command-id", required=True)
    execution.add_argument("--task-digest", required=True)
    execution.add_argument("--spec-ref", action="append")
    execution.add_argument("--cover", action="append")
    execution.add_argument("--evidence-id", required=True)
    execution.add_argument("--result", choices=sorted(RESULTS))
    execution.add_argument("--command")
    execution.set_defaults(func=_cmd_record_execution)

    verdict = sub.add_parser("set-verdict")
    _common(verdict)
    verdict.add_argument("verdict", choices=sorted(VERDICTS))
    verdict.set_defaults(func=_cmd_plan_authority_only)

    coverage = sub.add_parser("derive-scenario-coverage")
    _common(coverage)
    coverage.set_defaults(func=_cmd_derive)

    validate = sub.add_parser("validate")
    _common(validate)
    validate.add_argument("--structure", action="store_true")
    validate.add_argument("--gate", action="store_true")
    validate.set_defaults(func=_cmd_validate)

    show = sub.add_parser("show")
    _common(show)
    show.add_argument("--summary", action="store_true")
    show.set_defaults(func=_cmd_show)

    args = parser.parse_args(argv)
    if not getattr(args, "subcommand", None):
        parser.error("需要子命令。修复：使用 init/record-execution/validate/show。")
    try:
        if getattr(args, "writer_command", args.subcommand) == "add-target":
            missing = [
                name
                for name in ("spec_ref", "evidence_id")
                if not getattr(args, name)
            ]
            if missing:
                return render_result(
                    fail("missing_unit_target_trace_args", ",".join(missing))
                )
        return args.func(args)
    except (UTestPlanContractError, ValueError, OSError) as exc:
        return render_result(
            fail(
                "unit_test_result_writer_failed",
                "{}。修复：检查当前 plan、Evidence 与结果绑定。".format(exc),
            )
        )


if __name__ == "__main__":
    raise SystemExit(main())
