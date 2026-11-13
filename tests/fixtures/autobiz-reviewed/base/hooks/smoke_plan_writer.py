#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Incrementally write SMOKE_TEST_PLAN.json."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import (  # noqa: E402
    WriterResult,
    artifact_path,
    atomic_write_json,
    fail,
    fail_if_artifact_exists,
    load_json,
    next_numbered_id,
    read_object_file,
    render_result,
    require_finalized_plan,
    resolve_feature,
    resolve_workspace,
    with_result_data,
)


SMOKE_PLAN_FILE = "SMOKE_TEST_PLAN.json"
SMOKE_RESULT_FILE = "SMOKE_RESULT.json"
SMOKE_TYPES = {"startup", "api", "ui", "cli", "migration", "health", "custom"}
SMOKE_SEAM_TYPES = {"startup", "api", "http", "ui", "cli", "job", "migration", "health", "custom"}
SMOKE_SOURCE_PREFIXES = (
    "src/test/",
    "test/smoke/",
    "tests/smoke/",
    "scripts/smoke/",
    "e2e/smoke/",
    "cypress/e2e/smoke/",
    "playwright/smoke/",
)


def _path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, SMOKE_PLAN_FILE)


def _result_path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, SMOKE_RESULT_FILE)


def _initial(feature: str) -> dict[str, Any]:
    return {"version": 1, "featureId": feature, "flowBlocking": False, "skipReason": "", "tests": []}


def _load(workspace: Path, feature: str) -> dict[str, Any]:
    data = load_json(_path(workspace, feature), default=_initial(feature))
    if not isinstance(data, dict):
        raise ValueError("SMOKE_TEST_PLAN.json root 必须是 object")
    data.setdefault("version", 1)
    data.setdefault("featureId", feature)
    data.setdefault("flowBlocking", False)
    data.setdefault("skipReason", "")
    data.setdefault("tests", [])
    return data


def _tests(data: dict[str, Any]) -> list[dict[str, Any]]:
    tests = data.setdefault("tests", [])
    if not isinstance(tests, list):
        raise ValueError("SMOKE_TEST_PLAN.tests 必须是数组")
    return tests


def _split(values: list[str] | None) -> list[str]:
    return [value.strip() for value in values or [] if value.strip()]


def _find(data: dict[str, Any], test_id: str) -> dict[str, Any]:
    for item in _tests(data):
        if isinstance(item, dict) and item.get("id") == test_id:
            return item
    raise ValueError(f"smoke test 不存在: {test_id}")


def _source_allowed(value: str) -> bool:
    normalized = value.replace("\\", "/").lstrip("/")
    return any(normalized.startswith(prefix) for prefix in SMOKE_SOURCE_PREFIXES)


def _structure_errors(data: dict[str, Any], *, allow_skeleton: bool = True) -> list[str]:
    errors: list[str] = []
    if data.get("version") != 1:
        errors.append("invalid_smoke_test_plan_version")
    if not isinstance(data.get("featureId"), str) or not data.get("featureId"):
        errors.append("missing_smoke_feature_id")
    if data.get("flowBlocking") is not False:
        errors.append("invalid_smoke_flow_blocking")
    tests = data.get("tests")
    if not isinstance(tests, list):
        errors.append("invalid_smoke_test_plan_items")
        return errors
    if not tests:
        return errors
    seen: set[str] = set()
    for index, item in enumerate(tests):
        context = f"tests[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{context}.must_be_object")
            continue
        test_id = item.get("id")
        if not isinstance(test_id, str) or not test_id.startswith("SMK-"):
            errors.append(f"{context}.id_invalid")
        elif test_id in seen:
            errors.append(f"{context}.id_duplicate:{test_id}")
        else:
            seen.add(test_id)
        if not isinstance(item.get("taskId"), str) or not item.get("taskId"):
            errors.append(f"{context}.taskId_missing")
        if not isinstance(item.get("title"), str) or not item.get("title"):
            errors.append(f"{context}.title_missing")
        smoke_type = item.get("smokeType")
        if not isinstance(smoke_type, str) or smoke_type not in SMOKE_TYPES:
            errors.append(f"{context}.smokeType_invalid")
        source_path = item.get("sourcePath")
        if not isinstance(source_path, str) or not _source_allowed(source_path):
            errors.append(f"{context}.sourcePath_invalid")
        if not isinstance(item.get("command"), str) or not item.get("command"):
            errors.append(f"{context}.command_missing")
        if allow_skeleton:
            continue
        if not item.get("expectedSignals"):
            errors.append(f"{context}.expectedSignals_missing")
        seam = item.get("seam")
        if not isinstance(seam, dict) or seam.get("type") not in SMOKE_SEAM_TYPES:
            errors.append(f"{context}.seam_invalid")
        vertical = item.get("verticalSlice")
        if not isinstance(vertical, dict) or not vertical.get("trigger") or not vertical.get("expectedOutcome"):
            errors.append(f"{context}.verticalSlice_invalid")
        mock_policy = item.get("mockPolicy")
        if not isinstance(mock_policy, dict) or mock_policy.get("externalOnly") is not True:
            errors.append(f"{context}.mockPolicy_invalid")
        if not item.get("scenarioRefs"):
            errors.append(f"{context}.scenarioRefs_missing")
    return errors


