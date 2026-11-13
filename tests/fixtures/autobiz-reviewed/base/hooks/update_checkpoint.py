#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Safely update one Feature checkpoint in .autobizdevops/state.json."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOOKS_DIR = ROOT / "hooks"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from hooks.paths import (  # noqa: E402
    STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR,
    contains_workspace_argument,
    get_plugin_output_workspace,
    resolve_env_feature,
)
from state_checkpoint import (  # noqa: E402
    append_checkpoint_hook_logs,
    check_stage_inputs,
    validate_lifecycle,
    validate_transitions,
)
from board_core.contracts import BoardConfigError, load_board_config, load_record_workflow_contracts  # noqa: E402
from board_core.state_store import (  # noqa: E402
    EMPTY_CELL,
    StateRecords,
    check_or_fix_state_sync,
    render_state_md,
    state_json_content_from_records_preserving_raw,
    state_rows_from_records,
    write_state_records_preserving_raw,
)
from board_core.workflow import (  # noqa: E402
    landing_checkpoint_after_skip,
    validate_skip_request,
)
from board_core.workflow_compiler import (  # noqa: E402
    BASE_WORKFLOW_PROFILE,
    BASE_WORKFLOW_TEMPLATE,
    SKIPPED_WORKFLOW_DECISION,
    WorkflowCompileError,
    configured_dynamic_stages,
    configured_skip_policy,
    normalize_workflow_decisions,
    normalize_workflow_profile,
    normalize_workflow_skipped_nodes,
)


STATE_RELATIVE_PATH = Path(".autobizdevops") / "STATE.md"
STATE_JSON_RELATIVE_PATH = Path(".autobizdevops") / "state.json"
CHECKPOINT_LOG_EVENTS = (
    ("state-done", "STATE checkpoint 转移校验", "transition_errors"),
    ("autodev-lifecycle", "Autodev 产物校验", "lifecycle_errors"),
)


@dataclass(frozen=True)
class CheckpointUpdate:
    ok: bool
    state_path: Path
    state_json_path: Path
    content: str
    state_json_content: str
    records: StateRecords
    transition_errors: tuple[str, ...]
    lifecycle_errors: tuple[str, ...]
    old_checkpoint: str | None
    new_checkpoint: str | None
    workflow_profile: str = BASE_WORKFLOW_PROFILE
    workflow_decisions: dict[str, str] | None = None
    raw_records: dict[str, object] = field(default_factory=dict)

    @property
    def errors(self) -> tuple[str, ...]:
        return (*self.transition_errors, *self.lifecycle_errors)


def replace_feature_record(
    records: StateRecords,
    *,
    feature: str,
    checkpoint: str,
    stage: str | None,
    owner: str | None,
    iteration: str | None,
    allow_create: bool,
    updated_at: str,
    workflow_profile: str,
    workflow_decisions: dict[str, str],
    stage_labels: dict[str, str],
    initial_checkpoints: frozenset[str],
) -> tuple[StateRecords, list[str]]:
    errors: list[str] = []
    resolved_stage = stage if stage is not None else stage_labels.get(checkpoint, "")
    new_records: StateRecords = {slug: dict(record) for slug, record in records.items()}
    if feature in new_records:
        record = dict(new_records[feature])
        old_checkpoint = record.get("checkpoint", "")
        old_profile = normalize_workflow_profile(record.get("workflowProfile", BASE_WORKFLOW_PROFILE))
        if old_profile != workflow_profile:
            if old_checkpoint != "prd_done":
                return records, [
                    f"Feature '{feature}' 已绑定 workflowProfile={old_profile}，不能在 {old_checkpoint} 改为 {workflow_profile}"
                ]
            record["workflowProfile"] = workflow_profile
        record["feature"] = feature
        record["checkpoint"] = checkpoint
        record["stage"] = resolved_stage
        record["workflowDecisions"] = dict(workflow_decisions)
        if checkpoint == "needs_fix" and old_checkpoint != "needs_fix":
            record["needsFixFromCheckpoint"] = old_checkpoint
        elif checkpoint != "needs_fix":
            record.pop("needsFixFromCheckpoint", None)
        if owner is not None:
            record["owner"] = owner
        if iteration is not None:
            record["iteration"] = iteration
        record["updated_at"] = updated_at
        new_records[feature] = record
    else:
        if not allow_create:
            errors.append(f"Feature '{feature}' 不存在；新增行必须显式传入 --allow-create")
        if checkpoint not in initial_checkpoints:
            allowed = " / ".join(sorted(initial_checkpoints))
            errors.append(f"Feature '{feature}' 是新增行，只允许从空状态进入 {allowed}，当前为 {checkpoint}")
        if errors:
            return records, errors

        new_records[feature] = {
            "feature": feature,
            "owner": owner if owner is not None else EMPTY_CELL,
            "checkpoint": checkpoint,
            "stage": resolved_stage,
            "iteration": iteration if iteration is not None else EMPTY_CELL,
            "updated_at": updated_at,
            "workflowProfile": workflow_profile,
            "workflowDecisions": dict(workflow_decisions),
            "workflowTemplate": BASE_WORKFLOW_TEMPLATE,
        }

    return new_records, []


