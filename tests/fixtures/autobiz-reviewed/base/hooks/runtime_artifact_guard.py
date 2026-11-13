#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PreToolUse ownership guard for Runtime-owned Feature artifacts."""

from __future__ import print_function

import json
import os
import re
import shlex
import sys
from pathlib import Path


PROTECTED_ROOT_FILES = {
    "ARTIFACT_CATALOG.json",
    "FIX_REQUEST.json",
    "PLAN.md",
    "UNIT_TEST_RESULT.json",
    "VERIFY_DECISION.json",
    "plan.json",
}
PROTECTED_RUNTIME_FILES = {
    "CRITIC_REVIEWS.jsonl",
}
PROTECTED_EVIDENCE_FILES = {"EVIDENCE.jsonl", "EVIDENCE.index.json"}
PROTECTED_STATE_FILES = {"state.json"}
PROTECTED_DRAFT_MARKER = ".tmp/plan_writer/draft"
MUTATING_COMMANDS = {
    "cp", "dd", "install", "mv", "perl", "rm", "sed", "tee", "touch", "truncate",
}


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def _tool_input(payload):
    return _as_dict(payload.get("tool_input") or payload.get("input"))


def _workspace_root():
    plugin_workspace = str(os.environ.get("PLUGIN_WORKSPACE", "") or "").strip()
    project = str(os.environ.get("PROJECT_DIR", "") or os.environ.get("PROJECT_CODE", "") or "").strip()
    if not plugin_workspace or not project or "/" in project or "\\" in project:
        return None
    return (Path(plugin_workspace).expanduser() / project).resolve(strict=False)


def _feature_root():
    workspace = _workspace_root()
    feature = str(os.environ.get("FEATURE_ID", "") or "").strip()
    if workspace is None or not feature:
        return None
    return (workspace / ".autobizdevops" / "features" / feature).resolve(strict=False)


def _is_under(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def protected_path(raw_path):
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    raw = raw_path.strip()
    workspace = _workspace_root()
    feature = _feature_root()
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (Path.cwd() / candidate).resolve(strict=False)
    else:
        candidate = candidate.resolve(strict=False)
    candidate_parts = candidate.parts
    if (
        candidate.name in PROTECTED_RUNTIME_FILES
        and ".runtime" in candidate_parts
    ):
        return True
    if PROTECTED_DRAFT_MARKER in candidate.as_posix():
        return True
    if all(part in candidate_parts for part in (".autobizdevops", "features")):
        if candidate.name in PROTECTED_ROOT_FILES | PROTECTED_EVIDENCE_FILES:
            return True
    if workspace is not None and candidate == workspace / ".autobizdevops" / "state.json":
        return True
    if feature is None or not _is_under(candidate, feature):
        return False
    relative = candidate.relative_to(feature)
    parts = relative.parts
    if len(parts) == 1 and parts[0] in PROTECTED_ROOT_FILES:
        return True
    if len(parts) == 3 and parts[0] == "plans" and parts[2] == "plan.json":
        return True
    if len(parts) >= 2 and parts[0] == ".runtime" and parts[-1] in PROTECTED_RUNTIME_FILES:
        return True
    if len(parts) >= 3 and parts[:3] == (".tmp", "plan_writer", "draft"):
        return True
    if len(parts) == 2 and parts[0] == "evidence" and parts[1] in PROTECTED_EVIDENCE_FILES:
        return True
    return False


def _candidate_paths(tool_input):
    for key in ("filePath", "file_path", "path", "targetPath", "target_path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            yield value


def _command(tool_input, payload):
    for value in (
        tool_input.get("command"), tool_input.get("cmd"), tool_input.get("script"),
        payload.get("command"), payload.get("cmd"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _words(command):
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def _mentions_protected_artifact(command):
    markers = PROTECTED_ROOT_FILES | PROTECTED_RUNTIME_FILES | PROTECTED_EVIDENCE_FILES | PROTECTED_STATE_FILES
    return PROTECTED_DRAFT_MARKER in command.replace("\\", "/") or any(
        marker in command for marker in markers
    )


def _missing_context():
    missing = []
    if not str(os.environ.get("PLUGIN_WORKSPACE", "") or "").strip():
        missing.append("PLUGIN_WORKSPACE")
    if not str(os.environ.get("PROJECT_DIR", "") or os.environ.get("PROJECT_CODE", "") or "").strip():
        missing.append("PROJECT_DIR")
    if not str(os.environ.get("FEATURE_ID", "") or "").strip():
        missing.append("FEATURE_ID")
    return missing


def _guard_reason(reason):
    missing = _missing_context()
    if not missing:
        return reason
    return "RUNTIME_ARTIFACT_GUARD_CONTEXT_MISSING: missing={}; 已按产物路径特征阻断。{}".format(
        ",".join(missing), reason
    )


def _mutates(command):
    words = _words(command)
    executable = Path(words[0]).name.lower() if words else ""
    mutators = {Path(item).name.lower() for item in words} & MUTATING_COMMANDS
    if mutators - {"sed"}:
        return True
    if "sed" in mutators and any(item == "-i" or item.startswith("-i") for item in words[1:]):
        return True
    if executable in {"python", "python3", "node", "ruby", "bash", "sh", "zsh"}:
        return True
    return bool(re.search(r"(?:^|[\s;&|])(?:[012]?>>?)\s*\S", command))


def guard(payload):
    tool_name = str(payload.get("tool_name") or payload.get("toolName") or "")
    tool_input = _tool_input(payload)
    if tool_name in {"write_file", "edit_file", "apply_patch", "Write", "Edit"}:
        for path in _candidate_paths(tool_input):
            if protected_path(path):
                return _guard_reason(
                    "RUNTIME_ARTIFACT_OWNED: {} 只能由对应 Runtime writer 生成；修复：调用 hooks 下的专用 writer/runner。".format(path)
                )
    if tool_name.lower() in {"execute", "bash", "shell"}:
        command = _command(tool_input, payload)
        if not command:
            return None
        words = _words(command)
        if "evidence_store" in command or any(
            Path(token).name == "evidence_store.py" for token in words
        ):
            return _guard_reason(
                "RUNTIME_ARTIFACT_OWNED: 禁止直接 append Evidence；修复：使用 task/test runner 记录真实执行。"
            )
        if _mentions_protected_artifact(command) and _mutates(command):
            return _guard_reason(
                "RUNTIME_ARTIFACT_OWNED: 命令将修改 Runtime-owned 产物；修复：使用对应 Runtime writer/runner。"
            )
    return None


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    reason = guard(payload)
    if reason:
        print(reason)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
