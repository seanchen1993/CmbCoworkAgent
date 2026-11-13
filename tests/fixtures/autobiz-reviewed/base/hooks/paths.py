#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Path helpers for autobizdevops workspace bootstrap hooks."""

import os
from pathlib import Path
from typing import Iterable, Mapping, Optional, Union


PathLike = Union[str, Path]


STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR = (
    "状态读写脚本不接受 --workspace/-w；请删除该参数，路径由 PLUGIN_WORKSPACE/PROJECT_DIR 环境变量决定。"
)


def contains_workspace_argument(args: Iterable[str]) -> bool:
    for arg in args:
        if arg in {"--workspace", "-w"}:
            return True
        if arg.startswith("--workspace="):
            return True
        if arg.startswith("-w") and arg != "-w":
            return True
    return False


def _env_value(values: Mapping[str, str], name: str) -> str:
    return str(values.get(name, "") or "").strip()


def resolve_project_dir(values: Mapping[str, str]) -> str:
    """项目目录名：优先 PROJECT_DIR，回退旧变量 PROJECT_CODE（平台过渡期兼容）。"""
    return _env_value(values, "PROJECT_DIR") or _env_value(values, "PROJECT_CODE")


def _validate_plugin_output_workspace(
    plugin_workspace_raw: str,
    project_code: str,
    *,
    plugin_workspace_name: str,
    project_name: str,
    missing_suffix: str = "",
) -> Path:
    missing = [
        name
        for name, value in (
            (plugin_workspace_name, plugin_workspace_raw),
            (project_name, project_code),
        )
        if not value
    ]
    if missing:
        raise ValueError(f"{', '.join(missing)} 未设置{missing_suffix}")
    if "/" in project_code or "\\" in project_code:
        raise ValueError(f"{project_name} 不能包含路径分隔符: {project_code}")

    plugin_workspace = Path(plugin_workspace_raw).expanduser().resolve(strict=False)
    if not plugin_workspace.is_dir():
        raise ValueError(f"{plugin_workspace_name} 指向的目录不存在: {plugin_workspace}")

    workspace = (plugin_workspace / project_code).resolve(strict=False)
    if not workspace.is_dir():
        raise ValueError(f"{project_name} 对应的项目插件目录不存在: {workspace}")

    state_json_path = workspace / ".autobizdevops" / "state.json"
    if not state_json_path.is_file():
        raise ValueError(f"state.json 未找到: {state_json_path}")
    return workspace


def get_plugin_output_workspace(env: Optional[Mapping[str, str]] = None) -> Path:
    values = os.environ if env is None else env
    return _validate_plugin_output_workspace(
        _env_value(values, "PLUGIN_WORKSPACE"),
        resolve_project_dir(values),
        plugin_workspace_name="PLUGIN_WORKSPACE",
        project_name="PROJECT_DIR",
        missing_suffix="；状态脚本必须由插件环境提供 PLUGIN_WORKSPACE 和 PROJECT_DIR",
    )


def get_plugin_output_workspace_from_args(
    plugin_workspace: Optional[PathLike],
    project: Optional[str],
) -> Path:
    """通过显式 CLI 参数定位项目插件目录，不读取进程环境变量。"""
    return _validate_plugin_output_workspace(
        str(plugin_workspace or "").strip(),
        str(project or "").strip(),
        plugin_workspace_name="--plugin-workspace",
        project_name="--project",
    )


def resolve_env_feature(
    feature: Optional[str],
    *,
    required: bool,
    env: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    values = os.environ if env is None else env
    provided = (feature or "").strip()
    env_feature = _env_value(values, "FEATURE_ID")

    if required and not env_feature:
        raise ValueError("FEATURE_ID 未设置；当前 Feature 必须由插件环境提供")
    if provided and env_feature and provided != env_feature:
        raise ValueError(f"--feature 与 FEATURE_ID 不一致: --feature={provided} FEATURE_ID={env_feature}")
    if provided:
        return provided
    if env_feature:
        return env_feature
    if required:
        raise ValueError("feature 不能为空")
    return None


def get_workspace(workspace: Optional[PathLike] = None) -> Path:
    if workspace is None:
        return Path.cwd().resolve()
    return Path(workspace).resolve()


def get_autobizdevops_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_workspace(workspace) / ".autobizdevops"


def get_features_active_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "features"


def get_feature_active_dir(workspace: Optional[PathLike], feature: str) -> Path:
    return get_features_active_dir(workspace) / feature


def get_feature_hook_log_path(workspace: Optional[PathLike], feature: str) -> Path:
    return get_feature_active_dir(workspace, feature) / "hooks.ndjson"


def get_features_archive_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "archive"


def get_issues_active_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "issues" / "active"


def get_issues_completed_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "issues" / "completed"


def get_reviews_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "review"


def get_logs_dir(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "logs"


def get_state_md_path(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "STATE.md"


def get_state_json_path(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "state.json"


def get_project_md_path(workspace: Optional[PathLike] = None) -> Path:
    return get_autobizdevops_dir(workspace) / "PROJECT.md"


def get_sys_agents_md_path(system_no: str, workspace: Optional[PathLike] = None) -> Path:
    return get_workspace(workspace) / "sys" / system_no / "AGENTS.md"


def ensure_dir(path: PathLike) -> Path:
    resolved = Path(path)
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def is_initialized(workspace: Optional[PathLike] = None) -> bool:
    ws = get_workspace(workspace)
    return (
        get_autobizdevops_dir(ws).exists()
        and get_project_md_path(ws).exists()
        and get_state_json_path(ws).exists()
    )
