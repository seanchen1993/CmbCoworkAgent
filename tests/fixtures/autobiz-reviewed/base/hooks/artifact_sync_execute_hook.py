#!/usr/bin/env python3
"""Post-execute trigger for best-effort Feature artifact synchronization."""

from __future__ import annotations

import json
import re
import shlex
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.artifact_sync import schedule_current_checkpoint_sync_best_effort  # noqa: E402
from hooks.paths import get_plugin_output_workspace, resolve_env_feature  # noqa: E402


SUCCESS_MARKER = re.compile(r"\[Command succeeded with exit code 0(?:\]|,)")


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def first_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            return " ".join(str(item) for item in value).strip()
    return ""


def command_words(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def command_variants(command: str) -> list[str]:
    variants = [command]
    tokens = command_words(command)
    for index, token in enumerate(tokens):
        if token in {"-c", "-lc"} and index + 1 < len(tokens):
            variants.append(tokens[index + 1])
    return variants


def extract_tool_input(payload: dict[str, Any]) -> dict[str, Any]:
    return as_dict(payload.get("tool_input") or payload.get("input"))


def extract_command(payload: dict[str, Any]) -> str:
    tool_input = extract_tool_input(payload)
    return first_text(
        tool_input.get("command"),
        tool_input.get("cmd"),
        tool_input.get("script"),
        payload.get("command"),
        payload.get("cmd"),
    )


def has_option(tokens: list[str], *names: str) -> bool:
    for token in tokens:
        for name in names:
            if token == name or token.startswith(name + "="):
                return True
    return False


def is_checkpoint_update_command(command: str) -> bool:
    for variant in command_variants(command):
        tokens = command_words(variant)
        if not any(Path(token).name == "update_checkpoint.py" for token in tokens):
            continue
        if has_option(tokens, "--dry-run"):
            continue
        if has_option(tokens, "--checkpoint", "-c", "--skip-node"):
            return True
    return False


def tool_succeeded(response: Any) -> bool:
    if isinstance(response, dict):
        for name in ("exitCode", "exit_code", "returncode"):
            value = response.get(name)
            if isinstance(value, int):
                return value == 0
        success = response.get("success")
        if isinstance(success, bool):
            return success
        return tool_succeeded(response.get("output") or response.get("result"))
    if isinstance(response, str):
        return bool(SUCCESS_MARKER.search(response))
    return False


def run_hook(payload: dict[str, Any]) -> None:
    if payload.get("hook_event_name") != "PostToolUse":
        return
    if payload.get("tool_name") != "execute":
        return
    tool_input = extract_tool_input(payload)
    if tool_input.get("run_in_background") is True:
        return
    command = extract_command(payload)
    if not command or not is_checkpoint_update_command(command):
        return
    if not tool_succeeded(payload.get("tool_response")):
        return

    workspace = get_plugin_output_workspace()
    feature = resolve_env_feature(None, required=True)
    schedule_current_checkpoint_sync_best_effort(
        workspace=workspace,
        feature=feature,
    )


def main() -> int:
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        return 0
    try:
        payload = json.loads(raw_input)
        if isinstance(payload, dict):
            run_hook(payload)
    except Exception as exc:
        print(f"产物同步 PostToolUse hook 执行失败但不阻断命令: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