def parse_workflow_decision_args(items: list[str] | None) -> tuple[dict[str, str], tuple[str, ...]]:
    updates: dict[str, str] = {}
    errors: list[str] = []
    for raw in items or []:
        if "=" not in raw:
            errors.append(f"--workflow-decision 必须使用 stage=enabled|skipped 格式: {raw}")
            continue
        stage_id, decision = raw.split("=", 1)
        stage_id = stage_id.strip()
        decision = decision.strip()
        if not stage_id or not decision:
            errors.append(f"--workflow-decision 必须使用 stage=enabled|skipped 格式: {raw}")
            continue
        updates[stage_id] = decision
    try:
        return normalize_workflow_decisions(updates), tuple(errors)
    except WorkflowCompileError as exc:
        return {}, (*errors, str(exc))


def validate_workflow_decision_updates(
    *,
    old_checkpoint: str | None,
    updates: dict[str, str],
) -> tuple[str, ...]:
    if not updates:
        return ()
    stage_by_id = {stage["id"]: stage for stage in configured_dynamic_stages(load_board_config(ROOT / "board_core" / "board_config.json"))}
    errors: list[str] = []
    for stage_id in sorted(updates):
        stage = stage_by_id.get(stage_id)
        if stage is None:
            errors.append(f"未知 workflow dynamic stage: {stage_id}")
            continue
        choice_checkpoint = stage["choiceCheckpoint"]
        if old_checkpoint != choice_checkpoint:
            errors.append(
                f"workflow decision '{stage_id}' 只能在 {choice_checkpoint} 设置，当前 checkpoint 为 {old_checkpoint or 'empty'}"
            )
    return tuple(errors)


def apply_implicit_skip_decisions(
    *,
    target_checkpoint: str,
    decisions: dict[str, str],
) -> dict[str, str]:
    resolved = dict(decisions)
    for stage in configured_dynamic_stages(
        load_board_config(ROOT / "board_core" / "board_config.json")
    ):
        stage_id = stage["id"]
        if stage_id in resolved:
            continue
        if target_checkpoint == stage["skipTargetCheckpoint"]:
            resolved[stage_id] = SKIPPED_WORKFLOW_DECISION
    return resolved


