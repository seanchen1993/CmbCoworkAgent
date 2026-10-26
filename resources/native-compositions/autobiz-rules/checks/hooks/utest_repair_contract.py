"""Read-only rules extracted from hooks/utest_plan_contract.py. See provenance.json."""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path

TASK_CONTRACT_FIELDS = (
    "id",
    "title",
    "goal",
    "implementationPoints",
    "testPoints",
    "nonGoals",
    "validationBoundary",
    "verificationIntent",
    "workspaceRef",
    "specRefs",
    "acceptanceCriteria",
    "validationLocations",
)


TASK_ID_RE = re.compile(r"^T\d{3}$")


UTEST_COMMAND_PREFIX = "UTEST-"


PENDING_TEST_COMMAND = "待生成测试命令"


MAVEN_EXECUTABLES = {
    "mvn",
    "mvn.cmd",
    "mvn.bat",
    "mvn.exe",
    "mvnw",
    "mvnw.cmd",
    "mvnw.bat",
    "mvnw.exe",
    "./mvnw",
    ".\\mvnw.cmd",
}


GRADLE_EXECUTABLES = {
    "gradle",
    "gradle.bat",
    "gradlew",
    "gradlew.bat",
    "./gradlew",
    ".\\gradlew.bat",
}


PACKAGE_EXECUTABLES = {
    "npm",
    "npm.cmd",
    "pnpm",
    "pnpm.cmd",
    "yarn",
    "yarn.cmd",
    "bun",
    "bun.exe",
    "npx",
    "npx.cmd",
}


DIRECT_TEST_EXECUTABLES = {
    "pytest",
    "pytest.exe",
    "py.test",
    "jest",
    "jest.cmd",
    "vitest",
    "vitest.cmd",
}


class UTestPlanContractError(ValueError):
    """Raised when a plan cannot authorize a UTest action."""


def _error(message):
    raise UTestPlanContractError("{}。修复：回到 /autodev-plan 修正测试契约后重试。".format(message))


