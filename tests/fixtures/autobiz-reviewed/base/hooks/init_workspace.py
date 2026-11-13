#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
autobizdevops Workspace 初始化脚本
用法:
    python hooks/init_workspace.py --mode createProject --workspace <workspace> --project <project>
    python hooks/init_workspace.py --mode createFeature --workspace <workspace> --project <project> --feature <feature>
    python hooks/init_workspace.py --mode createFeature --workspace <workspace> --project <project> --feature <feature> --workflow-nodes '["dev.specs","dev.code"]'
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from paths import (
        ensure_dir,
        get_autobizdevops_dir,
        get_features_active_dir,
        get_features_archive_dir,
        get_feature_active_dir,
        get_issues_active_dir,
        get_issues_completed_dir,
        get_project_md_path,
        get_state_json_path,
        get_state_md_path,
        get_workspace,
        is_initialized,
    )
except ImportError:
    sys.path.insert(0, str(Path(__file__).parent))
    from paths import (  # type: ignore[no-redef]
        ensure_dir,
        get_autobizdevops_dir,
        get_features_active_dir,
        get_features_archive_dir,
        get_feature_active_dir,
        get_issues_active_dir,
        get_issues_completed_dir,
        get_project_md_path,
        get_state_json_path,
        get_state_md_path,
        get_workspace,
        is_initialized,
    )

from board_core.contracts import (  # noqa: E402
    BoardConfigError,
    load_board_config,
    load_record_workflow_contracts,
)
from board_core.state_store import (  # noqa: E402
    EMPTY_CELL,
    check_or_fix_state_sync,
    parse_state_md_records,
    render_state_md,
    state_json_content_from_records,
    write_state_records_preserving_raw,
)
from board_core.workflow_closure import solve_node_closure  # noqa: E402
from board_core.workflow_compiler import (  # noqa: E402
    BASE_WORKFLOW_PROFILE,
    BASE_WORKFLOW_TEMPLATE,
    WorkflowCompileError,
    configured_workflow_templates,
    normalize_workflow_profile,
    normalize_workflow_template,
)

BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"


def _generate_project_md(workspace_name: str) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"""# Project Metadata

- **Project Name**: {workspace_name}
- **Initialized At**: {now}
- **Skill Version**: autobizdevops v1.1.0
- **Schema Version**: 1

## Workflow Defaults

- **Auto Mode**: false (默认手动推进)

## Notes

- 本文件由 autobizdevops 初始化时自动生成
- 其他流程控制以各阶段 `SKILL.md` 与 `.autobizdevops/state.json` 为准；`.autobizdevops/STATE.md` 为自动生成视图
"""


def _generate_state_md() -> str:
    return render_state_md({})


def _generate_state_json() -> str:
    return state_json_content_from_records({})


def _generate_state_json_from_state_md(state_md: Path) -> str:
    if not state_md.is_file():
        return _generate_state_json()

    records, errors = parse_state_md_records(state_md.read_text(encoding="utf-8", errors="ignore"))
    if errors:
        return _generate_state_json()
    return state_json_content_from_records(records)


def _write_if_missing(path: Path, content: str, created: List[str]) -> None:
    if path.exists():
        return
    path.write_text(content, encoding="utf-8")
    created.append(str(path))


def _is_skill_root(path: Path) -> bool:
    """判断当前目录是否为 skill 自身根目录（含 hooks/init_workspace.py 与 SKILL.md）"""
    return (
        (path / "hooks" / "init_workspace.py").exists()
        and (path / "SKILL.md").exists()
    )


