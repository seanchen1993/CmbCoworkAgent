#!/usr/bin/env python3
"""AutoBizDevOps inspect adapter — translates plugin state into board JSON.

Usage:
    python inspect_state.py --workspace <path> --mode run --project <name> --feature <slug>
    python inspect_state.py --workspace <path> --mode project --projects <name1> [name2 ...]

Protocol: skill-board-inspect-protocol.md
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
HOOKS_DIR = ROOT / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from board_core.artifacts import scan_artifacts  # type: ignore[import-untyped]
from board_core.contracts import artifact_dicts  # type: ignore[import-untyped]
from board_core.state_store import check_or_fix_state_sync, state_rows_from_records  # type: ignore[import-untyped]
from board_core.workflow_compiler import (  # type: ignore[import-untyped]
    BASE_WORKFLOW_PROFILE,
    BASE_WORKFLOW_TEMPLATE,
    load_effective_board_config,
    load_record_effective_board_config,
    normalize_workflow_decisions,
    normalize_workflow_profile,
    normalize_workflow_skipped_nodes,
    normalize_workflow_template,
)
from board_core.state import (  # type: ignore[import-untyped]
    find_feature_dir,
)
from board_core.workflow import (  # type: ignore[import-untyped]
    derive_current_node_status,
    derive_current_node_status_label,
    build_workflow_shell,
    derive_node_status,
    find_effective_current_node,
    node_status_label,
)


BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"
BASE_WORKFLOW_ID = "base"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_board_config() -> dict:
    if not BOARD_CONFIG_PATH.is_file():
        print(f"board_config.json not found: {BOARD_CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    return json.loads(BOARD_CONFIG_PATH.read_text(encoding="utf-8"))


def _load_effective_config(workspace: Path, profile: str, workflow_decisions: dict[str, str] | None = None) -> dict:
    return load_effective_board_config(
        BOARD_CONFIG_PATH,
        repo_root=ROOT,
        workspace=workspace,
        profile=profile,
        workflow_decisions=workflow_decisions,
    )


def _load_record_config(workspace: Path, record: dict) -> dict:
    return load_record_effective_board_config(
        BOARD_CONFIG_PATH,
        repo_root=ROOT,
        workspace=workspace,
        record=record,
    )


def workflow_marker(
    profile: str,
    decisions: object | None,
    template: str | None = None,
    workflow_nodes: object | None = None,
    workflow_skipped: object | None = None,
) -> tuple[str, str, dict[str, str]]:
    workflow_profile = normalize_workflow_profile(profile)
    workflow_decisions = normalize_workflow_decisions(decisions)
    workflow_template = normalize_workflow_template(template)
    workflow_skipped_nodes = normalize_workflow_skipped_nodes(workflow_skipped)
    sorted_decisions = {
        stage_id: workflow_decisions[stage_id]
        for stage_id in sorted(workflow_decisions)
    }

    def _with_skips(marker: str) -> str:
        # Distinct marker per skip set so project mode caches one workflow
        # shell per effective chain.
        if not workflow_skipped_nodes:
            return marker
        skip_parts = [node_id.replace(".", "-") for node_id in workflow_skipped_nodes]
        return "__".join([marker, "skip", *skip_parts])

    if workflow_template != BASE_WORKFLOW_TEMPLATE:
        marker = workflow_template
        if isinstance(workflow_nodes, list) and workflow_nodes:
            node_parts = [str(node_id).replace(".", "-") for node_id in workflow_nodes]
            marker = "__".join([workflow_template, *node_parts])
        return _with_skips(marker), workflow_profile, sorted_decisions
    if workflow_profile == BASE_WORKFLOW_PROFILE and not sorted_decisions:
        return _with_skips(BASE_WORKFLOW_ID), workflow_profile, sorted_decisions
    if not sorted_decisions:
        return _with_skips(workflow_profile), workflow_profile, sorted_decisions
    decision_parts = [
        f"{stage_id}_{decision}"
        for stage_id, decision in sorted_decisions.items()
    ]
    return _with_skips("__".join([workflow_profile, *decision_parts])), workflow_profile, sorted_decisions


def _feature_ref_dir(workspace: Path, feature: str, feature_dir: Path | None) -> str:
    if feature_dir is not None:
        try:
            return feature_dir.resolve().relative_to(workspace.resolve()).as_posix()
        except ValueError:
            pass
    return f".autobizdevops/features/{feature}"


def _watch_refs(workspace: Path, feature: str, feature_dir: Path | None = None) -> list[dict]:
    feature_ref_dir = _feature_ref_dir(workspace, feature, feature_dir)
    return [
        {"path": ".autobizdevops/state.json", "purpose": "run-state"},
        {"path": ".autobizdevops/STATE.md", "purpose": "run-state-view"},
        {"path": feature_ref_dir, "purpose": "artifacts"},
        {"path": f"{feature_ref_dir}/hooks.ndjson", "purpose": "hook-log"},
    ]


def _hook_log_refs(workspace: Path, feature: str, feature_dir: Path | None = None) -> list[dict]:
    feature_ref_dir = _feature_ref_dir(workspace, feature, feature_dir)
    return [
        {"id": "default", "path": f"{feature_ref_dir}/hooks.ndjson", "format": "ndjson"},
    ]


def build_run_context(workspace: Path, feature: str, config: dict) -> tuple[dict, dict]:
    """Build the Feature Status payload plus the effective config it was built from.

    ``config`` is the baseline board config.  A record that selects a profile,
    template, dynamic stage or node skip compiles its own effective workflow
    here.  Callers that look nodes up by ``skill`` / ``states`` /
    ``runtimePolicy`` — session context resolving its runtime policy, for one —
    must use the returned config: nodes inserted by profiles and dynamic stages
    are not reachable through the baseline one.
    """
    sync_result = check_or_fix_state_sync(workspace, fix=True)
    state_records = sync_result.records
    state_record_errors: list[str] = []
    record = state_records.get(feature, {})
    workflow_profile = record.get("workflowProfile", BASE_WORKFLOW_PROFILE)
    workflow_template = normalize_workflow_template(record.get("workflowTemplate"))
    workflow_decisions = normalize_workflow_decisions(record.get("workflowDecisions", {}))
    workflow_skipped = normalize_workflow_skipped_nodes(record.get("workflowSkippedNodes"))
    if (
        workflow_profile != BASE_WORKFLOW_PROFILE
        or workflow_decisions
        or workflow_template != BASE_WORKFLOW_TEMPLATE
        or workflow_skipped
    ):
        config = _load_record_config(workspace, record)
    nodes_config = config["workflow"]["nodes"]
    suffix_states = config["checkpointSuffixState"]

    # Read state.json; STATE.md is repaired as a generated view when needed.
    state_rows = state_rows_from_records(state_records)
    state_errors = [
        *sync_result.errors,
        *sync_result.record_errors.get(feature, []),
    ]
    state_exists = sync_result.state_exists
    checkpoint = state_rows.get(feature)
    archive_iteration = record.get("iteration") if checkpoint == "archived" else None
    feature_dir = find_feature_dir(
        workspace,
        feature,
        archive_iteration=archive_iteration,
    )
    has_feature_dir = feature_dir is not None

    # Determine initial degraded state message
    summary_parts: list[str] = []
    if not state_exists:
        summary_parts.append("state.json 未找到，project 尚未初始化")
    elif not state_rows and not state_errors:
        summary_parts.append("state.json 中无 feature 记录")
    elif not state_rows and state_errors:
        # State parsing filtered all rows due to errors (e.g. unknown checkpoint)
        # state_errors will be appended below, don't add a generic "无记录" message
        pass
    elif checkpoint is None:
        summary_parts.append(f"feature '{feature}' 未在 state.json 中找到")
    if state_errors:
        summary_parts.extend(state_errors)
    if state_record_errors:
        summary_parts.extend(state_record_errors)

    # If there's no checkpoint, degrade gracefully: best-effort scan
    current_idx, current_node_id = -1, None
    if checkpoint:
        current_idx, current_node_id = find_effective_current_node(
            nodes_config,
            checkpoint,
            record.get("needsFixFromCheckpoint"),
            stage=record.get("stage"),
            stage_labels=config["workflow"]["checkpoints"]["stageLabels"],
        )

    if current_idx < 0 and checkpoint:
        summary_parts.append(f"未知 checkpoint '{checkpoint}'，adapter 无法映射到流程节点")

    # Build nodes
    run_nodes: list[dict] = []
    for idx, node in enumerate(nodes_config):
        node_status = derive_node_status(idx, current_idx, checkpoint or "", node, suffix_states)
        artifacts = scan_artifacts(
            feature_dir or (workspace / ".autobizdevops" / "features" / feature),
            workspace,
            artifact_dicts(node, "outputs"),
        )
        if checkpoint == "archived":
            archived_label = suffix_states["archived"]["label"]
            for artifact in artifacts:
                if artifact.get("artifactStatus") == "generated":
                    artifact["artifactStatusLabel"] = archived_label
        run_nodes.append({
            "id": node["id"],
            "nodeStatus": node_status,
            "nodeStatusLabel": node_status_label(node_status, node),
            "artifacts": artifacts,
        })

    workflow_id, _, _ = workflow_marker(
        workflow_profile,
        workflow_decisions,
        workflow_template,
        record.get("workflowNodes"),
        workflow_skipped,
    )

    # Assemble output
    output = {
        "workflow": build_workflow_shell(config),
        "run": {
            "featureId": feature,
            "featureName": feature,
            "workflowProfile": workflow_profile,
            "workflowTemplate": workflow_template,
            "workflowId": workflow_id,
            "workflowDecisions": workflow_decisions,
            "hookLogRefs": _hook_log_refs(workspace, feature, feature_dir),
            "watchRefs": _watch_refs(workspace, feature, feature_dir),
            "currentNodeId": current_node_id or "unknown",
            "nodes": run_nodes,
        },
    }
    if workflow_skipped:
        output["run"]["workflowSkippedNodes"] = list(workflow_skipped)

    return output, config


def build_run_payload(workspace: Path, feature: str, config: dict) -> dict:
    """Build the Feature Status payload used by both CLI and session context."""
    payload, _effective_config = build_run_context(workspace, feature, config)
    return payload


def run_mode(workspace: Path, feature: str, config: dict) -> int:
    """Handle --mode run."""
    payload = build_run_payload(workspace, feature, config)
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


def _resolve_project_workspace(workspace: Path, project: str) -> Path:
    project_workspace = (workspace / project).resolve()
    try:
        project_workspace.relative_to(workspace)
    except ValueError:
        print(f"project 路径越界: {project}", file=sys.stderr)
        sys.exit(1)
    return project_workspace


def _collect_project_runs(
    project_workspace: Path,
    config: dict,
) -> list[dict]:
    """返回某个 project 下所有 feature 的 runs 摘要列表。"""
    nodes_config = config["workflow"]["nodes"]
    suffix_states = config["checkpointSuffixState"]

    sync_result = check_or_fix_state_sync(project_workspace, fix=True)
    state_records = sync_result.records
    # Keep malformed records visible in the project overview.  State
    # normalization intentionally omits them from ``records`` so callers that
    # need a valid checkpoint can fail safely, but hiding the feature entirely
    # makes the board unable to surface a state.json repair problem.
    feature_names = sorted(set(state_records) | set(sync_result.raw_records))

    runs: list[dict] = []
    for feature in feature_names:
        record = state_records.get(feature)
        if record is None:
            # An invalid checkpoint (or another invalid record field) cannot
            # be routed reliably.  Preserve the feature in project status and
            # use the neutral default workflow with an unknown current state.
            runs.append({
                "featureName": feature,
                "featureId": feature,
                "currentNodeId": "unknown",
                "currentNodeStatus": "unknown",
                "currentNodeStatusLabel": "未知",
                "nodeIds": [node["id"] for node in config["workflow"]["nodes"]],
            })
            continue

        workflow_template = normalize_workflow_template(record.get("workflowTemplate"))
        workflow_skipped = normalize_workflow_skipped_nodes(record.get("workflowSkippedNodes"))
        workflow_id, _workflow_profile, _workflow_decisions = workflow_marker(
            record.get("workflowProfile", BASE_WORKFLOW_PROFILE),
            record.get("workflowDecisions", {}),
            workflow_template,
            record.get("workflowNodes"),
            workflow_skipped,
        )
        run_config = config
        if workflow_id != BASE_WORKFLOW_ID:
            run_config = _load_record_config(project_workspace, record)
        nodes_config = run_config["workflow"]["nodes"]
        suffix_states = run_config["checkpointSuffixState"]
        checkpoint = record.get("checkpoint", "")
        current_idx, current_node_id = (-1, None)
        if checkpoint:
            current_idx, current_node_id = find_effective_current_node(
                nodes_config,
                checkpoint,
                record.get("needsFixFromCheckpoint"),
                stage=record.get("stage"),
                stage_labels=run_config["workflow"]["checkpoints"]["stageLabels"],
            )

        current_node_status = derive_current_node_status(checkpoint, suffix_states, current_idx)
        current_node = nodes_config[current_idx] if 0 <= current_idx < len(nodes_config) else None
        current_node_status_label = derive_current_node_status_label(
            checkpoint,
            suffix_states,
            current_idx,
            current_node,
        )

        run_summary = {
            "featureName": feature,
            "featureId": feature,
            "currentNodeId": current_node_id or "unknown",
            "currentNodeStatus": current_node_status,
            "currentNodeStatusLabel": current_node_status_label,
            "nodeIds": [node["id"] for node in nodes_config],
        }
        if workflow_template != BASE_WORKFLOW_TEMPLATE:
            run_summary["workflowTemplate"] = workflow_template
        if workflow_skipped:
            run_summary["workflowSkippedNodes"] = list(workflow_skipped)
        runs.append(run_summary)

    return runs


def project_mode(workspace: Path, projects: list[str], config: dict) -> int:
    """Handle --mode project with one or more projects."""
    all_projects: dict[str, dict] = {}
    for project in projects:
        project_workspace = _resolve_project_workspace(workspace, project)
        if not project_workspace.is_dir():
            print(f"project 不存在: {project_workspace}", file=sys.stderr)
            continue
        runs = _collect_project_runs(project_workspace, config)
        all_projects[project] = {"runs": runs}

    output = {
        "workflow": build_workflow_shell(config),
        "projects": all_projects,
    }

    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoBizDevOps Inspect Adapter")
    parser.add_argument("--workspace", required=True, help="项目集合工作区路径")
    parser.add_argument("--mode", required=True, choices=("project", "run"), help="inspect mode")
    parser.add_argument("--feature", default=None, help="feature slug (required for run mode)")
    parser.add_argument("--project", default=None, help="project name (required for --mode run)")
    parser.add_argument("--projects", nargs="+", default=None,
                        help="one or more project names (for --mode project)")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    if not workspace.is_dir():
        print(f"workspace 不存在: {workspace}", file=sys.stderr)
        return 1

    config = _load_board_config()

    if args.mode == "run":
        if not args.project:
            print("--mode run 需要 --project 参数", file=sys.stderr)
            return 1
        if not args.feature:
            print("--mode run 需要 --feature 参数", file=sys.stderr)
            return 1
        project_workspace = _resolve_project_workspace(workspace, args.project)
        if not project_workspace.is_dir():
            print(f"project 不存在: {project_workspace}", file=sys.stderr)
            return 1
        return run_mode(project_workspace, args.feature, config)

    if not args.projects:
        print("--mode project 需要 --projects 参数", file=sys.stderr)
        return 1
    return project_mode(workspace, args.projects, config)


if __name__ == "__main__":
    raise SystemExit(main())
