#!/usr/bin/env python3
"""Read and write the Feature-level implementation scope contract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.artifact_paths import resolve_exact_relative_path  # noqa: E402
from hooks.json_writer_common import (  # noqa: E402
    atomic_write_json,
    resolve_feature,
    resolve_workspace,
    write_text,
)
from hooks.paths import get_features_active_dir  # noqa: E402


SCOPE_FILENAME = "IMPLEMENTATION_SCOPE.json"
SCOPE_SPLIT_FILENAME = "SCOPE_SPLIT.md"
VALID_SCOPES = frozenset({"full_stack", "backend_only", "frontend_only"})
DEFAULT_SCOPE = "full_stack"


def scope_path(feature_dir: Path) -> Path:
    return feature_dir / SCOPE_FILENAME


def scope_split_path(feature_dir: Path) -> Path:
    return feature_dir / SCOPE_SPLIT_FILENAME


def _scope_split_template(scope: str) -> str:
    if scope == "backend_only":
        kept = ["API、数据、权限、状态流和后端自动化验证"]
        deferred = ["页面布局、前端交互、前端路由和视觉回检"]
    elif scope == "frontend_only":
        kept = ["页面结构、前端交互、展示状态和前端自动化验证"]
        deferred = ["后端 API 实现、数据迁移、后端权限和审计逻辑"]
    else:
        kept = ["前端与后端的完整交付"]
        deferred = ["无"]
    return "\n".join([
        "# Scope Split",
        "",
        "## 当前实现范围",
        "",
        scope,
        "",
        "## 本轮保留",
        "",
        *[f"- {item}" for item in kept],
        "",
        "## 剥离到后续",
        "",
        *[f"- {item}" for item in deferred],
        "",
    ])


def validate_scope_payload(payload: Any, *, feature: str | None = None) -> list[str]:
    if not isinstance(payload, dict):
        return ["implementation_scope_root_must_be_object"]
    scope = payload.get("implementationScope")
    errors: list[str] = []
    if scope not in VALID_SCOPES:
        errors.append("implementationScope_invalid")
    if feature is not None and payload.get("featureId") != feature:
        errors.append("implementationScope_feature_mismatch")
    source = payload.get("source")
    if not isinstance(source, str) or not source.strip():
        errors.append("implementationScope_source_missing")
    return errors


def load_scope(feature_dir: Path, *, required: bool = False) -> tuple[str, list[str]]:
    """Return (scope, errors); absent legacy scopes default to full_stack."""

    path = scope_path(feature_dir)
    if not path.is_file():
        if required:
            return DEFAULT_SCOPE, ["implementation_scope_missing"]
        return DEFAULT_SCOPE, []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return DEFAULT_SCOPE, [f"implementation_scope_unreadable:{exc}"]
    errors = validate_scope_payload(payload, feature=feature_dir.name)
    return str(payload.get("implementationScope", DEFAULT_SCOPE)), errors


OWNED_SCOPE_FIELDS = frozenset({"version", "featureId", "implementationScope", "source"})


def _preserved_fields(path: Path) -> dict[str, Any]:
    """Keep fields other writers own (partition refs) across a scope rewrite."""

    if not path.is_file():
        return {}
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(existing, dict):
        return {}
    return {key: value for key, value in existing.items() if key not in OWNED_SCOPE_FIELDS}


def write_scope(feature_dir: Path, scope: str, *, source: str = "user_confirmed") -> Path:
    if scope not in VALID_SCOPES:
        raise ValueError(f"implementationScope must be one of: {', '.join(sorted(VALID_SCOPES))}")
    feature_dir.mkdir(parents=True, exist_ok=True)
    path = scope_path(feature_dir)
    atomic_write_json(
        path,
        {
            "version": 1,
            "featureId": feature_dir.name,
            "implementationScope": scope,
            "source": source,
            # A scope rewrite must not silently drop the round's included/deferred
            # partition; see hooks/plan_scope.py.
            **_preserved_fields(path),
        },
    )
    split_path = scope_split_path(feature_dir)
    if not split_path.exists():
        write_text(split_path, _scope_split_template(scope))
    return path


def resolve_feature_dir(feature: str, workspace: Path) -> Path:
    features_dir = get_features_active_dir(workspace)
    resolved = resolve_exact_relative_path(features_dir, feature)
    if resolved is None or not resolved.is_dir():
        raise ValueError(f"Feature 目录不存在: {features_dir / feature}")
    return resolved


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="管理 Feature 实现范围契约")
    subparsers = parser.add_subparsers(dest="command", required=True)

    set_parser = subparsers.add_parser("set")
    set_parser.add_argument("--feature", "-f")
    set_parser.add_argument("--scope", required=True, choices=sorted(VALID_SCOPES))
    set_parser.add_argument("--source", default="user_confirmed")

    for name in ("show", "validate"):
        command = subparsers.add_parser(name)
        command.add_argument("--feature", "-f")

    args = parser.parse_args(argv)
    try:
        workspace = resolve_workspace()
        feature = resolve_feature(args.feature)
        feature_dir = resolve_feature_dir(feature, workspace)
        if args.command == "set":
            path = write_scope(feature_dir, args.scope, source=args.source)
            print(json.dumps({"ok": True, "path": str(path), "implementationScope": args.scope}, ensure_ascii=False))
            return 0
        path = scope_path(feature_dir)
        if not path.is_file():
            if args.command == "show":
                print(json.dumps({"ok": True, "implementationScope": DEFAULT_SCOPE, "source": "legacy_default"}, ensure_ascii=False))
                return 0
            print(json.dumps({"ok": False, "errors": ["implementation_scope_missing"]}, ensure_ascii=False))
            return 1
        payload = json.loads(path.read_text(encoding="utf-8"))
        errors = validate_scope_payload(payload, feature=feature)
        result = {"ok": not errors, **payload}
        if errors:
            result["errors"] = errors
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if not errors else 1
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "errors": [str(exc)]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())