def _read_object(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        _error("无法读取计划 {}：{}".format(path, exc))
    except ValueError as exc:
        _error("计划不是合法 JSON {}：{}".format(path, exc))
    if not isinstance(data, dict):
        _error("计划顶层不是 object：{}".format(path))
    return data


def _batch_path(feature_dir, raw_path):
    if not isinstance(raw_path, str) or not raw_path.strip():
        _error("root plan batch.path 缺失")
    requested = Path(raw_path)
    if requested.is_absolute():
        _error("Batch plan path 不能是绝对路径：{}".format(raw_path))
    root = Path(feature_dir).resolve()
    resolved = (root / requested).resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        _error("Batch plan path 越界：{}".format(raw_path))
    return resolved


def validation_locations(task):
    """Return the Plan V2 workspace boundary for UTest-generated commands."""
    if not isinstance(task, dict):
        return []
    workspace_ref = task.get("workspaceRef")
    return [{"repo": workspace_ref, "cwd": "."}]


def canonical_task_contract(task):
    if not isinstance(task, dict):
        _error("TASK 不是 object")
    source = dict(task)
    source["validationLocations"] = validation_locations(task)
    return {field: source.get(field) for field in TASK_CONTRACT_FIELDS}


def canonical_task_digest(task):
    payload = canonical_task_contract(task)
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _string_list(value, context, allow_empty=False):
    if not isinstance(value, list) or (not allow_empty and not value):
        _error("{} 必须是{}字符串数组".format(context, "可空" if allow_empty else "非空"))
    if not all(isinstance(item, str) and item.strip() for item in value):
        _error("{} 包含空值或非字符串".format(context))
    return list(value)


def command_executes_tests(command):
    """Return whether a validation command can execute test cases."""
    if not isinstance(command, dict):
        return False
    argv = command.get("argv")
    if not isinstance(argv, list) or not argv or not all(
        isinstance(item, str) and item for item in argv
    ):
        return False
    executable = Path(argv[0].replace("\\", "/")).name.lower()
    executable_raw = argv[0].lower()
    lowered = [item.lower() for item in argv[1:]]
    if executable in DIRECT_TEST_EXECUTABLES:
        return True
    if executable in {"python", "python.exe", "python3", "python3.exe"} or executable.startswith("python3."):
        if "-m" in lowered:
            module_index = lowered.index("-m") + 1
            return module_index < len(lowered) and lowered[module_index] in {"pytest", "unittest"}
        return False
    if executable in MAVEN_EXECUTABLES or executable_raw in MAVEN_EXECUTABLES:
        if any(value in {"-dskiptests", "-dmaven.test.skip=true", "-dskiptests=true"} for value in lowered):
            return False
        goals = [value for value in lowered if value and not value.startswith("-")]
        return any(value in {"test", "integration-test", "verify", "package", "install"} for value in goals)
    if executable in GRADLE_EXECUTABLES or executable_raw in GRADLE_EXECUTABLES:
        return any("test" in value and not value.startswith("-") for value in lowered)
    if executable in PACKAGE_EXECUTABLES:
        return any(
            value in {"test", "test:unit", "test:integration", "vitest", "jest"}
            or value.startswith("test:")
            for value in lowered
        )
    return False


def _validate_task(task, batch_id):
    task_id = task.get("id") if isinstance(task, dict) else None
    context = "{} {}".format(batch_id, task_id or "TASK")
    if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id):
        _error("{} id 无效，必须形如 T001".format(context))
    title = task.get("title")
    if not isinstance(title, str) or not title.strip():
        _error("{} title 缺失".format(context))
    goal = task.get("goal")
    if not isinstance(goal, str) or not goal.strip():
        _error("{} goal 缺失".format(context))
    implementation_points = _string_list(
        task.get("implementationPoints"),
        "{} implementationPoints".format(context),
        allow_empty=True,
    )
    test_points = _string_list(task.get("testPoints", []), "{} testPoints".format(context), allow_empty=True)
    workspace_ref = task.get("workspaceRef")
    if not isinstance(workspace_ref, str) or not workspace_ref.strip():
        _error("{} workspaceRef 缺失".format(context))
    boundary = task.get("validationBoundary")
    if not isinstance(boundary, str) or not boundary.strip():
        _error("{} validationBoundary 缺失".format(context))
    verification_intent = task.get("verificationIntent") or boundary
    if not isinstance(verification_intent, str) or not verification_intent.strip():
        _error("{} verificationIntent 缺失".format(context))
    non_goals = _string_list(task.get("nonGoals"), "{} nonGoals".format(context), allow_empty=True)
    spec_refs = _string_list(task.get("specRefs"), "{} specRefs".format(context))

    raw_acceptance = task.get("acceptanceCriteria")
    if not isinstance(raw_acceptance, list) or not raw_acceptance:
        _error("{} acceptanceCriteria 必须是非空数组".format(context))
    acceptance_ids = []
    for index, criterion in enumerate(raw_acceptance):
        criterion_id = criterion.get("id") if isinstance(criterion, dict) else None
        if not isinstance(criterion_id, str) or not criterion_id.strip():
            _error("{} acceptanceCriteria[{}].id 缺失".format(context, index))
        if criterion_id in acceptance_ids:
            _error("{} acceptanceCriteria ID 重复：{}".format(context, criterion_id))
        criterion_text = criterion.get("text") if isinstance(criterion, dict) else None
        if not isinstance(criterion_text, str) or not criterion_text.strip():
            _error("{} acceptanceCriteria[{}].text 缺失".format(context, index))
        acceptance_ids.append(criterion_id)

    locations = validation_locations(task)

    return {
        "id": task_id,
        "title": title,
        "goal": goal,
        "implementationPoints": implementation_points,
        "testPoints": test_points,
        "workspaceRef": workspace_ref,
        "validationBoundary": boundary,
        "verificationIntent": verification_intent,
        "nonGoals": non_goals,
        "specRefs": spec_refs,
        "acceptanceCriteria": raw_acceptance,
        "validationLocations": locations,
        "taskDigest": canonical_task_digest(task),
        "rawTask": task,
        "acceptanceIds": acceptance_ids,
    }


