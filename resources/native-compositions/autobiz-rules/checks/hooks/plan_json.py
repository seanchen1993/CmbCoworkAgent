"""Read-only rules extracted from hooks/plan_json.py. See provenance.json."""
from __future__ import annotations
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any
from hooks.plan_write_ownership import write_ownership_error_codes

TASK_ID_RE = re.compile(r"^T\d{3}$")


BATCH_ID_RE = re.compile(r"^B\d{3}$")


ATOMIC_GROUP_ID_RE = re.compile(r"^AG\d{3}$")


REQ_ID_RE = re.compile(r"\bREQ-\d{3}\b")


SCN_ID_RE = re.compile(r"\bSCN-\d{3}\b")


API_ID_RE = re.compile(r"^API-\d{3}$")


DATA_ID_RE = re.compile(r"^DATA-\d{3}$")


TECH_DECISION_ID_RE = re.compile(r"^D-\d{3}$")


EVIDENCE_ID_RE = re.compile(r"^ev_\d{4}$")


ACCEPTANCE_ID_RE = re.compile(r"^AC-T\d{3}-\d{2,3}$")


REPOSITORY_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


PAGE_ID_RE = re.compile(r"^PAGE-\d{3}$")


INTERACTION_ID_RE = re.compile(r"^UIX-\d{3}$")


VISUAL_SOURCE_ID_RE = re.compile(r"^VIS-\d{3}$")


SOURCE_ID_RE = re.compile(r"^SRC-\d{3}$")


FRONTEND_ROUTES = {"none", "spec-driven-ui", "absolute-html", "standard-html", "missing-html"}


COMPLETION_POLICIES = {
    "all_required_validations_pass",
    "external_dependency_recorded",
}


TASK_EXECUTION_MODES = {"code", "verified_existing", "external_dependency"}


TASK_VALIDATION_POLICY_MODES = {"defer_to_test_stages"}


TASK_VALIDATION_ERROR_CATEGORIES = {
    "external_dependency",
    "environment_failure",
    "source_compile_failure",
    "behavior_test_failure",
    "validation_contract_failure",
    "workspace_changed",
    "runner_integrity_failure",
}


MAX_BATCH_TASKS = 3


BATCH_STRATEGY = "minimal_closed_delivery_v2"


EXECUTION_LANES = {"backend", "frontend"}


IMPLEMENTATION_SCOPES = {"full_stack", "backend_only", "frontend_only"}


TASK_SET_STATUSES = {"collecting", "reviewing", "finalized"}


FEATURE_STATUSES = {"todo", "in_progress", "failed", "done"}


BATCH_STATUSES = {"todo", "in_progress", "failed", "done"}


TEST_STAGE_MAX_REPAIR_ATTEMPTS = 3


PARALLEL_EXECUTION_STAGES = {"parallel", "proto", "global", "integration"}


VALIDATION_DEFERRAL_REASONS = {
    "environment_failure",
    "repair_attempts_exhausted",
    "external_dependency",
}


VALIDATION_DEFERRAL_SCOPES = {"task", "batch", "project"}


VALIDATION_DEFERRAL_STATUS = "deferred"


DEFAULT_WORKSPACE_ROOT = "default"


TODO_STATUSES = {"todo", "pending", "not_started", "not-started", "待做", "未开始"}


IN_PROGRESS_STATUSES = {"in_progress", "in-progress", "doing", "进行中"}


IMPLEMENTED_STATUSES = {"implemented", "awaiting_validation", "awaiting-validation", "待验证"}


VALIDATING_STATUSES = {"validating", "验证中"}


DONE_STATUSES = {"done", "completed", "complete", "pass", "passed", "完成", "已完成"}


FAILED_STATUSES = {"failed", "fail", "blocked", "失败", "阻断"}


class PlanJsonError(ValueError):
    """Raised when a plan.json file cannot be loaded or validated."""


@dataclass(frozen=True)
class PlanBundle:
    root: dict[str, Any]
    batches: dict[str, dict[str, Any]]
    tasks: list[dict[str, Any]]
    task_batches: dict[str, str]


def plan_json_path(target_feature_dir: Path) -> Path:
    return target_feature_dir / "plan.json"


def batch_plan_path(target_feature_dir: Path, batch_id: str) -> Path:
    if not BATCH_ID_RE.fullmatch(batch_id):
        raise PlanJsonError(f"invalid_batch_id:{batch_id}")
    return target_feature_dir / "plans" / batch_id / "plan.json"


def normalize_status(status: Any) -> str:
    if not isinstance(status, str):
        return ""
    raw = status.strip()
    lowered = raw.lower().replace(" ", "_")
    if raw in TODO_STATUSES or lowered in TODO_STATUSES:
        return "todo"
    if raw in IN_PROGRESS_STATUSES or lowered in IN_PROGRESS_STATUSES:
        return "in_progress"
    if raw in IMPLEMENTED_STATUSES or lowered in IMPLEMENTED_STATUSES:
        return "implemented"
    if raw in VALIDATING_STATUSES or lowered in VALIDATING_STATUSES:
        return "validating"
    if raw in DONE_STATUSES or lowered in DONE_STATUSES:
        return "done"
    if raw in FAILED_STATUSES or lowered in FAILED_STATUSES:
        return "failed"
    return ""


def task_execution_lane(task: dict[str, Any]) -> str:
    return "frontend" if task.get("uiRequired") is True else "backend"


def implementation_scope_task_errors(scope: Any, tasks: list[dict[str, Any]]) -> list[str]:
    """Reject tasks outside the Feature's selected implementation scope."""

    if scope is None:
        return []
    if scope not in IMPLEMENTATION_SCOPES:
        return ["plan_json_implementationScope_invalid"]
    if scope == "full_stack":
        return []
    errors: list[str] = []
    expected_lane = "backend" if scope == "backend_only" else "frontend"
    for task in tasks:
        task_id = str(task.get("id", "task"))
        actual_lane = task_execution_lane(task)
        if actual_lane != expected_lane:
            errors.append(
                f"{task_id}.implementation_scope_{expected_lane}_only_required:{scope}"
            )
    return errors


def task_execution_mode(task: dict[str, Any]) -> str:
    """Return the structured execution mode, defaulting legacy plans to code."""

    value = task.get("executionMode")
    return value if isinstance(value, str) and value in TASK_EXECUTION_MODES else "code"


def defer_to_test_stages_enabled(data: dict[str, Any]) -> bool:
    """Return whether the current Review/UTest validation policy is enabled."""
    policy = data.get("taskValidationPolicy")
    return (
        isinstance(policy, dict)
        and policy.get("mode") == "defer_to_test_stages"
        and policy.get("orchestration") == "inline"
        and policy.get("codeGate") == "review_only"
    )


