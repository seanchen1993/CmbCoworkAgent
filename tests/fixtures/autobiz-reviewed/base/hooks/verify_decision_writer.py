#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Incrementally write VERIFY_DECISION.json."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import (  # noqa: E402
    WriterResult,
    artifact_path,
    atomic_write_json,
    fail,
    fail_if_artifact_exists,
    load_json,
    render_result,
    resolve_feature,
    resolve_workspace,
    with_result_data,
)
from hooks.result_writer_common import (  # noqa: E402
    coverage_decision_sets,
    derive_coverage_from_evidence,
    empty_coverage,
    ui_summary_from_coverage,
)
from hooks.candidate_digest import compute as compute_candidate_digest  # noqa: E402


FILE_NAME = "VERIFY_DECISION.json"
VERDICTS = {"pass", "fail", "manual"}
ROW_VERDICTS = {"pass", "fail", "manual", "missing"}
SCN_ID_RE = re.compile(r"\bSCN-\d{3}\b")


def _path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, FILE_NAME)


def _feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def _initial(feature_dir: Path) -> dict[str, Any]:
    rows = _with_ui_applicability(feature_dir, empty_coverage(feature_dir))
    return _sync_summary(
        feature_dir,
        {
            "version": 1,
            "verdict": "fail",
            "nextCheckpoint": "needs_fix",
            "evidenceIds": [],
            "scenarioCoverage": rows,
        },
    )


def _load(workspace: Path, feature: str) -> dict[str, Any]:
    data = load_json(_path(workspace, feature), default=_initial(_feature_dir(workspace, feature)))
    if not isinstance(data, dict):
        raise ValueError(f"{FILE_NAME} root 必须是 object")
    data.setdefault("version", 1)
    data.setdefault("verdict", "fail")
    data.setdefault("nextCheckpoint", "needs_fix")
    data.setdefault("evidenceIds", [])
    data.setdefault("scenarioCoverage", [])
    return data


def _ui_scenarios(feature_dir: Path) -> tuple[bool, set[str], bool]:
    path = feature_dir / "UI_CONTEXT.json"
    if not path.is_file():
        return False, set(), False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False, set(), True
    if not isinstance(data, dict):
        return False, set(), True
    ui_required = data.get("uiRequired") is True
    result: set[str] = set()
    caps = data.get("capabilities")
    if isinstance(caps, list):
        for cap in caps:
            if isinstance(cap, dict) and cap.get("uiRequired") is not False:
                refs = cap.get("specRefs")
                if isinstance(refs, list):
                    result.update(SCN_ID_RE.findall(" ".join(str(ref) for ref in refs if isinstance(ref, str))))
    return ui_required, result, True