def load_utest_plan(feature_dir):
    feature_root = Path(feature_dir).expanduser().resolve()
    root = _read_object(feature_root / "plan.json")
    batches = root.get("batches")
    if not isinstance(batches, list) or not batches:
        _error("root plan.batches 必须是非空数组")
    result = []
    seen_tasks = set()
    for root_index, entry in enumerate(batches):
        if not isinstance(entry, dict):
            _error("root plan.batches[{}] 不是 object".format(root_index))
        path = _batch_path(feature_root, entry.get("path"))
        batch = _read_object(path)
        batch_id = batch.get("batchId") or entry.get("id") or entry.get("batchId")
        lane = batch.get("executionLane")
        if not isinstance(batch_id, str) or not batch_id.strip():
            _error("第 {} 个 Batch 缺少 batchId".format(root_index + 1))
        if not isinstance(lane, str) or not lane.strip():
            _error("{} executionLane 缺失".format(batch_id))
        tasks = batch.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            _error("{} tasks 必须是非空数组".format(batch_id))
        projected_tasks = []
        for task in tasks:
            projected = _validate_task(task, batch_id)
            if projected["id"] in seen_tasks:
                _error("TASK ID 跨 Batch 重复：{}".format(projected["id"]))
            seen_tasks.add(projected["id"])
            projected_tasks.append(projected)
        result.append(
            {
                "batchId": batch_id,
                "executionLane": lane,
                "planPath": path.relative_to(feature_root).as_posix(),
                "rootOrder": root_index,
                "tasks": projected_tasks,
            }
        )
    return {"featureDir": feature_root, "root": root, "batches": result}


def expand_plan_targets(plan):
    targets = []
    for batch in plan.get("batches", []):
        for task in batch.get("tasks", []):
            targets.append(
                {
                    "targetId": "UT-{:03d}".format(len(targets) + 1),
                    "taskId": task["id"],
                    "taskDigest": task["taskDigest"],
                    "commandId": "{}{}".format(UTEST_COMMAND_PREFIX, task["id"]),
                    "specRefs": list(task["specRefs"]),
                    "covers": list(task["acceptanceIds"]),
                    "result": "BLOCKED",
                    "command": PENDING_TEST_COMMAND,
                    "evidenceIds": [],
                    "validationLocations": list(task["validationLocations"]),
                    "required": True,
                    "assetType": "unit_test",
                    "acceptanceCriteria": task["acceptanceCriteria"],
                }
            )
    if not targets:
        _error("plan 没有可生成单测的 TASK")
    return targets


def shell_join_argv(argv):
    try:
        import shlex

        return shlex.join(argv)
    except AttributeError:
        import shlex

        return " ".join(shlex.quote(value) for value in argv)


def public_target(target):
    return {
        "targetId": target["targetId"],
        "taskId": target["taskId"],
        "taskDigest": target["taskDigest"],
        "commandId": target["commandId"],
        "specRefs": list(target["specRefs"]),
        "covers": list(target["covers"]),
        "evidenceIds": list(target.get("evidenceIds", [])),
        "result": target.get("result", "BLOCKED"),
        "command": target["command"],
    }


def resolve_plan_target(feature_dir, task_id, command_id=None):
    plan = load_utest_plan(feature_dir)
    matches = [
        target
        for target in expand_plan_targets(plan)
        if target["taskId"] == task_id
        and (command_id is None or target["commandId"] == command_id)
    ]
    if len(matches) != 1:
        _error(
            "--task-id {}{} 未唯一映射 UTest target".format(
                task_id,
                " 与 --command-id {}".format(command_id) if command_id else "",
            )
        )
    return plan, matches[0]


def read_evidence_records(feature_dir):
    path = Path(feature_dir) / "evidence" / "EVIDENCE.jsonl"
    if not path.is_file():
        return []
    records = []
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError as exc:
        _error("无法读取 Evidence：{}".format(exc))
    for line_no, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except ValueError:
            _error("Evidence 第 {} 行不是合法 JSON".format(line_no))
        if not isinstance(value, dict):
            _error("Evidence 第 {} 行不是 object".format(line_no))
        records.append(value)
    return records


def result_for_evidence(record):
    validation = record.get("validation") if isinstance(record, dict) else None
    if not isinstance(validation, dict):
        return "BLOCKED"
    result = str(validation.get("result", "")).strip().lower()
    exit_code = validation.get("exitCode")
    if result == "pass" and exit_code == 0:
        if "testsExecuted" in validation and (not isinstance(validation["testsExecuted"], int) or validation["testsExecuted"] <= 0):
            return "BLOCKED"
        return "PASS"
    if result == "fail" and isinstance(exit_code, int) and exit_code != 0:
        return "FAIL"
    return "BLOCKED"


