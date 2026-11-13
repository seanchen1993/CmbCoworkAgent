#!/usr/bin/env python3
"""Record Plan-approved, review-required repair Batch contracts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import resolve_feature, resolve_workspace
from hooks.parallel_runtime import append_event, load_manifest, run_lock, save_manifest, utc_now
from hooks.parallel_batch_stage import stage_template


def create_repair_batch(
    workspace: Path,
    feature: str,
    run_id: str,
    original_batch: str,
    *,
    approved_plan_revision: str,
    failure_context: dict[str, Any],
) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        pipeline = manifest.get("pipeline") if isinstance(manifest.get("pipeline"), dict) else {}
        if approved_plan_revision != pipeline.get("planRevision"):
            raise ValueError("parallel_repair_plan_revision_not_approved")
        source = manifest.get("batches", {}).get(original_batch)
        if not isinstance(source, dict):
            source = manifest.get("validationBatches", {}).get(original_batch)
        if not isinstance(source, dict):
            raise ValueError(f"parallel_batch_not_found:{original_batch}")
        repairs = manifest.setdefault("repairBatches", {})
        if not isinstance(repairs, dict):
            repairs = {}
            manifest["repairBatches"] = repairs
        sequence = 1
        while f"{original_batch}-R{sequence}" in repairs:
            sequence += 1
        repair_id = f"{original_batch}-R{sequence}"
        repair = {
            "batchId": repair_id,
            "type": "repair",
            "repairFor": original_batch,
            "planRevision": approved_plan_revision,
            "requireReview": True,
            "status": "pending",
            "scope": {"writeSet": list(source.get("writeSet", [])), "taskIds": list(source.get("taskIds", []))},
            "failureContext": failure_context,
            "createdAt": utc_now(),
        }
        # A repair is a first-class staged contract even before its approved
        # Plan revision adds it to the delivery DAG.  This makes the required
        # review and the precise failure context visible to operators without
        # silently scheduling unplanned source changes.
        repair["stageStates"] = stage_template(repair)
        repairs[repair_id] = repair
        save_manifest(workspace, feature, run_id, manifest)
    append_event(workspace, feature, run_id, "repair_batch_created", repairBatchId=repair_id, repairFor=original_batch)
    return {"success": True, "repair": repair}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Create Plan-approved parallel repair Batch records")
    parser.add_argument("create")
    parser.add_argument("--workspace")
    parser.add_argument("--feature", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--original-batch", required=True)
    parser.add_argument("--approved-plan-revision", required=True)
    parser.add_argument("--failure-context-json", required=True)
    args = parser.parse_args(argv)
    try:
        context = json.loads(args.failure_context_json)
        if not isinstance(context, dict):
            raise ValueError("parallel_repair_failure_context_must_be_object")
        result = create_repair_batch(resolve_workspace(args.workspace), resolve_feature(args.feature), args.run_id, args.original_batch, approved_plan_revision=args.approved_plan_revision, failure_context=context)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