def _with_ui_applicability(feature_dir: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ui_required, ui_scenarios, has_ui_context = _ui_scenarios(feature_dir)
    if not has_ui_context:
        return rows
    result: list[dict[str, Any]] = []
    for row in rows:
        next_row = dict(row)
        scenario = next_row.get("scenarioRef")
        verdict = str(next_row.get("verdict", "")).lower()
        if not ui_required or scenario not in ui_scenarios:
            next_row["uiApplicability"] = "not_applicable"
        elif verdict == "manual":
            next_row["uiApplicability"] = "manual"
        elif verdict == "missing":
            next_row["uiApplicability"] = "missing"
        else:
            next_row["uiApplicability"] = "required"
        result.append(next_row)
    return result


def _derive_verdict(rows: list[dict[str, Any]]) -> str:
    verdicts = {str(row.get("verdict", "")).lower() for row in rows if isinstance(row, dict)}
    if not rows or "fail" in verdicts or "missing" in verdicts:
        return "fail"
    if "manual" in verdicts:
        return "manual"
    return "pass"


def _next_checkpoint(verdict: str) -> str:
    if verdict == "pass":
        return "code_done"
    if verdict == "manual":
        return "needs_fix"
    return "needs_fix"


def _sync_summary(feature_dir: Path, data: dict[str, Any]) -> dict[str, Any]:
    rows = data.get("scenarioCoverage")
    rows = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    rows = _with_ui_applicability(feature_dir, rows)
    data["scenarioCoverage"] = rows
    decisions = coverage_decision_sets(rows)
    data.update(decisions)
    evidence: list[str] = []
    for row in rows:
        row_evidence = row.get("evidenceIds")
        if isinstance(row_evidence, list):
            for evidence_id in row_evidence:
                if isinstance(evidence_id, str) and evidence_id not in evidence:
                    evidence.append(evidence_id)
    existing = data.get("evidenceIds")
    if isinstance(existing, list):
        for evidence_id in existing:
            if isinstance(evidence_id, str) and evidence_id not in evidence:
                evidence.append(evidence_id)
    data["evidenceIds"] = evidence
    verdict = str(data.get("verdict", "")).lower()
    if verdict not in VERDICTS:
        verdict = _derive_verdict(rows)
    data["verdict"] = verdict
    data["nextCheckpoint"] = _next_checkpoint(verdict)
    data["uiSummary"] = ui_summary_from_coverage(feature_dir, rows)
    return data


def _write(workspace: Path, feature: str, data: dict[str, Any]) -> WriterResult:
    data = _sync_summary(_feature_dir(workspace, feature), data)
    try:
        data["diffDigest"] = compute_candidate_digest(workspace, feature)
    except ValueError:
        # Legacy plans without a concrete code workspace may still produce a
        # verification decision. They simply cannot opt into stale-code checks.
        data.pop("diffDigest", None)
    changed = atomic_write_json(_path(workspace, feature), data)
    return WriterResult(ok=True, path=_path(workspace, feature), changed=changed)


def _cmd_init(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    existing = fail_if_artifact_exists(_path(workspace, feature), force=args.force)
    if existing:
        return render_result(existing)
    data = _initial(_feature_dir(workspace, feature))
    if args.from_evidence:
        data["scenarioCoverage"] = derive_coverage_from_evidence(_feature_dir(workspace, feature), action="validation")
        data["verdict"] = _derive_verdict(data["scenarioCoverage"])
    return render_result(with_result_data(_write(workspace, feature, data), reset=bool(args.force)))


def _cmd_derive_coverage(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    rows = derive_coverage_from_evidence(_feature_dir(workspace, feature), action="validation")
    data["scenarioCoverage"] = rows
    data["verdict"] = _derive_verdict(rows)
    return render_result(_write(workspace, feature, data))


def _cmd_update_scenario(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    rows = data.setdefault("scenarioCoverage", [])
    if not isinstance(rows, list):
        rows = []
        data["scenarioCoverage"] = rows
    found = False
    for row in rows:
        if isinstance(row, dict) and row.get("scenarioRef") == args.scenario_ref:
            row["verdict"] = args.verdict
            row["evidenceIds"] = args.evidence_id or []
            found = True
            break
    if not found:
        rows.append({"scenarioRef": args.scenario_ref, "evidenceIds": args.evidence_id or [], "verdict": args.verdict})
    data["verdict"] = _derive_verdict([row for row in rows if isinstance(row, dict)])
    return render_result(_write(workspace, feature, data))


def _cmd_set_verdict(args: argparse.Namespace) -> int:
    del args
    return render_result(
        fail(
            "verify_verdict_is_coverage_authoritative",
            "修复：用 derive-scenario-coverage 或 update-scenario 记录证据绑定的逐项结论。",
        )
    )


def _cmd_validate(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    errors: list[dict[str, str]] = []
    if data.get("verdict") not in VERDICTS:
        errors.append({"reason": "invalid_verify_decision_verdict"})
    if data.get("nextCheckpoint") != _next_checkpoint(str(data.get("verdict"))):
        errors.append({"reason": "invalid_verify_decision_transition"})
    if not isinstance(data.get("scenarioCoverage"), list):
        errors.append({"reason": "invalid_scenario_coverage"})
    if isinstance(data.get("diffDigest"), str) and data["diffDigest"]:
        try:
            current_digest = compute_candidate_digest(workspace, feature)
        except ValueError as exc:
            errors.append({"reason": "verify_diff_digest_unresolved", "detail": str(exc)})
        else:
            if data["diffDigest"] != current_digest:
                errors.append({"reason": "verify_diff_digest_stale"})
    return render_result(WriterResult(ok=not errors, path=_path(workspace, feature), errors=errors))


def _cmd_show(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    return render_result(
        WriterResult(
            ok=True,
            path=_path(workspace, feature),
            data={
                "summary": {
                    "verdict": data.get("verdict"),
                    "nextCheckpoint": data.get("nextCheckpoint"),
                    "passed": len(data.get("passedScenarioRefs", [])),
                    "failed": len(data.get("failedScenarioRefs", [])),
                    "manual": len(data.get("manualVerificationRefs", [])),
                    "missing": len(data.get("missingScenarioRefs", [])),
                }
            },
        )
    )


def _resolve(args: argparse.Namespace) -> tuple[Path, str]:
    return resolve_workspace(args.workspace), resolve_feature(args.feature)


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace")
    parser.add_argument("--feature")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Incrementally write VERIFY_DECISION.json")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    _common(init)
    init.add_argument("--force", action="store_true")
    init.add_argument("--from-specs", action="store_true")
    init.add_argument("--from-evidence", action="store_true")
    init.set_defaults(func=_cmd_init)

    coverage = sub.add_parser("derive-scenario-coverage")
    _common(coverage)
    coverage.set_defaults(func=_cmd_derive_coverage)

    row = sub.add_parser("update-scenario")
    _common(row)
    row.add_argument("--scenario-ref", required=True)
    row.add_argument("--verdict", required=True, choices=sorted(ROW_VERDICTS))
    row.add_argument("--evidence-id", action="append")
    row.set_defaults(func=_cmd_update_scenario)

    verdict = sub.add_parser("set-verdict")
    _common(verdict)
    verdict.add_argument("verdict", choices=sorted(VERDICTS))
    verdict.set_defaults(func=_cmd_set_verdict)

    validate = sub.add_parser("validate")
    _common(validate)
    validate.add_argument("--structure", action="store_true")
    validate.add_argument("--gate", action="store_true")
    validate.set_defaults(func=_cmd_validate)

    show = sub.add_parser("show")
    _common(show)
    show.add_argument("--summary", action="store_true")
    show.set_defaults(func=_cmd_show)

    args = parser.parse_args(argv)
    try:
        if args.command == "init" and args.from_specs and args.from_evidence:
            return render_result(fail("ambiguous_verify_init_source", "只能选择 --from-specs 或 --from-evidence"))
        if args.command == "init" and not args.from_specs and not args.from_evidence:
            return render_result(fail("missing_verify_init_source", "请显式传 --from-specs 或 --from-evidence"))
        return args.func(args)
    except Exception as exc:
        return render_result(fail("verify_decision_writer_failed", str(exc)))


if __name__ == "__main__":
    raise SystemExit(main())
