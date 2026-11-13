#!/usr/bin/env python3
"""Shared helpers for Autodev board_config artifact checks."""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
_HOOKS_DIR = Path(__file__).resolve().parent
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))

from board_core.artifact_paths import artifact_exists_exact, resolve_exact_relative_path  # noqa: E402
from board_core.contracts import BoardConfigError, load_record_workflow_contracts, load_repo_workflow_contracts  # noqa: E402
from board_core.workflow_compiler import BASE_WORKFLOW_PROFILE  # noqa: E402

from repair_registry import lookup as lookup_repair  # noqa: E402
from repair_registry import render as render_repair  # noqa: E402


BLOCK_EXIT_CODE = 2


class HookCheckError(Exception):
    def __init__(self, reason: str, detail: str = "") -> None:
        self.reason = reason
        self.detail = detail
        super().__init__(reason)


@dataclass(frozen=True)
class ArtifactConfig:
    skill: str
    required_inputs: tuple[str, ...]
    required_outputs: tuple[str, ...]
    validators: tuple[str, ...]


@dataclass(frozen=True)
class HookContext:
    skill: str
    slug: str
    root: Path
    required_inputs: tuple[str, ...] = ()
    required_outputs: tuple[str, ...] = ()
    target_checkpoint: str | None = None

    def requires_artifact(self, name: str) -> bool:
        return name in self.required_inputs or name in self.required_outputs

    @property
    def feature_dir(self) -> Path:
        return self.root / ".autobizdevops" / "features" / self.slug

    def file(self, name: str) -> Path:
        return self.feature_dir / name


def is_nonempty(path: Path) -> bool:
    resolved = resolve_exact_relative_path(path.parent, path.name)
    return resolved is not None and resolved.is_file() and resolved.stat().st_size > 0


def artifact_exists(feature_dir: Path, name: str) -> bool:
    return artifact_exists_exact(feature_dir, name)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def missing_files(root: Path, slug: str, file_names: Iterable[str]) -> list[str]:
    feature_dir = root / ".autobizdevops" / "features" / slug
    return [name for name in file_names if not artifact_exists(feature_dir, name)]


def require_feature_dir(root: Path, slug: str) -> None:
    feature_dir = root / ".autobizdevops" / "features" / slug
    if not feature_dir.is_dir():
        raise HookCheckError("missing_feature_dir", str(feature_dir))


def validate_required_files(root: Path, slug: str, file_names: Iterable[str]) -> None:
    file_names = tuple(file_names)
    if not file_names:
        return
    require_feature_dir(root, slug)
    missing = missing_files(root, slug, file_names)
    if missing:
        raise HookCheckError("missing_required_artifacts", ", ".join(missing))


def load_artifact_config(
    repo_root: Path,
    skill: str,
    *,
    workspace_root: Path | None = None,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: dict[str, str] | None = None,
    workflow_record: dict | None = None,
) -> ArtifactConfig:
    try:
        if workflow_record is not None:
            contracts = load_record_workflow_contracts(
                repo_root,
                workflow_record,
                workspace=workspace_root,
            )
        else:
            contracts = load_repo_workflow_contracts(
                repo_root,
                workspace=workspace_root,
                profile=workflow_profile,
                workflow_decisions=workflow_decisions,
            )
        contract = contracts.contract_for_skill(skill)
    except BoardConfigError as error:
        raise HookCheckError("invalid_board_config", str(error)) from error

    return ArtifactConfig(
        skill=skill,
        required_inputs=contract.required_inputs,
        required_outputs=contract.required_outputs,
        validators=contract.validators,
    )


def fail_line(
    ctx: HookContext,
    reason: str,
    extra: str = "",
    *,
    repair: str = "",
    target: str = "",
    fields: dict | None = None,
    diagnostics: dict | None = None,
) -> int:
    """打印一条机器可解析的预检失败。

    结构化字段随行尾 ``payload={json}`` 一起输出，一条错误一行——同一个 reason
    重复出现时，每条错误各自带着自己的 target 与 action，不依赖跨行配对。
    未在 `repair_registry` 注册的 reason 不带 payload，行为与注册表引入前一致。
    """
    entry = lookup_repair(reason, extra)
    payload = ""
    action = repair
    if entry is not None:
        rendered_action = repair or render_repair(entry.action, target, fields)
        action = rendered_action
        payload_data = {
            "artifact": render_repair(entry.artifact, target, fields),
            "target": target,
            "problem": render_repair(entry.problem, target, fields),
            "action": rendered_action,
            "route": entry.route,
        }
        if diagnostics:
            payload_data["diagnostics"] = diagnostics
        payload = json.dumps(
            payload_data,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    line = f"POST_SKILL_FAIL skill={ctx.skill} reason={reason}{extra}"
    if payload:
        line = f"{line} payload={payload}"
    print(line)
    if action:
        print(
            f"POST_SKILL_REPAIR skill={ctx.skill} reason={reason} "
            f"action={action!r}"
        )
    return 1


def warn(ctx: HookContext, reason: str, extra: str = "") -> None:
    print(f"POST_SKILL_WARN skill={ctx.skill} reason={reason}{extra}")


def info(ctx: HookContext, reason: str, extra: str = "") -> None:
    print(f"POST_SKILL_INFO skill={ctx.skill} reason={reason}{extra}")


TASK_HEADING = re.compile(r"^###\s+(TASK-\d{3}):", re.MULTILINE)


def task_count(plan: Path) -> int:
    if not is_nonempty(plan):
        return 0
    # 新格式 `### TASK-001: 名称`；兼容旧格式 `### 1. 名称`
    return len(re.findall(r"^### (?:TASK-\d{3}:|[0-9]+\.)", read_text(plan), re.MULTILINE))


def plan_task_blocks(plan_text: str) -> dict[str, str]:
    """按 `### TASK-NNN:` 标题切出任务详情块；legacy 数字标题 PLAN 返回空 dict。"""
    blocks: dict[str, str] = {}
    matches = list(TASK_HEADING.finditer(plan_text))
    for index, match in enumerate(matches):
        start = match.end()
        if index + 1 < len(matches):
            end = matches[index + 1].start()
        else:
            next_section = re.search(r"^##\s", plan_text[start:], re.MULTILINE)
            end = start + next_section.start() if next_section else len(plan_text)
        blocks[match.group(1)] = plan_text[start:end]
    return blocks


def task_statuses(plan: Path) -> list[str]:
    if not is_nonempty(plan):
        return []
    return [
        match.group(1).strip()
        for match in re.finditer(r"^[ \t]*[-*][ \t]*\*\*状态:\*\*[ \t]*(.+)$", read_text(plan), re.MULTILINE)
    ]
