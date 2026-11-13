#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prepare a machine Plan v2 for review, then emit its Markdown projection."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from datetime import datetime, timezone
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
    load_json,
    read_object_file,
    read_object_stdin,
    render_result,
    resolve_feature,
    resolve_workspace,
    with_result_data,
    write_text,
    WriterError,
    WriterEncodingError,
)
from hooks.evidence_kernel import FileLock, unlink_if_exists  # noqa: E402
from hooks.implementation_scope import load_scope  # noqa: E402
from hooks.spec_contract import SPEC_SCENARIO_DEF_RE  # noqa: E402
from hooks.plan_scope import resolve_plan_scope, scope_report  # noqa: E402
from hooks.plan_json import (  # noqa: E402
    TEST_STAGE_MAX_REPAIR_ATTEMPTS,
    BATCH_STRATEGY,
    FRONTEND_ROUTES,
    MAX_BATCH_TASKS,
    PARALLEL_EXECUTION_STAGES,
    REPOSITORY_ID_RE,
    TASK_EXECUTION_MODES,
    VISUAL_SOURCE_ID_RE,
    atomic_group_errors,
    batch_plan_path,
    defer_to_test_stages_enabled,
    normalize_status,
    task_execution_lane,
    task_execution_mode,
    task_contract_sha256,
    task_set_digest,
    task_workspace_roots,
    validate_plan_bundle_data,
    validate_task_collection,
)
from hooks.plan_granularity import (  # noqa: E402
    validate_plan_task_granularity_item,
    validate_plan_task_grouping_item,
)
from hooks.plan_write_ownership import normalize_owned_path, write_ownership_violations  # noqa: E402
from hooks.repository_snapshot import (  # noqa: E402
    RepositorySnapshotError,
    resolve_git_root,
)
from hooks.artifact_ref_validator import (  # noqa: E402
    validate_plan_design_coverage,
    validate_task_artifact_refs,
    validate_task_group_design_contract,
)
from hooks.design_contract_lock import (  # noqa: E402
    load_confirmed_design_contract,
)
from hooks.parallel_validation_ownership import build_pipeline_contract  # noqa: E402


PLAN_FILE = "plan.json"
PLAN_MD_FILE = "PLAN.md"
PLAN_WRITE_TRANSACTION_FILE = ".plan-write-transaction.json"
SCENARIO_ID_RE = re.compile(r"\bSCN-\d{3}\b")
SOURCE_ID_RE = re.compile(r"^SRC-\d{3}$")
SPEC_REFERENCE_ID_RE = re.compile(r"\b(?:REQ|SCN)-\d{3}\b")
TASK_GROUP_TASK_ID_RE = re.compile(r"^T\d{3}$")
TASK_GROUP_REQUIREMENT_ID_RE = re.compile(r"\bREQ-\d{3}\b")
TASK_GROUP_API_ID_RE = re.compile(r"^API-\d{3}$")
TASK_GROUP_PAGE_ID_RE = re.compile(r"^PAGE-\d{3}$")
TASK_GROUP_INTERACTION_ID_RE = re.compile(r"^UIX-\d{3}$")
PLAN_SCHEMA = "autodev.plan.v2"
DEFAULT_TASK_VALIDATION_POLICY = {
    "mode": "defer_to_test_stages",
    "orchestration": "inline",
    "codeGate": "review_only",
    "maxTestStageRepairAttempts": TEST_STAGE_MAX_REPAIR_ATTEMPTS,
}


class PlanWriterInputError(ValueError):
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}:{detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


def _path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, PLAN_FILE)


def _md_path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, PLAN_MD_FILE)