def prepare_checkpoint_update(
    *,
    workspace: Path,
    feature: str,
    checkpoint: str,
    stage: str | None = None,
    owner: str | None = None,
    iteration: str | None = None,
    allow_create: bool = False,
    updated_at: str | None = None,
    workflow_profile: str | None = None,
    workflow_decision_updates: dict[str, str] | None = None,
    needs_fix_from_checkpoint: str | None = None,
) -> CheckpointUpdate:
    workspace = workspace.resolve()
    state_path = workspace / STATE_RELATIVE_PATH
    state_json_path = workspace / STATE_JSON_RELATIVE_PATH
    if not feature.strip():
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            records={},
            transition_errors=("feature 不能为空",),
            lifecycle_errors=(),
            old_checkpoint=None,
            new_checkpoint=None,
            workflow_profile=workflow_profile or BASE_WORKFLOW_PROFILE,
            workflow_decisions=workflow_decision_updates or {},
        )

    sync_result = check_or_fix_state_sync(workspace, fix=True)
    if not sync_result.state_exists:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            records={},
            transition_errors=(f"state.json 不存在且无法从 STATE.md 迁移: {state_json_path}",),
            lifecycle_errors=(),
            old_checkpoint=None,
            new_checkpoint=None,
            workflow_profile=workflow_profile or BASE_WORKFLOW_PROFILE,
            workflow_decisions=workflow_decision_updates or {},
        )
    if sync_result.errors:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=(f"STATE.md 不存在: {state_path}",),
            lifecycle_errors=(),
            records=sync_result.records,
            old_checkpoint=None,
            new_checkpoint=None,
            workflow_profile=workflow_profile or BASE_WORKFLOW_PROFILE,
            workflow_decisions=workflow_decision_updates or {},
            raw_records=sync_result.raw_records,
        )
    if sync_result.record_errors.get(feature):
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=tuple(sync_result.record_errors[feature]),
            lifecycle_errors=(),
            records=sync_result.records,
            old_checkpoint=None,
            new_checkpoint=None,
            workflow_profile=workflow_profile or BASE_WORKFLOW_PROFILE,
            workflow_decisions=workflow_decision_updates or {},
            raw_records=sync_result.raw_records,
        )

    old_records = sync_result.records
    old_map = state_rows_from_records(old_records)
    old_record = old_records.get(feature)
    resolved_profile = normalize_workflow_profile(
        workflow_profile or (
            old_record.get("workflowProfile", BASE_WORKFLOW_PROFILE) if old_record else BASE_WORKFLOW_PROFILE
        )
    )
    resolved_template = (old_record or {}).get("workflowTemplate", BASE_WORKFLOW_TEMPLATE)
    try:
        old_decisions = normalize_workflow_decisions(old_record.get("workflowDecisions", {}) if old_record else {})
        decision_updates = normalize_workflow_decisions(workflow_decision_updates or {})
    except WorkflowCompileError as exc:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=(f"workflowDecisions 无效: {exc}",),
            lifecycle_errors=(),
            records={},
            old_checkpoint=old_map.get(feature),
            new_checkpoint=None,
            workflow_profile=resolved_profile,
            workflow_decisions={},
        )
    decision_errors = validate_workflow_decision_updates(
        old_checkpoint=old_map.get(feature),
        updates=decision_updates,
    )
    if decision_errors:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=decision_errors,
            lifecycle_errors=(),
            records={},
            old_checkpoint=old_map.get(feature),
            new_checkpoint=None,
            workflow_profile=resolved_profile,
            workflow_decisions=old_decisions,
        )
    try:
        resolved_decisions = apply_implicit_skip_decisions(
            target_checkpoint=checkpoint,
            decisions={**old_decisions, **decision_updates},
        )
    except (BoardConfigError, WorkflowCompileError, ValueError) as exc:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=(
                "workflow dynamic stage 配置无效: "
                f"{exc}；修复：检查 board_core/board_config.json 的 workflow.dynamicStages",
            ),
            lifecycle_errors=(),
            records={},
            old_checkpoint=old_map.get(feature),
            new_checkpoint=None,
            workflow_profile=resolved_profile,
            workflow_decisions=old_decisions,
        )
    workflow_record = {
        "workflowProfile": resolved_profile,
        "workflowDecisions": resolved_decisions,
        "workflowTemplate": resolved_template,
        "workflowNodes": (old_record or {}).get("workflowNodes"),
        "workflowSkippedNodes": (old_record or {}).get("workflowSkippedNodes"),
    }
    try:
        contracts = load_record_workflow_contracts(ROOT, workflow_record, workspace=workspace)
    except BoardConfigError as exc:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=(f"workflowProfile '{resolved_profile}' 无法编译: {exc}",),
            lifecycle_errors=(),
            records={},
            old_checkpoint=old_map.get(feature),
            new_checkpoint=None,
            workflow_profile=resolved_profile,
            workflow_decisions=resolved_decisions,
        )
    if checkpoint not in contracts.known_checkpoints:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            transition_errors=(f"未知 checkpoint: {checkpoint}",),
            lifecycle_errors=(),
            records={},
            old_checkpoint=old_map.get(feature),
            new_checkpoint=None,
            workflow_profile=resolved_profile,
            workflow_decisions=resolved_decisions,
        )
    new_records, update_errors = replace_feature_record(
        old_records,
        feature=feature,
        checkpoint=checkpoint,
        stage=stage,
        owner=owner,
        iteration=iteration,
        allow_create=allow_create,
        updated_at=updated_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        workflow_profile=resolved_profile,
        workflow_decisions=resolved_decisions,
        stage_labels=contracts.stage_labels,
        initial_checkpoints=contracts.initial_checkpoints,
    )
    if needs_fix_from_checkpoint is not None and not update_errors:
        source_checkpoint = needs_fix_from_checkpoint.strip()
        old_checkpoint = old_map.get(feature)
        if checkpoint != "needs_fix":
            update_errors.append("--needs-fix-from-checkpoint 只能与 --checkpoint needs_fix 一起使用")
        elif not source_checkpoint:
            update_errors.append("--needs-fix-from-checkpoint 不能为空")
        elif old_checkpoint != "needs_fix" and source_checkpoint != old_checkpoint:
            update_errors.append(
                "--needs-fix-from-checkpoint 必须等于进入 needs_fix 前的当前 checkpoint: "
                f"{old_checkpoint or 'empty'}"
            )
        else:
            record_with_source = dict(new_records[feature])
            record_with_source["needsFixFromCheckpoint"] = source_checkpoint
            new_records[feature] = record_with_source
    new_map = state_rows_from_records(new_records)

    content = ""
    state_json_content = ""
    render_errors: list[str] = []
    if not update_errors:
        try:
            content = render_state_md(new_records, workspace=workspace)
            state_json_content = state_json_content_from_records_preserving_raw(
                new_records,
                raw_records=sync_result.raw_records,
                workspace=workspace,
            )
        except ValueError as exc:
            render_errors.extend(str(exc).splitlines())

    transition_errors = [
        *update_errors,
        *render_errors,
        *validate_transitions(
            old_map,
            new_map,
            workspace_root=workspace,
            old_records=old_records,
            new_records=new_records,
        ),
    ]
    lifecycle_errors: list[str] = []
    if not transition_errors:
        lifecycle_errors.extend(
            validate_lifecycle(
                workspace,
                old_map,
                new_map,
                old_records=old_records,
                new_records=new_records,
            )
        )

    errors = [*transition_errors, *lifecycle_errors]

    return CheckpointUpdate(
        ok=not errors,
        state_path=state_path,
        state_json_path=state_json_path,
        transition_errors=tuple(transition_errors),
        lifecycle_errors=tuple(lifecycle_errors),
        content=content if not errors else "",
        state_json_content=state_json_content if not errors else "",
        records=new_records if not errors else {},
        old_checkpoint=old_map.get(feature),
        new_checkpoint=new_map.get(feature),
        workflow_profile=resolved_profile,
        workflow_decisions=resolved_decisions,
        raw_records=sync_result.raw_records,
    )


