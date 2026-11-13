#!/usr/bin/env python3
"""Resolve the next workflow skill from the plugin-provided session context."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.route_checkpoint import resolve_route  # noqa: E402
from hooks.paths import (  # noqa: E402
    contains_workspace_argument,
    get_plugin_output_workspace,
    resolve_env_feature,
)


CONTEXT_ARGUMENT_ERROR = (
    "resolve_next_skill.py 不接受 --workspace/-w 或 --feature/-f；"
    "路径和 Feature 由 PLUGIN_WORKSPACE/PROJECT_DIR/FEATURE_ID 环境变量决定。"
)


def _contains_feature_argument(args: list[str]) -> bool:
    return any(
        arg in {"--feature", "-f"}
        or arg.startswith("--feature=")
        or (arg.startswith("-f") and arg != "-f")
        for arg in args
    )


def _print_text(payload: dict) -> None:
    if not payload.get("ok"):
        print("NEXT_SKILL_FAIL")
        for error in payload.get("errors", []):
            print(f"- {error}")
        return

    print(f"feature: {payload.get('feature', '')}")
    print(f"checkpoint: {payload.get('checkpoint', '')}")
    print(f"workflowProfile: {payload.get('workflowProfile', '')}")
    recommended = payload.get("recommendedNextSkill") or payload.get("nextAction", {}).get("slashSkill", "")
    print(f"recommendedNextSkill: {recommended or 'none'}")
    allowed = payload.get("allowedNextCheckpoints", [])
    print("allowedNextCheckpoints: " + (", ".join(allowed) if allowed else "none"))
    if payload.get("requiresProfileChoice"):
        print("requiresProfileChoice: true")
        for choice in payload.get("profileChoices", []):
            print(
                "- "
                + f"{choice.get('id')}: {choice.get('label')} "
                + f"-> {choice.get('recommendedNextSkill') or 'none'}"
            )
    if payload.get("requiresWorkflowChoice"):
        print("requiresWorkflowChoice: true")
        for choice in payload.get("workflowChoices", []):
            print(
                "- "
                + f"{choice.get('stageId')}={choice.get('decision')}: {choice.get('label')} "
                + f"-> {choice.get('recommendedNextSkill') or 'none'}"
            )


def main(argv: list[str] | None = None) -> int:
    raw_args = list(sys.argv[1:] if argv is None else argv)
    if contains_workspace_argument(raw_args) or _contains_feature_argument(raw_args):
        print(CONTEXT_ARGUMENT_ERROR, file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="Resolve next workflow skill for the current Feature",
        allow_abbrev=False,
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args(raw_args)

    try:
        workspace = get_plugin_output_workspace()
        feature = resolve_env_feature(None, required=True)
    except ValueError as exc:
        payload = {"ok": False, "errors": [f"下一技能解析失败: {exc}"]}
        if args.json:
            json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
            print()
        else:
            _print_text(payload)
        return 1

    payload, exit_code = resolve_route(workspace, feature)
    if args.json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        _print_text(payload)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