def init_workspace(workspace: Path, force: bool = False) -> Dict[str, object]:
    result = {
        "initialized": False,
        "created": [],
        "backup": None,
        "message": "",
    }

    workspace = workspace.resolve()
    # 如果传入的是 skill 自身根目录，自动退到父目录作为 workspace
    if _is_skill_root(workspace):
        workspace = workspace.parent
    abdo_dir = get_autobizdevops_dir(workspace)
    was_initialized = is_initialized(workspace)

    if abdo_dir.exists() and force:
        backup_name = f"{abdo_dir.name}_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        backup_path = abdo_dir.parent / backup_name
        abdo_dir.rename(backup_path)
        result["backup"] = str(backup_path)

    dirs = [
        get_features_active_dir(workspace),
        get_features_archive_dir(workspace),
        get_issues_active_dir(workspace),
        get_issues_completed_dir(workspace)
    ]
    for directory in dirs:
        if not directory.exists():
            ensure_dir(directory)
            result["created"].append(str(directory))
        else:
            ensure_dir(directory)

    project_md = get_project_md_path(workspace)
    _write_if_missing(project_md, _generate_project_md(workspace.name or "untitled"), result["created"])

    state_json = get_state_json_path(workspace)
    state_md = get_state_md_path(workspace)
    _write_if_missing(state_json, _generate_state_json_from_state_md(state_md), result["created"])
    _write_if_missing(state_md, _generate_state_md(), result["created"])
    check_or_fix_state_sync(workspace, fix=True)

    result["initialized"] = is_initialized(workspace)
    if result["backup"]:
        result["message"] = f"Workspace re-initialized successfully at {abdo_dir}"
    elif result["created"]:
        result["message"] = f"Workspace initialized successfully at {abdo_dir}"
    elif was_initialized:
        result["message"] = f"Workspace already initialized: {abdo_dir}"
    else:
        result["message"] = f"Workspace bootstrap checked: {abdo_dir}"
    return result


def _resolve_target_workspace(workspace: Path, project: Optional[str] = None) -> Path:
    workspace = workspace.resolve()
    if _is_skill_root(workspace):
        workspace = workspace.parent
    if not project:
        return workspace

    project_workspace = (workspace / project).resolve()
    try:
        project_workspace.relative_to(workspace)
    except ValueError:
        print(f"ERROR: Project path escapes workspace: {project}", file=sys.stderr)
        sys.exit(1)
    return project_workspace


def _resolve_feature_dir(workspace: Path, feature: str) -> Path:
    feature = feature.strip()
    if not feature:
        print("ERROR: Feature is required for createFeature mode", file=sys.stderr)
        sys.exit(1)
    if "\0" in feature:
        print("ERROR: Feature contains invalid characters", file=sys.stderr)
        sys.exit(1)

    features_dir = get_features_active_dir(workspace).resolve()
    feature_dir = get_feature_active_dir(workspace, feature).resolve()
    try:
        feature_dir.relative_to(features_dir)
    except ValueError:
        print(f"ERROR: Feature path escapes features directory: {feature}", file=sys.stderr)
        sys.exit(1)
    if feature_dir == features_dir:
        print("ERROR: Feature resolves to features directory itself", file=sys.stderr)
        sys.exit(1)
    return feature_dir


def _parse_workflow_nodes(raw_value: str) -> list[str]:
    try:
        value = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(
            "--workflow-nodes must be a JSON list, e.g. '[\"dev.specs\",\"dev.code\"]'"
        ) from exc

    if not isinstance(value, list):
        raise argparse.ArgumentTypeError("--workflow-nodes must be a JSON list of node ids")

    nodes: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise argparse.ArgumentTypeError("--workflow-nodes must contain only non-empty string node ids")
        nodes.append(item.strip())
    return nodes


