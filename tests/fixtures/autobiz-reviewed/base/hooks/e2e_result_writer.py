#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Incrementally write and mechanically finalize E2E_RESULT.json."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.e2e_trust_common import (  # noqa: E402
    is_fresh,
    load_json_object,
    quality_gate_snapshot,
    scan_path,
    validate_execution_evidence_chain,
    validate_execution_hash_chain,
    validate_execution_log_chain,
)
from hooks.evidence_store import EvidenceStoreError, read_records, stream_path  # noqa: E402
from hooks.json_writer_common import (  # noqa: E402
    WriterResult,
    artifact_path,
    atomic_write_json,
    fail,
    fail_if_artifact_exists,
    load_json,
    parse_json_value,
    render_result,
    resolve_feature,
    resolve_workspace,
    with_result_data,
)
from hooks.result_writer_common import (  # noqa: E402
    collect_scenario_ids,
    derive_coverage_from_evidence,
    empty_coverage,
    scenario_refs_from_record,
)


FILE_NAME = "E2E_RESULT.json"
CASE_RESULTS = {"PASS", "FAIL", "BLOCKED", "SKIP"}
MODEL_RESULTS = {"FAIL", "BLOCKED", "SKIP"}
SUMMARY_RESULTS = {"PASS", "FAIL", "BLOCKED"}
EXECUTION_MODES = {"browser", "api", "mixed", "database_assisted"}
PRIORITIES = {"P0", "P1", "P2"}
AUTH_STATUSES = {
    "bypassed",
    "pre_authenticated",
    "not_required",
    "failed",
    "not_verified",
}


def _path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, FILE_NAME)


def _feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _initial(feature: str) -> Dict[str, Any]:
    return {
        "version": 1,
        "verdict": "BLOCKED",
        "repairRounds": 0,
        "cases": [],
        "scenarioCoverage": [],
    }


def _load(workspace: Path, feature: str) -> Dict[str, Any]:
    data = load_json(_path(workspace, feature), default=_initial(feature))
    if not isinstance(data, dict):
        raise ValueError("{} root 必须是 object。修复：重新运行 init。".format(FILE_NAME))
    data.setdefault("version", 1)
    data.setdefault("verdict", "BLOCKED")
    data.setdefault("repairRounds", 0)
    data.setdefault("cases", [])
    data.setdefault("scenarioCoverage", [])
    return data


