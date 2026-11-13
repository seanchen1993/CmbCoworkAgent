#!/usr/bin/env python3
"""Operator diagnostics for the staged parallel Batch DAG."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import resolve_feature, resolve_workspace
from hooks.parallel_runtime import load_manifest, run_dir


def _stage_view(batch: dict[str, Any]) -> dict[str, str]:
    states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
    return {name: str(value.get("status") or "pending") for name, value in states.items() if isinstance(value, dict)}


def status(manifest: dict[str, Any]) -> dict[str, Any]:
    deliveries = [
        {
            "batchId": batch_id,
            "type": batch.get("type", "delivery"),
            "status": batch.get("status"),
            "dependencies": batch.get("dependencies", []),
            "activeStage": batch.get("activeStage"),
            "stages": _stage_view(batch),
        }
        for batch_id, batch in sorted((manifest.get("batches") or {}).items())
        if isinstance(batch, dict)
    ]
    validations = [
        {
            "batchId": batch_id,
            "type": "validation",
            "status": batch.get("status"),
            "dependencies": batch.get("dependencies", []),
            "activeStage": batch.get("activeStage"),
            "stages": _stage_view(batch),
        }
        for batch_id, batch in sorted((manifest.get("validationBatches") or {}).items())
        if isinstance(batch, dict)
    ]
    return {"runId": manifest.get("runId"), "runStatus": manifest.get("status"), "deliveries": deliveries, "validations": validations, "mergeTrains": manifest.get("mergeTrains", {})}


def why_blocked(manifest: dict[str, Any], batch_id: str) -> dict[str, Any]:
    batch = (manifest.get("batches") or {}).get(batch_id) or (manifest.get("validationBatches") or {}).get(batch_id)
    if not isinstance(batch, dict):
        raise ValueError(f"parallel_batch_not_found:{batch_id}")
    waiting: list[dict[str, Any]] = []
    for dependency in batch.get("dependencies", []):
        item = (manifest.get("batches") or {}).get(dependency) or (manifest.get("validationBatches") or {}).get(dependency)
        if not isinstance(item, dict):
            waiting.append({"batchId": dependency, "reason": "missing"})
        elif item.get("status") not in {"merged", "verified"}:
            waiting.append({"batchId": dependency, "status": item.get("status"), "activeStage": item.get("activeStage")})
    stages = _stage_view(batch)
    unfinished = [stage for stage, state in stages.items() if state not in {"passed", "skipped"}]
    reason = "dependencies" if waiting else "stage" if unfinished else "merge_train" if batch.get("status") == "ready_to_candidate" else "not_blocked"
    return {"batchId": batch_id, "status": batch.get("status"), "reason": reason, "waitingFor": waiting, "unfinishedStages": unfinished, "error": batch.get("error")}


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def report(manifest: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for group in ("batches", "validationBatches"):
        for batch_id, batch in sorted((manifest.get(group) or {}).items()):
            if not isinstance(batch, dict):
                continue
            for stage, state in (batch.get("stageStates") or {}).items():
                if not isinstance(state, dict):
                    continue
                started, completed = _parse_time(state.get("startedAt")), _parse_time(state.get("completedAt"))
                rows.append({"batchId": batch_id, "stage": stage, "status": state.get("status"), "startedAt": state.get("startedAt"), "completedAt": state.get("completedAt"), "durationSeconds": (completed - started).total_seconds() if started and completed else None, "attempt": state.get("attempt", 0)})
    bottleneck = max((row for row in rows if isinstance(row["durationSeconds"], (int, float))), key=lambda row: row["durationSeconds"], default=None)
    return {"runId": manifest.get("runId"), "stages": rows, "bottleneck": bottleneck, "mergeTrains": manifest.get("mergeTrains", {})}


def reproduce(workspace: Path, feature: str, run_id: str, evidence_id: str) -> dict[str, Any]:
    for path in run_dir(workspace, feature, run_id).glob("stages/*/*/*.json"):
        try:
            evidence = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if evidence.get("evidenceId") == evidence_id:
            inputs = evidence.get("inputs") if isinstance(evidence.get("inputs"), dict) else {}
            return {"evidenceId": evidence_id, "path": str(path), "inputs": inputs, "reproduce": {"commit": inputs.get("batchCommit"), "commandDigest": inputs.get("commandDigest"), "toolchainDigest": inputs.get("toolchainDigest"), "dependencies": inputs.get("dependencies", {})}}
    raise ValueError(f"parallel_evidence_not_found:{evidence_id}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect staged parallel Batch DAG execution")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "why-blocked", "report", "reproduce"):
        item = sub.add_parser(name)
        item.add_argument("--workspace")
        item.add_argument("--feature", required=True)
        item.add_argument("--run-id", required=True)
        if name == "why-blocked":
            item.add_argument("--batch-id", required=True)
        if name == "reproduce":
            item.add_argument("--evidence-id", required=True)
    args = parser.parse_args(argv)
    try:
        workspace, feature = resolve_workspace(args.workspace), resolve_feature(args.feature)
        manifest = load_manifest(workspace, feature, args.run_id)
        if args.command == "status":
            result = status(manifest)
        elif args.command == "why-blocked":
            result = why_blocked(manifest, args.batch_id)
        elif args.command == "report":
            result = report(manifest)
        else:
            result = reproduce(workspace, feature, args.run_id, args.evidence_id)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
