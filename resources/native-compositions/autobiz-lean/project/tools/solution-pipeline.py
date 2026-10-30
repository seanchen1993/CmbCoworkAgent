import hashlib
import json
import sys
from typing import Any

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


if __name__ == "__main__":
    solution = json.load(sys.stdin)
    print(json.dumps(build_pipeline_contract(solution["plan"], solution["batches"]), ensure_ascii=False))
