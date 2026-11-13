"""State loading + feature directory lookup.

The public function names are kept for compatibility, but state is now loaded
from .autobizdevops/state.json first. STATE.md is a generated view.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Tuple

from hooks.paths import (
    get_features_active_dir,
    get_features_archive_dir,
)
from board_core.state_store import (
    check_or_fix_state_sync,
    state_rows_from_records,
)


StateResult = Tuple[Dict[str, str], List[str], bool]  # rows, errors, file_exists
StateRecordsResult = Tuple[Dict[str, Dict[str, Any]], List[str], bool]


def load_state_md(workspace: Path) -> StateResult:
    """读取状态并返回 (feature→checkpoint 映射, 错误列表, 文件是否存在)。

    兼容旧函数名；实际以 state.json 为主，并按需重生 STATE.md。
    """
    result = check_or_fix_state_sync(workspace, fix=True)
    return state_rows_from_records(result.records), result.errors, result.state_exists


def load_state_rows(workspace: Path) -> dict[str, str]:
    """快速读取 feature→checkpoint 映射，忽略错误。

    与 load_state_md 的区别：不返回错误列表，适用于不需要精确错误的场景。
    """
    result = check_or_fix_state_sync(workspace, fix=True)
    if result.errors:
        return {}
    return state_rows_from_records(result.records)


def load_state_records(workspace: Path) -> StateRecordsResult:
    """读取完整 feature 状态记录。

    以 state.json 为主，额外保留迭代等 project 看板需要的列。
    """
    result = check_or_fix_state_sync(workspace, fix=True)
    return result.records, result.errors, result.state_exists


def list_active_feature_names(workspace: Path) -> list[str]:
    """Return active feature directory names under .autobizdevops/features."""
    active = get_features_active_dir(workspace)
    if not active.is_dir():
        return []
    return sorted(entry.name for entry in active.iterdir() if entry.is_dir())


def find_feature_dir(
    workspace: Path,
    feature: str,
    archive_iteration: object | None = None,
) -> Path | None:
    """Return the active directory or the selected archived iteration."""
    active = get_features_active_dir(workspace) / feature
    if active.is_dir():
        return active
    archive_base = get_features_archive_dir(workspace)
    if archive_base.is_dir():
        iteration = str(archive_iteration or "").strip()
        if iteration not in {"", "-", "—"}:
            selected_archive = archive_base / f"{feature}-iter{iteration}"
            return selected_archive if selected_archive.is_dir() else None
        exact_archive = archive_base / feature
        if exact_archive.is_dir():
            return exact_archive
        for entry in sorted(archive_base.iterdir()):
            if entry.is_dir() and entry.name.startswith(f"{feature}-iter"):
                return entry
    return None