def _cases(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    cases = data.setdefault("cases", [])
    if not isinstance(cases, list):
        raise ValueError("cases 必须是数组。修复：重新生成 E2E_RESULT.json。")
    return cases


def _next_case_id(data: Dict[str, Any], feature: str) -> str:
    prefix = "E2E-{}-".format(feature)
    highest = 0
    for case in _cases(data):
        case_id = case.get("caseId") if isinstance(case, dict) else None
        if isinstance(case_id, str) and case_id.startswith(prefix):
            suffix = case_id[len(prefix) :]
            if suffix.isdigit():
                highest = max(highest, int(suffix))
    return "{}{:03d}".format(prefix, highest + 1)


def _find(data: Dict[str, Any], case_id: str) -> Dict[str, Any]:
    for case in _cases(data):
        if isinstance(case, dict) and case.get("caseId") == case_id:
            return case
    raise ValueError(
        "E2E case 不存在: {}。修复：先用 add-case 登记用例。".format(case_id)
    )


def _write(workspace: Path, feature: str, data: Dict[str, Any]) -> WriterResult:
    changed = atomic_write_json(_path(workspace, feature), data)
    return WriterResult(ok=True, path=_path(workspace, feature), changed=changed)


def _valid_steps(steps: Any, ui_required: bool, priority: str) -> List[str]:
    errors: List[str] = []
    if not isinstance(steps, list) or not steps:
        return ["invalid_e2e_steps"]
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            errors.append("invalid_e2e_step:{}".format(index))
            continue
        for field in ("action", "expected"):
            if not isinstance(step.get(field), str) or not step.get(field).strip():
                errors.append("empty_e2e_step_{}_{}".format(index, field))
        verification = step.get("verification")
        if not isinstance(verification, dict):
            errors.append("missing_e2e_step_verification:{}".format(index))
        else:
            verification_type = str(verification.get("type", "")).lower()
            if verification_type not in {"ui", "api", "database"}:
                errors.append("invalid_e2e_verification_type:{}".format(index))
            if not isinstance(verification.get("details"), str) or not verification.get("details").strip():
                errors.append("empty_e2e_verification_details:{}".format(index))
    if ui_required and priority in {"P0", "P1"}:
        final = steps[-1] if isinstance(steps[-1], dict) else {}
        verification = final.get("verification") if isinstance(final.get("verification"), dict) else {}
        if str(verification.get("type", "")).lower() != "ui":
            errors.append("ui_p0_p1_requires_final_ui_assertion")
    return errors


def _evidence_by_id(
    feature_dir: Path,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str], List[str]]:
    errors: List[str] = []
    try:
        records = read_records(stream_path(feature_dir))
    except EvidenceStoreError as exc:
        return {}, {}, ["invalid_evidence_stream:{}".format(exc)]
    result: Dict[str, Dict[str, Any]] = {}
    run_ids: Dict[str, str] = {}
    for record in records:
        evidence_id = record.get("evidenceId")
        if isinstance(evidence_id, str):
            result[evidence_id] = record
        e2e_run = record.get("e2eRun")
        run_id = e2e_run.get("runId") if isinstance(e2e_run, dict) else None
        if isinstance(run_id, str):
            if run_id in run_ids:
                errors.append("duplicate_e2e_evidence_run_id:{}".format(run_id))
            else:
                run_ids[run_id] = str(evidence_id)
    return result, run_ids, errors


def _verdict_logs(feature_dir: Path) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    path = feature_dir / "e2e-run.log"
    if not path.is_file() or path.stat().st_size == 0:
        return {}, ["missing_e2e_run_log"]
    result: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        return {}, ["invalid_e2e_run_log:{}".format(exc)]
    for line_no, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            errors.append("invalid_e2e_run_log_json:line={}".format(line_no))
            continue
        if not isinstance(record, dict):
            errors.append("invalid_e2e_run_log_record:line={}".format(line_no))
            continue
        kind = record.get("kind")
        if kind == "note":
            if any(not isinstance(record.get(field), str) or not record.get(field) for field in ("ts", "phase", "text")):
                errors.append("invalid_e2e_note_record:line={}".format(line_no))
            continue
        if kind != "verdict_run":
            errors.append("invalid_e2e_run_log_kind:line={}".format(line_no))
            continue
        run_id = record.get("runId")
        if not isinstance(run_id, str) or not run_id:
            errors.append("missing_e2e_log_run_id:line={}".format(line_no))
        elif run_id in result:
            errors.append("duplicate_e2e_log_run_id:{}".format(run_id))
        else:
            result[run_id] = record
    return result, errors