def derive_verdict(targets, plan_targets):
    required_results = []
    optional_results = []
    required_by_id = {item["targetId"]: item["required"] for item in plan_targets}
    for target in targets:
        result = target.get("result", "BLOCKED")
        if required_by_id.get(target.get("targetId"), True):
            required_results.append(result)
        else:
            optional_results.append(result)
    if "FAIL" in required_results or "FAIL" in optional_results:
        return "FAIL"
    if any(result != "PASS" for result in required_results + optional_results):
        return "BLOCKED"
    return "PASS"


def derive_check_matrix(result_targets, plan_targets, runtime_block=None):
    required_by_id = {item["targetId"]: item["required"] for item in plan_targets}
    block_code = runtime_block.get("reasonCode") if isinstance(runtime_block, dict) else None
    result = []
    for target in result_targets:
        raw_result = target.get("result", "BLOCKED")
        if raw_result in {"PASS", "PASS_WITH_WARNINGS"}:
            status = "passed"
            reason_code = None
        elif raw_result == "FAIL":
            status = "failed"
            reason_code = None
        elif raw_result == "SKIP":
            status = "skipped"
            reason_code = "optional_check_skipped"
        elif block_code:
            status = "blocked"
            reason_code = block_code
        else:
            status = "not_run"
            reason_code = "not_executed"
        row = {
            "checkId": "CHECK-{}".format(target.get("targetId")),
            "targetId": target.get("targetId"),
            "kind": "unit_test",
            "required": required_by_id.get(target.get("targetId"), True),
            "status": status,
        }
        if reason_code is not None:
            row["reasonCode"] = reason_code
        result.append(row)
    return result


def derive_unverified_checks(checks):
    return [
        {
            "checkId": item.get("checkId"),
            "kind": item.get("kind"),
            "reasonCode": item.get("reasonCode", "not_executed"),
        }
        for item in checks
        if isinstance(item, dict) and item.get("status") in {"blocked", "not_run", "skipped"}
    ]


def _scenario_ids(refs):
    result = []
    for ref in refs:
        if not isinstance(ref, str):
            continue
        for value in re.findall(r"\bSCN-\d{3}\b", ref):
            if value not in result:
                result.append(value)
    return result


def plan_scenario_refs(plan):
    refs = []
    for batch in plan.get("batches", []):
        for task in batch.get("tasks", []):
            source_refs = list(task.get("specRefs", []))
            for criterion in task.get("acceptanceCriteria", []):
                if isinstance(criterion, dict) and isinstance(
                    criterion.get("scenarioRefs"), list
                ):
                    source_refs.extend(criterion["scenarioRefs"])
            for scenario_id in _scenario_ids(source_refs):
                if scenario_id not in refs:
                    refs.append(scenario_id)
    return refs


def derive_scenario_coverage(
    plan_targets, result_targets, evidence_by_id, scenario_refs=None
):
    result_by_id = {
        item.get("targetId"): item for item in result_targets if isinstance(item, dict)
    }
    scenario_order = list(scenario_refs or [])
    scenario_targets = {scenario_id: [] for scenario_id in scenario_order}
    for plan_target in plan_targets:
        criteria_by_id = {
            criterion.get("id"): criterion
            for criterion in plan_target.get("acceptanceCriteria", [])
            if isinstance(criterion, dict)
        }
        refs = []
        for criterion_id in plan_target.get("covers", []):
            criterion = criteria_by_id.get(criterion_id, {})
            raw_refs = criterion.get("scenarioRefs") if isinstance(criterion, dict) else []
            if isinstance(raw_refs, list):
                refs.extend(raw_refs)
        if not refs:
            refs = plan_target.get("specRefs", [])
        for scenario_id in _scenario_ids(refs):
            if scenario_id not in scenario_targets:
                scenario_targets[scenario_id] = []
                scenario_order.append(scenario_id)
            scenario_targets[scenario_id].append(plan_target["targetId"])
    rows = []
    for scenario_id in scenario_order:
        statuses = []
        evidence_ids = []
        for target_id in scenario_targets[scenario_id]:
            result_target = result_by_id.get(target_id, {})
            statuses.append(result_target.get("result", "BLOCKED"))
            target_evidence = result_target.get("evidenceIds", [])
            if target_evidence:
                latest = evidence_by_id.get(target_evidence[-1])
                if result_for_evidence(latest) == "PASS":
                    evidence_ids.append(target_evidence[-1])
        if "FAIL" in statuses:
            verdict = "fail"
            evidence_ids = []
        elif statuses and all(status == "PASS" for status in statuses):
            verdict = "pass"
        else:
            verdict = "missing"
            evidence_ids = []
        rows.append(
            {"scenarioRef": scenario_id, "evidenceIds": evidence_ids, "verdict": verdict}
        )
    return rows


