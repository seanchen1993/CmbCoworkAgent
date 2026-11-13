#!/usr/bin/env python3
"""Allow validation commands in a Batch worktree only during its UTest stage.

The fixed Code Workflow gives backend implementation a production-only
compile gate before task completion; behavioral tests and other validation
belong to UTest. Prompt wording is not sufficient by itself: an implementation
or review agent can still run broader commands. This pre-tool hook identifies
active Code task worktrees and fixed-workflow Batch worktrees. A Batch may run
validation only after Review passed and while its durable ``test`` stage is
running; all other Batch stages, including Review, are blocked.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Any


ACTIVE_CODE_RUN_STATUSES = frozenset({"started", "in_progress", "implementation_recording"})

# Keep this focused on executable validation entrypoints rather than generic
# commands such as git or package-manager inspection.
FORBIDDEN_COMMAND_RE = re.compile(
    r"(?:"
    r"(?<![\w.-])(?:mvn|mvnw(?:\.cmd)?|gradle|gradlew(?:\.bat)?)(?![\w.-])"
    r"|(?<![\w.-])(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:(?:run|exec)\s+)?(?:build|compile|typecheck|lint|test|check)(?![\w.-])"
    r"|(?<![\w.-])(?:npx\s+)?(?:vite|webpack|tsc|vue-tsc|eslint|jest|vitest|pytest)(?![\w.-])"
    r"|(?<![\w.-])go\s+(?:build|test|vet)(?![\w.-])"
    r"|(?<![\w.-])cargo\s+(?:build|check|test|clippy)(?![\w.-])"
    r")",
    re.IGNORECASE,
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _tool_input(payload: dict[str, Any]) -> dict[str, Any]:
    return _as_dict(payload.get("tool_input") or payload.get("input"))


def _command(payload: dict[str, Any], tool_input: dict[str, Any]) -> str:
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


def _workspace_root() -> Path | None:
    plugin_workspace = str(os.environ.get("PLUGIN_WORKSPACE", "") or "").strip()
    project = str(os.environ.get("PROJECT_DIR", "") or os.environ.get("PROJECT_CODE", "") or "").strip()
    if not plugin_workspace or not project or "/" in project or "\\" in project:
        return None
    return (Path(plugin_workspace).expanduser() / project).resolve(strict=False)


def _feature_dir() -> Path | None:
    workspace = _workspace_root()
    feature = str(os.environ.get("FEATURE_ID", "") or "").strip()
    if workspace is None or not feature:
        return None
    return workspace / ".autobizdevops" / "features" / feature


def _normalize_path(raw: Any) -> str:
    if not isinstance(raw, str):
        return ""
    return raw.strip().strip('"').strip("'").replace("\\", "/").rstrip("/").casefold()


def _active_code_workspaces() -> dict[str, str]:
    feature_dir = _feature_dir()
    if feature_dir is None:
        return {}

    active: dict[str, str] = {}
    for run_path in feature_dir.glob(".task-runs/*/*.json"):
        try:
            state = json.loads(run_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(state, dict) or state.get("status") not in ACTIVE_CODE_RUN_STATUSES:
            continue
        identity = "{}:{}".format(
            state.get("taskId", run_path.parent.name),
            state.get("runId", run_path.stem),
        )
        candidates = [state.get("codeWorkspace")]
        for key in ("requestedCodeWorkspaces", "resolvedGitRoots"):
            value = state.get(key)
            if isinstance(value, list):
                candidates.extend(value)
        for candidate in candidates:
            normalized = _normalize_path(candidate)
            if normalized:
                active[normalized] = identity
    return active


def _parallel_batch_workspaces() -> dict[str, dict[str, str | bool]]:
    """Return fixed-workflow Batch worktrees and their durable test authority.

    ``task_runner.py finish-implementation`` deliberately completes the Code
    task before Review begins. Looking only at ``.task-runs`` therefore leaves
    a gap in Review. The parallel manifest is the durable authority for the
    Batch stage, including across agent restarts.
    """
    feature_dir = _feature_dir()
    if feature_dir is None:
        return {}

    batches_by_workspace: dict[str, dict[str, str | bool]] = {}
    for manifest_path in feature_dir.glob(".parallel-runs/*/manifest.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        run_id = str(manifest.get("runId") or manifest_path.parent.name)
        batches = manifest.get("batches")
        if not isinstance(batches, dict):
            continue
        for batch_id, batch in batches.items():
            if not isinstance(batch, dict):
                continue
            workspace = _normalize_path(batch.get("worktreePath"))
            if not workspace:
                continue
            states = _as_dict(batch.get("stageStates"))
            review = _as_dict(states.get("review"))
            test = _as_dict(states.get("test"))
            batches_by_workspace[workspace] = {
                "identity": f"{run_id}:{batch_id}",
                "testRunning": (
                    review.get("status") == "passed"
                    and test.get("status") == "running"
                ),
                "stage": str(batch.get("activeStage") or "none"),
            }
    return batches_by_workspace


def _command_workspace_matches(
    payload: dict[str, Any], tool_input: dict[str, Any], command: str, workspace: str
) -> bool:
    normalized_command = command.replace("\\", "/").casefold()
    if workspace in normalized_command:
        return True
    for candidate in (
        tool_input.get("cwd"),
        tool_input.get("workdir"),
        tool_input.get("workingDirectory"),
        payload.get("cwd"),
        payload.get("workdir"),
    ):
        normalized = _normalize_path(candidate)
        if normalized == workspace or normalized.startswith(workspace + "/"):
            return True
    return False


def _is_backend_production_compile(command: str) -> bool:
    """Recognize a narrow compile-only command allowed during Code TASKs."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    if not tokens:
        return False
    executable = Path(tokens[0]).name.casefold()
    if executable in {"bash", "sh", "zsh"}:
        command_index = next(
            (index + 1 for index, token in enumerate(tokens[:-1]) if token in {"-c", "-lc", "-cl"}),
            None,
        )
        if command_index is None:
            return False
        return _is_backend_production_compile(tokens[command_index])

    executable = executable.removesuffix(".cmd").removesuffix(".bat")
    if executable in {"mvn", "mvnw"}:
        goals: set[str] = set()
        skip_next = False
        value_options = {"-f", "--file", "-pl", "--projects", "-P", "--define", "-s", "--settings", "-t", "--toolchains"}
        for token in tokens[1:]:
            if skip_next:
                skip_next = False
                continue
            if token in value_options:
                skip_next = True
                continue
            if not token.startswith("-"):
                goals.add(token)
        return "compile" in goals and goals <= {"compile", "clean"}
    if executable in {"gradle", "gradlew"}:
        tasks = {token.rsplit(":", 1)[-1] for token in tokens[1:] if not token.startswith("-")}
        return bool(tasks) and tasks <= {
            "classes", "compileJava", "compileKotlin", "compileGroovy", "compileScala"
        }
    if executable == "go":
        return len(tokens) >= 2 and tokens[1] == "build" and not any(
            token in {"test", "vet", "run", "install"} for token in tokens[1:]
        )
    if executable == "cargo":
        return len(tokens) >= 2 and tokens[1] == "check" and not any(
            token in {"test", "build", "clippy", "bench"} for token in tokens[1:]
        )
    return False