def _write(workspace: Path, feature: str, data: dict[str, Any], *, allow_skeleton: bool = True) -> WriterResult:
    path = _path(workspace, feature)
    errors = _structure_errors(data, allow_skeleton=allow_skeleton)
    if errors:
        return WriterResult(ok=False, path=path, errors=[{"reason": error} for error in errors])
    changed = atomic_write_json(path, data)
    return WriterResult(ok=True, path=path, changed=changed)


def _cmd_init(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    guard = require_finalized_plan(workspace, feature)
    if guard:
        return render_result(guard)
    existing = fail_if_artifact_exists(_path(workspace, feature), force=args.force)
    if existing:
        return render_result(existing)
    data = _initial(feature)
    if args.skip_reason:
        data["skipReason"] = args.skip_reason
    return render_result(with_result_data(_write(workspace, feature, data), reset=bool(args.force)))


def _body_to_test(body: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(body.get("id"), str):
        raise ValueError("body.id 必填")
    return dict(body)


def _cmd_add_test(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    tests = _tests(data)
    if args.body_file:
        item = _body_to_test(read_object_file(args.body_file))
    else:
        test_id = args.test_id or next_numbered_id(
            {item.get("id") for item in tests if isinstance(item, dict) and isinstance(item.get("id"), str)},
            "SMK",
        )
        item = {
            "id": test_id,
            "taskId": args.task_id,
            "scenarioRefs": _split(args.scenario_ref),
            "title": args.title,
            "smokeType": args.smoke_type,
            "sourcePath": args.source_path,
            "command": args.command,
            "expectedSignals": _split(args.expected_signal),
            "preconditions": _split(args.precondition),
            "timeoutSeconds": args.timeout_seconds,
        }
        if args.seam_type or args.seam_entrypoint or args.seam_observable:
            item["seam"] = {
                "type": args.seam_type or args.smoke_type,
                "entrypoint": args.seam_entrypoint or args.command,
                "observable": args.seam_observable or "公开入口返回结果",
            }
        if args.trigger or args.expected_outcome:
            item["verticalSlice"] = {
                "trigger": args.trigger or args.title,
                "expectedOutcome": args.expected_outcome or "出现预期可观察信号",
            }
        item["mockPolicy"] = {
            "externalOnly": True,
            "allowedMocks": _split(args.allowed_mock),
        }
    if any(isinstance(existing, dict) and existing.get("id") == item.get("id") for existing in tests):
        return render_result(fail("duplicate_smoke_test_id", str(item.get("id"))))
    tests.append(item)
    data["skipReason"] = ""
    return render_result(_write(workspace, feature, data))


def _cmd_update_test(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    item = _find(data, args.test_id)
    for field, value in (
        ("taskId", args.task_id),
        ("title", args.title),
        ("smokeType", args.smoke_type),
        ("sourcePath", args.source_path),
        ("command", args.command),
    ):
        if value is not None:
            item[field] = value
    if args.scenario_ref is not None:
        item["scenarioRefs"] = _split(args.scenario_ref)
    if args.expected_signal is not None:
        item["expectedSignals"] = _split(args.expected_signal)
    return render_result(_write(workspace, feature, data))


def _cmd_set_seam(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    _find(data, args.test_id)["seam"] = {
        "type": args.type,
        "entrypoint": args.entrypoint,
        "observable": args.observable,
    }
    return render_result(_write(workspace, feature, data))


def _cmd_set_vertical_slice(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    _find(data, args.test_id)["verticalSlice"] = {
        "trigger": args.trigger,
        "expectedOutcome": args.expected_outcome,
    }
    return render_result(_write(workspace, feature, data))


def _cmd_set_mock_policy(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    _find(data, args.test_id)["mockPolicy"] = {
        "externalOnly": args.external_only.lower() == "true",
        "allowedMocks": _split(args.allowed_mock),
    }
    return render_result(_write(workspace, feature, data))


def _cmd_add_expected_signal(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    item = _find(data, args.test_id)
    values = item.setdefault("expectedSignals", [])
    if not isinstance(values, list):
        values = []
        item["expectedSignals"] = values
    values.append(args.signal)
    return render_result(_write(workspace, feature, data))


def _cmd_set_preconditions(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    _find(data, args.test_id)["preconditions"] = _split(args.precondition)
    return render_result(_write(workspace, feature, data))


def _cmd_remove_test(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    result_path = _result_path(workspace, feature)
    if result_path.is_file():
        result = load_json(result_path, default={})
        rows = result.get("results") if isinstance(result, dict) else None
        if isinstance(rows, list) and any(isinstance(row, dict) and row.get("testId") == args.test_id for row in rows):
            return render_result(fail("smoke_result_would_be_orphaned", args.test_id, path=_path(workspace, feature)))
    data = _load(workspace, feature)
    data["tests"] = [item for item in _tests(data) if not (isinstance(item, dict) and item.get("id") == args.test_id)]
    return render_result(_write(workspace, feature, data))


def _cmd_set_not_applicable(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    data["tests"] = []
    data["skipReason"] = args.reason
    return render_result(_write(workspace, feature, data))


def _cmd_validate(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    path = _path(workspace, feature)
    data = load_json(path)
    errors = _structure_errors(data, allow_skeleton=not args.gate)
    return render_result(
        WriterResult(
            ok=not errors,
            path=path,
            errors=[{"reason": error} for error in errors],
            data={"validation": "gate" if args.gate else "structure"},
        )
    )


def _cmd_show(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    tests = _tests(data)
    summary = {
        "featureId": data.get("featureId"),
        "flowBlocking": data.get("flowBlocking"),
        "skipReason": data.get("skipReason"),
        "testCount": len(tests),
        "tests": [
            {"id": item.get("id"), "taskId": item.get("taskId"), "smokeType": item.get("smokeType")}
            for item in tests
            if isinstance(item, dict)
        ],
    }
    return render_result(WriterResult(ok=True, path=_path(workspace, feature), data={"summary": summary}))


def _resolve(args: argparse.Namespace) -> tuple[Path, str]:
    return resolve_workspace(args.workspace), resolve_feature(args.feature)


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace")
    parser.add_argument("--feature")


def _test_selector(parser: argparse.ArgumentParser) -> None:
    _common(parser)
    parser.add_argument("--test-id", required=True)


def _add_test_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--test-id")
    parser.add_argument("--body-file")
    parser.add_argument("--task-id")
    parser.add_argument("--scenario-ref", action="append")
    parser.add_argument("--title")
    parser.add_argument("--smoke-type", default="api", choices=sorted(SMOKE_TYPES))
    parser.add_argument("--source-path")
    parser.add_argument("--command")
    parser.add_argument("--expected-signal", action="append")
    parser.add_argument("--precondition", action="append")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--seam-type", choices=sorted(SMOKE_SEAM_TYPES))
    parser.add_argument("--seam-entrypoint")
    parser.add_argument("--seam-observable")
    parser.add_argument("--trigger")
    parser.add_argument("--expected-outcome")
    parser.add_argument("--allowed-mock", action="append")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Incrementally write SMOKE_TEST_PLAN.json")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    _common(init)
    init.add_argument("--force", action="store_true")
    init.add_argument("--skip-reason")
    init.set_defaults(func=_cmd_init)

    add = sub.add_parser("add-test")
    _common(add)
    _add_test_args(add)
    add.set_defaults(func=_cmd_add_test)

    update = sub.add_parser("update-test")
    _test_selector(update)
    update.add_argument("--task-id")
    update.add_argument("--scenario-ref", action="append")
    update.add_argument("--title")
    update.add_argument("--smoke-type", choices=sorted(SMOKE_TYPES))
    update.add_argument("--source-path")
    update.add_argument("--command")
    update.add_argument("--expected-signal", action="append")
    update.set_defaults(func=_cmd_update_test)

    seam = sub.add_parser("set-seam")
    _test_selector(seam)
    seam.add_argument("--type", required=True, choices=sorted(SMOKE_SEAM_TYPES))
    seam.add_argument("--entrypoint", required=True)
    seam.add_argument("--observable", required=True)
    seam.set_defaults(func=_cmd_set_seam)

    vertical = sub.add_parser("set-vertical-slice")
    _test_selector(vertical)
    vertical.add_argument("--trigger", required=True)
    vertical.add_argument("--expected-outcome", required=True)
    vertical.set_defaults(func=_cmd_set_vertical_slice)

    mock = sub.add_parser("set-mock-policy")
    _test_selector(mock)
    mock.add_argument("--external-only", default="true", choices=["true", "false"])
    mock.add_argument("--allowed-mock", action="append")
    mock.set_defaults(func=_cmd_set_mock_policy)

    signal = sub.add_parser("add-expected-signal")
    _test_selector(signal)
    signal.add_argument("--signal", required=True)
    signal.set_defaults(func=_cmd_add_expected_signal)

    preconditions = sub.add_parser("set-preconditions")
    _test_selector(preconditions)
    preconditions.add_argument("--precondition", action="append")
    preconditions.set_defaults(func=_cmd_set_preconditions)

    remove = sub.add_parser("remove-test")
    _test_selector(remove)
    remove.set_defaults(func=_cmd_remove_test)

    na = sub.add_parser("set-not-applicable")
    _common(na)
    na.add_argument("--reason", required=True)
    na.set_defaults(func=_cmd_set_not_applicable)

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
    try:
        return args.func(args)
    except Exception as exc:
        return render_result(fail("smoke_plan_writer_failed", str(exc)))


if __name__ == "__main__":
    raise SystemExit(main())