def validate_result_against_plan(feature_dir, data):
    """Return stable semantic errors for writer and board stage gates."""
    errors = []
    try:
        plan = load_utest_plan(feature_dir)
        plan_targets = expand_plan_targets(plan)
    except UTestPlanContractError as exc:
        return ["utest_plan_contract_invalid:{}".format(exc)]
    if not isinstance(data, dict):
        return ["unit_test_result_root_invalid"]
    if data.get("version") != 1:
        errors.append("invalid_unit_test_result_version")
    targets = data.get("targets")
    if not isinstance(targets, list):
        return ["unit_test_targets_invalid"]
    expected_by_id = {target["targetId"]: target for target in plan_targets}
    actual_by_id = {
        target.get("targetId"): target
        for target in targets
        if isinstance(target, dict) and isinstance(target.get("targetId"), str)
    }
    if set(actual_by_id) != set(expected_by_id) or len(targets) != len(plan_targets):
        errors.append("unit_test_targets_not_initialized_from_plan_tasks")
    try:
        records = read_evidence_records(feature_dir)
    except UTestPlanContractError as exc:
        return errors + ["unit_test_evidence_contract_invalid:{}".format(exc)]
    evidence_by_id = {
        record.get("evidenceId"): record
        for record in records
        if isinstance(record.get("evidenceId"), str)
    }
    for target_id, expected in expected_by_id.items():
        actual = actual_by_id.get(target_id)
        if not isinstance(actual, dict):
            errors.append("required_unit_test_target_missing:{}".format(target_id))
            continue
        for field in ("taskId", "taskDigest", "commandId", "specRefs", "covers"):
            expected_value = expected[field]
            if actual.get(field) != expected_value:
                errors.append("unit_test_target_plan_mismatch:{}:{}".format(target_id, field))
        if not isinstance(actual.get("command"), str) or not actual.get("command", "").strip():
            errors.append("unit_test_target_command_invalid:{}".format(target_id))
        evidence_ids = actual.get("evidenceIds")
        if not isinstance(evidence_ids, list) or not all(
            isinstance(value, str) and value for value in evidence_ids
        ):
            errors.append("unit_test_target_evidenceIds_invalid:{}".format(target_id))
            continue
        latest_result = "BLOCKED"
        latest_command = PENDING_TEST_COMMAND
        for evidence_id in evidence_ids:
            record = evidence_by_id.get(evidence_id)
            if record is None:
                errors.append("unit_test_target_evidence_missing:{}:{}".format(target_id, evidence_id))
                continue
            validation = record.get("validation")
            if not isinstance(validation, dict):
                errors.append("unit_test_evidence_validation_missing:{}".format(evidence_id))
                continue
            expected_fields = {
                "taskId": expected["taskId"],
                "taskDigest": expected["taskDigest"],
                "specRefs": expected["specRefs"],
                "covers": expected["covers"],
            }
            for field, expected_value in expected_fields.items():
                if record.get(field) != expected_value:
                    errors.append("unit_test_evidence_plan_mismatch:{}:{}".format(evidence_id, field))
            if validation.get("commandId") != expected["commandId"]:
                errors.append("unit_test_evidence_plan_mismatch:{}:commandId".format(evidence_id))
            if validation.get("required") is not True:
                errors.append("unit_test_evidence_plan_mismatch:{}:required".format(evidence_id))
            if validation.get("covers") != expected["covers"]:
                errors.append("unit_test_evidence_plan_mismatch:{}:covers".format(evidence_id))
            location = {
                "repo": validation.get("repo"),
                "cwd": validation.get("cwd"),
            }
            if location not in expected["validationLocations"]:
                errors.append("unit_test_evidence_location_not_allowed:{}".format(evidence_id))
            if not command_executes_tests(validation):
                errors.append("unit_test_evidence_command_not_test:{}".format(evidence_id))
            argv = validation.get("argv")
            if isinstance(argv, list) and argv and all(
                isinstance(value, str) and value for value in argv
            ):
                derived_command = shell_join_argv(argv)
                if validation.get("command") != derived_command:
                    errors.append("unit_test_evidence_command_not_derived:{}".format(evidence_id))
            test_files = validation.get("testFiles")
            if not isinstance(test_files, list) or not test_files or not all(
                isinstance(value, str) and value for value in test_files
            ):
                errors.append("unit_test_evidence_testFiles_invalid:{}".format(evidence_id))
            elif record.get("changedFiles") != test_files:
                errors.append("unit_test_evidence_testFiles_not_bound:{}".format(evidence_id))
            if isinstance(validation.get("command"), str) and validation.get("command"):
                latest_command = validation["command"]
            latest_result = result_for_evidence(record)
        if actual.get("result") != latest_result:
            errors.append("unit_test_target_result_not_derived:{}".format(target_id))
        if actual.get("command") != latest_command:
            errors.append("unit_test_target_command_not_derived:{}".format(target_id))
    expected_verdict = derive_verdict(targets, plan_targets)
    if data.get("verdict") != expected_verdict:
        errors.append("unit_test_verdict_not_derived:{}".format(expected_verdict))
    expected_coverage = derive_scenario_coverage(
        plan_targets,
        targets,
        evidence_by_id,
        scenario_refs=plan_scenario_refs(plan),
    )
    if data.get("scenarioCoverage") != expected_coverage:
        errors.append("unit_test_coverage_not_derived_from_plan_evidence")
    expected_checks = derive_check_matrix(targets, plan_targets, data.get("runtimeBlock"))
    if data.get("checks") != expected_checks:
        errors.append("unit_test_checks_not_derived_from_plan_evidence")
    if data.get("unverifiedChecks") != derive_unverified_checks(expected_checks):
        errors.append("unit_test_unverified_checks_not_derived")
    return errors