def guard(payload: dict[str, Any]) -> str | None:
    """Return a blocking reason unless validation is authorized by UTest."""
    tool_name = str(payload.get("tool_name") or payload.get("toolName") or "").lower()
    if tool_name not in {"execute", "bash", "shell"}:
        return None
    tool_input = _tool_input(payload)
    command = _command(payload, tool_input)
    if not command or not FORBIDDEN_COMMAND_RE.search(command):
        return None
    if _is_backend_production_compile(command):
        for workspace in _active_code_workspaces():
            if _command_workspace_matches(payload, tool_input, command, workspace):
                return None
    for workspace, batch in _parallel_batch_workspaces().items():
        if not _command_workspace_matches(payload, tool_input, command, workspace):
            continue
        if batch["testRunning"] is True:
            return None
        return (
            "BATCH_STAGE_VALIDATION_FORBIDDEN: Batch {identity} 当前阶段为 {stage}；"
            "构建、编译、typecheck、lint、测试和 E2E 命令仅允许在 Review 已通过且 test 阶段正在运行时执行。"
        ).format(**batch)
    for workspace, run_identity in _active_code_workspaces().items():
        if _command_workspace_matches(payload, tool_input, command, workspace):
            return (
                "CODE_EXECUTION_VALIDATION_FORBIDDEN: 活动 Code task run {} 的 worktree 禁止执行构建、编译、"
                "typecheck、lint、测试或 E2E 命令（后端 production-only compile 除外）；"
                "其余验证由 Review 通过后的 UTest 阶段运行。"
            ).format(run_identity)
    return None


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
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
