#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for result JSON writers."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


SCENARIO_DEF_RE = re.compile(
    r"^####\s+Scenario\s+(?=\[?(SCN-\d{3})\]?:)(?:\[SCN-\d{3}\]|SCN-\d{3}):",
    re.MULTILINE,
)
SCN_ID_RE = re.compile(r"\bSCN-\d{3}\b")
REQ_ID_RE = re.compile(r"\bREQ-\d{3}\b")


def collect_scenario_ids(feature_dir: Path) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    specs_dir = feature_dir / "specs"
    for spec in sorted(specs_dir.rglob("*.md")) if specs_dir.is_dir() else []:
        text = spec.read_text(encoding="utf-8", errors="ignore")
        for scenario_id in SCENARIO_DEF_RE.findall(text):
            if scenario_id not in seen:
                seen.add(scenario_id)
                result.append(scenario_id)
    return result


def collect_plan_tasks(feature_dir: Path) -> list[dict[str, Any]]:
    path = feature_dir / "plan.json"
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict) or "tasks" in data:
        return []
    result: list[dict[str, Any]] = []
    for entry in data.get("batches", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        batch_path = feature_dir / str(entry["path"])
        try:
            batch = json.loads(batch_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        batch_tasks = batch.get("tasks") if isinstance(batch, dict) else None
        if isinstance(batch_tasks, list):
            result.extend(task for task in batch_tasks if isinstance(task, dict))
    return result


def task_by_id(feature_dir: Path) -> dict[str, dict[str, Any]]:
    return {task["id"]: task for task in collect_plan_tasks(feature_dir) if isinstance(task.get("id"), str)}


def _evidence_records(feature_dir: Path) -> list[dict[str, Any]]:
    path = feature_dir / "evidence" / "EVIDENCE.jsonl"
    if not path.is_file():
        return []
    result: list[dict[str, Any]] = []
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            result.append(record)
    return result


def scenario_refs_from_record(record: dict[str, Any]) -> set[str]:
    refs = record.get("specRefs")
    if not isinstance(refs, list):
        return set()
    return set(SCN_ID_RE.findall(" ".join(str(ref) for ref in refs if isinstance(ref, str))))


def derive_coverage_from_evidence(
    feature_dir: Path,
    *,
    action: str | None = None,
    skill: str | None = None,
) -> list[dict[str, Any]]:
    scenarios = collect_scenario_ids(feature_dir)
    evidence_by_scenario: dict[str, list[str]] = {scenario: [] for scenario in scenarios}
    failed_by_scenario: set[str] = set()
    for record in _evidence_records(feature_dir):
        if action and record.get("action") != action:
            continue
        if skill and record.get("skill") != skill:
            continue
        evidence_id = record.get("evidenceId")
        if not isinstance(evidence_id, str):
            continue
        passed = False
        validation = record.get("validation")
        if isinstance(validation, dict):
            result = str(validation.get("result", "")).strip().lower()
            exit_code = validation.get("exitCode")
            passed = result == "pass" or exit_code == 0
        smoke = record.get("smoke")
        if isinstance(smoke, dict):
            passed = str(smoke.get("result", "")).strip().lower() == "pass"
        for scenario in scenario_refs_from_record(record):
            if scenario not in evidence_by_scenario:
                continue
            if passed:
                evidence_by_scenario[scenario].append(evidence_id)
            else:
                failed_by_scenario.add(scenario)
    rows: list[dict[str, Any]] = []
    for scenario in scenarios:
        evidence_ids = evidence_by_scenario.get(scenario, [])
        if evidence_ids:
            rows.append({"scenarioRef": scenario, "evidenceIds": evidence_ids, "verdict": "pass"})
        elif scenario in failed_by_scenario:
            rows.append({"scenarioRef": scenario, "evidenceIds": [], "verdict": "fail"})
        else:
            rows.append({"scenarioRef": scenario, "evidenceIds": [], "verdict": "missing"})
    return rows


def empty_coverage(feature_dir: Path) -> list[dict[str, Any]]:
    return [
        {"scenarioRef": scenario, "evidenceIds": [], "verdict": "missing"}
        for scenario in collect_scenario_ids(feature_dir)
    ]


def coverage_decision_sets(rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    passed: list[str] = []
    failed: list[str] = []
    manual: list[str] = []
    missing: list[str] = []
    for row in rows:
        scenario = row.get("scenarioRef")
        verdict = row.get("verdict")
        if not isinstance(scenario, str) or not isinstance(verdict, str):
            continue
        normalized = verdict.lower()
        if normalized == "pass":
            passed.append(scenario)
        elif normalized == "fail":
            failed.append(scenario)
        elif normalized == "manual":
            manual.append(scenario)
        else:
            missing.append(scenario)
    return {
        "passedScenarioRefs": passed,
        "failedScenarioRefs": failed,
        "manualVerificationRefs": manual,
        "missingScenarioRefs": missing,
    }


def ui_summary_from_coverage(feature_dir: Path, rows: list[dict[str, Any]]) -> dict[str, Any]:
    path = feature_dir / "UI_CONTEXT.json"
    ui_required = False
    ui_scenarios: set[str] = set()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        if isinstance(data, dict):
            ui_required = data.get("uiRequired") is True
            caps = data.get("capabilities")
            if isinstance(caps, list):
                for cap in caps:
                    if isinstance(cap, dict) and cap.get("uiRequired") is not False:
                        refs = cap.get("specRefs")
                        if isinstance(refs, list):
                            ui_scenarios.update(SCN_ID_RE.findall(" ".join(str(ref) for ref in refs if isinstance(ref, str))))
    summary = {
        "uiRequired": ui_required,
        "passedUiScenarioRefs": [],
        "failedUiScenarioRefs": [],
        "manualUiScenarioRefs": [],
        "missingUiScenarioRefs": [],
        "notApplicableScenarioRefs": [],
    }
    for row in rows:
        scenario = row.get("scenarioRef")
        verdict = str(row.get("verdict", "")).lower()
        if not isinstance(scenario, str):
            continue
        if not ui_required or scenario not in ui_scenarios:
            summary["notApplicableScenarioRefs"].append(scenario)
        elif verdict == "pass":
            summary["passedUiScenarioRefs"].append(scenario)
        elif verdict == "fail":
            summary["failedUiScenarioRefs"].append(scenario)
        elif verdict == "manual":
            summary["manualUiScenarioRefs"].append(scenario)
        else:
            summary["missingUiScenarioRefs"].append(scenario)
    return summary