def prepare_skip_update(
    *,
    workspace: Path,
    feature: str,
    skip_nodes: list[str],
    updated_at: str | None = None,
) -> CheckpointUpdate:
    """Atomically skip workflow nodes for one feature.

    Skip is its own sanctioned transition: it bypasses allowed_next and the
    skipped node's postcheck, but still runs the landing skill's precheck under
    the post-skip contracts (inputs dropped by the skip are no longer part of
    the landing contract).
    """
    workspace = workspace.resolve()
    state_path = workspace / STATE_RELATIVE_PATH
    state_json_path = workspace / STATE_JSON_RELATIVE_PATH

    raw_records: dict[str, object] = {}

    def failed(
        *transition_errors: str,
        old_checkpoint: str | None = None,
        new_checkpoint: str | None = None,
        profile: str = BASE_WORKFLOW_PROFILE,
        decisions: dict[str, str] | None = None,
    ) -> CheckpointUpdate:
        return CheckpointUpdate(
            ok=False,
            state_path=state_path,
            state_json_path=state_json_path,
            content="",
            state_json_content="",
            records={},
            transition_errors=tuple(transition_errors),
            lifecycle_errors=(),
            old_checkpoint=old_checkpoint,
            new_checkpoint=new_checkpoint,
            workflow_profile=profile,
            workflow_decisions=decisions or {},
            raw_records=raw_records,
        )

    if not feature.strip():
        return failed("feature 不能为空")
    try:
        requested_skips = normalize_workflow_skipped_nodes(skip_nodes)
    except WorkflowCompileError as exc:
        return failed(f"--skip-node 无效: {exc}")
    if not requested_skips:
        return failed("--skip-node 不能为空")

    sync_result = check_or_fix_state_sync(workspace, fix=True)
    raw_records = sync_result.raw_records
    if not sync_result.state_exists:
        return failed(f"state.json 不存在且无法从 STATE.md 迁移: {state_json_path}")
    if sync_result.errors:
        return failed(*sync_result.errors)
    if sync_result.record_errors.get(feature):
        return failed(*sync_result.record_errors[feature])

    old_records = sync_result.records
    old_record = old_records.get(feature)
    if old_record is None:
        return failed(f"Feature '{feature}' 不存在，无法跳过节点")

    old_checkpoint = old_record.get("checkpoint", "")
    profile = normalize_workflow_profile(old_record.get("workflowProfile", BASE_WORKFLOW_PROFILE))
    decisions = normalize_workflow_decisions(old_record.get("workflowDecisions", {}))

    try:
        old_contracts = load_record_workflow_contracts(ROOT, old_record, workspace=workspace)
    except BoardConfigError as exc:
        return failed(
            f"workflow 配置无法编译: {exc}",
            old_checkpoint=old_checkpoint, profile=profile, decisions=decisions,
        )
    try:
        policy = configured_skip_policy(load_board_config(ROOT / "board_core" / "board_config.json"))
    except WorkflowCompileError as exc:
        return failed(
            f"skipPolicy 无效: {exc}",
            old_checkpoint=old_checkpoint, profile=profile, decisions=decisions,
        )

    nodes = list(old_contracts.nodes)
    skip_errors = validate_skip_request(
        nodes,
        old_checkpoint,
        list(requested_skips),
        locked_nodes=policy["lockedNodes"],
    )
    if skip_errors:
        return failed(*skip_errors, old_checkpoint=old_checkpoint, profile=profile, decisions=decisions)

    landing = landing_checkpoint_after_skip(nodes, old_checkpoint, list(requested_skips))
    new_checkpoint = landing or old_checkpoint

    new_record = dict(old_record)
    merged_skips = normalize_workflow_skipped_nodes(
        [*(old_record.get("workflowSkippedNodes") or []), *requested_skips]
    )
    new_record["workflowSkippedNodes"] = list(merged_skips)
    new_record["checkpoint"] = new_checkpoint
    new_record["updated_at"] = updated_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        new_contracts = load_record_workflow_contracts(ROOT, new_record, workspace=workspace)
    except BoardConfigError as exc:
        return failed(
            f"跳过后的 workflow 配置无法编译: {exc}",
            old_checkpoint=old_checkpoint, new_checkpoint=new_checkpoint,
            profile=profile, decisions=decisions,
        )
    if new_checkpoint not in new_contracts.known_checkpoints:
        return failed(
            f"跳过后没有可用的落地 checkpoint: {new_checkpoint or 'empty'}",
            old_checkpoint=old_checkpoint, profile=profile, decisions=decisions,
        )
    new_record["stage"] = new_contracts.stage_labels.get(new_checkpoint, "")

    new_records: StateRecords = {slug: dict(record) for slug, record in old_records.items()}
    new_records[feature] = new_record

    content = ""
    state_json_content = ""
    render_errors: list[str] = []
    try:
        content = render_state_md(new_records, workspace=workspace)
        state_json_content = state_json_content_from_records_preserving_raw(
            new_records,
            raw_records=sync_result.raw_records,
            workspace=workspace,
        )
    except ValueError as exc:
        render_errors.extend(str(exc).splitlines())

    lifecycle_errors: list[str] = []
    if not render_errors and landing is not None:
        start_skill = new_contracts.start_checkpoint_to_skill.get(new_checkpoint)
        if start_skill:
            error = check_stage_inputs(
                workspace,
                feature,
                start_skill,
                ROOT,
                workflow_profile=profile,
                workflow_decisions=decisions,
                workflow_record=new_record,
            )
            if error:
                lifecycle_errors.append(error)

    errors = [*render_errors, *lifecycle_errors]
    return CheckpointUpdate(
        ok=not errors,
        state_path=state_path,
        state_json_path=state_json_path,
        content=content if not errors else "",
        state_json_content=state_json_content if not errors else "",
        records=new_records if not errors else {},
        transition_errors=tuple(render_errors),
        lifecycle_errors=tuple(lifecycle_errors),
        old_checkpoint=old_checkpoint,
        new_checkpoint=new_checkpoint,
        workflow_profile=profile,
        workflow_decisions=decisions,
        raw_records=sync_result.raw_records,
    )


