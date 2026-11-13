#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Audit evidence artifacts and optionally reset untrusted completed tasks."""

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

from hooks.evidence_integrity_gate import check_code_done, check_integrity  # noqa: E402
from hooks.evidence_kernel import FileLock, unlink_if_exists  # noqa: E402
from hooks.evidence_store import EvidenceStoreError, read_records, stream_path  # noqa: E402
from hooks.json_writer_common import atomic_write_json  # noqa: E402
from hooks.plan_json import batch_plan_path, load_plan, load_plan_bundle, normalize_status  # noqa: E402


def _finding(code: str, *, task_id: str | None = None, detail: str = "") -> dict[str, str]:
    result = {"code": code}
    if task_id:
        result["taskId"] = task_id
    if detail:
        result["detail"] = detail
    return result


def audit_feature(feature_dir: Path) -> tuple[dict[str, Any], set[str]]:
    findings: list[dict[str, str]] = []
    invalid_tasks: set[str] = set()
    path = stream_path(feature_dir)
    integrity_errors: list[str] = []
    if not path.is_file() or path.stat().st_size <= 0:
        findings.append(_finding("missing_evidence_stream"))
        records: tuple[dict[str, Any], ...] = ()
    else:
        try:
            records = read_records(path)
        except EvidenceStoreError as exc:
            records = ()
            findings.append(_finding("invalid_evidence_stream", detail=str(exc)))
        integrity_errors = check_integrity(feature_dir)
        for error in integrity_errors:
            code, _, detail = error.partition(":")
            findings.append(_finding(code, detail=detail))

    plan_path = feature_dir / "plan.json"
    try:
        bundle = load_plan_bundle(feature_dir)
        plan_tasks = bundle.tasks
    except Exception as exc:
        findings.append(_finding("invalid_plan_json", detail=str(exc)))
        plan_tasks = []

    by_id = {
        str(record.get("evidenceId")): record
        for record in records
        if isinstance(record.get("evidenceId"), str)
    }
    damaged_evidence_ids = {
        match.group(0)
        for error in integrity_errors
        for match in re.finditer(r"\bev_\d{4}\b", error)
    }
    global_integrity_failure = bool(integrity_errors) and not damaged_evidence_ids
    for task in plan_tasks:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id", ""))
        evidence_ids = task.get("evidenceIds") if isinstance(task.get("evidenceIds"), list) else []
        if normalize_status(task.get("status")) == "done" and not evidence_ids:
            findings.append(_finding("done_without_evidence", task_id=task_id))
            invalid_tasks.add(task_id)
        if normalize_status(task.get("status")) == "done" and (
            global_integrity_failure or damaged_evidence_ids.intersection(str(item) for item in evidence_ids)
        ):
            findings.append(_finding("task_references_damaged_evidence", task_id=task_id))
            invalid_tasks.add(task_id)
        for evidence_id in evidence_ids:
            record = by_id.get(str(evidence_id))
            if record is None:
                findings.append(_finding("plan_references_missing_evidence", task_id=task_id, detail=str(evidence_id)))
                invalid_tasks.add(task_id)
            elif record.get("taskId") != task_id:
                findings.append(_finding("evidence_task_mismatch", task_id=task_id, detail=str(evidence_id)))
                invalid_tasks.add(task_id)

    for error in check_code_done(feature_dir):
        if "." in error and error.startswith("T"):
            task_id, _, detail = error.partition(".")
            invalid_tasks.add(task_id)
            findings.append(_finding("code_done_gate_failure", task_id=task_id, detail=detail))

    payload = {
        "ok": not findings,
        "featureDir": str(feature_dir),
        "findings": findings,
        "invalidTaskIds": sorted(invalid_tasks),
    }
    return payload, invalid_tasks


def reset_invalid_tasks(feature_dir: Path, invalid_tasks: set[str]) -> bool:
    plan_path = feature_dir / "plan.json"
    with FileLock(feature_dir / ".plan.lock"):
        bundle = load_plan_bundle(feature_dir)
        changed = False
        root = bundle.root
        for batch_id, batch in bundle.batches.items():
            batch_changed = False
            for task in batch.get("tasks", []):
                if not isinstance(task, dict) or task.get("id") not in invalid_tasks:
                    continue
                task["status"] = "todo"
                task["completionEvidenceIds"] = []
                task["latestPassEvidenceId"] = None
                batch_changed = True
                changed = True
            if batch_changed:
                batch["status"] = "todo"
                batch["completedTaskCount"] = sum(
                    normalize_status(item.get("status")) == "done"
                    for item in batch.get("tasks", [])
                    if isinstance(item, dict)
                )
                batch["completedAt"] = None
                atomic_write_json(batch_plan_path(feature_dir, batch_id), batch)
                for entry in root.get("batches", []):
                    if isinstance(entry, dict) and entry.get("id") == batch_id:
                        entry["status"] = "todo"
        if changed:
            entries = [entry for entry in root.get("batches", []) if isinstance(entry, dict)]
            unfinished = [str(entry.get("id")) for entry in entries if entry.get("status") != "done"]
            if unfinished:
                root["status"] = "in_progress"
                root["activeBatchId"] = unfinished[0]
                root["nextBatchId"] = unfinished[1] if len(unfinished) > 1 else None
            else:
                root["status"] = "done"
                root["activeBatchId"] = None
                root["nextBatchId"] = None
            atomic_write_json(plan_path, root)
        return changed


def _cmd(args: argparse.Namespace) -> int:
    feature_dir = Path(args.feature_dir).expanduser().resolve()
    payload, invalid_tasks = audit_feature(feature_dir)
    if getattr(args, "reset_invalid_tasks", False):
        payload["resetInvalidTasks"] = reset_invalid_tasks(feature_dir, invalid_tasks)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit feature evidence")
    subparsers = parser.add_subparsers(dest="command", required=True)

    report = subparsers.add_parser("report")
    report.add_argument("--feature-dir", required=True)
    report.set_defaults(func=_cmd)

    audit = subparsers.add_parser("audit")
    audit.add_argument("--feature-dir", required=True)
    audit.add_argument("--reset-invalid-tasks", action="store_true")
    audit.set_defaults(func=_cmd)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