def normalize_repository_relative_path(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw == ".":
        return "."
    slash_normalized = raw.replace("\\", "/")
    posix_path = PurePosixPath(slash_normalized)
    windows_path = PureWindowsPath(raw)
    if (
        not slash_normalized
        or posix_path.is_absolute()
        or windows_path.is_absolute()
        or bool(windows_path.drive)
        or ".." in posix_path.parts
    ):
        return None
    normalized = slash_normalized.strip("/")
    return posix_path.as_posix()


def _validate_code_workspace_bindings(
    errors: list[str],
    data: dict[str, Any],
    batch_workspace_refs: set[str],
) -> None:
    """Validate the top-level runtime mapping without touching the filesystem."""
    raw = data.get("codeWorkspaces")
    if raw is None:
        return  # Backward-compatible read of Plans created before this contract.
    if not isinstance(raw, dict) or not raw:
        errors.append("plan_json_codeWorkspaces_must_be_non_empty_object")
        return
    for repository, path in raw.items():
        if not isinstance(repository, str) or not REPOSITORY_ID_RE.fullmatch(repository):
            errors.append(f"plan_json_codeWorkspaces_repository_invalid:{repository}")
        if not isinstance(path, str) or not path.strip():
            errors.append(f"plan_json_codeWorkspaces_path_missing:{repository}")
            continue
        if not (Path(path).expanduser().is_absolute() or PureWindowsPath(path).is_absolute()):
            errors.append(f"plan_json_codeWorkspaces_path_must_be_absolute:{repository}")
    missing = sorted(batch_workspace_refs - set(raw))
    unexpected = sorted(set(raw) - batch_workspace_refs)
    if missing:
        errors.append("plan_json_codeWorkspaces_missing_refs:" + ",".join(missing))
    if unexpected:
        errors.append("plan_json_codeWorkspaces_unknown_refs:" + ",".join(unexpected))


def task_workspace_roots(task: dict[str, Any]) -> dict[str, str]:
    scope = task.get("scope")
    raw_roots = scope.get("workspaceRoots") if isinstance(scope, dict) else None
    if not isinstance(raw_roots, dict):
        return {}
    roots: dict[str, str] = {}
    for key, value in raw_roots.items():
        normalized = normalize_repository_relative_path(value)
        if isinstance(key, str) and normalized is not None:
            roots[key] = normalized
    return roots


def repository_path_within_workspace(path: str, workspace_root: str) -> bool:
    normalized_path = normalize_repository_relative_path(path)
    normalized_root = normalize_repository_relative_path(workspace_root)
    if normalized_path is None or normalized_root is None:
        return False
    if normalized_root == ".":
        return True
    return normalized_path == normalized_root or normalized_path.startswith(f"{normalized_root}/")


def _string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        stripped = item.strip()
        if stripped:
            result.append(stripped)
    return result


def _validate_string_list(
    errors: list[str],
    task: dict[str, Any],
    task_id: str,
    field: str,
    *,
    required: bool = True,
    item_re: re.Pattern[str] | None = None,
) -> list[str]:
    values = _string_list(task.get(field))
    if values is None:
        errors.append(f"{task_id}.{field}_must_be_string_array")
        return []
    if required and not values:
        errors.append(f"{task_id}.{field}_missing")
    if item_re is not None:
        for value in values:
            if not item_re.fullmatch(value):
                errors.append(f"{task_id}.{field}_invalid:{value}")
    return values


def load_plan(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size <= 0:
        raise PlanJsonError(f"missing_plan_json:{path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PlanJsonError(f"invalid_plan_json:{path}:{exc}") from exc
    if not isinstance(data, dict):
        raise PlanJsonError(f"invalid_plan_json_root:{path}")
    return data


def _validate_tasks_container(
    data: Any,
    *,
    require_initial_status: bool = False,
    require_all_done: bool = False,
    known_task_ids: set[str] | None = None,
    defer_to_test_stages: bool = False,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["plan_json_root_must_be_object"]

    feature_id = data.get("featureId")
    if not isinstance(feature_id, str) or not feature_id.strip():
        errors.append("plan_json_missing_feature_id")

    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        errors.append("plan_json_missing_tasks")
        return errors

    task_ids: list[str] = []
    deps_by_task: dict[str, list[str]] = {}
    for index, raw_task in enumerate(tasks):
        if not isinstance(raw_task, dict):
            errors.append(f"tasks[{index}]_must_be_object")
            continue
        task_id = raw_task.get("id")
        if not isinstance(task_id, str) or not TASK_ID_RE.match(task_id):
            errors.append(f"tasks[{index}].id_invalid")
            task_id = f"tasks[{index}]"
        elif task_id in task_ids:
            errors.append(f"duplicate_task_id:{task_id}")
        task_ids.append(task_id)

        title = raw_task.get("title")
        if not isinstance(title, str) or not title.strip():
            errors.append(f"{task_id}.title_missing")

        _validate_task_details(errors, raw_task, task_id)

        status = normalize_status(raw_task.get("status"))
        if not status:
            errors.append(f"{task_id}.status_invalid")
        elif require_initial_status and status != "todo":
            errors.append(f"{task_id}.status_not_initial")
        elif require_all_done and status != "done":
            errors.append(f"{task_id}.status_not_done")

        deps = _validate_string_list(errors, raw_task, task_id, "deps", required=False, item_re=TASK_ID_RE)
        deps_by_task[task_id] = deps
        if task_id in deps:
            errors.append(f"{task_id}.dependency_self_cycle")

        spec_refs = _validate_string_list(errors, raw_task, task_id, "specRefs")
        if spec_refs and not any(REQ_ID_RE.search(ref) for ref in spec_refs):
            errors.append(f"{task_id}.specRefs_missing_requirement_id")
        if spec_refs and not any(SCN_ID_RE.search(ref) for ref in spec_refs):
            errors.append(f"{task_id}.specRefs_missing_scenario_id")

        _validate_string_list(errors, raw_task, task_id, "designRefs", required=False)
        if "mergedScenarioRefs" in raw_task:
            _validate_string_list(errors, raw_task, task_id, "mergedScenarioRefs", required=False)
        _validate_string_list(errors, raw_task, task_id, "apiIds", required=False, item_re=API_ID_RE)
        _validate_string_list(errors, raw_task, task_id, "dataIds", required=False, item_re=DATA_ID_RE)
        _validate_string_list(
            errors,
            raw_task,
            task_id,
            "decisionIds",
            required=False,
            item_re=TECH_DECISION_ID_RE,
        )
        evidence_ids = _validate_string_list(
            errors,
            raw_task,
            task_id,
            "evidenceIds",
            required=False,
            item_re=EVIDENCE_ID_RE,
        )
        if require_all_done and not evidence_ids:
            errors.append(f"{task_id}.evidenceIds_missing")
        implementation_ids = _validate_string_list(
            errors,
            raw_task,
            task_id,
            "implementationEvidenceIds",
            required=False,
            item_re=EVIDENCE_ID_RE,
        ) if "implementationEvidenceIds" in raw_task else []
        validation_ids = _validate_string_list(
            errors,
            raw_task,
            task_id,
            "validationEvidenceIds",
            required=False,
            item_re=EVIDENCE_ID_RE,
        ) if "validationEvidenceIds" in raw_task else []
        for evidence_id in [*implementation_ids, *validation_ids]:
            if evidence_id not in evidence_ids:
                errors.append(f"{task_id}.runtimeEvidenceId_not_in_evidenceIds:{evidence_id}")
        latest_implementation = raw_task.get("latestImplementationEvidenceId")
        if (
            (implementation_ids and latest_implementation != implementation_ids[-1])
            or (not implementation_ids and latest_implementation is not None)
        ):
            errors.append(f"{task_id}.latestImplementationEvidenceId_invalid")
        revision = raw_task.get("implementationRevision")
        if revision is not None and (not isinstance(revision, int) or isinstance(revision, bool) or revision < 0):
            errors.append(f"{task_id}.implementationRevision_invalid")
        elif revision is not None and revision != len(implementation_ids):
            errors.append(f"{task_id}.implementationRevision_evidence_mismatch")
        repair_attempts = raw_task.get("validationRepairAttempts", 0)
        if (
            not isinstance(repair_attempts, int)
            or isinstance(repair_attempts, bool)
            or repair_attempts < 0
        ):
            errors.append(f"{task_id}.validationRepairAttempts_invalid")
        disposition = raw_task.get("validationDisposition")
        if disposition is not None:
            _validate_validation_deferral(
                errors,
                disposition,
                context=f"{task_id}.validationDisposition",
                expected_scope="task",
            )
            if isinstance(disposition, dict) and disposition.get("taskId") != task_id:
                errors.append(f"{task_id}.validationDisposition.taskId_mismatch")
        completion_evidence_ids = _validate_string_list(
            errors,
            raw_task,
            task_id,
            "completionEvidenceIds",
            required=False,
            item_re=EVIDENCE_ID_RE,
        )
        for completion_id in completion_evidence_ids:
            if completion_id not in evidence_ids:
                errors.append(f"{task_id}.completionEvidenceId_not_in_evidenceIds:{completion_id}")
        latest_pass = raw_task.get("latestPassEvidenceId")
        if latest_pass is not None and (
            not isinstance(latest_pass, str) or not EVIDENCE_ID_RE.fullmatch(latest_pass)
        ):
            errors.append(f"{task_id}.latestPassEvidenceId_invalid")
        if require_all_done:
            # defer_to_test_stages 下任务 done 不强制要求 completion evidence；
            # Review/UTest/Merge Train 负责后续验证闭环。
            validation_deferred = isinstance(disposition, dict)
            defer_to_test = defer_to_test_stages

            if not completion_evidence_ids and not validation_deferred and not defer_to_test:
                errors.append(f"{task_id}.completionEvidenceIds_missing")
            if validation_deferred and latest_pass is not None:
                errors.append(f"{task_id}.latestPassEvidenceId_forbidden_when_deferred")
            elif not validation_deferred and not defer_to_test and (not isinstance(latest_pass, str) or not latest_pass):
                errors.append(f"{task_id}.latestPassEvidenceId_missing")
            elif isinstance(latest_pass, str) and latest_pass not in completion_evidence_ids:
                errors.append(f"{task_id}.latestPassEvidenceId_not_completion_evidence:{latest_pass}")
            elif isinstance(latest_pass, str) and latest_pass != completion_evidence_ids[-1]:
                errors.append(f"{task_id}.latestPassEvidenceId_not_latest:{latest_pass}")
        _validate_string_list(errors, raw_task, task_id, "expectedFiles", required=False)
        if "sourceRefs" in raw_task:
            _validate_string_list(
                errors, raw_task, task_id, "sourceRefs", required=False, item_re=SOURCE_ID_RE,
            )
        blockers = _validate_string_list(errors, raw_task, task_id, "blockers", required=False)
        if require_all_done and blockers:
            errors.append(f"{task_id}.blockers_unresolved")

        ui_required = raw_task.get("uiRequired")
        is_ui_required = ui_required is True
        if ui_required is not None and not isinstance(ui_required, bool):
            errors.append(f"{task_id}.uiRequired_must_be_bool")
        ui_refs = raw_task.get("uiRefs")
        if ui_refs is None:
            if is_ui_required:
                errors.append(f"{task_id}.uiRefs_missing")
        elif not isinstance(ui_refs, dict):
            errors.append(f"{task_id}.uiRefs_must_be_object")
        else:
            for field, item_re in (
                ("pageRefs", PAGE_ID_RE),
                ("interactionRefs", INTERACTION_ID_RE),
                ("visualSourceRefs", VISUAL_SOURCE_ID_RE),
            ):
                if field not in ui_refs and is_ui_required:
                    errors.append(f"{task_id}.uiRefs.{field}_missing")
                elif field in ui_refs:
                    _validate_string_list(errors, ui_refs, task_id, field, required=False, item_re=item_re)
            frontend_route = ui_refs.get("frontendRoute")
            if frontend_route is None and is_ui_required:
                errors.append(f"{task_id}.uiRefs.frontendRoute_missing")
            elif frontend_route is not None and (
                not isinstance(frontend_route, str) or frontend_route not in FRONTEND_ROUTES
            ):
                errors.append(f"{task_id}.uiRefs.frontendRoute_invalid")

    known_ids = known_task_ids or {task_id for task_id in task_ids if TASK_ID_RE.match(task_id)}
    for task_id, deps in deps_by_task.items():
        for dep in deps:
            if dep not in known_ids:
                errors.append(f"{task_id}.dependency_unknown:{dep}")
    errors.extend(_dag_errors(deps_by_task))
    return errors


def atomic_group_errors(
    task_items: list[dict[str, Any]],
    *,
    allow_incomplete: bool = False,
) -> list[str]:
    """Validate the cross-Task contract for explicit atomic delivery groups."""

    groups: dict[str, list[dict[str, Any]]] = {}
    for task in task_items:
        raw = task.get("atomicGroup")
        if raw is None:
            continue
        task_id = str(task.get("id", "task"))
        if not isinstance(raw, dict):
            continue  # The per-Task validator reports the shape error.
        group_id = raw.get("id")
        if isinstance(group_id, str) and ATOMIC_GROUP_ID_RE.fullmatch(group_id):
            groups.setdefault(group_id, []).append(task)

    errors: list[str] = []
    for group_id, members in groups.items():
        member_ids = ",".join(str(item.get("id")) for item in members)
        if len(members) == 1 and not allow_incomplete:
            errors.append(f"atomicGroup.{group_id}_requires_two_or_three_tasks:taskIds={member_ids}")
            continue
        if len(members) > MAX_BATCH_TASKS:
            errors.append(f"atomicGroup.{group_id}_task_limit_exceeded:{len(members)}>{MAX_BATCH_TASKS}")
        workspace_refs = {item.get("workspaceRef") for item in members}
        lanes = {task_execution_lane(item) for item in members}
        stages = {str(item.get("executionStage") or "parallel") for item in members}
        rationales = {
            str(item.get("atomicGroup", {}).get("rationale")).strip()
            for item in members
            if isinstance(item.get("atomicGroup"), dict)
        }
        if len(workspace_refs) > 1:
            errors.append(f"atomicGroup.{group_id}_workspaceRef_mismatch:taskIds={member_ids}")
        if len(lanes) > 1:
            errors.append(f"atomicGroup.{group_id}_executionLane_mismatch:taskIds={member_ids}")
        if len(stages) > 1:
            errors.append(f"atomicGroup.{group_id}_executionStage_mismatch:taskIds={member_ids}")
        if len(rationales) > 1:
            errors.append(f"atomicGroup.{group_id}_rationale_mismatch:taskIds={member_ids}")
    return errors


def validate_plan_data(
    data: Any,
    *,
    require_initial_status: bool = False,
    require_all_done: bool = False,
) -> list[str]:
    """Validate the root batch index. Task contracts live in batch plans."""

    errors: list[str] = []
    if not isinstance(data, dict):
        return ["plan_json_root_must_be_object"]
    if "tasks" in data:
        errors.append("monolithic_plan_requires_rebuild")
    if "version" in data or "taskDetailVersion" in data:
        errors.append("legacy_plan_requires_rebuild")
    feature_id = data.get("featureId")
    if not isinstance(feature_id, str) or not feature_id.strip():
        errors.append("plan_json_missing_feature_id")
    implementation_scope = data.get("implementationScope")
    if implementation_scope is not None and implementation_scope not in IMPLEMENTATION_SCOPES:
        errors.append("plan_json_implementationScope_invalid")
    if data.get("taskSetStatus") not in TASK_SET_STATUSES:
        errors.append("plan_json_taskSetStatus_invalid")
    status = data.get("status")
    if status not in FEATURE_STATUSES:
        errors.append("plan_json_status_invalid")
    elif require_initial_status and status != "todo":
        errors.append("plan_json_status_not_initial")
    elif require_all_done and status != "done":
        errors.append("plan_json_status_not_done")

    policy = data.get("batchPolicy")
    if not isinstance(policy, dict):
        errors.append("plan_json_batchPolicy_missing")
    else:
        strategy = policy.get("strategy")
        if strategy == BATCH_STRATEGY:
            if policy.get("maxTasks") != MAX_BATCH_TASKS:
                errors.append(f"plan_json_batchPolicy_maxTasks_must_be:{MAX_BATCH_TASKS}")
        else:
            errors.append(f"plan_json_batchPolicy_strategy_must_be:{BATCH_STRATEGY}")
    _validate_task_validation_policy(errors, data)

    raw_batches = data.get("batches")
    batch_ids: list[str] = []
    if not isinstance(raw_batches, list) or not raw_batches:
        errors.append("plan_json_missing_batches")
    else:
        for index, entry in enumerate(raw_batches):
            context = f"batches[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{context}_must_be_object")
                continue
            batch_id = entry.get("id")
            if not isinstance(batch_id, str) or not BATCH_ID_RE.fullmatch(batch_id):
                errors.append(f"{context}.id_invalid")
                continue
            if batch_id in batch_ids:
                errors.append(f"duplicate_batch_id:{batch_id}")
            batch_ids.append(batch_id)
            expected_path = f"plans/{batch_id}/plan.json"
            if entry.get("path") != expected_path:
                errors.append(f"{batch_id}.path_invalid")
            if not isinstance(entry.get("title"), str) or not str(entry.get("title")).strip():
                errors.append(f"{batch_id}.title_missing")
            if entry.get("executionLane") not in EXECUTION_LANES:
                errors.append(f"{batch_id}.executionLane_invalid")
            workspace_ref = entry.get("workspaceRef")
            if workspace_ref is not None and (
                not isinstance(workspace_ref, str) or not workspace_ref.strip()
            ):
                errors.append(f"{batch_id}.workspaceRef_invalid")
            if "executionStage" in entry and entry.get("executionStage") not in PARALLEL_EXECUTION_STAGES:
                errors.append(f"{batch_id}.executionStage_invalid")
            _validate_string_list(errors, entry, batch_id, "specRoots", required=True)
            _validate_string_list(errors, entry, batch_id, "deps", required=False, item_re=BATCH_ID_RE)
            task_ids = _validate_string_list(errors, entry, batch_id, "taskIds", required=True, item_re=TASK_ID_RE)
            delivery_kind = entry.get("deliveryKind")
            if delivery_kind not in {"single_task", "atomic_group"}:
                errors.append(f"{batch_id}.deliveryKind_invalid")
            elif delivery_kind == "single_task":
                if len(task_ids) != 1:
                    errors.append(f"{batch_id}.single_task_requires_one_task")
                if "atomicGroupId" in entry or "batchRationale" in entry:
                    errors.append(f"{batch_id}.single_task_atomic_fields_forbidden")
            else:
                group_id = entry.get("atomicGroupId")
                rationale = entry.get("batchRationale")
                if not isinstance(group_id, str) or not ATOMIC_GROUP_ID_RE.fullmatch(group_id):
                    errors.append(f"{batch_id}.atomicGroupId_invalid")
                if not isinstance(rationale, str) or len(rationale.strip()) < 10:
                    errors.append(f"{batch_id}.batchRationale_missing_or_too_short")
                if len(task_ids) > MAX_BATCH_TASKS:
                    errors.append(f"{batch_id}.atomic_group_task_limit_invalid")
            batch_status = entry.get("status")
            if batch_status not in BATCH_STATUSES:
                errors.append(f"{batch_id}.status_invalid")
            elif require_initial_status and batch_status != "todo":
                errors.append(f"{batch_id}.status_not_initial")
            elif require_all_done and batch_status != "done":
                errors.append(f"{batch_id}.status_not_done")

    used_lanes = {
        str(entry.get("executionLane"))
        for entry in raw_batches or []
        if isinstance(entry, dict) and entry.get("executionLane") in EXECUTION_LANES
    }
    batch_workspace_refs = {
        str(entry.get("workspaceRef"))
        for entry in raw_batches or []
        if isinstance(entry, dict)
        and isinstance(entry.get("workspaceRef"), str)
        and entry.get("workspaceRef")
    }
    _validate_code_workspace_bindings(errors, data, batch_workspace_refs)

    known_batches = set(batch_ids)
    for field in ("activeBatchId", "nextBatchId"):
        value = data.get(field)
        if value is not None and (not isinstance(value, str) or value not in known_batches):
            errors.append(f"plan_json_{field}_invalid")
    if require_all_done and (data.get("activeBatchId") is not None or data.get("nextBatchId") is not None):
        errors.append("plan_json_done_with_pending_batch_pointer")

    return errors


def validate_batch_plan_data(
    data: Any,
    *,
    expected_feature_id: str | None = None,
    expected_batch_id: str | None = None,
    known_task_ids: set[str] | None = None,
    require_initial_status: bool = False,
    require_all_done: bool = False,
    defer_to_test_stages: bool = False,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["batch_plan_root_must_be_object"]
    if "version" in data or "taskDetailVersion" in data:
        errors.append("legacy_plan_requires_rebuild")
    feature_id = data.get("featureId")
    if not isinstance(feature_id, str) or not feature_id.strip():
        errors.append("batch_plan_missing_feature_id")
    elif expected_feature_id is not None and feature_id != expected_feature_id:
        errors.append(f"batch_plan_feature_mismatch:{feature_id}")
    batch_id = data.get("batchId")
    if not isinstance(batch_id, str) or not BATCH_ID_RE.fullmatch(batch_id):
        errors.append("batch_plan_id_invalid")
        batch_id = "batch"
    elif expected_batch_id is not None and batch_id != expected_batch_id:
        errors.append(f"batch_plan_id_mismatch:{batch_id}")
    if data.get("executionLane") not in EXECUTION_LANES:
        errors.append(f"{batch_id}.executionLane_invalid")
    if not isinstance(data.get("title"), str) or not str(data.get("title")).strip():
        errors.append(f"{batch_id}.title_missing")
    status = data.get("status")
    if status not in BATCH_STATUSES:
        errors.append(f"{batch_id}.status_invalid")
    elif require_initial_status and status != "todo":
        errors.append(f"{batch_id}.status_not_initial")
    elif require_all_done and status != "done":
        errors.append(f"{batch_id}.status_not_done")

    batch_tasks = tasks(data)
    if len(batch_tasks) > MAX_BATCH_TASKS:
        errors.append(f"{batch_id}.batch_task_limit_exceeded:{len(batch_tasks)}>{MAX_BATCH_TASKS}")
    if data.get("taskCount") != len(batch_tasks):
        errors.append(f"{batch_id}.taskCount_mismatch")
    completed_count = sum(normalize_status(item.get("status")) == "done" for item in batch_tasks)
    if data.get("completedTaskCount") != completed_count:
        errors.append(f"{batch_id}.completedTaskCount_mismatch")
    if "taskValidation" in data:
        errors.append(f"{batch_id}.taskValidation_forbidden")
    delivery_kind = data.get("deliveryKind")
    if delivery_kind not in {"single_task", "atomic_group"}:
        errors.append(f"{batch_id}.deliveryKind_invalid")
    elif delivery_kind == "single_task":
        if len(batch_tasks) != 1:
            errors.append(f"{batch_id}.single_task_requires_one_task")
        if "atomicGroupId" in data or "batchRationale" in data:
            errors.append(f"{batch_id}.single_task_atomic_fields_forbidden")
    elif delivery_kind == "atomic_group":
        group_id = data.get("atomicGroupId")
        rationale = data.get("batchRationale")
        if not isinstance(group_id, str) or not ATOMIC_GROUP_ID_RE.fullmatch(group_id):
            errors.append(f"{batch_id}.atomicGroupId_invalid")
        if not isinstance(rationale, str) or len(rationale.strip()) < 10:
            errors.append(f"{batch_id}.batchRationale_missing_or_too_short")
        if len(batch_tasks) > MAX_BATCH_TASKS:
            errors.append(f"{batch_id}.atomic_group_task_limit_invalid")
    workspace_root_sets = [
        task_workspace_roots(item)
        for item in batch_tasks
        if task_workspace_roots(item)
    ]
    workspace_refs = {
        item.get("workspaceRef")
        for item in batch_tasks
        if isinstance(item.get("workspaceRef"), str)
    }
    if len(workspace_refs) > 1:
        errors.append(f"{batch_id}.mixed_task_workspace_refs")
    workspace_roots = workspace_root_sets[0] if workspace_root_sets else {}
    if any(item != workspace_roots for item in workspace_root_sets[1:]):
        errors.append(f"{batch_id}.mixed_task_workspace_roots")
    frontend_routes = {
        ui_refs.get("frontendRoute")
        for item in batch_tasks
        if item.get("uiRequired") is True
        for ui_refs in [item.get("uiRefs")]
        if isinstance(ui_refs, dict) and isinstance(ui_refs.get("frontendRoute"), str)
    }
    if len(frontend_routes) > 1:
        errors.append(f"{batch_id}.mixed_task_frontend_routes")
    _validate_string_list(errors, data, str(batch_id), "completionEvidenceIds", required=False, item_re=EVIDENCE_ID_RE)
    for field in ("startedAt", "completedAt"):
        value = data.get(field)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            errors.append(f"{batch_id}.{field}_invalid")
    errors.extend(
        _validate_tasks_container(
            data,
            require_initial_status=require_initial_status,
            require_all_done=require_all_done,
            known_task_ids=known_task_ids,
            defer_to_test_stages=defer_to_test_stages,
        )
    )
    return errors


def _validate_acceptance_criteria(errors: list[str], task: dict[str, Any], task_id: str) -> None:
    criteria = task.get("acceptanceCriteria")
    if not isinstance(criteria, list):
        errors.append(f"{task_id}.acceptanceCriteria_must_be_array")
        return
    if not criteria:
        errors.append(f"{task_id}.acceptanceCriteria_missing")
        return
    seen: set[str] = set()
    task_scenario_ids = {
        match.group(0)
        for ref in (_string_list(task.get("specRefs")) or [])
        for match in SCN_ID_RE.finditer(ref)
    }
    for index, criterion in enumerate(criteria):
        context = f"{task_id}.acceptanceCriteria[{index}]"
        if not isinstance(criterion, dict):
            errors.append(f"{context}_must_be_object")
            continue
        criterion_id = criterion.get("id")
        if not isinstance(criterion_id, str) or not ACCEPTANCE_ID_RE.fullmatch(criterion_id):
            errors.append(f"{context}.id_invalid")
        elif not criterion_id.startswith(f"AC-{task_id}-"):
            errors.append(f"{context}.id_task_mismatch:{criterion_id}")
        elif criterion_id in seen:
            errors.append(f"{task_id}.acceptanceCriteria_duplicate:{criterion_id}")
        else:
            seen.add(criterion_id)
        text = criterion.get("text")
        if not isinstance(text, str) or not text.strip():
            errors.append(f"{context}.text_missing")
        scenario_refs = _string_list(criterion.get("scenarioRefs"))
        if scenario_refs is None:
            errors.append(f"{context}.scenarioRefs_must_be_string_array")
        elif not scenario_refs or not all(SCN_ID_RE.search(ref) for ref in scenario_refs):
            errors.append(f"{context}.scenarioRefs_missing_scenario_id")
        else:
            criterion_scenario_ids = {
                match.group(0)
                for ref in scenario_refs
                for match in SCN_ID_RE.finditer(ref)
            }
            for scenario_id in sorted(criterion_scenario_ids - task_scenario_ids):
                errors.append(f"{context}.scenario_not_in_task_specRefs:{scenario_id}")


def _validate_task_validation_policy(errors: list[str], data: dict[str, Any]) -> None:
    policy = data.get("taskValidationPolicy")
    if policy is None:
        errors.append("taskValidationPolicy_missing")
        return
    if not isinstance(policy, dict):
        errors.append("taskValidationPolicy_must_be_object")
        return
    if policy.get("mode") not in TASK_VALIDATION_POLICY_MODES:
        errors.append("taskValidationPolicy.mode_invalid")

    if policy.get("orchestration") != "inline":
        errors.append("taskValidationPolicy.orchestration_must_be_inline")
    if policy.get("codeGate") != "review_only":
        errors.append("taskValidationPolicy.codeGate_must_be_review_only")
    if policy.get("maxTestStageRepairAttempts") != TEST_STAGE_MAX_REPAIR_ATTEMPTS:
        errors.append(
            f"taskValidationPolicy.maxTestStageRepairAttempts_must_be:{TEST_STAGE_MAX_REPAIR_ATTEMPTS}"
        )
    allowed_fields = {
        "mode",
        "orchestration",
        "codeGate",
        "maxTestStageRepairAttempts",
    }
    for field in sorted(set(policy) - allowed_fields):
        errors.append(f"taskValidationPolicy.{field}_forbidden")


def _validate_validation_deferral(
    errors: list[str],
    issue: Any,
    *,
    context: str,
    expected_scope: str | None = None,
) -> None:
    if not isinstance(issue, dict):
        errors.append(f"{context}_must_be_object")
        return
    if not isinstance(issue.get("issueId"), str) or not issue.get("issueId", "").strip():
        errors.append(f"{context}.issueId_invalid")
    scope = issue.get("scope")
    if scope not in VALIDATION_DEFERRAL_SCOPES or (
        expected_scope is not None and scope != expected_scope
    ):
        errors.append(f"{context}.scope_invalid")
    if issue.get("status") != VALIDATION_DEFERRAL_STATUS:
        errors.append(f"{context}.status_invalid")
    if issue.get("reason") not in VALIDATION_DEFERRAL_REASONS:
        errors.append(f"{context}.reason_invalid")
    if issue.get("errorCategory") not in TASK_VALIDATION_ERROR_CATEGORIES:
        errors.append(f"{context}.errorCategory_invalid")
    command_id = issue.get("commandId")
    if command_id is not None and (not isinstance(command_id, str) or not command_id.strip()):
        errors.append(f"{context}.commandId_invalid")
    attempts = issue.get("repairAttempts")
    if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
        errors.append(f"{context}.repairAttempts_invalid")
    max_attempts = issue.get("maxRepairAttempts")
    if not isinstance(max_attempts, int) or isinstance(max_attempts, bool) or max_attempts < 0:
        errors.append(f"{context}.maxRepairAttempts_invalid")
    evidence_ids = _string_list(issue.get("evidenceIds"))
    if evidence_ids is None or any(not EVIDENCE_ID_RE.fullmatch(item) for item in evidence_ids):
        errors.append(f"{context}.evidenceIds_invalid")
    owner_stages = _string_list(issue.get("handoffStages"))
    if owner_stages is None or not owner_stages:
        errors.append(f"{context}.handoffStages_invalid")
    if not isinstance(issue.get("createdAt"), str) or not issue.get("createdAt", "").strip():
        errors.append(f"{context}.createdAt_invalid")


def _validate_task_details(
    errors: list[str],
    task: dict[str, Any],
    task_id: str,
) -> None:
    atomic_group = task.get("atomicGroup")
    if atomic_group is not None:
        if not isinstance(atomic_group, dict):
            errors.append(f"{task_id}.atomicGroup_must_be_object")
        else:
            unknown = sorted(set(atomic_group) - {"id", "rationale"})
            if unknown:
                errors.append(f"{task_id}.atomicGroup_unknown_fields:{','.join(unknown)}")
            group_id = atomic_group.get("id")
            rationale = atomic_group.get("rationale")
            if not isinstance(group_id, str) or not ATOMIC_GROUP_ID_RE.fullmatch(group_id):
                errors.append(f"{task_id}.atomicGroup.id_invalid")
            if not isinstance(rationale, str) or len(rationale.strip()) < 10:
                errors.append(f"{task_id}.atomicGroup.rationale_missing_or_too_short")

    raw_execution_mode = task.get("executionMode")
    if raw_execution_mode is not None and raw_execution_mode not in TASK_EXECUTION_MODES:
        errors.append(f"{task_id}.executionMode_invalid")
    execution_mode = task_execution_mode(task)
    external_dependency = task.get("externalDependency")
    if execution_mode == "external_dependency":
        if not isinstance(external_dependency, dict):
            errors.append(f"{task_id}.externalDependency_missing")
        else:
            for field in ("system", "owner"):
                value = external_dependency.get(field)
                if not isinstance(value, str) or not value.strip():
                    errors.append(f"{task_id}.externalDependency.{field}_missing")
            tracking_refs = _string_list(external_dependency.get("trackingRefs"))
            if not tracking_refs:
                errors.append(f"{task_id}.externalDependency.trackingRefs_missing")
    elif external_dependency is not None:
        errors.append(f"{task_id}.externalDependency_forbidden")

    goal = task.get("goal")
    if not isinstance(goal, str) or not goal.strip():
        errors.append(f"{task_id}.goal_missing")

    scope = task.get("scope")
    scope_pages: list[str] = []
    scope_paths: list[str] = []
    workspace_roots: dict[str, str] = {}
    if not isinstance(scope, dict):
        errors.append(f"{task_id}.scope_must_be_object")
    else:
        for field in ("modules", "entrypoints", "pages", "dataObjects", "paths"):
            values = _string_list(scope.get(field))
            if field == "paths" and values is None:
                continue
            if values is None:
                errors.append(f"{task_id}.scope.{field}_must_be_string_array")
                continue
            if field == "paths":
                scope_paths = values
                for value in values:
                    raw_path = value.partition(":")[2] if ":" in value else value
                    if normalize_repository_relative_path(raw_path) is None:
                        errors.append(f"{task_id}.scope.paths_invalid:{value}")
            if field == "pages":
                scope_pages = values
                for value in values:
                    if not PAGE_ID_RE.fullmatch(value):
                        errors.append(f"{task_id}.scope.pages_invalid:{value}")

        raw_workspace_roots = scope.get("workspaceRoots")
        if scope_paths and not isinstance(raw_workspace_roots, dict):
            errors.append(f"{task_id}.scope.workspaceRoots_missing")
        elif raw_workspace_roots is not None:
            if not isinstance(raw_workspace_roots, dict) or not raw_workspace_roots:
                errors.append(f"{task_id}.scope.workspaceRoots_must_be_object")
            else:
                for key, value in raw_workspace_roots.items():
                    if not isinstance(key, str) or (
                        key != DEFAULT_WORKSPACE_ROOT and not REPOSITORY_ID_RE.fullmatch(key)
                    ):
                        errors.append(f"{task_id}.scope.workspaceRoots_key_invalid:{key}")
                        continue
                    normalized_root = normalize_repository_relative_path(value)
                    if normalized_root is None:
                        errors.append(f"{task_id}.scope.workspaceRoots_path_invalid:{value}")
                    else:
                        workspace_roots[key] = normalized_root
                if DEFAULT_WORKSPACE_ROOT in workspace_roots and len(workspace_roots) != 1:
                    errors.append(f"{task_id}.scope.workspaceRoots_default_must_be_single")
                if len(workspace_roots) > 1:
                    errors.append(f"{task_id}.scope.workspaceRoots_multiple_forbidden")

        for value in scope_paths:
            repository: str | None = None
            relative = value
            if DEFAULT_WORKSPACE_ROOT not in workspace_roots and workspace_roots:
                repository, separator, relative = value.partition(":")
                if not separator or repository not in workspace_roots:
                    errors.append(f"{task_id}.scope.path_workspace_prefix_invalid:{value}")
                    continue
            elif ":" in value:
                errors.append(f"{task_id}.scope.path_workspace_prefix_unexpected:{value}")
                continue
            workspace_root = workspace_roots.get(repository or DEFAULT_WORKSPACE_ROOT)
            normalized_relative = normalize_repository_relative_path(relative)
            if (
                workspace_root
                and workspace_root != "."
                and normalized_relative is not None
                and repository_path_within_workspace(normalized_relative, workspace_root)
            ):
                errors.append(f"{task_id}.scope.path_repeats_workspace_root:{value}")

    workspace_ref = task.get("workspaceRef")
    if not isinstance(workspace_ref, str) or not REPOSITORY_ID_RE.fullmatch(workspace_ref):
        errors.append(f"{task_id}.workspaceRef_missing_or_invalid")
    elif workspace_roots:
        expected_key = DEFAULT_WORKSPACE_ROOT if workspace_ref == DEFAULT_WORKSPACE_ROOT else workspace_ref
        if expected_key not in workspace_roots:
            errors.append(f"{task_id}.workspaceRef_not_in_workspaceRoots:{workspace_ref}")

    implementation_points = _string_list(task.get("implementationPoints"))
    if implementation_points is None:
        errors.append(f"{task_id}.implementationPoints_must_be_string_array")

    _validate_acceptance_criteria(errors, task, task_id)
    completion_policy = task.get("completionPolicy")
    if completion_policy not in COMPLETION_POLICIES:
        errors.append(f"{task_id}.completionPolicy_invalid")
    expected_completion_policy = (
        "external_dependency_recorded"
        if execution_mode == "external_dependency"
        else "all_required_validations_pass"
    )
    if completion_policy in COMPLETION_POLICIES and completion_policy != expected_completion_policy:
        errors.append(f"{task_id}.completionPolicy_executionMode_mismatch")

    validation_boundary = task.get("validationBoundary")
    if not isinstance(validation_boundary, str) or not validation_boundary.strip():
        errors.append(f"{task_id}.validationBoundary_missing")

    raw_non_goals = task.get("nonGoals")
    non_goals = _string_list(task.get("nonGoals"))
    if non_goals is None:
        errors.append(f"{task_id}.nonGoals_must_be_string_array")
    elif isinstance(raw_non_goals, list) and len(non_goals) != len(raw_non_goals):
        errors.append(f"{task_id}.nonGoals_empty_item")

    ui_required = task.get("uiRequired") is True
    ui_refs = task.get("uiRefs")
    page_refs: list[str] = []
    if isinstance(ui_refs, dict):
        page_refs = _string_list(ui_refs.get("pageRefs")) or []
    if ui_required and sorted(scope_pages) != sorted(page_refs):
        errors.append(f"{task_id}.scope.pages_mismatch_uiRefs")


def _dag_errors(deps_by_task: dict[str, list[str]]) -> list[str]:
    errors: list[str] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str, stack: list[str]) -> None:
        if task_id in visited:
            return
        if task_id in visiting:
            errors.append("task_dependency_cycle:" + "->".join([*stack, task_id]))
            return
        visiting.add(task_id)
        for dep in deps_by_task.get(task_id, []):
            if dep in deps_by_task:
                visit(dep, [*stack, task_id])
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in deps_by_task:
        visit(task_id, [])
    return errors


def tasks(data: dict[str, Any]) -> list[dict[str, Any]]:
    bundle_tasks = data.get("_bundleTasks")
    if isinstance(bundle_tasks, list):
        return [task for task in bundle_tasks if isinstance(task, dict)]
    raw_tasks = data.get("tasks")
    return [task for task in raw_tasks if isinstance(task, dict)] if isinstance(raw_tasks, list) else []


def task_ids(data: dict[str, Any]) -> set[str]:
    return {task["id"] for task in tasks(data) if isinstance(task.get("id"), str)}


def _bundle_consistency_errors(
    root: dict[str, Any],
    batch_data: dict[str, dict[str, Any]],
    *,
    require_initial_status: bool = False,
    require_all_done: bool = False,
) -> list[str]:
    entries = [entry for entry in root.get("batches", []) if isinstance(entry, dict)]
    all_tasks: list[dict[str, Any]] = []
    task_batches: dict[str, str] = {}
    errors: list[str] = []
    for entry in entries:
        batch_id = str(entry.get("id", ""))
        data = batch_data.get(batch_id)
        if not isinstance(data, dict):
            errors.append(f"missing_batch_plan:{batch_id}")
            continue
        for item in tasks(data):
            task_id = item.get("id")
            if not isinstance(task_id, str):
                continue
            if task_id in task_batches:
                errors.append(f"duplicate_task_id:{task_id}")
            else:
                task_batches[task_id] = batch_id
                all_tasks.append(item)
    if errors:
        return errors
    known_task_ids = set(task_batches)
    strategy = root.get("batchPolicy", {}).get("strategy") if isinstance(root.get("batchPolicy"), dict) else None
    if strategy == BATCH_STRATEGY:
        errors.extend(atomic_group_errors(
            all_tasks,
            allow_incomplete=root.get("taskSetStatus") == "collecting",
        ))
    batch_order = {str(entry.get("id")): index for index, entry in enumerate(entries)}
    task_by_id = {str(item.get("id")): item for item in all_tasks}
    # Plan v2 has no speculative physical write set. When a producer later
    # records actual changes, impact analysis invalidates same-repository
    # concurrent evidence conservatively; Merge Train handles real conflicts.
    errors.extend(write_ownership_error_codes(
        all_tasks,
        ownership_scope_by_task=task_batches,
    ))
    deps_by_task: dict[str, list[str]] = {}
    for entry in entries:
        batch_id = str(entry.get("id"))
        data = batch_data[batch_id]
        entry_lane = entry.get("executionLane")
        errors.extend(
            validate_batch_plan_data(
                data,
                expected_feature_id=str(root.get("featureId")),
                expected_batch_id=batch_id,
                known_task_ids=known_task_ids,
                require_initial_status=require_initial_status,
                require_all_done=require_all_done,
                defer_to_test_stages=defer_to_test_stages_enabled(root),
            )
        )
        if root.get("batchPolicy", {}).get("strategy") == BATCH_STRATEGY:
            for field in ("deliveryKind",):
                if entry.get(field) != data.get(field):
                    errors.append(f"{batch_id}.{field}_projection_mismatch")
            delivery_kind = entry.get("deliveryKind")
            if delivery_kind == "atomic_group":
                for field in ("atomicGroupId", "batchRationale"):
                    if entry.get(field) != data.get(field):
                        errors.append(f"{batch_id}.{field}_projection_mismatch")
            if data.get("deliveryKind") is None:
                errors.append(f"{batch_id}.deliveryKind_missing")
        actual_ids = [str(item.get("id")) for item in tasks(data)]
        if entry.get("taskIds") != actual_ids:
            errors.append(f"{batch_id}.taskIds_mismatch")
        if entry.get("status") != data.get("status"):
            errors.append(f"{batch_id}.root_status_projection_mismatch")
        if strategy == BATCH_STRATEGY:
            task_atomic_ids = {
                item.get("atomicGroup", {}).get("id")
                for item in tasks(data)
                if isinstance(item.get("atomicGroup"), dict)
            }
            if entry.get("deliveryKind") == "single_task" and task_atomic_ids:
                errors.append(f"{batch_id}.single_task_contains_atomic_task")
            if entry.get("deliveryKind") == "atomic_group":
                if task_atomic_ids != {entry.get("atomicGroupId")}:
                    errors.append(f"{batch_id}.atomicGroup_task_membership_mismatch")
        root_lane = entry.get("executionLane")
        batch_lane = data.get("executionLane")
        if root_lane != batch_lane:
            errors.append(f"{batch_id}.executionLane_projection_mismatch")
        task_lanes = {task_execution_lane(item) for item in tasks(data)}
        if len(task_lanes) > 1:
            errors.append(f"{batch_id}.mixed_execution_lanes")
        elif task_lanes and batch_lane not in task_lanes:
            errors.append(f"{batch_id}.executionLane_task_mismatch")
        task_workspace_refs = {
            item.get("workspaceRef")
            for item in tasks(data)
            if isinstance(item.get("workspaceRef"), str) and item.get("workspaceRef")
        }
        if len(task_workspace_refs) > 1:
            errors.append(f"{batch_id}.workspaceRef_ambiguous")
        elif entry.get("workspaceRef") is not None and entry.get("workspaceRef") not in task_workspace_refs:
            errors.append(f"{batch_id}.workspaceRef_projection_mismatch")
        if "taskValidation" in data:
            errors.append(f"{batch_id}.taskValidation_forbidden")

        declared_batch_deps = set(entry.get("deps") or [])
        for dep_batch in declared_batch_deps:
            if dep_batch not in batch_order:
                errors.append(f"{batch_id}.dependency_unknown:{dep_batch}")
            elif batch_order[dep_batch] >= batch_order[batch_id]:
                errors.append(f"{batch_id}.dependency_not_earlier:{dep_batch}")
        required_batch_deps: set[str] = set()
        for item in tasks(data):
            task_id = str(item.get("id"))
            deps = [dep for dep in item.get("deps", []) if isinstance(dep, str)]
            deps_by_task[task_id] = deps
            for dep in deps:
                dep_batch = task_batches.get(dep)
                if dep_batch is None:
                    continue
                if batch_order[dep_batch] > batch_order[batch_id]:
                    errors.append(f"{task_id}.dependency_not_in_earlier_batch:{dep}")
                elif dep_batch != batch_id:
                    required_batch_deps.add(dep_batch)
        for dep_batch in sorted(required_batch_deps - declared_batch_deps):
            errors.append(f"{batch_id}.missing_batch_dependency:{dep_batch}")

    for task_id, item in task_by_id.items():
        for dep in item.get("deps", []):
            if isinstance(dep, str) and dep not in known_task_ids:
                errors.append(f"{task_id}.dependency_unknown:{dep}")
    errors.extend(_dag_errors(deps_by_task))

    active = root.get("activeBatchId")
    next_batch = root.get("nextBatchId")
    status = root.get("status")
    if status == "done" and (active is not None or next_batch is not None):
        errors.append("done_plan_has_pending_batch_pointer")
    if isinstance(active, str):
        active_entry = next((entry for entry in entries if entry.get("id") == active), None)
        if isinstance(active_entry, dict) and active_entry.get("status") == "done":
            errors.append(f"active_batch_already_done:{active}")
    if isinstance(next_batch, str):
        next_entry = next((entry for entry in entries if entry.get("id") == next_batch), None)
        if isinstance(next_entry, dict) and next_entry.get("status") != "todo":
            errors.append(f"next_batch_not_todo:{next_batch}")
    return errors


def validate_plan_bundle_data(
    root: dict[str, Any],
    batch_data: dict[str, dict[str, Any]],
    *,
    require_initial_status: bool = False,
    require_all_done: bool = False,
) -> list[str]:
    errors = validate_plan_data(
        root,
        require_initial_status=require_initial_status,
        require_all_done=require_all_done,
    )
    if errors:
        return errors
    scope_errors = implementation_scope_task_errors(root.get("implementationScope"), [
        task
        for batch in batch_data.values()
        for task in tasks(batch)
        if isinstance(task, dict)
    ])
    if scope_errors:
        return scope_errors
    errors.extend(_bundle_consistency_errors(
        root,
        batch_data,
        require_initial_status=require_initial_status,
        require_all_done=require_all_done,
    ))
    return sorted(set(errors))


def load_plan_bundle(
    target_feature_dir: Path,
    *,
    require_initial_status: bool = False,
    require_all_done: bool = False,
) -> PlanBundle:
    root = load_plan(plan_json_path(target_feature_dir))
    root_errors = validate_plan_data(
        root,
        require_initial_status=require_initial_status,
        require_all_done=require_all_done,
    )
    if root_errors:
        raise PlanJsonError(";".join(root_errors))

    entries = [entry for entry in root.get("batches", []) if isinstance(entry, dict)]
    batch_data: dict[str, dict[str, Any]] = {}
    all_tasks: list[dict[str, Any]] = []
    task_batches: dict[str, str] = {}
    load_errors: list[str] = []
    for entry in entries:
        batch_id = str(entry.get("id", ""))
        path = batch_plan_path(target_feature_dir, batch_id)
        try:
            data = load_plan(path)
        except PlanJsonError as exc:
            load_errors.append(str(exc))
            continue
        batch_data[batch_id] = data
        for item in tasks(data):
            task_id = item.get("id")
            if not isinstance(task_id, str):
                continue
            if task_id in task_batches:
                load_errors.append(f"duplicate_task_id:{task_id}")
            else:
                task_batches[task_id] = batch_id
                all_tasks.append(item)
    if load_errors:
        raise PlanJsonError(";".join(load_errors))

    errors = validate_plan_bundle_data(
        root,
        batch_data,
        require_initial_status=require_initial_status,
        require_all_done=require_all_done,
    )
    if errors:
        raise PlanJsonError(";".join(errors))
    return PlanBundle(root=root, batches=batch_data, tasks=all_tasks, task_batches=task_batches)


def load_and_validate_plan(path: Path, **kwargs: Any) -> tuple[dict[str, Any] | None, list[str]]:
    try:
        data = load_plan(path)
    except PlanJsonError as exc:
        return None, [str(exc)]
    errors = validate_plan_data(data, **kwargs)
    if errors:
        return data, errors
    try:
        bundle = load_plan_bundle(path.parent, **kwargs)
    except PlanJsonError as exc:
        return data, str(exc).split(";")
    view = dict(data)
    view["_bundleTasks"] = bundle.tasks
    view["_bundleTaskBatches"] = bundle.task_batches
    view["_bundleBatches"] = bundle.batches
    view["tasks"] = bundle.tasks
    return view, []
