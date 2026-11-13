#!/usr/bin/env python3
"""Request a Human Gate before an Auto feature advances past technical design.

This is a synchronous ``PreToolUse(execute)`` hook.  It emits a Human Gate
decision only for a real ``update_checkpoint.py --checkpoint design_done``
invocation; every other execute command, including a dry run, remains a no-op.
The platform keeps the command unexecuted until the user approves the gate.
"""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Any


DESIGN_DONE_CHECKPOINT = "design_done"
SYSTEM_MESSAGE = "请确认技术设计产物无误，再将该阶段推进为完成！"


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def command_words(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def command_variants(command: str) -> list[str]:
    """Include the command passed to common shell ``-c`` / ``-lc`` wrappers."""
    variants = [command]
    normalized = command.replace("\\", "/")
    if normalized != command:
        variants.append(normalized)
    for candidate in tuple(variants):
        tokens = command_words(candidate)
        for index, token in enumerate(tokens):
            if token in {"-c", "-lc"} and index + 1 < len(tokens):
                variants.append(tokens[index + 1])
    return variants


def is_update_checkpoint_script(token: str) -> bool:
    return token.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] == "update_checkpoint.py"


def option_value(tokens: list[str], *names: str) -> str | None:
    for index, token in enumerate(tokens):
        for name in names:
            if token == name:
                return tokens[index + 1] if index + 1 < len(tokens) else None
            if token.startswith(name + "="):
                return token[len(name) + 1 :]
    return None


def has_option(tokens: list[str], *names: str) -> bool:
    return any(token == name or token.startswith(name + "=") for token in tokens for name in names)


def is_design_done_checkpoint_command(command: str) -> bool:
    for variant in command_variants(command):
        tokens = command_words(variant)
        if not any(is_update_checkpoint_script(token) for token in tokens):
            continue
        if has_option(tokens, "--dry-run"):
            continue
        checkpoint = option_value(tokens, "--checkpoint", "-c")
        if checkpoint == DESIGN_DONE_CHECKPOINT:
            return True
    return False


def extract_command(payload: dict[str, Any]) -> str:
    tool_input = as_dict(payload.get("tool_input") or payload.get("input"))
    for value in (
        tool_input.get("command"),
        tool_input.get("cmd"),
        tool_input.get("script"),
        payload.get("command"),
        payload.get("cmd"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def should_request_human_gate(payload: dict[str, Any]) -> bool:
    if payload.get("tool_name") not in (None, "execute"):
        return False
    return is_design_done_checkpoint_command(extract_command(payload))


def main() -> int:
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        return 0
    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError:
        return 0
    if isinstance(payload, dict) and should_request_human_gate(payload):
        json.dump(
            {"decision": "human_gate", "systemMessage": SYSTEM_MESSAGE},
            sys.stdout,
            ensure_ascii=False,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
