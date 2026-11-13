#!/usr/bin/env python3
"""Resolve the next action for a feature checkpoint from the effective workflow."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.contracts import load_record_workflow_contracts, load_repo_workflow_contracts  # noqa: E402
from board_core.state_store import get_state_json_path, load_state_json_records_result  # noqa: E402
from board_core.workflow import (  # noqa: E402
    derive_node_status,
    find_effective_current_node,
    skippable_node_ids,
)
from board_core.workflow_compiler import (  # noqa: E402
    BASE_WORKFLOW_PROFILE,
    BASE_WORKFLOW_TEMPLATE,
    ENABLED_WORKFLOW_DECISION,
    SKIPPED_WORKFLOW_DECISION,
    WorkflowCompileError,
    configured_dynamic_stages,
    configured_profile_options,
    configured_skip_policy,
    load_effective_board_config,
    load_record_effective_board_config,
    normalize_workflow_decisions,
    normalize_workflow_skipped_nodes,
    normalize_workflow_template,
    read_json,
)


BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"
PROFILE_CHOICE_CHECKPOINT = "prd_done"


def _state_next_action(node: dict, node_status: str) -> dict[str, str]:
    for state in node.get("states", []):
        if isinstance(state, dict) and state.get("nodeStatus", state.get("id")) == node_status:
            action = state.get("nextAction", {})
            return action if isinstance(action, dict) else {}
    return {}


def _profile_options() -> list[dict[str, str]]:
    return configured_profile_options(read_json(BOARD_CONFIG_PATH))


def _allowed_next(config: dict, checkpoint: str) -> list[str]:
    transitions = config.get("workflow", {}).get("checkpoints", {}).get("transitions", {})
    if not isinstance(transitions, dict):
        return []
    targets = transitions.get(checkpoint, [])
    if not isinstance(targets, list):
        return []
    return [target for target in targets if isinstance(target, str)]


def _recommended_next_skill(
    workspace: Path,
    workflow_profile: str,
    allowed_next: list[str],
    workflow_decisions: dict[str, str] | None = None,
) -> str:
    if not allowed_next:
        return ""
    try:
        contracts = load_repo_workflow_contracts(
            ROOT,
            workspace=workspace,
            profile=workflow_profile,
            workflow_decisions=workflow_decisions,
        )
    except Exception:
        return ""
    for checkpoint in allowed_next:
        skill = contracts.start_checkpoint_to_skill.get(checkpoint)
        if skill:
            return skill
    return ""


def _recommended_next_skill_for_record(workspace: Path, record: dict, allowed_next: list[str]) -> str:
    if not allowed_next:
        return ""
    try:
        contracts = load_record_workflow_contracts(ROOT, record, workspace=workspace)
    except Exception:
        return ""
    for checkpoint in allowed_next:
        skill = contracts.start_checkpoint_to_skill.get(checkpoint)
        if skill:
            return skill
    return ""


def _profile_choice_payload(workspace: Path, checkpoint: str) -> list[dict[str, object]]:
    choices: list[dict[str, object]] = []
    if checkpoint != PROFILE_CHOICE_CHECKPOINT:
        return choices
    for option in _profile_options():
        profile = option["id"]
        try:
            config = load_effective_board_config(
                BOARD_CONFIG_PATH,
                repo_root=ROOT,
                workspace=workspace,
                profile=profile,
            )
        except Exception:
            continue
        allowed_next = _allowed_next(config, checkpoint)
        choices.append({
            **option,
            "allowedNextCheckpoints": allowed_next,
            "recommendedNextSkill": _recommended_next_skill(workspace, profile, allowed_next),
        })
    return choices


def _pending_dynamic_stage(checkpoint: str, workflow_decisions: dict[str, str]) -> dict | None:
    for stage in configured_dynamic_stages(read_json(BOARD_CONFIG_PATH)):
        if stage["choiceCheckpoint"] != checkpoint:
            continue
        if stage["id"] in workflow_decisions:
            continue
        if stage["defaultDecision"] == "skip":
            continue
        return stage
    return None


def _workflow_choice_payload(
    workspace: Path,
    workflow_profile: str,
    workflow_decisions: dict[str, str],
    checkpoint: str,
) -> list[dict[str, object]]:
    stage = _pending_dynamic_stage(checkpoint, workflow_decisions)
    if stage is None:
        return []

    choices: list[dict[str, object]] = []
    for decision, label_key, description_key, target_key in (
        (ENABLED_WORKFLOW_DECISION, "enableLabel", "enableDescription", "enableTargetCheckpoint"),
        (SKIPPED_WORKFLOW_DECISION, "skipLabel", "skipDescription", "skipTargetCheckpoint"),
    ):
        next_decisions = {**workflow_decisions, stage["id"]: decision}
        target = stage[target_key]
        allowed_next: list[str] = []
        try:
            config = load_effective_board_config(
                BOARD_CONFIG_PATH,
                repo_root=ROOT,
                workspace=workspace,
                profile=workflow_profile,
                workflow_decisions=next_decisions,
            )
            allowed_next = _allowed_next(config, checkpoint)
        except Exception:
            allowed_next = []
        choices.append({
            "id": decision,
            "stageId": stage["id"],
            "stageLabel": stage["label"],
            "decision": decision,
            "label": stage[label_key],
            "description": stage[description_key],
            "targetCheckpoint": target,
            "allowedNextCheckpoints": allowed_next,
            "recommendedNextSkill": _recommended_next_skill(
                workspace,
                workflow_profile,
                [target],
                next_decisions,
            ),
        })
    return choices


def resolve_route(workspace: Path, feature: str) -> tuple[dict, int]:
    workspace = workspace.resolve()
    result = load_state_json_records_result(workspace)
    errors = list(result.fatal_errors)
    if not result.exists:
        errors.append(f"state.json 未找到: {get_state_json_path(workspace)}")
    record = result.records.get(feature)
    if record is None:
        errors.extend(result.record_errors.get(feature, []))
    if record is None and not errors:
        errors.append(f"feature '{feature}' 未在 state.json 中找到")
    if errors or record is None:
        return {"ok": False, "feature": feature, "errors": errors}, 1

    workflow_profile = record.get("workflowProfile", BASE_WORKFLOW_PROFILE)
    workflow_template = normalize_workflow_template(record.get("workflowTemplate"))
    try:
        workflow_decisions = normalize_workflow_decisions(record.get("workflowDecisions", {}))
    except WorkflowCompileError as exc:
        return {
            "ok": False,
            "feature": feature,
            "workflowProfile": workflow_profile,
            "workflowTemplate": workflow_template,
            "checkpoint": record.get("checkpoint", ""),
            "errors": [f"workflowDecisions 无效: {exc}"],
        }, 1
    checkpoint = record.get("checkpoint", "")
    try:
        config = load_record_effective_board_config(
            BOARD_CONFIG_PATH,
            repo_root=ROOT,
            workspace=workspace,
            record=record,
        )
    except Exception as exc:
        return {
            "ok": False,
            "feature": feature,
            "workflowProfile": workflow_profile,
            "workflowTemplate": workflow_template,
            "workflowDecisions": workflow_decisions,
            "checkpoint": checkpoint,
            "errors": [str(exc)],
        }, 1

    nodes = config["workflow"]["nodes"]
    current_idx, current_node_id = find_effective_current_node(
        nodes,
        checkpoint,
        record.get("needsFixFromCheckpoint"),
        stage=record.get("stage"),
        stage_labels=config["workflow"]["checkpoints"]["stageLabels"],
    )
    if current_idx < 0:
        return {
            "ok": False,
            "feature": feature,
            "workflowProfile": workflow_profile,
            "workflowTemplate": workflow_template,
            "workflowDecisions": workflow_decisions,
            "checkpoint": checkpoint,
            "errors": [f"未知 checkpoint: {checkpoint}"],
        }, 1

    node_status = derive_node_status(
        current_idx,
        current_idx,
        checkpoint,
        nodes[current_idx],
        config["checkpointSuffixState"],
    )
    next_action = _state_next_action(nodes[current_idx], node_status)
    allowed_next = _allowed_next(config, checkpoint)
    # Subset templates have a fixed chain: no profile or dynamic-stage choices.
    is_standard_template = workflow_template == BASE_WORKFLOW_TEMPLATE
    profile_choices = _profile_choice_payload(workspace, checkpoint) if is_standard_template else []
    workflow_choices = (
        _workflow_choice_payload(workspace, workflow_profile, workflow_decisions, checkpoint)
        if is_standard_template
        else []
    )
    workflow_skipped = normalize_workflow_skipped_nodes(record.get("workflowSkippedNodes"))
    try:
        skip_policy = configured_skip_policy(read_json(BOARD_CONFIG_PATH))
        skippable = skippable_node_ids(list(nodes), checkpoint, locked_nodes=skip_policy["lockedNodes"])
    except WorkflowCompileError:
        skippable = []
    return {
        "ok": True,
        "feature": feature,
        "workflowProfile": workflow_profile,
        "workflowTemplate": workflow_template,
        "workflowDecisions": workflow_decisions,
        "workflowSkippedNodes": list(workflow_skipped),
        "checkpoint": checkpoint,
        "currentNodeId": current_node_id,
        "currentNodeStatus": node_status,
        "currentStateId": node_status,
        "allowedNextCheckpoints": allowed_next,
        "recommendedNextSkill": (
            "" if checkpoint == "needs_fix"
            else _recommended_next_skill_for_record(workspace, record, allowed_next)
        ),
        "requiresProfileChoice": checkpoint == PROFILE_CHOICE_CHECKPOINT and len(profile_choices) > 1,
        "profileChoices": profile_choices,
        "requiresWorkflowChoice": bool(workflow_choices),
        "workflowChoices": workflow_choices,
        "skippableNodes": skippable,
        "nextAction": next_action,
    }, 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resolve next workflow action for a feature")
    parser.add_argument("--workspace", "-w", required=True)
    parser.add_argument("--feature", "-f", required=True)
    args = parser.parse_args(argv)

    payload, exit_code = resolve_route(Path(args.workspace), args.feature)
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