def _plan_write_transaction_path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, PLAN_WRITE_TRANSACTION_FILE)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _current_design_contract(feature_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    # Plan deliberately consumes the snapshot produced by dev.design instead
    # of re-opening design.md.  A Design edit must re-run its own completion
    # gate and refresh this snapshot before Plan can start.
    return load_confirmed_design_contract(feature_dir, feature_dir.name)


def _plan_lock(workspace: Path, feature: str) -> FileLock:
    return FileLock(_path(workspace, feature).parent / ".plan.lock")


def _initial(feature: str) -> dict[str, Any]:
    return {
        "featureId": feature,
        "status": "todo",
        "taskSetStatus": "collecting",
        "activeBatchId": None,
        "nextBatchId": None,
        "batchPolicy": {"maxTasks": MAX_BATCH_TASKS, "strategy": BATCH_STRATEGY},
        "taskValidationPolicy": copy.deepcopy(DEFAULT_TASK_VALIDATION_POLICY),
        "batches": [],
        "tasks": [],  # in-memory working view; never written to root plan.json
        "_batchAssignments": {},
        "_batchPlans": {},
    }


def _load(workspace: Path, feature: str) -> dict[str, Any]:
    path = _path(workspace, feature)
    if not path.is_file() or path.stat().st_size <= 0:
        return _initial(feature)
    root = load_json(path)
    if not isinstance(root, dict):
        raise ValueError("plan.json root 必须是 object")
    if "tasks" in root:
        raise PlanWriterInputError("monolithic_plan_requires_rebuild")
    if "version" in root or "taskDetailVersion" in root:
        raise PlanWriterInputError("legacy_plan_requires_rebuild")
    policy = root.get("batchPolicy")
    if isinstance(policy, dict) and policy.get("strategy") != BATCH_STRATEGY:
        raise PlanWriterInputError("batch_policy_requires_rebuild", str(policy.get("strategy")))
    finalized = root.get("taskSetStatus") == "finalized"
    data = dict(root)
    data.setdefault("featureId", feature)
    data.setdefault("status", "todo")
    data.setdefault("activeBatchId", None)
    data.setdefault("nextBatchId", None)
    data.setdefault("batchPolicy", {"maxTasks": MAX_BATCH_TASKS, "strategy": BATCH_STRATEGY})
    data.setdefault("batches", [])
    task_items: list[dict[str, Any]] = []
    assignments: dict[str, str] = {}
    batch_plans: dict[str, dict[str, Any]] = {}
    feature_dir = _path(workspace, feature).parent
    for entry in data.get("batches", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        batch_id = str(entry["id"])
        plan = load_json(batch_plan_path(feature_dir, batch_id))
        if not isinstance(plan, dict):
            raise PlanWriterInputError("missing_batch_plan", batch_id)
        batch_plans[batch_id] = plan
        for task in plan.get("tasks", []):
            if isinstance(task, dict):
                task_items.append(task)
                if isinstance(task.get("id"), str):
                    assignments[str(task["id"])] = batch_id
    data["tasks"] = task_items
    data["_batchAssignments"] = assignments
    data["_batchPlans"] = batch_plans
    return data


def _structure_errors(data: dict[str, Any], *, allow_empty: bool = False) -> list[str]:
    if allow_empty and _tasks(data) == []:
        errors: list[str] = []
        if "version" in data or "taskDetailVersion" in data:
            errors.append("legacy_plan_requires_rebuild")
        if not isinstance(data.get("featureId"), str) or not data.get("featureId"):
            errors.append("plan_json_missing_feature_id")
        return errors
    return validate_task_collection(
        str(data.get("featureId", "")),
        _tasks(data),
        defer_to_test_stages=defer_to_test_stages_enabled(data),
    )


def _task_groups(data: dict[str, Any]) -> list[dict[str, Any]]:
    groups = data.get("groups")
    if not isinstance(groups, list):
        return []
    return [item for item in groups if isinstance(item, dict)]


def _compact_string_list(value: Any, *, task_id: str, field: str) -> list[str]:
    """Read a compact-contract string list without silently inventing data."""

    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise PlanWriterInputError("compact_plan_core_string_array_required", f"task={task_id};field={field}")
    return [item.strip() for item in value]


def _plan_v2_to_groups(data: dict[str, Any]) -> dict[str, Any]:
    """Project the intentionally small Plan v2 input into runtime groups.

    Plan v2 is the only model-facing contract. It contains outcomes, repository
    ownership, dependencies, references, outcome-level implementation points
    and test points. File lists, symbols, concrete commands and batch mechanics
    are discovered or derived by later stages.
    """
    feature_id = data.get("featureId")
    raw_tasks = data.get("tasks")
    if not isinstance(feature_id, str) or not feature_id.strip():
        raise PlanWriterInputError("plan_v2_feature_id_missing")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise PlanWriterInputError("plan_v2_tasks_missing")

    groups: list[dict[str, Any]] = []
    allowed_task_fields = {
        "id", "outcome", "workspace", "dependsOn", "refs", "implementationPoints",
        "testPoints", "verification",
        "ui", "mode", "stage", "external", "atomic",
    }
    for index, raw in enumerate(raw_tasks, start=1):
        if not isinstance(raw, dict):
            raise PlanWriterInputError("plan_v2_task_must_be_object", f"index={index}")
        task_id = raw.get("id")
        if not isinstance(task_id, str) or not TASK_GROUP_TASK_ID_RE.fullmatch(task_id):
            raise PlanWriterInputError("plan_v2_task_id_invalid", f"index={index};task={task_id}")
        unknown = sorted(set(raw) - allowed_task_fields)
        if unknown:
            raise PlanWriterInputError("plan_v2_task_field_unknown", f"task={task_id};fields={','.join(unknown)}")
        outcome = raw.get("outcome")
        if not isinstance(outcome, str) or not outcome.strip():
            raise PlanWriterInputError("plan_v2_task_outcome_missing", f"task={task_id}")
        implementation_points = _compact_string_list(
            raw.get("implementationPoints"), task_id=task_id, field="implementationPoints",
        )
        if not implementation_points:
            raise PlanWriterInputError("plan_v2_task_implementation_points_missing", f"task={task_id}")
        test_points = _compact_string_list(
            raw.get("testPoints"), task_id=task_id, field="testPoints",
        )
        if not test_points:
            raise PlanWriterInputError("plan_v2_task_test_points_missing", f"task={task_id}")
        refs = raw.get("refs")
        if not isinstance(refs, dict):
            raise PlanWriterInputError("plan_v2_task_refs_missing", f"task={task_id}")
        unknown_refs = sorted(set(refs) - {"requirements", "scenarios", "api", "design", "data", "decisions"})
        if unknown_refs:
            raise PlanWriterInputError("plan_v2_task_refs_field_unknown", f"task={task_id};fields={','.join(unknown_refs)}")
        requirements = _compact_string_list(refs.get("requirements"), task_id=task_id, field="refs.requirements")
        scenarios = _compact_string_list(refs.get("scenarios"), task_id=task_id, field="refs.scenarios")
        api_ids = _compact_string_list(refs.get("api", []), task_id=task_id, field="refs.api")
        design_refs = _compact_string_list(refs.get("design", []), task_id=task_id, field="refs.design")
        design_refs = [ref if "#" in ref else f"design.md#{ref}" for ref in design_refs]
        if any(ref.startswith("design.md#D-") for ref in design_refs):
            raise PlanWriterInputError(
                "plan_v2_task_decision_must_use_refs_decisions",
                f"task={task_id};field=refs.design",
            )
        data_ids = _compact_string_list(refs.get("data", []), task_id=task_id, field="refs.data")
        decision_ids = _compact_string_list(refs.get("decisions", []), task_id=task_id, field="refs.decisions")
        verification = raw.get("verification")
        if not isinstance(verification, dict):
            raise PlanWriterInputError("plan_v2_task_verification_invalid", f"task={task_id}")
        if set(verification) - {"intent"}:
            raise PlanWriterInputError("plan_v2_task_verification_field_unknown", f"task={task_id}")
        intent = verification.get("intent")
        if not isinstance(intent, str) or not intent.strip():
            raise PlanWriterInputError("plan_v2_task_verification_intent_invalid", f"task={task_id}")
        if not isinstance(raw.get("workspace"), str) or not raw["workspace"].strip():
            raise PlanWriterInputError("plan_v2_task_workspace_missing", f"task={task_id}")
        group: dict[str, Any] = {
            "id": task_id,
            "title": outcome.strip(),
            "executionMode": raw.get("mode", "code"),
            "executionStage": raw.get("stage", "parallel"),
            "touches": [],
            "writeTargets": [],
            "deps": _compact_string_list(raw.get("dependsOn", []), task_id=task_id, field="dependsOn"),
            "workspaceRef": raw["workspace"].strip(),
            "specRefs": [*requirements, *scenarios],
            "apiIds": api_ids,
            "designRefs": design_refs,
            "dataIds": data_ids,
            "decisionIds": decision_ids,
            "validationBoundary": str(intent or outcome).strip(),
            "verificationIntent": str(intent or outcome).strip(),
            "implementationPoints": implementation_points,
            "testPoints": test_points,
        }
        ui = raw.get("ui")
        group["uiRequired"] = ui is not None
        if ui is not None:
            if not isinstance(ui, dict):
                raise PlanWriterInputError("plan_v2_task_ui_invalid", f"task={task_id}")
            unknown_ui_fields = sorted(set(ui) - {"pages", "interactions", "route"})
            if unknown_ui_fields:
                raise PlanWriterInputError(
                    "plan_v2_task_ui_field_unknown",
                    f"task={task_id};fields={','.join(unknown_ui_fields)}",
                )
            group["uiRefs"] = {
                "pageRefs": _compact_string_list(ui.get("pages"), task_id=task_id, field="ui.pages"),
                "interactionRefs": _compact_string_list(ui.get("interactions", []), task_id=task_id, field="ui.interactions"),
                "visualSourceRefs": [],
                "frontendRoute": ui.get("route"),
            }
        if raw.get("external") is not None:
            group["externalDependency"] = copy.deepcopy(raw["external"])
        if raw.get("atomic") is not None:
            group["atomicGroup"] = copy.deepcopy(raw["atomic"])
        groups.append(group)
    by_id = {group["id"]: group for group in groups}
    if len(by_id) != len(groups):
        raise PlanWriterInputError("plan_v2_task_id_duplicate")
    for group in groups:
        unknown = sorted(set(group["deps"]) - set(by_id))
        if unknown:
            raise PlanWriterInputError("plan_v2_dependency_unknown", f"task={group['id']};ids={','.join(unknown)}")
    # ``graphlib.TopologicalSorter`` is only available from Python 3.9.  Keep
    # ordering deterministic while supporting the project's Python 3.7 floor.
    pending = {group["id"]: set(group["deps"]) for group in groups}
    order: list[str] = []
    while pending:
        ready = [group["id"] for group in groups if group["id"] in pending and not pending[group["id"]]]
        if not ready:
            raise PlanWriterInputError("plan_v2_dependency_cycle", "dependency cycle detected")
        for task_id in ready:
            del pending[task_id]
        for dependencies in pending.values():
            dependencies.difference_update(ready)
        order.extend(ready)
    # Legacy runtime projection expects dependency order; it must not impose
    # that serialization rule on model input or renumber task identities.
    return {"featureId": feature_id, "groups": [by_id[task_id] for task_id in order]}


def _materialize_v2_ui_visual_sources(feature_dir: Path, group_data: dict[str, Any]) -> None:
    """Derive each UI task's visual-source union from UI_CONTEXT.json."""
    ui_groups = [
        group for group in _task_groups(group_data)
        if group.get("uiRequired") is True and isinstance(group.get("uiRefs"), dict)
    ]
    if not ui_groups:
        return
    path = feature_dir / "UI_CONTEXT.json"
    if not path.is_file():
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlanWriterInputError("plan_v2_ui_context_invalid", str(exc)) from exc
    capabilities = payload.get("capabilities") if isinstance(payload, dict) else None
    if not isinstance(capabilities, list):
        return
    for group in ui_groups:
        task_spec_refs = {
            ref for ref in group.get("specRefs", [])
            if isinstance(ref, str) and ref.strip()
        }
        expected: set[str] = set()
        for capability in capabilities:
            if not isinstance(capability, dict) or capability.get("uiRequired") is False:
                continue
            capability_refs = {
                ref for ref in capability.get("specRefs", [])
                if isinstance(ref, str) and ref.strip()
            }
            if task_spec_refs.intersection(capability_refs):
                expected.update(
                    ref for ref in capability.get("visualSourceRefs", [])
                    if isinstance(ref, str) and ref.strip()
                )
        group["uiRefs"]["visualSourceRefs"] = sorted(expected)


def _markdown_section_body(text: str, title: str) -> str | None:
    match = re.search(rf"^ {{0,3}}(?P<marks>#+)\s+{re.escape(title)}\s*$", text, re.MULTILINE)
    if match is None:
        return None
    level = len(match.group("marks"))
    next_heading = re.compile(rf"^ {{0,3}}#{{1,{level}}}\s+\S", re.MULTILINE)
    end_match = next_heading.search(text, match.end())
    return text[match.end():end_match.start() if end_match else len(text)]


def _spec_source_reference_index(feature_dir: Path) -> dict[str, set[str]]:
    """Map a source snapshot to the REQ/SCN references it constrains."""

    index: dict[str, set[str]] = {}
    specs_dir = feature_dir / "specs"
    if not specs_dir.is_dir():
        return index
    for path in sorted(specs_dir.glob("**/*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise PlanWriterInputError("plan_v2_spec_unreadable", str(path)) from exc
        section = _markdown_section_body(text, "Source References / 外部资料引用")
        if section is None:
            continue
        relative = path.relative_to(feature_dir).as_posix()
        for line in section.splitlines():
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) < 2 or SOURCE_ID_RE.fullmatch(cells[0]) is None:
                continue
            refs = {
                f"{relative}#{ref}"
                for ref in SPEC_REFERENCE_ID_RE.findall(cells[1])
            }
            if refs:
                index.setdefault(cells[0], set()).update(refs)
    return index


def _materialize_v2_source_references(feature_dir: Path, group_data: dict[str, Any]) -> None:
    """Project Specs' source-to-behavior mappings onto the owning Plan tasks.

    Specs is the semantic bridge from a source ID to REQ/SCN; the planner never
    repeats source IDs in its v2 body.  A mapped source is allowed to be absent,
    never provided, or missing its snapshot: Plan records the declared ID and
    Code receives its resolution state without blocking publication.
    """

    source_to_refs = _spec_source_reference_index(feature_dir)

    for source_id, spec_refs in source_to_refs.items():
        for group in _task_groups(group_data):
            task_refs = {
                ref for ref in group.get("specRefs", [])
                if isinstance(ref, str) and ref.strip()
            }
            if task_refs.intersection(spec_refs):
                group.setdefault("sourceRefs", []).append(source_id)
    for group in _task_groups(group_data):
        refs = group.get("sourceRefs")
        if isinstance(refs, list):
            group["sourceRefs"] = sorted({ref for ref in refs if isinstance(ref, str) and ref})


def _group_string_list(
    errors: list[dict[str, str]],
    group: dict[str, Any],
    task_id: str,
    field: str,
    *,
    required: bool = True,
    item_re: re.Pattern[str] | None = None,
) -> list[str]:
    value = group.get(field)
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        errors.append({"reason": f"{task_id}.{field}_must_be_string_array"})
        return []
    normalized = [item.strip() for item in value]
    if required and not normalized:
        errors.append({"reason": f"{task_id}.{field}_missing"})
    if item_re is not None:
        for item in normalized:
            if not item_re.fullmatch(item):
                errors.append({"reason": f"{task_id}.{field}_invalid:{item}"})
    return normalized


def _task_group_structure_errors(data: dict[str, Any]) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    feature_id = data.get("featureId")
    if not isinstance(feature_id, str) or not feature_id.strip():
        errors.append({"reason": "task_groups_feature_id_missing"})
    raw_groups = data.get("groups")
    if not isinstance(raw_groups, list) or not raw_groups:
        return [*errors, {"reason": "task_groups_missing"}]

    prior_ids: set[str] = set()
    for index, raw_group in enumerate(raw_groups, start=1):
        if not isinstance(raw_group, dict):
            errors.append({"reason": f"task_groups[{index - 1}]_must_be_object"})
            continue
        task_id = raw_group.get("id")
        if not isinstance(task_id, str) or not TASK_GROUP_TASK_ID_RE.fullmatch(task_id):
            errors.append({"reason": "task_group_id_invalid", "detail": f"index={index};actual={task_id}"})
            task_id = f"invalid-{index}"
        elif task_id in prior_ids:
            errors.append({"reason": "task_group_id_duplicate", "detail": f"task={task_id}"})
        title = raw_group.get("title")
        if not isinstance(title, str) or not title.strip():
            errors.append({"reason": f"{task_id}.title_missing"})

        raw_execution_mode = raw_group.get("executionMode")
        if raw_execution_mode is not None and raw_execution_mode not in TASK_EXECUTION_MODES:
            errors.append({"reason": f"{task_id}.executionMode_invalid"})
        execution_stage = raw_group.get("executionStage", "parallel")
        if execution_stage not in PARALLEL_EXECUTION_STAGES:
            errors.append({"reason": f"{task_id}.executionStage_invalid"})
        atomic_group = raw_group.get("atomicGroup")
        if atomic_group is not None:
            if not isinstance(atomic_group, dict):
                errors.append({"reason": f"{task_id}.atomicGroup_must_be_object"})
            else:
                unknown = sorted(set(atomic_group) - {"id", "rationale"})
                if unknown:
                    errors.append({"reason": f"{task_id}.atomicGroup_unknown_fields:{','.join(unknown)}"})
                group_id = atomic_group.get("id")
                rationale = atomic_group.get("rationale")
                if not isinstance(group_id, str) or not re.fullmatch(r"AG\d{3}", group_id):
                    errors.append({"reason": f"{task_id}.atomicGroup.id_invalid"})
                if not isinstance(rationale, str) or len(rationale.strip()) < 10:
                    errors.append({"reason": f"{task_id}.atomicGroup.rationale_missing_or_too_short"})
        if "touches" in raw_group:
            _group_string_list(errors, raw_group, task_id, "touches", required=False)
        write_targets = raw_group.get("writeTargets")
        if write_targets is not None:
            if not isinstance(write_targets, list):
                errors.append({"reason": f"{task_id}.writeTargets_must_be_array"})
            else:
                for target_index, target in enumerate(write_targets, start=1):
                    if not isinstance(target, dict):
                        errors.append({"reason": f"{task_id}.writeTargets[{target_index}].must_be_object"})
                        continue
                    target_path = target.get("path")
                    symbols = target.get("symbols")
                    if not isinstance(target_path, str) or not target_path.strip():
                        errors.append({"reason": f"{task_id}.writeTargets[{target_index}].path_missing"})
                    if symbols is not None and (
                        not isinstance(symbols, list)
                        or not symbols
                        or any(not isinstance(symbol, str) or not symbol.strip() for symbol in symbols)
                    ):
                        errors.append({"reason": f"{task_id}.writeTargets[{target_index}].symbols_invalid"})
        execution_mode = task_execution_mode(raw_group)
        external_dependency = raw_group.get("externalDependency")
        if execution_mode == "external_dependency":
            if not isinstance(external_dependency, dict):
                errors.append({"reason": f"{task_id}.externalDependency_missing"})
            else:
                for field in ("system", "owner"):
                    value = external_dependency.get(field)
                    if not isinstance(value, str) or not value.strip():
                        errors.append({
                            "reason": f"{task_id}.externalDependency.{field}_missing"
                        })
                _group_string_list(
                    errors,
                    external_dependency,
                    task_id,
                    "trackingRefs",
                )
        elif external_dependency is not None:
            errors.append({"reason": f"{task_id}.externalDependency_forbidden"})

        deps = _group_string_list(
            errors,
            raw_group,
            task_id,
            "deps",
            required=False,
            item_re=TASK_GROUP_TASK_ID_RE,
        )
        for dep in deps:
            if dep not in prior_ids:
                errors.append({
                    "reason": "task_group_dependency_must_reference_earlier_task",
                    "detail": f"task={task_id};dep={dep}",
                })

        spec_refs = _group_string_list(errors, raw_group, task_id, "specRefs")
        if spec_refs and not any(TASK_GROUP_REQUIREMENT_ID_RE.search(ref) for ref in spec_refs):
            errors.append({"reason": f"{task_id}.specRefs_missing_requirement_id"})
        if spec_refs and not any(SCENARIO_ID_RE.search(ref) for ref in spec_refs):
            errors.append({"reason": f"{task_id}.specRefs_missing_scenario_id"})
        _group_string_list(
            errors,
            raw_group,
            task_id,
            "apiIds",
            required=False,
            item_re=TASK_GROUP_API_ID_RE,
        )
        if "mergedScenarioRefs" in raw_group:
            _group_string_list(errors, raw_group, task_id, "mergedScenarioRefs", required=False)

        ui_required = raw_group.get("uiRequired")
        if not isinstance(ui_required, bool):
            errors.append({"reason": f"{task_id}.uiRequired_must_be_bool"})
            ui_required = False

        ui_refs = raw_group.get("uiRefs")
        if ui_required and not isinstance(ui_refs, dict):
            errors.append({"reason": f"{task_id}.uiRefs_missing"})
        elif isinstance(ui_refs, dict):
            _group_string_list(
                errors,
                ui_refs,
                task_id,
                "pageRefs",
                required=ui_required,
                item_re=TASK_GROUP_PAGE_ID_RE,
            )
            _group_string_list(
                errors,
                ui_refs,
                task_id,
                "interactionRefs",
                required=False,
                item_re=TASK_GROUP_INTERACTION_ID_RE,
            )
            _group_string_list(
                errors,
                ui_refs,
                task_id,
                "visualSourceRefs",
                required=False,
                item_re=VISUAL_SOURCE_ID_RE,
            )
            frontend_route = ui_refs.get("frontendRoute")
            if frontend_route is None and ui_required:
                errors.append({"reason": f"{task_id}.frontendRoute_missing"})
            elif frontend_route is not None and (
                not isinstance(frontend_route, str) or frontend_route not in FRONTEND_ROUTES
            ):
                errors.append({"reason": f"{task_id}.frontendRoute_invalid"})

        validation_boundary = raw_group.get("validationBoundary")
        if not isinstance(validation_boundary, str) or not validation_boundary.strip():
            errors.append({"reason": f"{task_id}.validationBoundary_missing"})
        workspace_ref = raw_group.get("workspaceRef")
        if not isinstance(workspace_ref, str) or not REPOSITORY_ID_RE.fullmatch(workspace_ref):
            errors.append({"reason": f"{task_id}.workspaceRef_invalid"})
        prior_ids.add(task_id)
    errors.extend({"reason": reason} for reason in atomic_group_errors(
        [item for item in raw_groups if isinstance(item, dict)],
    ))
    return errors


def _with_validation_stage(
    stage: str,
    errors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Annotate independently-computed preflight failures with their stage."""

    annotated: list[dict[str, Any]] = []
    for error in errors:
        item = copy.deepcopy(error)
        item.setdefault("validationStage", stage)
        annotated.append(item)
    return annotated


def _task_group_spec_ref_errors(
    feature_dir: Path,
    groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Verify that every path-qualified Core scenario reference exists.

    Coverage alone catches a missing expected scenario, but it used to leave a
    misplaced ``SCN-110`` looking like an unrelated coverage gap.  This check
    reports the owning task, input field, and exact missing path first.
    """

    defined: dict[str, set[str]] = {}
    for spec_path in sorted((feature_dir / "specs").glob("**/*.md")):
        relative = spec_path.relative_to(feature_dir).as_posix()
        defined[relative] = set(SPEC_SCENARIO_DEF_RE.findall(
            spec_path.read_text(encoding="utf-8")
        ))

    errors: list[dict[str, Any]] = []
    for group in groups:
        task_id = str(group.get("id", "task"))
        refs = group.get("specRefs") if isinstance(group.get("specRefs"), list) else []
        for index, raw_ref in enumerate(refs):
            if not isinstance(raw_ref, str):
                continue
            path_part, separator, anchor = raw_ref.partition("#")
            scenario_ids = SCENARIO_ID_RE.findall(anchor) if separator else []
            if not scenario_ids:
                continue
            normalized_path = path_part.strip().replace("\\", "/")
            field = f"specRefs[{index}]"
            if not normalized_path:
                errors.append({
                    "reason": "plan_task_scenario_ref_not_path_qualified",
                    "detail": f"task={task_id};ref={raw_ref}",
                    "taskIds": [task_id],
                    "field": field,
                    "repairTarget": "task_group",
                    "repairSuggestion": "每个 SCN 必须写成 specs/<capability>/spec.md#SCN-NNN，不能只写 SCN ID。",
                })
                continue
            known_scenarios = defined.get(normalized_path)
            if known_scenarios is None:
                errors.append({
                    "reason": "plan_task_spec_file_unknown",
                    "detail": f"task={task_id};path={normalized_path}",
                    "taskIds": [task_id],
                    "field": field,
                    "repairTarget": "task_group",
                    "repairSuggestion": "将 specRefs 指向 Feature specs/ 下实际存在的 spec 文件。",
                })
                continue
            for scenario_id in scenario_ids:
                if scenario_id not in known_scenarios:
                    errors.append({
                        "reason": "unknown_plan_task_scenario_ref",
                        "detail": f"task={task_id};path={normalized_path};scenario={scenario_id}",
                        "taskIds": [task_id],
                        "field": field,
                        "repairTarget": "task_group",
                        "repairSuggestion": (
                            f"{normalized_path} 未定义 {scenario_id}；请改用该文件中真实的 SCN，"
                            "或将引用移到实际定义该 SCN 的 spec 文件。"
                        ),
                    })
    return errors


def _task_group_preflight_errors(feature_dir: Path, data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return all independent Core failures in one pass.

    Later stages deliberately continue after structural, granularity, or
    ownership failures whenever their input is still readable.  A missing
    design lock is the only dependency that suppresses Design-ID validation;
    it does not suppress spec-reference validation or scenario coverage.
    """

    errors = _with_validation_stage("structure", _task_group_structure_errors(data))
    _, partition_errors = resolve_plan_scope(feature_dir)
    errors.extend(_with_validation_stage("scope", partition_errors))
    implementation_scope, scope_errors = load_scope(feature_dir)
    errors.extend(_with_validation_stage(
        "scope", [{"reason": error} for error in scope_errors],
    ))
    groups = _task_groups(data)
    grouping_errors: list[dict[str, Any]] = []
    for group in groups:
        task_id = str(group.get("id", "task"))
        ui_required = group.get("uiRequired") is True
        if implementation_scope == "backend_only" and ui_required:
            grouping_errors.append({
                "reason": "implementation_scope_frontend_task_forbidden",
                "detail": f"scope=backend_only;task={task_id}",
                "repairSuggestion": f"当前范围为 backend_only，请从本期 Plan 移出前端任务 {task_id}；若实际范围已变更，先更新已确认的 IMPLEMENTATION_SCOPE.json。不要改 UI 标记伪装任务归属。"
            })
        elif implementation_scope == "frontend_only" and not ui_required:
            grouping_errors.append({
                "reason": "implementation_scope_backend_task_forbidden",
                "detail": f"scope=frontend_only;task={task_id}",
                "repairSuggestion": f"当前范围为 frontend_only，请从本期 Plan 移出后端任务 {task_id}；若实际范围已变更，先更新已确认的 IMPLEMENTATION_SCOPE.json。不要改 UI 标记伪装任务归属。"
            })
        grouping_errors.extend(validate_plan_task_grouping_item(group, task_id=task_id))
    errors.extend(_with_validation_stage("granularity", grouping_errors))
    # Validate write ownership on the input groups before any Batch is
    # projected, so a shared file surfaces as one actionable planning error.
    group_tasks = [
        {
            "id": group.get("id"),
            "executionMode": group.get("executionMode", "code"),
            "executionStage": group.get("executionStage", "parallel"),
            "workspaceRef": group.get("workspaceRef"),
            "scope": {"paths": group.get("touches", [])},
            "writeTargets": copy.deepcopy(group.get("writeTargets", [])),
            "expectedFiles": [],
        }
        for group in groups
    ]
    group_scope_data = {
        "featureId": data.get("featureId"),
        "tasks": copy.deepcopy(group_tasks),
    }
    try:
        _, projected_group_batches = _project_batches(group_scope_data)
        group_scopes = {
            str(task.get("id")): batch_id
            for batch_id, batch in projected_group_batches.items()
            for task in batch.get("tasks", [])
            if isinstance(task, dict) and isinstance(task.get("id"), str)
        }
        ownership_errors = write_ownership_violations(
            group_tasks,
            ownership_scope_by_task=group_scopes,
        )
    except (TypeError, ValueError) as exc:
        ownership_errors = [{
            "reason": "task_group_ownership_projection_invalid",
            "detail": str(exc),
            "repairTarget": "task_group",
        }]
    errors.extend(_with_validation_stage("write_ownership", ownership_errors))

    design_contract, design_errors = _current_design_contract(feature_dir)
    errors.extend(_with_validation_stage("design_lock", design_errors))
    if not design_errors:
        errors.extend(_with_validation_stage(
            "design_refs", validate_task_group_design_contract(design_contract, groups),
        ))

    errors.extend(_with_validation_stage(
        "spec_refs", _task_group_spec_ref_errors(feature_dir, groups),
    ))
    expected, covered = _scenario_coverage(feature_dir, groups)
    missing = sorted(expected - covered)
    if missing:
        missing_count = len(missing)
        missing_preview = ', '.join(missing[:10])
        if missing_count > 10:
            missing_preview += f" ...还有 {missing_count - 10} 个"
        errors.extend(_with_validation_stage("scenario_coverage", [{
            "reason": "missing_plan_scenario_coverage",
            "detail": f"return_to_scenario_matrix;ids={','.join(missing)}",
            "repairSuggestion": (
                f"有 {missing_count} 个场景未被任务覆盖：{missing_preview}。"
                "请在 Plan v2 输入的 refs.scenarios 中添加或调整任务引用，确保所有场景都被覆盖。"
            ),
        }]))
    return errors


def _task_group_projection(item: dict[str, Any]) -> dict[str, Any]:
    ui_refs = item.get("uiRefs") if isinstance(item.get("uiRefs"), dict) else {}
    result = {
        "id": item.get("id"),
        "title": item.get("title"),
        "deps": item.get("deps") if isinstance(item.get("deps"), list) else [],
        "uiRequired": item.get("uiRequired"),
        "specRefs": item.get("specRefs") if isinstance(item.get("specRefs"), list) else [],
        "sourceRefs": item.get("sourceRefs") if isinstance(item.get("sourceRefs"), list) else [],
        "mergedScenarioRefs": (
            item.get("mergedScenarioRefs") if isinstance(item.get("mergedScenarioRefs"), list) else []
        ),
        "apiIds": item.get("apiIds") if isinstance(item.get("apiIds"), list) else [],
        "pageRefs": ui_refs.get("pageRefs") if isinstance(ui_refs.get("pageRefs"), list) else [],
        "interactionRefs": (
            ui_refs.get("interactionRefs") if isinstance(ui_refs.get("interactionRefs"), list) else []
        ),
        "visualSourceRefs": (
            ui_refs.get("visualSourceRefs") if isinstance(ui_refs.get("visualSourceRefs"), list) else []
        ),
        "frontendRoute": ui_refs.get("frontendRoute"),
        "validationBoundary": item.get("validationBoundary"),
        "workspaceRef": item.get("workspaceRef"),
        "executionMode": item.get("executionMode", "code"),
        "executionStage": item.get("executionStage", "parallel"),
        "atomicGroup": copy.deepcopy(item.get("atomicGroup")) if isinstance(item.get("atomicGroup"), dict) else None,
        "externalDependency": (
            copy.deepcopy(item.get("externalDependency"))
            if isinstance(item.get("externalDependency"), dict)
            else None
        ),
        "splitRationale": item.get("splitRationale") or None,
    }
    if (isinstance(item.get("touches"), list) and item.get("touches")) or (
        isinstance(item.get("scope"), dict)
        and isinstance(item["scope"].get("paths"), list)
        and bool(item["scope"]["paths"])
    ):
        raw = item.get("touches") if isinstance(item.get("touches"), list) else item["scope"].get("paths", [])
        normalized_touches: set[str] = set()
        for path in raw:
            normalized = normalize_owned_path(path, item.get("workspaceRef"))
            if normalized is not None:
                normalized_touches.add(normalized)
        result["touches"] = sorted(normalized_touches)
    if isinstance(item.get("writeTargets"), list):
        result["writeTargets"] = copy.deepcopy(item["writeTargets"])
    return result


def _task_group_contract_errors(
    group_data: dict[str, Any],
    task_items: list[dict[str, Any]],
) -> list[dict[str, str]]:
    groups = _task_groups(group_data)
    if len(groups) != len(task_items):
        return [{
            "reason": "task_group_contract_count_mismatch",
            "detail": f"groups={len(groups)};tasks={len(task_items)}",
        }]
    errors: list[dict[str, str]] = []
    for group, task in zip(groups, task_items):
        expected = _task_group_projection(group)
        actual = _task_group_projection(task)
        changed_fields = [field for field in expected if expected[field] != actual[field]]
        if changed_fields:
            errors.append({
                "reason": "task_group_contract_mismatch",
                "detail": f"task={expected.get('id')};fields={','.join(changed_fields)}",
            })
    return errors


def _task_set_validation_errors(
    data: dict[str, Any],
    *,
    allow_empty: bool = False,
) -> list[dict[str, Any]]:
    granularity_errors: list[dict[str, Any]] = []
    for task in _tasks(data):
        task_id = str(task.get("id", "task"))
        granularity_errors.extend(validate_plan_task_granularity_item(task, task_id=task_id))
    if granularity_errors:
        return granularity_errors

    structure_errors = [{"reason": reason} for reason in _structure_errors(data, allow_empty=allow_empty)]
    if structure_errors or (allow_empty and not _tasks(data)):
        return structure_errors
    return []


def _primary_spec_root(task: dict[str, Any]) -> str:
    for ref in task.get("specRefs", []):
        if isinstance(ref, str) and ref.strip():
            return ref.split("#", 1)[0] or "specs/unspecified/spec.md"
    return "specs/unspecified/spec.md"


def _batch_status(batch_tasks: list[dict[str, Any]]) -> str:
    statuses = [normalize_status(task.get("status")) for task in batch_tasks]
    if any(status == "failed" for status in statuses):
        return "failed"
    if statuses and all(status == "done" for status in statuses):
        # A Batch becomes done only when Merge Train records its merge.
        return "in_progress"
    if any(status in {"in_progress", "implemented", "validating", "done"} for status in statuses):
        return "in_progress"
    return "todo"


def _batch_workspace_contract(task: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    roots = task_workspace_roots(task)
    workspace_ref = task.get("workspaceRef")
    if not roots and isinstance(workspace_ref, str) and workspace_ref:
        roots = {workspace_ref: "."}
    return tuple(sorted(roots.items()))


def _batch_frontend_route(task: dict[str, Any]) -> str:
    if task_execution_lane(task) != "frontend":
        return "none"
    ui_refs = task.get("uiRefs")
    route = ui_refs.get("frontendRoute") if isinstance(ui_refs, dict) else None
    return str(route) if route in FRONTEND_ROUTES else "spec-driven-ui"


def _project_batches(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    tasks_view = _tasks(data)
    assignments = dict(data.get("_batchAssignments") or {})
    prior_plans = data.get("_batchPlans") if isinstance(data.get("_batchPlans"), dict) else {}
    groups: dict[str, list[dict[str, Any]]] = {}
    spec_roots: dict[str, str] = {}
    execution_lanes: dict[str, str] = {}
    execution_stages: dict[str, str] = {}
    workspace_contracts: dict[str, tuple[tuple[str, str], ...]] = {}
    frontend_routes: dict[str, str] = {}
    existing_ids = {
        str(entry.get("id"))
        for entry in data.get("batches", [])
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }
    used_ids = set(existing_ids)
    next_batch_number = max(
        (int(value[1:]) for value in used_ids if re.fullmatch(r"B\d{3}", value)),
        default=0,
    ) + 1

    def allocate_batch_id() -> str:
        """Allocate deterministically without rescanning all existing IDs."""

        nonlocal next_batch_number
        while True:
            batch_id = f"B{next_batch_number:03d}"
            next_batch_number += 1
            if batch_id not in used_ids:
                used_ids.add(batch_id)
                return batch_id

    # Default to one independently deliverable Task per Batch.  Similarity of
    # capability, route, workspace, or write set is not a reason to co-deliver.
    # The only grouping signal is an explicit atomicGroup id on every member.
    delivery_units: dict[str, list[dict[str, Any]]] = {}
    for task in tasks_view:
        raw_atomic = task.get("atomicGroup")
        atomic_id = raw_atomic.get("id") if isinstance(raw_atomic, dict) else None
        unit_key = f"atomic:{atomic_id}" if isinstance(atomic_id, str) else f"task:{task.get('id')}"
        delivery_units.setdefault(unit_key, []).append(task)

    for unit_tasks in delivery_units.values():
        assigned = sorted({
            str(assignments[str(task.get("id"))])
            for task in unit_tasks
            if str(task.get("id")) in assignments
        })
        batch_id = assigned[0] if assigned else allocate_batch_id()
        used_ids.add(batch_id)
        for task in unit_tasks:
            assignments[str(task.get("id", ""))] = batch_id
            task_stage = str(task.get("executionStage") or "parallel")
            if task_stage not in PARALLEL_EXECUTION_STAGES:
                raise PlanWriterInputError("invalid_batch_execution_stage", f"task={task.get('id')};stage={task_stage}")
            task.pop("touches", None)
            groups.setdefault(batch_id, []).append(task)
            spec_roots.setdefault(batch_id, _primary_spec_root(task))
            execution_lanes.setdefault(batch_id, task_execution_lane(task))
            execution_stages.setdefault(batch_id, task_stage)
            workspace_contracts.setdefault(batch_id, _batch_workspace_contract(task))
            frontend_routes.setdefault(batch_id, _batch_frontend_route(task))

    ordered_ids = sorted(groups)
    root = {
        key: value
        for key, value in data.items()
        if key not in {"tasks", "_batchAssignments", "_batchPlans", "parallelPolicy"}
    }
    root["batchPolicy"] = {"maxTasks": MAX_BATCH_TASKS, "strategy": BATCH_STRATEGY}
    root_entries: list[dict[str, Any]] = []
    projected: dict[str, dict[str, Any]] = {}
    task_to_batch = {
        str(task.get("id")): batch_id
        for batch_id, batch_tasks in groups.items()
        for task in batch_tasks
    }
    for index, batch_id in enumerate(ordered_ids):
        batch_tasks = groups[batch_id]
        previous = prior_plans.get(batch_id) if isinstance(prior_plans, dict) else None
        previous = previous if isinstance(previous, dict) else {}
        completion_ids = [
            evidence_id
            for task in batch_tasks
            for evidence_id in task.get("completionEvidenceIds", [])
            if isinstance(evidence_id, str)
        ]
        spec_root = spec_roots[batch_id]
        execution_lane = execution_lanes[batch_id]
        title = str(previous.get("title") or Path(spec_root).parent.name or batch_id)
        workspace_contract = workspace_contracts[batch_id]
        status = _batch_status(batch_tasks)
        execution_stage = execution_stages.get(batch_id, "parallel")
        task_ids_list = [str(task.get("id")) for task in batch_tasks]
        atomic_group = batch_tasks[0].get("atomicGroup") if batch_tasks else None
        is_atomic_group = isinstance(atomic_group, dict)
        delivery_kind = "atomic_group" if is_atomic_group else "single_task"
        atomic_group_id = atomic_group.get("id") if is_atomic_group else None
        batch_rationale = atomic_group.get("rationale") if is_atomic_group else None
        projected[batch_id] = {
            "featureId": root.get("featureId"),
            "batchId": batch_id,
            "title": title,
            "executionLane": execution_lane,
            "executionStage": execution_stage,
            "status": status,
            "taskCount": len(batch_tasks),
            "completedTaskCount": sum(normalize_status(task.get("status")) == "done" for task in batch_tasks),
            "completionEvidenceIds": completion_ids,
            "taskIds": task_ids_list,
            "deliveryKind": delivery_kind,
            **({"atomicGroupId": atomic_group_id, "batchRationale": batch_rationale} if is_atomic_group else {}),
            **({"mergeCommitSha": previous.get("mergeCommitSha")} if "mergeCommitSha" in previous else {}),
            **({"deliveryRunId": previous.get("deliveryRunId")} if "deliveryRunId" in previous else {}),
            **({"mergedAt": previous.get("mergedAt")} if "mergedAt" in previous else {}),
            "startedAt": previous.get("startedAt"),
            "completedAt": previous.get("completedAt") if status == "done" else None,
            "tasks": batch_tasks,
        }
        cross_deps = {
            task_to_batch[dep]
            for task in batch_tasks
            for dep in task.get("deps", [])
            if isinstance(dep, str) and dep in task_to_batch and task_to_batch[dep] != batch_id
        }
        workspace_ref = workspace_contract[0][0] if len(workspace_contract) == 1 else None
        root_entries.append(
            {
                "id": batch_id,
                "path": f"plans/{batch_id}/plan.json",
                "title": title,
                "specRoots": [spec_root],
                "executionLane": execution_lane,
                "executionStage": execution_stage,
                **({"workspaceRef": workspace_ref} if workspace_ref else {}),
                "deps": sorted(cross_deps),
                "taskIds": [str(task.get("id")) for task in batch_tasks],
                "deliveryKind": delivery_kind,
                **({"atomicGroupId": atomic_group_id, "batchRationale": batch_rationale} if is_atomic_group else {}),
                "status": status,
                **({"mergeCommitSha": previous.get("mergeCommitSha")} if "mergeCommitSha" in previous else {}),
                **({"deliveryRunId": previous.get("deliveryRunId")} if "deliveryRunId" in previous else {}),
            }
        )
    root["batches"] = root_entries
    # The parallel workflow consumes this contract directly.  It deliberately
    # owns Review/Test execution inside each Batch and reserves integration
    # and E2E validation for runtime validation Batches, so Board-level stages
    # cannot execute the same command a second time after merge.
    root["parallelBatchPipeline"] = build_pipeline_contract(root, projected)
    root["taskSetDigest"] = task_set_digest(root, projected)
    unfinished = [entry["id"] for entry in root_entries if entry["status"] != "done"]
    if not root_entries:
        root.update({"status": "todo", "activeBatchId": None, "nextBatchId": None})
    elif not unfinished:
        root["status"] = "failed" if data.get("status") == "failed" else "done"
        root["activeBatchId"] = None
        root["nextBatchId"] = None
    elif len(unfinished) > 1:
        # Multi-Batch execution is selected from the dependency DAG, not the
        # presentation order of Batch IDs.
        root["activeBatchId"] = None
        root["nextBatchId"] = None
        if data.get("status") == "failed" or any(entry["status"] == "failed" for entry in root_entries):
            root["status"] = "failed"
        elif data.get("status") == "in_progress" or any(entry["status"] == "in_progress" for entry in root_entries):
            root["status"] = "in_progress"
        else:
            root["status"] = "todo"
    else:
        active = root.get("activeBatchId")
        if active not in unfinished:
            active = unfinished[0]
        root["activeBatchId"] = active
        active_index = unfinished.index(active)
        root["nextBatchId"] = unfinished[active_index + 1] if active_index + 1 < len(unfinished) else None
        if data.get("status") == "failed" or any(entry["status"] == "failed" for entry in root_entries):
            root["status"] = "failed"
        elif data.get("status") == "in_progress" or any(entry["status"] == "in_progress" for entry in root_entries):
            root["status"] = "in_progress"
        else:
            root["status"] = "todo"
    data["_batchAssignments"] = assignments
    data["_batchPlans"] = projected
    return root, projected


def _write(
    workspace: Path,
    feature: str,
    data: dict[str, Any],
    *,
    allow_empty: bool = False,
    plan_markdown: str | None = None,
) -> WriterResult:
    path = _path(workspace, feature)
    errors = _task_set_validation_errors(data, allow_empty=allow_empty)
    if errors:
        return WriterResult(ok=False, path=path, errors=errors)
    root, batch_plans = _project_batches(data)
    if batch_plans:
        errors = validate_plan_bundle_data(
            root,
            batch_plans,
        )
        if errors:
            return WriterResult(ok=False, path=path, errors=[{"reason": error} for error in errors])
    changed = False
    feature_dir = path.parent
    transaction_path: Path | None = None
    if batch_plans:
        transaction_path = _plan_write_transaction_path(workspace, feature)
        transaction = {
            "version": 1,
            "featureId": feature,
            "root": root,
            "batchPlans": batch_plans,
        }
        if plan_markdown is not None:
            transaction["planMarkdown"] = plan_markdown
        atomic_write_json(transaction_path, transaction)
    for batch_id, batch in batch_plans.items():
        changed = atomic_write_json(batch_plan_path(feature_dir, batch_id), batch) or changed
    changed = atomic_write_json(path, root) or changed
    if plan_markdown is not None:
        changed = write_text(_md_path(workspace, feature), plan_markdown) or changed
    if transaction_path is not None:
        unlink_if_exists(transaction_path)
    try:
        # UI_CONTEXT.md exists before Plan. Refresh its derived task labels
        # whenever the formal Plan changes so it does not keep page summaries.
        from hooks.ui_context_writer import refresh_ui_context_md

        refresh_ui_context_md(workspace, feature, tasks=_tasks(data))
    except Exception as exc:
        # A human-readable sidecar must not invalidate a committed Plan.
        print(f"Warning: Failed to refresh UI_CONTEXT.md from Plan: {exc}", file=sys.stderr)
    return WriterResult(ok=True, path=path, changed=changed)


def _workspace_context_for_group(
    group: dict[str, Any],
    contexts: list[dict[str, Any]],
) -> dict[str, Any]:
    task_id = str(group.get("id", "task"))
    workspace_ref = group.get("workspaceRef")
    if workspace_ref == "default" and len(contexts) == 1:
        return contexts[0]
    matches = [item for item in contexts if item.get("repo") == workspace_ref]
    if len(matches) != 1:
        raise PlanWriterInputError(
            "task_group_workspace_ref_not_found",
            f"task={task_id};workspaceRef={workspace_ref};available={','.join(str(item.get('repo')) for item in contexts)}",
        )
    return matches[0]


def _draft_task_workspace_roots(
    group: dict[str, Any],
    contexts: list[dict[str, Any]],
) -> dict[str, str]:
    context = _workspace_context_for_group(group, contexts)
    workspace_ref = str(group.get("workspaceRef"))
    key = "default" if workspace_ref == "default" else str(context["repo"])
    return {key: str(context["workspaceRoot"])}


def _draft_task_skeleton(group: dict[str, Any], workspace_roots: dict[str, str]) -> dict[str, Any]:
    task_id = str(group.get("id"))
    ui_required = group.get("uiRequired") is True
    execution_mode = group.get("executionMode", "code")
    ui_refs = copy.deepcopy(group.get("uiRefs")) if isinstance(group.get("uiRefs"), dict) else None
    touches = (
        sorted({str(path).replace("\\", "/").strip("/") for path in group.get("touches", []) if isinstance(path, str) and path.strip()})
        if isinstance(group.get("touches"), list)
        else []
    )
    task: dict[str, Any] = {
        "id": task_id,
        "title": group.get("title"),
        "executionMode": execution_mode,
        "executionStage": group.get("executionStage", "parallel"),
        "goal": "",
        "status": "todo",
        "deps": copy.deepcopy(group.get("deps", [])),
        "uiRequired": ui_required,
        "scope": {
            "modules": [],
            "entrypoints": [],
            "pages": copy.deepcopy(ui_refs.get("pageRefs", [])) if ui_refs else [],
            "dataObjects": [],
            "workspaceRoots": copy.deepcopy(workspace_roots),
            "paths": touches,
        },
        "writeTargets": copy.deepcopy(group.get("writeTargets", [])),
        "implementationPoints": [],
        "acceptanceCriteria": [],
        "validationBoundary": group.get("validationBoundary"),
        "workspaceRef": group.get("workspaceRef"),
        "nonGoals": [],
        "specRefs": copy.deepcopy(group.get("specRefs", [])),
        "sourceRefs": copy.deepcopy(group.get("sourceRefs", [])),
        "mergedScenarioRefs": copy.deepcopy(group.get("mergedScenarioRefs", [])),
        "designRefs": [],
        "apiIds": copy.deepcopy(group.get("apiIds", [])),
        "dataIds": [],
        "decisionIds": [],
        "expectedFiles": [],
        "evidenceIds": [],
        "implementationEvidenceIds": [],
        "latestImplementationEvidenceId": None,
        "validationEvidenceIds": [],
        "implementationRevision": 0,
        "completionPolicy": (
            "external_dependency_recorded"
            if execution_mode == "external_dependency"
            else "all_required_validations_pass"
        ),
        "completionEvidenceIds": [],
        "latestPassEvidenceId": None,
        "blockers": [],
    }
    if ui_refs is not None:
        task["uiRefs"] = ui_refs
    if execution_mode == "external_dependency":
        task["externalDependency"] = copy.deepcopy(group.get("externalDependency"))
    if isinstance(group.get("atomicGroup"), dict):
        task["atomicGroup"] = copy.deepcopy(group["atomicGroup"])
    rationale = group.get("splitRationale")
    if isinstance(rationale, str) and rationale.strip():
        task["splitRationale"] = rationale
    return task


def _plan_v2_runtime_task(group: dict[str, Any], workspace_roots: dict[str, str]) -> dict[str, Any]:
    """Create a complete runtime task without asking the planner for code detail.

    The generated fields preserve the planner's high-level implementation and
    test guidance. Code and UTest select actual files, symbols and executable
    commands against the codebase in their respective stages.
    """
    task = _draft_task_skeleton(group, workspace_roots)
    task_id = str(task["id"])
    outcome = str(group.get("title") or "").strip()
    scenario_refs = [
        ref for ref in task.get("specRefs", [])
        if isinstance(ref, str) and "#SCN-" in ref
    ]
    task["goal"] = outcome
    task["implementationPoints"] = copy.deepcopy(group.get("implementationPoints", []))
    task["testPoints"] = copy.deepcopy(group.get("testPoints", []))
    task["acceptanceCriteria"] = [{
        "id": f"AC-{task_id}-01",
        "text": outcome,
        "scenarioRefs": scenario_refs,
    }]
    task["nonGoals"] = []
    task["designRefs"] = copy.deepcopy(group.get("designRefs", []))
    task["dataIds"] = copy.deepcopy(group.get("dataIds", []))
    task["decisionIds"] = copy.deepcopy(group.get("decisionIds", []))
    task["verificationIntent"] = str(group.get("verificationIntent") or outcome).strip()
    return task


def _plan_writer_stdin_body() -> dict[str, Any]:
    try:
        return read_object_stdin()
    except WriterEncodingError as exc:
        raise PlanWriterInputError("invalid_body_stdin_encoding", str(exc)) from exc
    except WriterError as exc:
        message = str(exc)
        if "stdin 为空" in message:
            raise PlanWriterInputError("empty_body_stdin", message) from exc
        if "stdin 不是合法 JSON" in message:
            raise PlanWriterInputError("invalid_body_stdin_json", message) from exc
        if "stdin JSON 顶层必须是 object" in message:
            raise PlanWriterInputError("invalid_body_stdin_object", message) from exc
        raise


def _tasks(data: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = data.setdefault("tasks", [])
    if not isinstance(tasks, list):
        raise ValueError("plan.json.tasks 必须是数组")
    return tasks


def _scenario_coverage(feature_dir: Path, task_items: list[dict[str, Any]]) -> tuple[set[str], set[str]]:
    selections, _ = resolve_plan_scope(feature_dir)
    expected = selections["scenario"].included

    covered: set[str] = set()
    for task in task_items:
        for raw_ref in task.get("specRefs", []):
            if not isinstance(raw_ref, str):
                continue
            path_part, separator, anchor = raw_ref.partition("#")
            scenario_ids = SCENARIO_ID_RE.findall(anchor) if separator else []
            normalized_path = path_part.strip().replace("\\", "/")
            if normalized_path:
                covered.update(f"{normalized_path}#{scenario_id}" for scenario_id in scenario_ids)
    return expected, covered


def _feature_scope_report(feature_dir: Path, task_items: list[dict[str, Any]]) -> dict[str, Any]:
    selections, _ = resolve_plan_scope(feature_dir)
    return scope_report(selections)


def _find_task(data: dict[str, Any], task_id: str) -> dict[str, Any]:
    for task in _tasks(data):
        if isinstance(task, dict) and task.get("id") == task_id:
            return task
    raise ValueError(f"任务不存在: {task_id}")


def _batch_for_task(data: dict[str, Any], task_id: str) -> str:
    assignments = data.get("_batchAssignments")
    batch_id = assignments.get(task_id) if isinstance(assignments, dict) else None
    if not isinstance(batch_id, str):
        raise ValueError(f"任务批次不存在: {task_id}")
    return batch_id


def _append_unique(values: list[str], items: list[str]) -> list[str]:
    result = list(values)
    for item in items:
        if item not in result:
            result.append(item)
    return result


def _code_workspace_contexts(values: list[str] | None) -> list[dict[str, Any]]:
    contexts: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in values or []:
        requested = Path(raw).expanduser().resolve()
        try:
            git_root = resolve_git_root(requested)
        except RepositorySnapshotError as exc:
            raise PlanWriterInputError("code_workspace_invalid", str(exc)) from exc
        try:
            relative = requested.relative_to(git_root)
        except ValueError as exc:
            raise PlanWriterInputError("code_workspace_outside_git_root", str(requested)) from exc
        workspace_root = "." if relative == Path(".") else relative.as_posix()
        key = (git_root.name, workspace_root)
        if key in seen:
            continue
        existing = next(
            (item for item in contexts if item.get("repo") == git_root.name),
            None,
        )
        if existing is not None:
            raise PlanWriterInputError(
                "code_workspace_repository_id_duplicate",
                (
                    f"repo={git_root.name};first={existing.get('requestedPath')};"
                    f"second={requested};use_distinct_git_root_directory_names"
                ),
            )
        contexts.append({
            "repo": git_root.name,
            "gitRoot": git_root,
            "workspaceRoot": workspace_root,
            "requestedPath": requested,
        })
        seen.add(key)
    return contexts


def _code_workspace_bindings(
    contexts: list[dict[str, Any]],
    workspace_refs: set[str] | None = None,
) -> dict[str, str]:
    """Project Plan-time repository paths into the root Plan contract."""
    refs = workspace_refs or set()
    if len(contexts) == 1 and refs == {"default"}:
        return {"default": str(contexts[0]["requestedPath"])}
    return {
        str(context["repo"]): str(context["requestedPath"])
        for context in contexts
        if isinstance(context.get("repo"), str) and isinstance(context.get("requestedPath"), Path)
    }


def _context_for_workspace_root(
    contexts: list[dict[str, Any]],
    key: str,
    workspace_root: str,
) -> dict[str, Any] | None:
    matches = [
        item
        for item in contexts
        if item["workspaceRoot"] == workspace_root
        and (key == "default" or item["repo"] == key)
    ]
    return matches[0] if len(matches) == 1 else None


def _code_workspace_preflight_errors(
    data: dict[str, Any],
    code_workspaces: list[str] | None,
) -> list[dict[str, str]]:
    tasks_with_roots = [task for task in _tasks(data) if task_workspace_roots(task)]
    if not tasks_with_roots:
        return []
    if not code_workspaces:
        return [{"reason": "code_workspace_preflight_required"}]
    contexts = _code_workspace_contexts(code_workspaces)
    errors: list[dict[str, str]] = []
    for task in tasks_with_roots:
        task_id = str(task.get("id", "task"))
        workspace_roots = task_workspace_roots(task)
        for key, workspace_root in workspace_roots.items():
            if _context_for_workspace_root(contexts, key, workspace_root) is None:
                errors.append({
                    "reason": "code_workspace_contract_mismatch",
                    "detail": f"task={task_id};repo={key};workspaceRoot={workspace_root}",
                })
    return errors


def _task_set_preflight_errors(
    feature_dir: Path,
    data: dict[str, Any],
    group_data: dict[str, Any],
    code_workspaces: list[str] | None = None,
) -> list[dict[str, Any]]:
    errors = _task_group_preflight_errors(feature_dir, group_data)
    if errors:
        return errors
    contract_errors = _task_group_contract_errors(group_data, _tasks(data))
    if contract_errors:
        return contract_errors
    errors = []
    design_contract, design_errors = _current_design_contract(feature_dir)
    errors.extend(design_errors)
    if design_errors:
        return errors
    for task in _tasks(data):
        errors.extend(validate_task_artifact_refs(
            feature_dir,
            task,
            design_contract=design_contract,
            check_design_artifact=False,
        ))
    selections, partition_errors = resolve_plan_scope(feature_dir)
    errors.extend(partition_errors)
    errors.extend(validate_plan_design_coverage(
        design_contract, _tasks(data), included_ids=selections["design"].included,
    ))
    # A task detail may add scope.paths/expectedFiles beyond its group-owned
    # touches.  Recheck the final write sets before projecting Batches.
    _, projected_batches = _project_batches(copy.deepcopy(data))
    projected_scopes = {
        str(task.get("id")): batch_id
        for batch_id, batch in projected_batches.items()
        for task in batch.get("tasks", [])
        if isinstance(task, dict) and isinstance(task.get("id"), str)
    }
    errors.extend(write_ownership_violations(
        _tasks(data),
        ownership_scope_by_task=projected_scopes,
    ))
    errors.extend(_task_set_validation_errors(data))
    errors.extend(_code_workspace_preflight_errors(data, code_workspaces))
    if not errors:
        root, batches = _project_batches(data)
        bundle_errors = validate_plan_bundle_data(root, batches)
        errors.extend({"reason": error} for error in bundle_errors)
    expected, covered = _scenario_coverage(feature_dir, _tasks(data))
    missing = sorted(expected - covered)
    if missing:
        errors.append({
            "reason": "missing_plan_scenario_coverage",
            "detail": f"return_to_scenario_matrix;ids={','.join(missing)}",
            "field": "specRefs",
            "repairTarget": "task_group",
        })
    return errors


def _task_set_summary(data: dict[str, Any]) -> dict[str, Any]:
    root, _ = _project_batches(data)
    return {
        "taskCount": len(_tasks(data)),
        "batchCount": len(root.get("batches", [])),
        "batches": [
            {"id": entry["id"], "executionLane": entry["executionLane"], "taskIds": entry["taskIds"]}
            for entry in root.get("batches", [])
        ],
    }


def _cmd_prepare_plan(args: argparse.Namespace) -> int:
    """Write a complete, critic-ready Plan v2 bundle without ``PLAN.md``.

    A review-ready machine bundle may be replaced by another complete Plan v2
    input while the Plan stage is still open.  Once ``plan.json`` is
    finalized, subsequent corrections must use the normal rollback flow;
    ``PLAN.md`` is only its human-readable projection.
    """
    workspace, feature = _resolve(args)
    plan_path = _path(workspace, feature)
    if plan_path.is_file():
        try:
            existing = _load(workspace, feature)
        except (PlanWriterInputError, ValueError) as exc:
            return render_result(fail("review_plan_not_revisable", str(exc)))
        if existing.get("taskSetStatus") != "reviewing":
            return render_result(fail("formal_plan_already_exists", path=plan_path))
    elif _md_path(workspace, feature).is_file():
        return render_result(fail("orphan_plan_markdown", path=_md_path(workspace, feature)))
    body = _plan_writer_stdin_body() if args.body_stdin else read_object_file(Path(args.body_file))
    if not isinstance(body, dict):
        return render_result(fail("plan_v2_body_must_be_object"))
    if body.get("schemaVersion") != PLAN_SCHEMA:
        return render_result(fail("plan_v2_schema_required", f"expected={PLAN_SCHEMA};actual={body.get('schemaVersion')}"))
    try:
        group_data = _plan_v2_to_groups(body)
    except PlanWriterInputError as exc:
        return render_result(fail(exc.reason, exc.detail))
    if group_data.get("featureId") != feature:
        return render_result(fail("plan_v2_feature_mismatch", f"expected={feature};actual={group_data.get('featureId')}"))
    feature_dir = _path(workspace, feature).parent
    try:
        _materialize_v2_ui_visual_sources(feature_dir, group_data)
        _materialize_v2_source_references(feature_dir, group_data)
    except PlanWriterInputError as exc:
        return render_result(fail(exc.reason, exc.detail))
    group_errors = _task_group_preflight_errors(feature_dir, group_data)
    blocking_group_errors = [item for item in group_errors if item.get("severity") != "warning"]
    if blocking_group_errors:
        return render_result(WriterResult(ok=False, path=_path(workspace, feature), errors=blocking_group_errors))
    try:
        workspace_contexts = _code_workspace_contexts(args.code_workspace)
        implementation_scope, scope_errors = load_scope(feature_dir)
        if scope_errors:
            return render_result(WriterResult(
                ok=False,
                path=_path(workspace, feature),
                errors=[{"reason": error} for error in scope_errors],
            ))
        data = _initial(feature)
        data["implementationScope"] = implementation_scope
        data["codeWorkspaces"] = _code_workspace_bindings(
            workspace_contexts,
            {str(group.get("workspaceRef")) for group in _task_groups(group_data)},
        )
        data["tasks"] = [
            _plan_v2_runtime_task(group, _draft_task_workspace_roots(group, workspace_contexts))
            for group in _task_groups(group_data)
        ]
        data["scopeReport"] = _feature_scope_report(feature_dir, _tasks(data))
        data["taskSetStatus"] = "reviewing"
        plan_errors = _task_set_preflight_errors(
            feature_dir,
            data,
            group_data,
            [str(Path(value).expanduser().resolve()) for value in args.code_workspace],
        )
        blocking_plan_errors = [item for item in plan_errors if item.get("severity") != "warning"]
        if blocking_plan_errors:
            return render_result(WriterResult(ok=False, path=_path(workspace, feature), errors=blocking_plan_errors))
        result = _write(workspace, feature, data)
        return render_result(with_result_data(
            result,
            planSchema=PLAN_SCHEMA,
            publicationStatus="reviewing",
            warnings=[item for item in [*group_errors, *plan_errors] if item.get("severity") == "warning"],
            materialized=_task_set_summary(data),
            scopeReport=_feature_scope_report(feature_dir, _tasks(data)),
        ))
    except (PlanWriterInputError, ValueError) as exc:
        if isinstance(exc, PlanWriterInputError):
            return render_result(fail(exc.reason, exc.detail))
        return render_result(fail("plan_v2_prepare_failed", str(exc)))


def _cmd_publish_plan(args: argparse.Namespace) -> int:
    """Finalize reviewed ``plan.json`` and emit its ``PLAN.md`` projection."""
    workspace, feature = _resolve(args)
    if not _path(workspace, feature).is_file():
        return render_result(fail("review_plan_missing", path=_path(workspace, feature)))
    if _md_path(workspace, feature).is_file():
        return render_result(fail("plan_markdown_already_exists", path=_md_path(workspace, feature)))
    try:
        data = _load(workspace, feature)
        if data.get("taskSetStatus") != "reviewing":
            return render_result(fail("review_plan_not_ready", "taskSetStatus must be reviewing"))
        data["taskSetStatus"] = "finalized"
        root, batches = _project_batches(copy.deepcopy(data))
        errors = validate_plan_bundle_data(root, batches, require_initial_status=True)
        if errors:
            return render_result(WriterResult(
                ok=False,
                path=_path(workspace, feature),
                errors=[{"reason": error} for error in errors],
            ))
        result = _write(workspace, feature, data, plan_markdown=_render_plan_md(data))
        return render_result(with_result_data(
            result,
            publicationStatus="finalized",
            materialized=_task_set_summary(data),
        ))
    except (PlanWriterInputError, ValueError) as exc:
        return render_result(fail("plan_v2_publish_failed", str(exc)))


def set_task_execution_status(
    workspace: Path,
    feature: str,
    task_id: str,
    status: str,
    *,
    expected_task_contract_sha256: str | None = None,
    parallel: bool = False,
) -> WriterResult:
    """Internal task-runner API; public CLI cannot set a task to done."""

    with _plan_lock(workspace, feature):
        data = _load(workspace, feature)
        task = _find_task(data, task_id)
        if (
            expected_task_contract_sha256 is not None
            and task_contract_sha256(task) != expected_task_contract_sha256
        ):
            return fail("task_contract_changed_after_start", task_id, path=_path(workspace, feature))
        task["status"] = status
        batch_id = _batch_for_task(data, task_id)
        batch_plans = data.get("_batchPlans")
        batch_plan = batch_plans.get(batch_id) if isinstance(batch_plans, dict) else None
        if isinstance(batch_plan, dict) and normalize_status(status) == "in_progress":
            batch_plan["startedAt"] = batch_plan.get("startedAt") or _utc_now()
            data["status"] = "in_progress"
            if not parallel:
                data["activeBatchId"] = batch_id
        result = _write(workspace, feature, data)
        if result.ok:
            write_text(_md_path(workspace, feature), _render_plan_md(data))
        return result


def record_task_implementation(
    workspace: Path,
    feature: str,
    task_id: str,
    evidence_id: str,
    *,
    expected_task_contract_sha256: str,
    parallel: bool = False,
) -> WriterResult:
    """Bind implementation evidence without running or completing task validation."""

    with _plan_lock(workspace, feature):
        data = _load(workspace, feature)
        if not defer_to_test_stages_enabled(data):
            return fail("defer_to_test_stages_not_enabled", task_id, path=_path(workspace, feature))
        task = _find_task(data, task_id)
        if task_contract_sha256(task) != expected_task_contract_sha256:
            return fail("task_contract_changed_after_start", task_id, path=_path(workspace, feature))
        if normalize_status(task.get("status")) != "in_progress":
            return fail("task_not_in_progress", task_id, path=_path(workspace, feature))
        task["evidenceIds"] = _append_unique(
            task.get("evidenceIds") if isinstance(task.get("evidenceIds"), list) else [],
            [evidence_id],
        )
        task["implementationEvidenceIds"] = _append_unique(
            task.get("implementationEvidenceIds")
            if isinstance(task.get("implementationEvidenceIds"), list)
            else [],
            [evidence_id],
        )
        task["latestImplementationEvidenceId"] = evidence_id
        task["implementationRevision"] = int(task.get("implementationRevision", 0)) + 1
        task["completionEvidenceIds"] = []
        task["latestPassEvidenceId"] = None
        task["status"] = "implemented"

        batch_id = _batch_for_task(data, task_id)
        batch_plans = data.get("_batchPlans")
        batch_plan = batch_plans.get(batch_id) if isinstance(batch_plans, dict) else None

        if not isinstance(batch_plan, dict):
            return fail("batch_plan_missing", batch_id, path=_path(workspace, feature))
        batch_tasks = [item for item in batch_plan.get("tasks", []) if isinstance(item, dict)]
        all_implemented = bool(batch_tasks) and all(
            normalize_status(item.get("status")) in {"implemented", "done"}
            for item in batch_tasks
        )

        data["status"] = "in_progress"
        if not parallel:
            data["activeBatchId"] = batch_id

        result = _write(workspace, feature, data)
        if not result.ok:
            return result
        if all_implemented:
            return with_result_data(result, batchContinuation={
                "requiredAction": "await_review",
                "activeBatchId": batch_id,
                "taskIds": [str(item.get("id")) for item in batch_tasks],
                "status": "awaiting_review",
            })

        return result


def mark_parallel_batch_tasks_merged(
    workspace: Path,
    feature: str,
    batch_id: str,
    *,
    merge_commit_sha: str,
    delivery_run_id: str,
) -> WriterResult:
    """Complete a parallel Batch only after its sealed delivery is merged.

    Review, UTest and Merge Train form the only delivery path that moves
    parallel Tasks from ``implemented`` to ``done``.
    """
    if not merge_commit_sha:
        return fail("parallel_merge_commit_sha_required", batch_id, path=_path(workspace, feature))
    if not delivery_run_id:
        return fail("parallel_delivery_run_id_required", batch_id, path=_path(workspace, feature))
    with _plan_lock(workspace, feature):
        data = _load(workspace, feature)
        if not defer_to_test_stages_enabled(data):
            return fail("defer_to_test_stages_not_enabled", batch_id, path=_path(workspace, feature))
        batch_plans = data.get("_batchPlans")
        batch_plan = batch_plans.get(batch_id) if isinstance(batch_plans, dict) else None
        if not isinstance(batch_plan, dict):
            return fail("batch_not_found", batch_id, path=_path(workspace, feature))
        existing_commit = batch_plan.get("mergeCommitSha")
        if isinstance(existing_commit, str) and existing_commit and existing_commit != merge_commit_sha:
            return fail("parallel_batch_merge_commit_mismatch", batch_id, path=_path(workspace, feature))
        task_ids = batch_plan.get("taskIds", [])
        if not isinstance(task_ids, list):
            return fail("batch_task_ids_invalid", batch_id, path=_path(workspace, feature))
        for task in data.get("tasks", []):
            if not isinstance(task, dict) or task.get("id") not in task_ids:
                continue
            status = normalize_status(task.get("status"))
            if status == "implemented":
                task["status"] = "done"
            elif status != "done":
                return fail(
                    "parallel_batch_task_not_implemented",
                    f"batch={batch_id};task={task.get('id')};status={status}",
                    path=_path(workspace, feature),
                )
        batch_plan["mergeCommitSha"] = merge_commit_sha
        batch_plan["deliveryRunId"] = delivery_run_id
        batch_plan["mergedAt"] = _utc_now()
        data["status"] = "in_progress"
        data["activeBatchId"] = None
        data["nextBatchId"] = None
        return _write(workspace, feature, data)


def _fmt(values: Any) -> str:
    if not isinstance(values, list) or not values:
        return "-"
    return " / ".join(str(value) for value in values)


def _render_plan_md(data: dict[str, Any]) -> str:
    lines = [
        f"# 执行计划: {data.get('featureId', '')}",
        "",
        "来源: plan.json",
        "状态: 待执行",
        "",
        "## 代码仓库映射",
        "",
        "| workspaceRef | 代码仓库路径 |",
        "| ------------ | ------------ |",
    ]
    code_workspaces = data.get("codeWorkspaces")
    if isinstance(code_workspaces, dict) and code_workspaces:
        for workspace_ref, code_workspace in sorted(code_workspaces.items()):
            lines.append(f"| {workspace_ref} | {code_workspace} |")
    else:
        lines.append("| - | 未登记，Code 阶段禁止猜测路径 |")
    lines.extend([
        "",
        "## 任务总览",
        "",
        "| Task ID | 任务 | 执行模式 | 依赖 | 状态 |",
        "| ------- | ---- | -------- | ---- | ---- |",
    ])
    for task in _tasks(data):
        lines.append(
            f"| {task.get('id', '')} | {task.get('title', '')} | {task_execution_mode(task)} | {_fmt(task.get('deps'))} | {task.get('status', '')} |"
        )
    lines.extend(["", "## 任务详情", ""])
    for task in _tasks(data):
        lines.extend(
            [
                f"### Task [{task.get('id', '')}]: {task.get('title', '')}",
                "",
                f"- 做什么: {task.get('goal', '')}",
                f"- 执行模式: {task_execution_mode(task)}",
                f"- 规格依据: {_fmt(task.get('specRefs'))}",
                f"- api_id: {_fmt(task.get('apiIds'))}",
                f"- data_id: {_fmt(task.get('dataIds'))}",
                f"- decision_id: {_fmt(task.get('decisionIds'))}",
                f"- 外部资料: {_fmt(task.get('sourceRefs'))}",
                f"- 涉及范围: modules={_fmt(task.get('scope', {}).get('modules') if isinstance(task.get('scope'), dict) else [])}; entrypoints={_fmt(task.get('scope', {}).get('entrypoints') if isinstance(task.get('scope'), dict) else [])}; pages={_fmt(task.get('scope', {}).get('pages') if isinstance(task.get('scope'), dict) else [])}",
                f"- 验证边界: {task.get('validationBoundary', '')}",
                f"- 代码工作区: {task.get('workspaceRef', '')}",
                "- 执行要点:",
            ]
        )
        for index, point in enumerate(task.get("implementationPoints", []) if isinstance(task.get("implementationPoints"), list) else [], start=1):
            lines.append(f"  {index}. {point}")
        lines.append("- 测试要点:")
        for index, point in enumerate(task.get("testPoints", []), start=1):
            lines.append(f"  {index}. {point}")
        lines.append(f"- 验证意图: {task.get('verificationIntent') or task.get('validationBoundary', '')}")
        lines.append("- 验收标准:")
        for index, criterion in enumerate(task.get("acceptanceCriteria", []) if isinstance(task.get("acceptanceCriteria"), list) else [], start=1):
            text = criterion.get("text", "") if isinstance(criterion, dict) else criterion
            criterion_id = criterion.get("id") if isinstance(criterion, dict) else None
            label = f"{criterion_id}: {text}" if criterion_id else text
            lines.append(f"  {index}. {label}")
        if task.get("nonGoals"):
            lines.append(f"- 非目标: {_fmt(task.get('nonGoals'))}")
        external_dependency = task.get("externalDependency")
        if isinstance(external_dependency, dict):
            lines.append(
                "- 外部依赖: "
                f"system={external_dependency.get('system', '')}; "
                f"owner={external_dependency.get('owner', '')}; "
                f"trackingRefs={_fmt(external_dependency.get('trackingRefs'))}"
            )
        if task.get("splitRationale"):
            lines.append(f"- 合并理由: {task.get('splitRationale')}")
        lines.append("- 验证点:")
        for point in task.get("testPoints", []):
            lines.append(f"  - {point}")
        lines.append(f"- 验证意图: {task.get('verificationIntent', '')}")
        lines.append("- 测试命令: 由 UTest/E2E 在测试资产落地后根据真实 runner 生成")
        lines.append(f"- 状态: {task.get('status', '')}")
        disposition = task.get("validationDisposition")
        if isinstance(disposition, dict):
            lines.append(
                "- Code 验证延期: "
                f"{disposition.get('issueId', '')}; "
                f"reason={disposition.get('reason', '')}; "
                f"command={disposition.get('commandId', '')}; "
                f"repairAttempts={disposition.get('repairAttempts', 0)}"
            )
        lines.append("")
    report = data.get("scopeReport")
    if isinstance(report, dict) and report:
        lines.extend(["## 本期范围之外", ""])
        for kind, selection in sorted(report.items()):
            lines.append(f"- {kind}: 后续={_fmt(selection.get('deferred'))}; 未分配={_fmt(selection.get('unpartitioned'))}")
        lines.append("")
    return "\n".join(lines)


def _resolve(args: argparse.Namespace) -> tuple[Path, str]:
    return resolve_workspace(args.workspace), resolve_feature(args.feature)


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace")
    parser.add_argument("--feature")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare a machine Plan v2 for review, then emit PLAN.md")
    sub = parser.add_subparsers(dest="command", required=True)

    prepare = sub.add_parser("prepare-plan", help="write one critic-ready Plan v2 bundle without PLAN.md")
    _common(prepare)
    prepare.add_argument("--code-workspace", required=True, action="append")
    prepare_input = prepare.add_mutually_exclusive_group(required=True)
    prepare_input.add_argument("--body-stdin", action="store_true")
    prepare_input.add_argument("--body-file")
    prepare.set_defaults(func=_cmd_prepare_plan)

    publish = sub.add_parser("publish-plan", help="finalize reviewed plan.json and emit its PLAN.md projection")
    _common(publish)
    publish.set_defaults(func=_cmd_publish_plan)

    args = parser.parse_args(argv)
    try:
        workspace, feature = _resolve(args)
        with _plan_lock(workspace, feature):
            _load(workspace, feature)
            return args.func(args)
    except PlanWriterInputError as exc:
        return render_result(fail(exc.reason, exc.detail))
    except WriterEncodingError as exc:
        return render_result(fail("plan_writer_encoding_error", str(exc)))
    except Exception as exc:
        return render_result(fail("plan_writer_failed", str(exc)))


if __name__ == "__main__":
    raise SystemExit(main())