def write_skip_hook_logs(
    result: CheckpointUpdate,
    *,
    workspace: Path,
    feature: str,
    skip_nodes: list[str],
) -> None:
    label = "节点跳过"
    skipped_text = ", ".join(skip_nodes)
    transition = f"{result.old_checkpoint or 'empty'} -> {result.new_checkpoint or result.old_checkpoint or 'empty'}"
    errors = list(result.errors)
    message = (
        f"skip {skipped_text}: {transition}: {label} 通过"
        if result.ok
        else f"skip {skipped_text}: {transition}: " + "\n".join(errors)
    )
    append_checkpoint_hook_logs(
        workspace,
        [(feature, result.old_checkpoint, result.new_checkpoint or result.old_checkpoint)],
        event_id="node-skip",
        label=label,
        errors=errors,
        event_status="success" if result.ok else "blocked",
        exit_code=0 if result.ok else 1,
        message=message,
        workflow_profiles={feature: result.workflow_profile},
        workflow_decisions={feature: result.workflow_decisions or {}},
    )


def stage_event_status(result: CheckpointUpdate, stage: str) -> str:
    if stage == "transition_errors":
        return "blocked" if result.transition_errors else "success"
    if stage == "lifecycle_errors":
        if result.transition_errors:
            return "skipped"
        return "blocked" if result.lifecycle_errors else "success"
    return "error"


