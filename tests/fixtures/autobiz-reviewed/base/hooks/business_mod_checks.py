"""Resolve registered business-Mod checks without executing code during discovery.

Checks run only from the normal, approved artifact postcheck. A business module
cannot replace built-in validators or load Python from the shared kernel paths.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

from board_core.contracts import load_record_workflow_contracts, load_repo_workflow_contracts


def resolve_check(repo_root: Path, workspace_root: Path | None, skill: str,
                  validator: str, *, workflow_profile: str = "standard",
                  workflow_decisions: dict | None = None,
                  workflow_record: dict | None = None) -> tuple[Path, str]:
    contracts = (
        load_record_workflow_contracts(repo_root, workflow_record, workspace=workspace_root)
        if workflow_record else load_repo_workflow_contracts(
            repo_root, workspace=workspace_root, profile=workflow_profile,
            workflow_decisions=workflow_decisions)
    )
    node = next((item for item in contracts.nodes if item.get("skill") == skill), None)
    if not node or validator != f"business:{node['id']}":
        raise ValueError(f"unregistered business validator: {skill}:{validator}")
    binding = node.get("validatorBindings", {}).get(validator)
    if not isinstance(binding, dict) or set(binding) != {"path", "function"}:
        raise ValueError(f"invalid validator binding: {validator}")
    relative = binding.get("path")
    function = binding.get("function")
    if not isinstance(relative, str) or "\\" in relative:
        raise ValueError("validator path must be a portable relative path")
    parts = Path(relative).parts
    if (Path(relative).is_absolute() or ".." in parts
            or len(parts) < 4 or parts[:3] != ("mods", "business", node["id"])
            or not relative.endswith(".py")
            or not isinstance(function, str) or not re.fullmatch(r"[A-Za-z_]\w*", function)):
        raise ValueError("validator must belong to its business module namespace")
    root = repo_root.resolve()
    path = root.joinpath(*parts)
    for parent in (path, *path.parents):
        if parent == root:
            break
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise ValueError("validator links are not allowed")
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise ValueError("validator file is missing or outside the plugin")
    return path, function


def run_check(path: Path, function: str, feature_dir: Path) -> list[str]:
    spec = importlib.util.spec_from_file_location("_autobiz_business_check", path)
    if spec is None or spec.loader is None:
        raise ValueError("cannot load business validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checker = getattr(module, function, None)
    if not callable(checker):
        raise ValueError("business validator function is missing")
    result = checker(feature_dir)
    if not isinstance(result, list) or any(not isinstance(item, str) for item in result):
        raise ValueError("business validator must return a list of error strings")
    return result