def validate_source_bug(feature_dir, data, task_id, command_id, target_id, task_digest, evidence_id):
    errors = validate_result_against_plan(feature_dir, data)
    if errors:
        _error("UNIT_TEST_RESULT 不满足可信契约：{}".format(",".join(errors)))
    plan, expected = resolve_plan_target(feature_dir, task_id, command_id)
    del plan
    if target_id != expected["targetId"]:
        _error("source_bug targetId 与当前 TASK 的 UTest target 不一致")
    if task_digest != expected["taskDigest"]:
        _error("source_bug taskDigest 与当前 plan 不一致")
    targets = data.get("targets", [])
    target = next(
        (item for item in targets if isinstance(item, dict) and item.get("targetId") == target_id),
        None,
    )
    if target is None or target.get("result") != "FAIL":
        _error("source_bug 必须绑定 result=FAIL 的真实 UT target")
    evidence_ids = target.get("evidenceIds", [])
    if not evidence_ids or evidence_id != evidence_ids[-1]:
        _error("source_bug 必须绑定 target 最新一次失败 Evidence")
    records = read_evidence_records(feature_dir)
    record = next((item for item in records if item.get("evidenceId") == evidence_id), None)
    validation = record.get("validation") if isinstance(record, dict) else None
    if not isinstance(validation, dict) or validation.get("result") != "fail":
        _error("source_bug Evidence 必须是失败测试证据")
    exit_code = validation.get("exitCode")
    if not isinstance(exit_code, int) or exit_code == 0:
        _error("source_bug Evidence exitCode 必须非 0")
    if record.get("covers") != expected["covers"]:
        _error("source_bug covers 必须映射当前 TASK 的真实 acceptanceCriteria")
    return {
        "taskId": task_id,
        "commandId": command_id,
        "targetId": target_id,
        "taskDigest": task_digest,
        "evidenceId": evidence_id,
        "covers": list(expected["covers"]),
    }