def stage_errors(result: CheckpointUpdate, stage: str) -> tuple[str, ...]:
    if stage == "transition_errors":
        return result.transition_errors
    if stage == "lifecycle_errors":
        return result.lifecycle_errors
    return ()


def stage_message(result: CheckpointUpdate, *, label: str, stage: str) -> str:
    transition = f"{result.old_checkpoint or 'empty'} -> {result.new_checkpoint or 'empty'}"
    event_status = stage_event_status(result, stage)
    errors = stage_errors(result, stage)
    if event_status == "success":
        return f"{transition}: {label} 通过"
    if event_status == "blocked":
        return f"{transition}: " + "\n".join(errors)
    if stage == "lifecycle_errors":
        return f"{transition}: {label} 未执行，因为 state-done 已阻断"
    return f"{transition}: {label} 执行异常"


def write_hook_logs(result: CheckpointUpdate, *, workspace: Path, feature: str) -> None:
    changes = [(feature, result.old_checkpoint, result.new_checkpoint)]
    for event_id, label, stage in CHECKPOINT_LOG_EVENTS:
        event_status = stage_event_status(result, stage)
        append_checkpoint_hook_logs(
            workspace,
            changes,
            event_id=event_id,
            label=label,
            errors=list(stage_errors(result, stage)),
            event_status=event_status,
            exit_code=0 if event_status == "success" else 1,
            message=stage_message(result, label=label, stage=stage),
            workflow_profiles={feature: result.workflow_profile},
            workflow_decisions={feature: result.workflow_decisions or {}},
        )