def _coverage_errors(
    feature_dir: Path,
    coverage: Any,
    evidence_by_id: Dict[str, Dict[str, Any]],
    current: Optional[Dict[str, Any]],
) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    if not isinstance(coverage, list) or not coverage:
        return [{"reason": "scenario_coverage_missing"}]
    expected_scenarios = set(collect_scenario_ids(feature_dir))
    seen = set()
    for index, row in enumerate(coverage):
        detail = "scenarioCoverage[{}]".format(index)
        if not isinstance(row, dict):
            errors.append({"reason": "invalid_scenario_coverage_row", "detail": detail})
            continue
        scenario = row.get("scenarioRef")
        if not isinstance(scenario, str) or scenario not in expected_scenarios or scenario in seen:
            errors.append({"reason": "invalid_scenario_coverage_ref", "detail": detail})
            continue
        seen.add(scenario)
        if str(row.get("verdict", "")).lower() != "pass":
            errors.append({"reason": "scenario_coverage_not_complete", "detail": scenario})
            continue
        evidence_ids = row.get("evidenceIds")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            errors.append({"reason": "scenario_coverage_pass_without_evidence", "detail": scenario})
            continue
        covering = False
        for evidence_id in evidence_ids:
            evidence = evidence_by_id.get(evidence_id) if isinstance(evidence_id, str) else None
            validation = evidence.get("validation") if isinstance(evidence, dict) and isinstance(evidence.get("validation"), dict) else {}
            if (
                evidence is None
                or evidence.get("skill") != "autodev-e2e"
                or evidence.get("action") != "validation"
                or validation.get("result") != "pass"
                or validation.get("exitCode") != 0
            ):
                errors.append({"reason": "invalid_e2e_coverage_evidence", "detail": str(evidence_id)})
                continue
            if current is None or not is_fresh(evidence.get("createdAt"), current.get("startedAt")):
                errors.append({"reason": "stale_e2e_coverage_evidence", "detail": str(evidence_id)})
                continue
            if scenario in scenario_refs_from_record(evidence):
                covering = True
        if not covering:
            errors.append({"reason": "scenario_coverage_pass_evidence_mismatch", "detail": scenario})
    missing = expected_scenarios - seen
    if missing:
        errors.append(
            {"reason": "missing_scenario_coverage_rows", "detail": ",".join(sorted(missing))}
        )
    return errors


