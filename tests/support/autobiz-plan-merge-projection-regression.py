"""Read-only Plan projection assertions, with reversible private-fixture fault injection."""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def check(plugin: Path, workspace: Path, feature: str) -> dict:
    sys.path.insert(0, str(plugin))
    from hooks.plan_writer import _load, _project_batches
    from hooks.evidence_integrity_gate import check_code_done
    from hooks.parallel_runtime import manifest_path
    from hooks.parallel_evidence_aggregate import aggregate_evidence
    feature_dir = workspace / ".autobizdevops/features" / feature
    original = _load(workspace, feature)
    def projected(data: dict) -> tuple[dict, dict]:
        return _project_batches(data, workspace=workspace, feature=feature)
    root, batches = projected(original)
    assert root["status"] == "done", root
    assert all(batch["status"] == "done" for batch in batches.values())
    assert all(batch["completedAt"] == batch["mergedAt"] for batch in batches.values())
    assert check_code_done(feature_dir) == [], check_code_done(feature_dir)
    negatives = []
    for field, value in (("mergeCommitSha", None), ("deliveryRunId", None), ("mergedAt", None),
            ("mergeCommitSha", "f" * 40), ("deliveryRunId", "cw-19990101-000000-000"),
            ("mergedAt", "invalid")):
        candidate = copy.deepcopy(original)
        receipt = candidate["_batchPlans"]["B001"]
        if value is None:
            receipt.pop(field, None)
        else:
            receipt[field] = value
        negative_root, negative_batches = projected(candidate)
        assert negative_root["status"] != "done"
        assert negative_batches["B001"]["status"] != "done"
        negatives.append("missing_" + field if value is None else "forged_" + field)
    candidate = copy.deepcopy(original)
    candidate["tasks"][0]["status"] = "failed"
    negative_root, negative_batches = projected(candidate)
    assert negative_root["status"] != "done" and negative_batches["B001"]["status"] != "done"
    negatives.append("failed_task")
    run_id = original["_batchPlans"]["B001"]["deliveryRunId"]
    path = manifest_path(workspace, feature, run_id)
    path.resolve().relative_to(workspace.resolve())
    bytes_before = path.read_bytes()
    manifest = json.loads(bytes_before)
    # These mutate only the private sample's original runtime record, restore
    # exact bytes after each check, and never create successful evidence.
    faults = [
        ("failed_test_stage", lambda value: value["batches"]["B001"]["stageStates"]["test"].update(status="failed")),
        ("wrong_task_identity", lambda value: value["batches"]["B001"].update(taskIds=["T999"])),
        ("wrong_feature", lambda value: value.update(featureId="other-feature")),
        ("unpromoted_train", lambda value: [train.update(status="built") for train in value["mergeTrains"].values()]),
        ("wrong_live_head_binding", lambda value: [binding.update(headSha="f" * 40) for binding in value["repositories"].values()]),
        ("wrong_promoted_commit", lambda value: [train.update(promotedSha="f" * 40) for train in value["mergeTrains"].values()]),
    ]
    for name, mutate in faults:
        broken = copy.deepcopy(manifest)
        mutate(broken)
        try:
            path.write_text(json.dumps(broken), encoding="utf-8")
            negative_root, negative_batches = projected(original)
            assert negative_root["status"] != "done", name
            assert negative_batches["B001"]["status"] != "done", name
        finally:
            path.write_bytes(bytes_before)
        negatives.append(name)
    assert path.read_bytes() == bytes_before
    assert check_code_done(feature_dir) == []
    evidence = Path(manifest["batches"]["B001"]["stageStates"]["review"]["evidencePath"])
    evidence.resolve(strict=True).relative_to(workspace.resolve())
    evidence_bytes = evidence.read_bytes()
    for name in ("deleted_actual_stage_evidence", "corrupted_actual_stage_evidence"):
        try:
            if name.startswith("deleted"):
                evidence.unlink()
            else:
                broken_evidence = json.loads(evidence_bytes)
                broken_evidence["metadata"]["tampered"] = True
                evidence.write_text(json.dumps(broken_evidence), encoding="utf-8")
            rejected = aggregate_evidence(workspace, feature, run_id)
            assert rejected["passed"] is False, name
            current = json.loads(path.read_text(encoding="utf-8"))
            assert "finalVerification" not in current, "earlier success must be invalidated"
            assert current["finalEvidenceAggregate"]["passed"] is False
            assert check_code_done(feature_dir), "unchanged original code_done must reject"
        finally:
            evidence.write_bytes(evidence_bytes)
        restored = aggregate_evidence(workspace, feature, run_id)
        assert restored["passed"] is True
        current = json.loads(path.read_text(encoding="utf-8"))
        assert current["finalVerification"] == current["finalEvidenceAggregate"]
        assert check_code_done(feature_dir) == []
        negatives.append(name)
    successful_manifest = path.read_bytes()
    deferred = json.loads(successful_manifest)
    deferred["deferredIssues"] = [{"blocksWorkflow": False,
        "kind": "test_failure", "message": "negative fixture: unresolved test finding"}]
    try:
        path.write_text(json.dumps(deferred), encoding="utf-8")
        reported = aggregate_evidence(workspace, feature, run_id)
        assert reported["hasDeferredIssues"] is True
        current = json.loads(path.read_text(encoding="utf-8"))
        assert "finalVerification" not in current
        assert check_code_done(feature_dir)
    finally:
        path.write_bytes(successful_manifest)
    assert check_code_done(feature_dir) == []
    negatives.append("deferred_finding_removes_legacy_success")
    return {"passed": True, "actualOriginalCodeDone": True,
        "batchStatuses": {key: batch["status"] for key, batch in batches.items()},
        "completedAtFromOriginalMergedAt": True, "negativeCases": negatives,
        "faultInjectionRestored": True, "newEvidenceCreated": False,
        "actualAggregateFailureInvalidatesOldLegacySuccess": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--feature", default="alpha")
    args = parser.parse_args()
    print(json.dumps(check(args.plugin_root.resolve(strict=True),
        args.workspace.resolve(strict=True), args.feature)))
