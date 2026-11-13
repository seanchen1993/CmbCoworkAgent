#!/usr/bin/env python3
"""Check Autodev SKILL.md files for stale formal artifact gate references."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.contracts import (  # noqa: E402
    BoardConfigError,
    SkillContract,
    WorkflowContracts,
    load_board_config,
    load_repo_workflow_contracts,
)
from board_core.workflow_compiler import configured_profile_names  # noqa: E402


CONTRACT_BEGIN_MARKER = "<!-- AUTOBIZDEVOPS_CONTRACT:BEGIN -->"
CONTRACT_END_MARKER = "<!-- AUTOBIZDEVOPS_CONTRACT:END -->"
LEGACY_RULES_BEGIN_MARKER = "<!-- AUTOBIZDEVOPS_ARTIFACT_RULES:BEGIN -->"
LEGACY_RULES_END_MARKER = "<!-- AUTOBIZDEVOPS_ARTIFACT_RULES:END -->"

DEFAULT_FORMAL_ARTIFACT_PATHS = frozenset(
    {
        "PRD.md",
        "design.md",
        "PLAN.md",
        "REQUIREMENTS_EVAL.md",
        "UNIT_TEST_REPORT.md",
        "test-output.log",
        "E2E_TEST_CASES.yaml",
        "E2E_REPORT.md",
        "e2e-run.log",
        "VERIFY_REPORT.md",
    }
)

GATE_LINE_KEYWORDS = (
    "必须",
    "必需",
    "必读",
    "不得",
    "禁止",
    "允许写入",
    "完成前",
    "完成条件",
    "完成状态",
    "输出清单",
    "已写入",
    "已生成",
    "准入",
    "门禁",
)

GATE_HEADING_KEYWORDS = (
    "输入契约",
    "输出契约",
    "准入检查",
    "完成条件",
    "输出清单",
    "写入边界",
    "允许写入",
    "禁止写入",
    "自检",
    "产物输出约定",
)


@dataclass(frozen=True)
class ArtifactDriftFinding:
    skill: str
    path: Path
    line_number: int
    artifact: str
    line: str

    def format(self) -> str:
        return (
            f"ARTIFACT_DRIFT skill={self.skill} path={self.path}:{self.line_number} "
            f"artifact={self.artifact} reason=formal_artifact_not_in_skill_contract "
            f"line={self.line.strip()!r}"
        )


SKILL_GROUP_DIRS = {"Biz": "autobiz", "Dev": "autodev", "Ops": "autoops"}


def skill_file_for_contract(repo_root: Path, contract: SkillContract) -> Path:
    group_dir = SKILL_GROUP_DIRS.get(contract.group, "autodev")
    return repo_root / "skills" / group_dir / contract.skill / "SKILL.md"


def is_managed_contract(contract: SkillContract) -> bool:
    group_dir = SKILL_GROUP_DIRS.get(contract.group)
    return group_dir is not None and contract.skill.startswith(f"{group_dir}-")


def managed_contracts(contracts: WorkflowContracts) -> list[SkillContract]:
    result: list[SkillContract] = []
    for node in sorted(contracts.nodes, key=lambda item: item.get("order", 0)):
        skill = node.get("skill")
        if not isinstance(skill, str):
            continue
        contract = contracts.skill_contracts.get(skill)
        if contract and is_managed_contract(contract):
            result.append(contract)
    return result


def profile_names(repo_root: Path, profile: str) -> list[str]:
    cleaned = profile.strip()
    if cleaned == "all":
        return list(configured_profile_names(load_board_config(repo_root / "board_core" / "board_config.json")))
    profiles = [item.strip() for item in cleaned.split(",") if item.strip()]
    return profiles or ["standard"]


def profile_contracts(repo_root: Path, profile: str = "standard") -> list[WorkflowContracts]:
    profiles = profile_names(repo_root, profile)
    return [
        load_repo_workflow_contracts(repo_root, profile=profile)
        for profile in profiles
    ]


def unique_contracts(contracts: list[SkillContract]) -> list[SkillContract]:
    result: list[SkillContract] = []
    seen: set[str] = set()
    for contract in contracts:
        if contract.skill in seen:
            continue
        seen.add(contract.skill)
        result.append(contract)
    return result


def selected_contracts(contract_sets: list[WorkflowContracts], skill: str | None) -> list[SkillContract]:
    if skill is None:
        return unique_contracts([
            contract
            for contracts in contract_sets
            for contract in managed_contracts(contracts)
        ])

    last_error: BoardConfigError | None = None
    for contracts in contract_sets:
        try:
            contract = contracts.contract_for_skill(skill)
        except BoardConfigError as error:
            last_error = error
            continue
        if not is_managed_contract(contract):
            raise BoardConfigError(f"skill is outside artifact drift scope: {skill}")
        return [contract]
    raise last_error or BoardConfigError(f"unknown skill in board_config.json: {skill}")


def remove_marked_section(content: str, begin_marker: str, end_marker: str) -> str:
    while begin_marker in content or end_marker in content:
        begin_count = content.count(begin_marker)
        end_count = content.count(end_marker)
        if begin_count != end_count:
            raise ValueError(f"marker count mismatch: {begin_marker}")
        if begin_count == 0:
            return content

        begin_index = content.index(begin_marker)
        end_index = content.index(end_marker, begin_index)
        end_index += len(end_marker)
        if end_index < len(content) and content[end_index : end_index + 1] == "\n":
            end_index += 1
        content = content[:begin_index] + content[end_index:]
    return content


def skill_body_for_drift_scan(content: str) -> str:
    content = remove_marked_section(content, CONTRACT_BEGIN_MARKER, CONTRACT_END_MARKER)
    return remove_marked_section(content, LEGACY_RULES_BEGIN_MARKER, LEGACY_RULES_END_MARKER)


def artifact_pattern(artifact_paths: Iterable[str]) -> re.Pattern[str]:
    escaped = [re.escape(path) for path in sorted(set(artifact_paths), key=len, reverse=True)]
    if not escaped:
        return re.compile(r"a\Ab")
    return re.compile(r"(?<![\w.-])(" + "|".join(escaped) + r")(?![\w.-])")


def line_is_gate_context(line: str, heading_context: str) -> bool:
    return any(keyword in line for keyword in GATE_LINE_KEYWORDS) or any(
        keyword in heading_context for keyword in GATE_HEADING_KEYWORDS
    ) or ("状态:" in line and any(word in line for word in ("完成", "待做", "失败")))


def contract_artifact_paths(contract: SkillContract) -> set[str]:
    return {artifact.path for artifact in (*contract.inputs, *contract.outputs)}


def all_workflow_artifact_paths(contracts: WorkflowContracts) -> set[str]:
    result: set[str] = set(DEFAULT_FORMAL_ARTIFACT_PATHS)
    for contract in contracts.skill_contracts.values():
        result.update(contract_artifact_paths(contract))
    return result


def detect_artifact_drift_in_content(
    *,
    content: str,
    contract: SkillContract,
    path: Path,
    known_artifact_paths: set[str],
) -> list[ArtifactDriftFinding]:
    scan_content = skill_body_for_drift_scan(content)
    allowed = contract_artifact_paths(contract)
    pattern = artifact_pattern(known_artifact_paths)
    findings: list[ArtifactDriftFinding] = []
    headings: list[str] = []
    in_code_fence = False

    for line_number, line in enumerate(scan_content.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_fence = not in_code_fence
            continue
        if in_code_fence:
            continue

        heading_match = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading_match:
            depth = len(heading_match.group(1))
            headings = headings[: depth - 1]
            headings.append(heading_match.group(2))

        artifacts = sorted(set(pattern.findall(line)))
        if not artifacts:
            continue

        heading_context = " ".join(headings)
        if not line_is_gate_context(line, heading_context):
            continue

        for artifact in artifacts:
            if artifact not in allowed:
                findings.append(
                    ArtifactDriftFinding(
                        skill=contract.skill,
                        path=path,
                        line_number=line_number,
                        artifact=artifact,
                        line=line,
                    )
                )
    return findings


def check_contracts_for_drift(
    repo_root: Path,
    contracts: Iterable[SkillContract],
    *,
    profile: str = "standard",
) -> list[ArtifactDriftFinding]:
    workflow_contracts = profile_contracts(repo_root, profile)
    known_artifact_paths: set[str] = set(DEFAULT_FORMAL_ARTIFACT_PATHS)
    for contract_set in workflow_contracts:
        known_artifact_paths.update(all_workflow_artifact_paths(contract_set))
    findings: list[ArtifactDriftFinding] = []

    for contract in contracts:
        path = skill_file_for_contract(repo_root, contract)
        if not path.is_file():
            continue
        content = path.read_text(encoding="utf-8")
        findings.extend(
            detect_artifact_drift_in_content(
                content=content,
                contract=contract,
                path=path,
                known_artifact_paths=known_artifact_paths,
            )
        )
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check SKILL.md artifact drift for Biz/Dev/Ops node skills")
    parser.add_argument("--repo-root", default=str(ROOT), help="plugin repository root")
    parser.add_argument("--skill", help="check a single node skill, e.g. autodev-plan / autobiz-requirement-discuss")
    parser.add_argument(
        "--profile",
        default="standard",
        help="workflow profile(s) to inspect, comma-separated; use 'all' to include every configured profile",
    )
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    try:
        selected = selected_contracts(profile_contracts(repo_root, args.profile), args.skill)
        findings = check_contracts_for_drift(repo_root, selected, profile=args.profile)
    except (BoardConfigError, ValueError) as error:
        print(f"ARTIFACT_DRIFT_FAIL {error}", file=sys.stderr)
        return 1

    if not findings:
        print("ARTIFACT_DRIFT_OK")
        return 0

    for finding in findings:
        print(finding.format(), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
