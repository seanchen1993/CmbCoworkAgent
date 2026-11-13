#!/usr/bin/env python3
"""Plan-owned validation ownership for the staged parallel workflow.

Every test intent and review criterion has exactly one owner.  The owner is a delivery Batch or the single post-merge runtime
validation Batch (``V-E2E``).  This is deliberately Plan data rather than
an agent convention: the scheduler can reject duplicate execution before a
worktree is provisioned.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import resolve_feature, resolve_workspace
from hooks.plan_json import PlanBundle, load_plan_bundle


PIPELINE_SCHEMA_VERSION = "autobiz.parallel.pipeline.v1"
DELIVERY_STAGES = ("prepare", "implement", "review", "test")
VALIDATION_BATCHES = (
    {
        "id": "V-E2E",
        "type": "validation",
        "stage": "e2e_test",
        "dependsOn": "all_delivery",
        "executionTarget": "merged_main",
    },
)


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _pipeline_revision(root: dict[str, Any], batches: dict[str, dict[str, Any]]) -> str:
    contract = {
        "batches": [
            {
                "id": entry.get("id"),
                "deps": entry.get("deps", []),
                "taskIds": entry.get("taskIds", []),
                "workspaceRef": entry.get("workspaceRef"),
                "writeSet": [
                    path
                    for task in batches.get(str(entry.get("id")), {}).get("tasks", [])
                    if isinstance(task, dict)
                    for path in (task.get("scope", {}).get("paths", []) if isinstance(task.get("scope"), dict) else [])
                ],
                "taskVerification": [
                    {
                        "id": task.get("id"),
                        "testPoints": task.get("testPoints", []),
                        "verificationIntent": task.get("verificationIntent"),
                        "acceptanceCriteria": task.get("acceptanceCriteria", []),
                    }
                    for task in batches.get(str(entry.get("id")), {}).get("tasks", [])
                    if isinstance(task, dict)
                ],
            }
            for entry in root.get("batches", [])
            if isinstance(entry, dict)
        ],
    }
    return "sha256:" + hashlib.sha256(_canonical(contract).encode("utf-8")).hexdigest()


def build_pipeline_contract(root: dict[str, Any], batches: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Create the deterministic pipeline projection written by Plan Writer."""
    ownership: dict[str, dict[str, Any]] = {}
    for entry in root.get("batches", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        batch_id = entry["id"]
        batch = batches.get(batch_id, {})
        ownership[f"REVIEW-{batch_id}"] = {
            "ownerBatchId": batch_id,
            "stage": "review",
            "kind": "review",
        }
        for task in batch.get("tasks", []) if isinstance(batch, dict) else []:
            if not isinstance(task, dict) or not isinstance(task.get("id"), str):
                continue
            if task.get("executionMode") == "external_dependency":
                continue
            target_id = f"UTEST-{task['id']}"
            ownership[target_id] = {
                "ownerBatchId": batch_id,
                "stage": "test",
                "kind": "utest_target",
                "taskId": task["id"],
                "sourceBatchId": batch_id,
            }

    return {
        "schemaVersion": PIPELINE_SCHEMA_VERSION,
        "planRevision": _pipeline_revision(root, batches),
        "deliveryStages": list(DELIVERY_STAGES),
        "validationBatches": [dict(item) for item in VALIDATION_BATCHES],
        "validationOwnership": ownership,
        "finalization": {
            "mode": "evidence_aggregate_only",
            "forbidPostMergeDuplicateExecution": True,
        },
    }


def validation_ownership_errors(root: dict[str, Any], batches: dict[str, dict[str, Any]]) -> list[str]:
    pipeline = root.get("parallelBatchPipeline")
    if not isinstance(pipeline, dict):
        return ["parallel_batch_pipeline_missing"]
    errors: list[str] = []
    if pipeline.get("schemaVersion") != PIPELINE_SCHEMA_VERSION:
        errors.append("parallel_batch_pipeline_schema_invalid")
    if pipeline.get("deliveryStages") != list(DELIVERY_STAGES):
        errors.append("parallel_batch_pipeline_delivery_stages_invalid")
    if not isinstance(pipeline.get("planRevision"), str) or not pipeline["planRevision"].startswith("sha256:"):
        errors.append("parallel_batch_pipeline_revision_invalid")
    elif pipeline["planRevision"] != _pipeline_revision(root, batches):
        errors.append("parallel_batch_pipeline_revision_stale")

    expected_validation = [dict(item) for item in VALIDATION_BATCHES]
    if pipeline.get("validationBatches") != expected_validation:
        errors.append("parallel_batch_pipeline_validation_batches_invalid")

    ownership = pipeline.get("validationOwnership")
    if not isinstance(ownership, dict):
        return [*errors, "parallel_validation_ownership_missing"]
    expected = build_pipeline_contract(root, batches)["validationOwnership"]
    source_ids: list[str] = []
    for entry in root.get("batches", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        batch_id = entry["id"]
        batch = batches.get(batch_id, {})
        for task in batch.get("tasks", []) if isinstance(batch, dict) else []:
            if not isinstance(task, dict) or not isinstance(task.get("id"), str):
                continue
            if task.get("executionMode") != "external_dependency":
                source_ids.append(f"UTEST-{task['id']}")
    duplicate_ids = sorted({item for item in source_ids if source_ids.count(item) > 1})
    errors.extend(f"validation_ownership_duplicate:{command_id}" for command_id in duplicate_ids)
    for command_id, owner in expected.items():
        actual = ownership.get(command_id)
        if actual != owner:
            errors.append(f"validation_ownership_missing_or_invalid:{command_id}")
    for command_id, owner in ownership.items():
        if command_id not in expected:
            errors.append(f"validation_ownership_unknown:{command_id}")
            continue
        if not isinstance(owner, dict):
            errors.append(f"validation_ownership_invalid:{command_id}")

    finalization = pipeline.get("finalization")
    if not isinstance(finalization, dict) or finalization.get("mode") != "evidence_aggregate_only":
        errors.append("parallel_batch_pipeline_finalization_invalid")
    if isinstance(finalization, dict) and finalization.get("forbidPostMergeDuplicateExecution") is not True:
        errors.append("parallel_batch_pipeline_duplicate_execution_not_forbidden")
    return errors


def ownership_report(root: dict[str, Any], batches: dict[str, dict[str, Any]]) -> dict[str, Any]:
    pipeline = root.get("parallelBatchPipeline")
    ownership = pipeline.get("validationOwnership", {}) if isinstance(pipeline, dict) else {}
    by_owner: dict[str, list[str]] = {}
    for command_id, value in ownership.items() if isinstance(ownership, dict) else []:
        owner = value.get("ownerBatchId") if isinstance(value, dict) else None
        if isinstance(owner, str):
            by_owner.setdefault(owner, []).append(command_id)
    return {
        "planRevision": pipeline.get("planRevision") if isinstance(pipeline, dict) else None,
        "owners": {owner: sorted(ids) for owner, ids in sorted(by_owner.items())},
        "errors": validation_ownership_errors(root, batches),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate staged Batch command ownership")
    parser.add_argument("command", choices=("validate", "report"))
    parser.add_argument("--workspace")
    parser.add_argument("--feature", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = resolve_workspace(args.workspace)
        bundle: PlanBundle = load_plan_bundle(workspace / ".autobizdevops" / "features" / resolve_feature(args.feature))
        result = ownership_report(bundle.root, bundle.batches)
        if args.command == "validate":
            result = {"ok": not result["errors"], **result}
        else:
            result = {"ok": True, **result}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    except (OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