def write_result_json(
    result: CheckpointUpdate,
    *,
    feature: str,
    checkpoint: str,
    dry_run: bool,
    skip_nodes: list[str] | None = None,
    errors_as_message: bool = False,
) -> None:
    payload = {
        "ok": result.ok,
        "state_path": str(result.state_path),
        "state_json_path": str(result.state_json_path),
        "feature": feature,
        "old_checkpoint": result.old_checkpoint,
        "new_checkpoint": result.new_checkpoint,
        "requested_checkpoint": checkpoint,
        "workflow_profile": result.workflow_profile,
        "workflow_decisions": result.workflow_decisions or {},
        "dry_run": dry_run,
    }
    if errors_as_message:
        # 前端直调（skip_node.py）取用 message 字符串，便于直接展示
        payload["message"] = "\n".join(result.errors)
    else:
        payload["errors"] = list(result.errors)
    if skip_nodes:
        payload["skip_nodes"] = list(skip_nodes)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    raw_args = list(sys.argv[1:] if argv is None else argv)
    if contains_workspace_argument(raw_args):
        print(STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR, file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="Safely update .autobizdevops/state.json checkpoint",
        allow_abbrev=False,
    )
    parser.add_argument("--feature", "-f", help="feature slug; defaults to FEATURE_ID")
    parser.add_argument("--checkpoint", "-c", help="target checkpoint")
    parser.add_argument(
        "--skip-node",
        action="append",
        default=[],
        help="skip a workflow node mid-flight (node id, e.g. dev.code); may be repeated",
    )
    parser.add_argument("--stage", help="stage column override")
    parser.add_argument(
        "--needs-fix-from-checkpoint",
        help="backfill the source checkpoint for a feature already at needs_fix",
    )
    parser.add_argument("--owner", help="owner column override")
    parser.add_argument("--iteration", help="iteration column override")
    parser.add_argument("--workflow-profile", help="workflow profile for a new feature row")
    parser.add_argument(
        "--workflow-decision",
        action="append",
        default=[],
        help="workflow decision in stage=enabled|skipped form; may be repeated",
    )
    parser.add_argument("--allow-create", action="store_true", help="allow creating a new feature row")
    parser.add_argument("--dry-run", action="store_true", help="validate and print target content without writing")
    parser.add_argument("--json", action="store_true", help="print JSON result")
    args = parser.parse_args(raw_args)

    if bool(args.skip_node) == bool(args.checkpoint):
        print("checkpoint 更新失败: 必须且只能提供 --checkpoint 或 --skip-node 之一", file=sys.stderr)
        return 1
    if args.skip_node and any(
        [
            args.stage,
            args.owner,
            args.iteration,
            args.workflow_profile,
            args.workflow_decision,
            args.allow_create,
            args.needs_fix_from_checkpoint,
        ]
    ):
        print(
            "checkpoint 更新失败: --skip-node 不能与 --stage/--owner/--iteration/"
            "--workflow-profile/--workflow-decision/--allow-create/"
            "--needs-fix-from-checkpoint 同时使用",
            file=sys.stderr,
        )
        return 1
    if args.needs_fix_from_checkpoint is not None and args.checkpoint != "needs_fix":
        print(
            "checkpoint 更新失败: --needs-fix-from-checkpoint 只能与 --checkpoint needs_fix 一起使用",
            file=sys.stderr,
        )
        return 1

    try:
        workspace = get_plugin_output_workspace()
        feature = resolve_env_feature(args.feature, required=True)
    except ValueError as exc:
        print(f"checkpoint 更新失败: {exc}", file=sys.stderr)
        return 1

    if args.skip_node:
        result = prepare_skip_update(
            workspace=workspace,
            feature=feature,
            skip_nodes=args.skip_node,
        )
    else:
        workflow_decision_updates, decision_arg_errors = parse_workflow_decision_args(args.workflow_decision)
        if decision_arg_errors:
            result = CheckpointUpdate(
                ok=False,
                state_path=workspace / STATE_RELATIVE_PATH,
                state_json_path=workspace / STATE_JSON_RELATIVE_PATH,
                content="",
                state_json_content="",
                records={},
                transition_errors=decision_arg_errors,
                lifecycle_errors=(),
                old_checkpoint=None,
                new_checkpoint=None,
                workflow_profile=args.workflow_profile or BASE_WORKFLOW_PROFILE,
                workflow_decisions={},
            )
        else:
            result = prepare_checkpoint_update(
                workspace=workspace,
                feature=feature,
                checkpoint=args.checkpoint,
                stage=args.stage,
                owner=args.owner,
                iteration=args.iteration,
                allow_create=args.allow_create,
                workflow_profile=args.workflow_profile,
                workflow_decision_updates=workflow_decision_updates,
                needs_fix_from_checkpoint=args.needs_fix_from_checkpoint,
            )

    requested_checkpoint = args.checkpoint or result.new_checkpoint or ""
    if args.json:
        write_result_json(
            result,
            feature=feature,
            checkpoint=requested_checkpoint,
            dry_run=args.dry_run,
            skip_nodes=args.skip_node or None,
        )
    elif not result.ok:
        print("checkpoint 更新失败:", file=sys.stderr)
        for error in result.errors:
            print(f"  - {error}", file=sys.stderr)
    elif args.dry_run:
        print(f"DRY_RUN checkpoint update: feature={feature} checkpoint={requested_checkpoint}")
        print("--- state.json ---")
        print(result.state_json_content, end="")
        print("--- STATE.md ---")
        print(result.content, end="")
    elif args.skip_node:
        print(
            f"workflow nodes skipped: feature={feature} nodes={','.join(args.skip_node)} "
            f"checkpoint={result.new_checkpoint}"
        )
    else:
        print(f"checkpoint updated: feature={feature} checkpoint={args.checkpoint}")

    def _write_logs() -> None:
        if args.skip_node:
            write_skip_hook_logs(result, workspace=workspace, feature=feature, skip_nodes=args.skip_node)
        else:
            write_hook_logs(result, workspace=workspace, feature=feature)

    if not result.ok:
        if not args.dry_run:
            _write_logs()
        return 1
    if not args.dry_run:
        write_state_records_preserving_raw(workspace, result.records, raw_records=result.raw_records)
        _write_logs()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