def create_feature(
    workspace: Path,
    feature: str,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    *,
    workflow_template: str = BASE_WORKFLOW_TEMPLATE,
    workflow_nodes: list[str] | None = None,
) -> Dict[str, object]:
    workspace = workspace.resolve()
    workflow_profile = normalize_workflow_profile(workflow_profile)
    workflow_template = normalize_workflow_template(workflow_template)
    feature_dir = _resolve_feature_dir(workspace, feature)
    if feature_dir.exists():
        print(f"ERROR: 特性已存在：{feature_dir}", file=sys.stderr)
        sys.exit(1)

    record: Dict[str, object] = {
        "feature": feature,
        "owner": EMPTY_CELL,
        "iteration": EMPTY_CELL,
        "workflowProfile": workflow_profile,
        "workflowDecisions": {},
        "workflowTemplate": workflow_template,
    }
    if workflow_template != BASE_WORKFLOW_TEMPLATE and workflow_profile != BASE_WORKFLOW_PROFILE:
        print(f"ERROR: workflow template {workflow_template} 不支持 workflowProfile={workflow_profile}", file=sys.stderr)
        sys.exit(1)
    try:
        base_config = load_board_config(BOARD_CONFIG_PATH)
        template_registry = configured_workflow_templates(base_config)
        template_spec = template_registry.get(workflow_template)
        if template_spec is None:
            known = " / ".join(sorted(template_registry))
            print(f"ERROR: workflow template 已不可用于新建 Feature: {workflow_template}; 可用模板: {known}", file=sys.stderr)
            sys.exit(1)
        effective_nodes = list(workflow_nodes or [])
        for required_id in template_spec.get("requiredNodes", []):
            if required_id not in effective_nodes:
                effective_nodes.append(required_id)
        if effective_nodes:
            closure = solve_node_closure(base_config, effective_nodes)
            record["workflowNodes"] = list(closure.nodes)
        contracts = load_record_workflow_contracts(ROOT, record, workspace=workspace)
    except (BoardConfigError, WorkflowCompileError) as exc:
        print(f"ERROR: workflow template 无法编译: {exc}", file=sys.stderr)
        sys.exit(1)

    initial_checkpoint = next(
        (
            checkpoint
            for node in contracts.nodes
            for checkpoint in node.get("checkpoints", [])
            if checkpoint in contracts.initial_checkpoints
        ),
        "",
    )
    if not initial_checkpoint:
        print("ERROR: workflow template 没有可用的初始 checkpoint", file=sys.stderr)
        sys.exit(1)
    record["checkpoint"] = initial_checkpoint
    record["stage"] = contracts.stage_labels.get(initial_checkpoint, "")

    sync_result = check_or_fix_state_sync(workspace, fix=True)
    if not sync_result.state_exists:
        print(f"ERROR: Workspace 未初始化，缺少 state.json: {get_state_json_path(workspace)}", file=sys.stderr)
        sys.exit(1)
    if sync_result.errors:
        print("ERROR: 状态文件异常:", file=sys.stderr)
        for error in sync_result.errors:
            print(f"  - {error}", file=sys.stderr)
        sys.exit(1)
    if feature in sync_result.records or feature in sync_result.raw_records:
        print(f"ERROR: Feature 已存在于 state.json: {feature}", file=sys.stderr)
        sys.exit(1)

    ensure_dir(feature_dir)

    record["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    records = {slug: dict(existing) for slug, existing in sync_result.records.items()}
    records[feature] = record
    write_state_records_preserving_raw(workspace, records, raw_records=sync_result.raw_records)

    return {
        "initialized": feature_dir.is_dir(),
        "created": [str(feature_dir)],
        "backup": None,
        "message": f"Feature created successfully: {feature_dir}",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize autobizdevops workspace")
    parser.add_argument("--mode", choices=("createProject", "createFeature"), default="createProject")
    parser.add_argument("--workspace", required=True, help="Workspace path")
    parser.add_argument("--project", help="Project code under workspace")
    parser.add_argument("--feature", help="Feature name for createFeature mode")
    parser.add_argument("--workflow-profile", default=BASE_WORKFLOW_PROFILE, help="Workflow profile for createFeature")
    parser.add_argument(
        "--workflow-template",
        default=BASE_WORKFLOW_TEMPLATE,
        help="Workflow template for createFeature: standard",
    )
    parser.add_argument(
        "--workflow-nodes",
        default=None,
        type=_parse_workflow_nodes,
        help="JSON list of node ids, e.g. '[\"dev.specs\",\"dev.code\"]'",
    )
    parser.add_argument(
        "--selected-deployUnit",
        dest="selected_deploy_units",
        default="",
        help=(
            "占位参数：UI 在 createFeature 勾选的部署单元（JSON 数组字符串）。"
            "当前仅接收以保证命令可解析，不落库（沿用「选择不落库」决策），"
            "由 session_context_inject 在会话期现传消费。"
        ),
    )
    parser.add_argument("--force", action="store_true", help="Force re-initialization (will backup existing)")
    args = parser.parse_args()

    workspace = _resolve_target_workspace(Path(args.workspace), args.project)
    if not workspace.exists():
        print(f"ERROR: Workspace does not exist: {workspace}", file=sys.stderr)
        sys.exit(1)

    if args.mode == "createFeature":
        result = create_feature(
            workspace,
            args.feature or "",
            args.workflow_profile,
            workflow_template=args.workflow_template,
            workflow_nodes=args.workflow_nodes or None,
        )
    else:
        result = init_workspace(workspace, force=args.force)

    print(result["message"])
    if result["backup"]:
        print(f"Backup created: {result['backup']}")
    if result["created"]:
        print("Created files/directories:")
        for item in result["created"]:
            print(f"  - {item}")

    sys.exit(0 if result["initialized"] else 1)


if __name__ == "__main__":
    main()