def _cmd_init(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    existing = fail_if_artifact_exists(_path(workspace, feature), force=args.force)
    if existing:
        return render_result(existing)
    data = _initial(feature)
    data["scenarioCoverage"] = empty_coverage(_feature_dir(workspace, feature))
    return render_result(with_result_data(_write(workspace, feature, data), reset=bool(args.force)))


def _cmd_add_case(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    case_id = args.case_id or _next_case_id(data, feature)
    if any(isinstance(case, dict) and case.get("caseId") == case_id for case in _cases(data)):
        return render_result(
            fail(
                "duplicate_e2e_case_id",
                "{}。修复：使用未登记的 --case-id，或 update-case 更新现有用例。".format(
                    case_id
                ),
                path=_path(workspace, feature),
            )
        )
    steps = [parse_json_value(raw) for raw in args.step_json or []]
    ui_required = args.ui_required == "true"
    step_errors = _valid_steps(steps, ui_required, args.priority)
    if step_errors:
        return render_result(
            fail(
                "invalid_e2e_case_steps",
                "{}。修复：补齐结构化步骤及 UI/page/interaction/visual 引用。".format(
                    ",".join(step_errors)
                ),
            )
        )
    _cases(data).append(
        {
            "caseId": case_id,
            "taskId": args.task_id,
            "specRefs": list(args.spec_ref or []),
            "evidenceIds": [],
            "priority": args.priority,
            "uiRequired": ui_required,
            "pageRefs": list(args.page_ref or []),
            "interactionRefs": list(args.interaction_ref or []),
            "visualSourceRefs": list(args.visual_source_ref or []),
            "executionMode": args.execution_mode,
            "steps": steps,
            "verdict": "BLOCKED",
            "reason": "等待可信 verdict 执行与 finalize",
            "executions": [],
        }
    )
    return render_result(_write(workspace, feature, data))


def _cmd_update_case(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    case = _find(data, args.case_id)
    for field, value in (
        ("taskId", args.task_id),
        ("executionMode", args.execution_mode),
        ("priority", args.priority),
    ):
        if value is not None:
            case[field] = value
    if args.verdict is not None:
        if not args.reason or not args.reason.strip():
            return render_result(
                fail("e2e_nonpass_verdict_requires_reason", "修复：传入 --reason。")
            )
        case["verdict"] = args.verdict
        case["reason"] = args.reason.strip()
        case.pop("verdictSource", None)
    if args.spec_ref is not None:
        case["specRefs"] = list(args.spec_ref)
    if args.step_json is not None:
        case["steps"] = [parse_json_value(raw) for raw in args.step_json]
    if args.ui_required is not None:
        case["uiRequired"] = args.ui_required == "true"
    for field, value in (
        ("pageRefs", args.page_ref),
        ("interactionRefs", args.interaction_ref),
        ("visualSourceRefs", args.visual_source_ref),
    ):
        if value is not None:
            case[field] = list(value)
    step_errors = _valid_steps(
        case.get("steps"), bool(case.get("uiRequired")), str(case.get("priority", ""))
    )
    if step_errors:
        return render_result(
            fail(
                "invalid_e2e_case_steps",
                "{}。修复：补齐结构化步骤及 UI/page/interaction/visual 引用。".format(
                    ",".join(step_errors)
                ),
            )
        )
    return render_result(_write(workspace, feature, data))


def _cmd_begin_round(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    repair_rounds = data.get("repairRounds", 0)
    if not isinstance(repair_rounds, int) or repair_rounds < 0:
        return render_result(
            fail(
                "invalid_e2e_repair_rounds",
                "修复：恢复非负整数 repairRounds，或重新 init 该 E2E 结果。",
            )
        )
    current = data.get("currentRound")
    current_index = current.get("index", 0) if isinstance(current, dict) else 0
    if not isinstance(current_index, int) or current_index < 0:
        current_index = 0
    if args.kind == "initial" and isinstance(current, dict):
        return render_result(
            fail(
                "e2e_initial_round_already_started",
                "修复：任何后续修复使用 --kind repair，不能重复开启 initial 轮。",
            )
        )
    if args.kind == "repair":
        if repair_rounds >= 3:
            return render_result(
                fail(
                    "e2e_repair_budget_exhausted",
                    "修复：停止自动修复并按失败分类生成回流结论。",
                )
            )
        repair_rounds += 1
    data["currentRound"] = {
        "index": current_index + 1,
        "kind": args.kind,
        "startedAt": _utc_now(),
    }
    data["repairRounds"] = repair_rounds
    data["verdict"] = "BLOCKED"
    data.pop("verdictSource", None)
    data.pop("qualityGate", None)
    for case in _cases(data):
        if case.get("verdict") == "PASS":
            case["verdict"] = "BLOCKED"
            case["reason"] = "新执行轮已开始，上一轮 PASS Evidence 已失效"
            case.pop("verdictSource", None)
    return render_result(
        with_result_data(
            _write(workspace, feature, data), currentRound=data["currentRound"], repairRounds=repair_rounds
        )
    )


def _cmd_sync_quality(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    feature_dir = _feature_dir(workspace, feature)
    scan = load_json_object(scan_path(feature_dir), "E2E_QUALITY_SCAN.json")
    data["qualityGate"] = quality_gate_snapshot(feature_dir, scan)
    return render_result(
        with_result_data(_write(workspace, feature, data), qualityGate=data["qualityGate"])
    )


def _cmd_derive_coverage(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    data["scenarioCoverage"] = derive_coverage_from_evidence(
        _feature_dir(workspace, feature), action="validation", skill="autodev-e2e"
    )
    return render_result(_write(workspace, feature, data))


def record_execution(
    workspace: Path,
    feature: str,
    case_id: str,
    execution: Dict[str, Any],
) -> WriterResult:
    """Idempotently record one execution derived by run_e2e_command.py."""

    data = _load(workspace, feature)
    case = _find(data, case_id)
    run_id = execution.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("execution 缺少 runId。修复：只通过 run_e2e_command.py 写入。")
    executions = case.setdefault("executions", [])
    if not isinstance(executions, list):
        raise ValueError("executions 结构损坏。修复：恢复合法 E2E_RESULT.json。")
    existing = [item for item in executions if isinstance(item, dict) and item.get("runId") == run_id]
    if len(existing) > 1:
        raise ValueError("duplicate_e2e_execution_run_id:{}。修复：人工恢复重复记录。".format(run_id))
    if existing:
        if existing[0] != execution:
            raise ValueError("e2e_execution_run_id_payload_mismatch:{}。修复：保留执行器原始 pending。".format(run_id))
        return WriterResult(ok=True, path=_path(workspace, feature), changed=False, data={"execution": existing[0]})
    executions.append(dict(execution))
    evidence_id = execution.get("evidenceId")
    evidence_ids = case.setdefault("evidenceIds", [])
    if isinstance(evidence_id, str) and isinstance(evidence_ids, list) and evidence_id not in evidence_ids:
        evidence_ids.append(evidence_id)
    result = execution.get("result")
    if result in {"FAIL", "FLAKY"}:
        case["verdict"] = "FAIL"
        case["reason"] = "执行器派生结果为 {}".format(result)
        case.pop("verdictSource", None)
    elif result == "BLOCKED":
        case["verdict"] = "BLOCKED"
        case["reason"] = "可信执行器被阻断"
        case.pop("verdictSource", None)
    data["verdict"] = "BLOCKED"
    data.pop("verdictSource", None)
    written = _write(workspace, feature, data)
    return with_result_data(written, execution=execution)


def _finalize_data(feature_dir: Path, data: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    errors: List[Dict[str, str]] = []
    quality_gate = data.get("qualityGate") if isinstance(data.get("qualityGate"), dict) else None
    current = data.get("currentRound") if isinstance(data.get("currentRound"), dict) else None
    if quality_gate is None or quality_gate.get("passed") is not True:
        errors.append({"reason": "quality_gate_not_passed"})
    if current is None or not isinstance(current.get("index"), int) or not isinstance(current.get("startedAt"), str):
        errors.append({"reason": "current_round_missing"})
    cases = _cases(data)
    if not cases:
        errors.append({"reason": "invalid_e2e_result_cases"})
    evidence_by_id, evidence_run_ids, evidence_errors = _evidence_by_id(feature_dir)
    errors.extend({"reason": item} for item in evidence_errors)
    verdict_logs, log_errors = _verdict_logs(feature_dir)
    errors.extend({"reason": item} for item in log_errors)
    execution_run_id_list = [
        execution.get("runId")
        for case in cases
        for execution in (case.get("executions") if isinstance(case.get("executions"), list) else [])
        if isinstance(execution, dict) and isinstance(execution.get("runId"), str)
    ]
    execution_run_ids = set(execution_run_id_list)
    if len(execution_run_id_list) != len(execution_run_ids):
        errors.append({"reason": "duplicate_e2e_execution_run_id"})
    if execution_run_ids != set(evidence_run_ids):
        errors.append({"reason": "e2e_execution_evidence_run_set_mismatch"})
    if execution_run_ids != set(verdict_logs):
        errors.append({"reason": "e2e_execution_log_run_set_mismatch"})
    used_run_ids = set()
    for case in cases:
        case_id = str(case.get("caseId", ""))
        if case.get("verdict") == "SKIP":
            if not isinstance(case.get("reason"), str) or not case.get("reason").strip():
                errors.append({"reason": "skip_requires_reason", "detail": case_id})
            continue
        executions = case.get("executions") if isinstance(case.get("executions"), list) else []
        candidates = [
            execution
            for execution in executions
            if isinstance(execution, dict)
            and execution.get("executionPhase") == "verdict"
            and execution.get("result") == "PASS"
            and execution.get("gateExitCode") == 0
            and current is not None
            and execution.get("roundIndex") == current.get("index")
        ]
        case_failures: List[str] = []
        selected: Optional[Dict[str, Any]] = None
        candidate_failures: List[str] = []
        for candidate in reversed(candidates):
            current_failures: List[str] = []
            run_id = candidate.get("runId")
            evidence_id = candidate.get("evidenceId")
            evidence = evidence_by_id.get(evidence_id) if isinstance(evidence_id, str) else None
            if not isinstance(run_id, str) or not run_id:
                current_failures.append("execution_run_id_missing")
            elif run_id in used_run_ids:
                current_failures.append("execution_reused_by_multiple_cases")
            if evidence is None:
                current_failures.append("execution_evidence_missing")
            else:
                current_failures.extend(
                    validate_execution_evidence_chain(
                        candidate,
                        evidence,
                        case.get("caseId"),
                        case.get("taskId"),
                        case.get("specRefs"),
                    )
                )
                if current is None or not is_fresh(evidence.get("createdAt"), current.get("startedAt")):
                    current_failures.append("execution_evidence_stale")
                current_failures.extend(
                    validate_execution_hash_chain(feature_dir, quality_gate, candidate, evidence)
                )
            log = verdict_logs.get(run_id) if isinstance(run_id, str) else None
            if log is None:
                current_failures.append("execution_log_missing")
            else:
                current_failures.extend(
                    validate_execution_log_chain(
                        candidate,
                        evidence_id,
                        log,
                        case.get("caseId"),
                        case.get("taskId"),
                        case.get("specRefs"),
                    )
                )
            if case.get("uiRequired") is True and candidate.get("executionAdapter") != "playwright_test":
                current_failures.append("ui_case_requires_playwright_test")
            if not current_failures:
                selected = candidate
                break
            candidate_failures.extend(current_failures)
        if selected is None:
            case_failures.append("missing_current_round_pass_execution")
            case_failures.extend(candidate_failures)
        else:
            run_id = selected.get("runId")
            used_run_ids.add(run_id)
        if case_failures:
            errors.extend(
                {"reason": reason, "detail": case_id} for reason in case_failures
            )
            if case.get("verdict") == "PASS":
                case["verdict"] = "BLOCKED"
                case["reason"] = "当前轮可信执行链不完整"
                case.pop("verdictSource", None)
        else:
            case["verdict"] = "PASS"
            case["verdictSource"] = "finalize"
            case.pop("reason", None)

    errors.extend(
        _coverage_errors(
            feature_dir, data.get("scenarioCoverage"), evidence_by_id, current
        )
    )
    if errors:
        data["verdict"] = (
            "FAIL"
            if any(case.get("verdict") == "FAIL" for case in _cases(data))
            else "BLOCKED"
        )
        data["verdictSource"] = "finalize"
        return data, errors
    if all(case.get("verdict") in {"PASS", "SKIP"} for case in _cases(data)):
        data["verdict"] = "PASS"
        data["verdictSource"] = "finalize"
    else:
        data["verdict"] = "BLOCKED"
        data["verdictSource"] = "finalize"
        errors.append({"reason": "not_all_e2e_cases_terminal"})
    return data, errors


def _cmd_finalize(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    data, errors = _finalize_data(_feature_dir(workspace, feature), data)
    result = _write(workspace, feature, data)
    return render_result(
        WriterResult(
            ok=not errors and data.get("verdict") == "PASS",
            path=result.path,
            changed=result.changed,
            errors=errors,
            data={"verdict": data.get("verdict")},
        )
    )


def _validate_data(feature_dir: Path, data: Dict[str, Any]) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    if data.get("verdict") not in SUMMARY_RESULTS:
        errors.append({"reason": "invalid_e2e_result_summary_verdict"})
    if data.get("verdict") == "PASS" and data.get("verdictSource") != "finalize":
        errors.append({"reason": "e2e_pass_requires_finalize_source"})
    if not isinstance(data.get("cases"), list) or not data["cases"]:
        errors.append({"reason": "invalid_e2e_result_cases"})
        return errors
    for case in data["cases"]:
        if not isinstance(case, dict):
            errors.append({"reason": "invalid_e2e_result_case"})
            continue
        case_id = str(case.get("caseId", ""))
        for field in ("caseId", "taskId"):
            if not isinstance(case.get(field), str) or not case.get(field):
                errors.append({"reason": "missing_e2e_case_{}".format(field), "detail": case_id})
        if not isinstance(case.get("specRefs"), list) or not case.get("specRefs"):
            errors.append({"reason": "missing_e2e_case_specRefs", "detail": case_id})
        if case.get("executionMode") not in EXECUTION_MODES:
            errors.append({"reason": "invalid_e2e_execution_mode", "detail": case_id})
        if case.get("priority") not in PRIORITIES:
            errors.append({"reason": "invalid_e2e_priority", "detail": case_id})
        for reason in _valid_steps(case.get("steps"), case.get("uiRequired") is True, str(case.get("priority", ""))):
            errors.append({"reason": reason, "detail": case_id})
        if case.get("verdict") not in CASE_RESULTS:
            errors.append({"reason": "invalid_e2e_case_verdict", "detail": case_id})
        if case.get("verdict") == "PASS" and case.get("verdictSource") != "finalize":
            errors.append({"reason": "e2e_case_pass_requires_finalize_source", "detail": case_id})
    return errors


def _cmd_validate(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    errors = _validate_data(_feature_dir(workspace, feature), data)
    return render_result(
        WriterResult(ok=not errors, path=_path(workspace, feature), errors=errors)
    )


def _cmd_show(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    return render_result(
        WriterResult(
            ok=True,
            path=_path(workspace, feature),
            data={
                "summary": {
                    "verdict": data.get("verdict"),
                    "cases": len(data.get("cases", [])) if isinstance(data.get("cases"), list) else 0,
                    "currentRound": data.get("currentRound"),
                    "repairRounds": data.get("repairRounds", 0),
                    "scenarioCoverage": len(data.get("scenarioCoverage", []))
                    if isinstance(data.get("scenarioCoverage"), list)
                    else 0,
                }
            },
        )
    )


def _resolve(args: argparse.Namespace) -> Tuple[Path, str]:
    return resolve_workspace(args.workspace), resolve_feature(args.feature)


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--feature", required=True)


def _case_args(parser: argparse.ArgumentParser, require_case_id: bool, add: bool) -> None:
    _common(parser)
    parser.add_argument("--case-id", required=require_case_id)
    parser.add_argument("--task-id", required=add)
    parser.add_argument("--spec-ref", action="append", required=add)
    parser.add_argument("--ui-required", choices=["true", "false"], required=add)
    parser.add_argument("--priority", choices=sorted(PRIORITIES), required=add)
    parser.add_argument("--page-ref", action="append")
    parser.add_argument("--interaction-ref", action="append")
    parser.add_argument("--visual-source-ref", action="append")
    parser.add_argument("--execution-mode", choices=sorted(EXECUTION_MODES), required=add)
    parser.add_argument("--step-json", action="append", required=add)
    if not add:
        parser.add_argument("--verdict", choices=sorted(MODEL_RESULTS))
        parser.add_argument("--reason")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Incrementally write E2E_RESULT.json")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    _common(init)
    init.add_argument("--force", action="store_true")
    init.set_defaults(func=_cmd_init)

    add = sub.add_parser("add-case")
    _case_args(add, require_case_id=False, add=True)
    add.set_defaults(func=_cmd_add_case)

    update = sub.add_parser("update-case")
    _case_args(update, require_case_id=True, add=False)
    update.set_defaults(func=_cmd_update_case)

    begin = sub.add_parser("begin-round")
    _common(begin)
    begin.add_argument("--kind", choices=["initial", "repair"], required=True)
    begin.set_defaults(func=_cmd_begin_round)

    quality = sub.add_parser("sync-quality-gate")
    _common(quality)
    quality.set_defaults(func=_cmd_sync_quality)

    coverage = sub.add_parser("derive-scenario-coverage")
    _common(coverage)
    coverage.set_defaults(func=_cmd_derive_coverage)

    finalize = sub.add_parser("finalize")
    _common(finalize)
    finalize.set_defaults(func=_cmd_finalize)

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
        return render_result(
            fail(
                "e2e_result_writer_failed",
                "{}。修复：检查当前轮次、质量扫描与 E2E 产物后重试。".format(exc),
            )
        )


if __name__ == "__main__":
    raise SystemExit(main())
