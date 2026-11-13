#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run the exact board_config artifact postcheck for a workflow node."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
HOOKS_DIR = ROOT / "hooks"
AUTODEV_HOOKS_DIR = ROOT / "skills" / "autodev" / "hooks"
for candidate in (ROOT, HOOKS_DIR, AUTODEV_HOOKS_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from artifact_check import run_postcheck  # noqa: E402
from board_core.contracts import BoardConfigError, load_record_workflow_contracts  # noqa: E402
from board_core.state_store import load_state_json_records_result  # noqa: E402
from hooks.json_writer_common import (  # noqa: E402
    WriterResult,
    capture_stdout,
    fail,
    parse_postcheck_output,
    render_result,
    resolve_feature,
    resolve_workspace,
)


SPECS_STRUCTURE_VALIDATORS = (
    "proposal_contract",
    "specs_contract",
    "capability_spec_correspondence",
)
SPECS_STRUCTURE_OUTPUTS = ("proposal.md", "specs/**/*.md")


def _stage_skill(workspace: Path, record: dict[str, Any], stage: str) -> str:
    try:
        contracts = load_record_workflow_contracts(ROOT, record, workspace=workspace)
    except BoardConfigError as exc:
        raise ValueError(str(exc)) from exc
    for node in contracts.nodes:
        if isinstance(node, dict) and node.get("id") == stage:
            skill = node.get("skill")
            if isinstance(skill, str) and skill:
                return skill
            raise ValueError(f"workflow node 无 skill: {stage}")
    raise ValueError(f"未知 workflow node: {stage}")


def validate_stage(*, workspace: Path, feature: str, stage: str, phase: str = "final") -> WriterResult:
    state = load_state_json_records_result(workspace)
    if not state.exists:
        return fail("missing_state_json", str(workspace / ".autobizdevops" / "state.json"))
    if state.fatal_errors:
        return WriterResult(
            ok=False,
            errors=[{"reason": "invalid_state_json", "detail": "; ".join(state.fatal_errors)}],
        )
    record = state.records.get(feature)
    if record is None and state.record_errors.get(feature):
        return WriterResult(
            ok=False,
            errors=[
                {
                    "reason": "invalid_state_json",
                    "detail": "; ".join(state.record_errors[feature]),
                }
            ],
        )
    if record is None:
        return fail("feature_not_found", feature)
    try:
        skill = _stage_skill(workspace, record, stage)
    except ValueError as exc:
        return fail("invalid_stage", str(exc))
    if phase not in {"structure", "final"}:
        return fail("invalid_phase", phase)
    if phase == "structure" and stage != "dev.specs":
        return fail("invalid_phase", "structure 只适用于 dev.specs")

    def _run() -> tuple[int, str]:
        if phase == "structure":
            return run_postcheck(
                ROOT,
                workspace,
                skill,
                feature,
                workflow_record=record,
                validators_override=SPECS_STRUCTURE_VALIDATORS,
                required_outputs_override=SPECS_STRUCTURE_OUTPUTS,
            )
        return run_postcheck(
            ROOT,
            workspace,
            skill,
            feature,
            workflow_record=record,
        )

    code, message, output = capture_stdout(_run)
    errors = parse_postcheck_output(output, fallback_message=message if code else "")
    invalid_task_ids: list[str] = []
    for error in errors:
        diagnostics = error.get("diagnostics")
        if not isinstance(diagnostics, dict):
            continue
        candidates = diagnostics.get("taskIds")
        if not isinstance(candidates, list):
            candidates = [diagnostics.get("taskId")]
        for task_id in candidates:
            if isinstance(task_id, str) and task_id and task_id not in invalid_task_ids:
                invalid_task_ids.append(task_id)
    return WriterResult(
        ok=code == 0,
        changed=False,
        errors=errors,
        data={
            "stage": stage,
            "phase": phase,
            "skill": skill,
            "feature": feature,
            "message": message,
            "validationReport": {
                "ok": not errors,
                "invalidTaskIds": invalid_task_ids,
                "issueCount": len(errors),
            },
        },
    )


def _cmd_validate(args: argparse.Namespace) -> int:
    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
    except Exception as exc:
        return render_result(fail("path_resolution_failed", str(exc)))
    return render_result(
        validate_stage(
            workspace=workspace,
            feature=feature,
            stage=args.stage,
            phase=args.phase,
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run board_config stage artifact gate")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate")
    validate.add_argument("--stage", required=True, help="Workflow node id, e.g. dev.plan")
    validate.add_argument("--phase", choices=("structure", "final"), default="final")
    validate.add_argument("--feature")
    validate.add_argument("--workspace")
    validate.set_defaults(func=_cmd_validate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
