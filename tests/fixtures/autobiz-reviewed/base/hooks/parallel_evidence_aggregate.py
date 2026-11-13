#!/usr/bin/env python3
"""Read-only completion gate for the staged parallel pipeline.

No command is executed here.  The aggregate validates that the evidence which
already exists still matches the exact Plan revision, delivery commit and
dependency commits being declared complete.
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

from hooks.json_writer_common import atomic_write_json, resolve_feature, resolve_workspace
from hooks.plan_write_ownership import is_test_asset_path
from hooks.parallel_runtime import append_event, load_manifest, run_dir, run_lock, save_manifest, utc_now


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _read_evidence(path: str | None) -> dict[str, Any] | None:
    if not isinstance(path, str) or not path:
        return None
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _dependency_snapshot(manifest: dict[str, Any], batch: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    candidate_validation = batch.get("type") == "validation" and batch.get("validationStage") == "integration_test"
    for dependency in batch.get("dependencies", []):
        item = manifest.get("batches", {}).get(dependency)
        if isinstance(item, dict):
            sha = (item.get("commitSha") or item.get("mergeCommitSha")) if candidate_validation else (item.get("mergeCommitSha") or item.get("commitSha"))
            if isinstance(sha, str) and sha:
                result[str(dependency)] = sha
    return result


def _evidence_errors(manifest: dict[str, Any], batch_id: str, batch: dict[str, Any]) -> list[str]:
    pipeline = manifest.get("pipeline") if isinstance(manifest.get("pipeline"), dict) else {}
    states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
    errors: list[str] = []
    for stage, state in states.items():
        if not isinstance(state, dict) or state.get("status") not in {"passed", "skipped", "deferred"}:
            errors.append(f"{batch_id}.{stage}_not_passed")
            continue
        if state.get("status") == "skipped":
            continue
        evidence = _read_evidence(state.get("evidencePath"))
        if evidence is None:
            errors.append(f"{batch_id}.{stage}_evidence_missing")
            continue
        if evidence.get("digest") != _digest({key: value for key, value in evidence.items() if key != "digest"}):
            errors.append(f"{batch_id}.{stage}_evidence_digest_invalid")
            continue
        inputs = evidence.get("inputs") if isinstance(evidence.get("inputs"), dict) else {}
        if inputs.get("planRevision") != pipeline.get("planRevision"):
            errors.append(f"{batch_id}.{stage}_plan_revision_stale")
        if batch.get("type") == "validation":
            expected_commit = batch.get("candidateSha")
        else:
            expected_commit = batch.get("commitSha")
        if expected_commit and inputs.get("batchCommit") != expected_commit:
            last_seal = batch.get("lastSeal") if isinstance(batch.get("lastSeal"), dict) else {}
            valid_utest_reseal = (
                stage in {"prepare", "implement", "review"}
                and last_seal.get("purpose") == "utest"
                and last_seal.get("commitSha") == expected_commit
                and last_seal.get("previousCommitSha") == inputs.get("batchCommit")
                and all(
                    isinstance(path, str) and is_test_asset_path(path)
                    for path in last_seal.get("changedFiles", [])
                )
            )
            if not valid_utest_reseal:
                errors.append(f"{batch_id}.{stage}_batch_commit_stale")
        if inputs.get("dependencies") != _dependency_snapshot(manifest, batch):
            errors.append(f"{batch_id}.{stage}_dependency_stale")
        if batch_id == "V-E2E" and stage == "e2e_test":
            metadata = evidence.get("metadata") if isinstance(evidence.get("metadata"), dict) else {}
            environment = metadata.get("environment") if isinstance(metadata.get("environment"), dict) else {}
            if not isinstance(environment.get("version"), str) or not environment.get("version"):
                errors.append("V-E2E.e2e_environment_version_missing")
            if not isinstance(environment.get("seedDataDigest"), str) or not environment.get("seedDataDigest"):
                errors.append("V-E2E.e2e_seed_data_digest_missing")
            if not isinstance(environment.get("dependencies"), dict):
                errors.append("V-E2E.e2e_dependencies_missing")
    return errors


def aggregate_evidence(workspace: Path, feature: str, run_id: str) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        errors: list[str] = []
        deliveries = manifest.get("batches", {})
        for batch_id, batch in deliveries.items():
            if not isinstance(batch, dict):
                errors.append(f"{batch_id}.invalid")
                continue
            if batch.get("status") != "merged" or not batch.get("mergeCommitSha"):
                errors.append(f"{batch_id}.not_merged")
            errors.extend(_evidence_errors(manifest, batch_id, batch))
        validations = manifest.get("validationBatches", {})
        for validation_id in ("V-E2E",):
            batch = validations.get(validation_id) if isinstance(validations, dict) else None
            if not isinstance(batch, dict) or batch.get("status") != "verified":
                errors.append(f"{validation_id}.not_verified")
                continue
            errors.extend(_evidence_errors(manifest, validation_id, batch))
        # Each delivery has passed its own Review and UTest before promotion.
        # The only post-merge executable validation is V-E2E; merge-train
        # records still prove that main advanced to each exact candidate SHA.
        trains = manifest.get("mergeTrains", {})
        if not isinstance(trains, dict) or not trains:
            errors.append("merge_train_records_missing")
        else:
            for train_id, record in sorted(trains.items()):
                if not isinstance(record, dict):
                    errors.append(f"merge_train_invalid:{train_id}")
                    continue
                if record.get("status") != "promoted":
                    errors.append(f"merge_train_not_promoted:{train_id}")
                    continue
                candidate_sha = record.get("candidateSha")
                promoted_sha = record.get("promotedSha")
                if not isinstance(candidate_sha, str) or candidate_sha != promoted_sha:
                    errors.append(f"merge_train_promoted_sha_invalid:{train_id}")
                validation = record.get("validation")
                if not isinstance(validation, dict) or validation.get("skipped") is not True:
                    commands = validation.get("commands") if isinstance(validation, dict) else None
                    if not isinstance(commands, list) or not commands:
                        errors.append(f"merge_train_validation_missing:{train_id}")
                    elif any(not isinstance(item, dict) or item.get("passed") is not True for item in commands):
                        errors.append(f"merge_train_validation_failed:{train_id}")
        deferred_issues = list(manifest.get("deferredIssues", [])) if isinstance(manifest.get("deferredIssues"), list) else []
        blocking_deferred_issues = [
            item
            for item in deferred_issues
            if not isinstance(item, dict) or item.get("blocksWorkflow") is not False
        ]
        report = {
            "runId": run_id,
            "createdAt": utc_now(),
            "mode": "evidence_aggregate_only",
            "passed": not errors,
            "errors": sorted(set(errors)),
            "pipelineRevision": (manifest.get("pipeline") or {}).get("planRevision"),
            "deferredIssues": deferred_issues,
        }
        report["hasDeferredIssues"] = bool(report["deferredIssues"])
        report["hasBlockingDeferredIssues"] = bool(blocking_deferred_issues)
        if report["hasBlockingDeferredIssues"]:
            # Delivery gates must already have stopped these findings before
            # merge.  Keep this final check as a defence against old or
            # externally-edited manifests, rather than reporting success with
            # known implementation defects.
            report["errors"] = sorted({*report["errors"], "deferred_implementation_findings_unresolved"})
            report["passed"] = False
        manifest["finalEvidenceAggregate"] = report
        manifest["status"] = (
            "succeeded_with_issues"
            if report["passed"] and report["hasDeferredIssues"]
            else "succeeded"
            if report["passed"]
            else "blocked"
        )
        save_manifest(workspace, feature, run_id, manifest)
        atomic_write_json(run_dir(workspace, feature, run_id) / "final-evidence-aggregate.json", report)
    append_event(workspace, feature, run_id, "evidence_aggregate_completed", passed=report["passed"], errors=report["errors"])
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Aggregate staged parallel evidence without running commands")
    parser.add_argument("--workspace")
    parser.add_argument("--feature", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    try:
        result = aggregate_evidence(resolve_workspace(args.workspace), resolve_feature(args.feature), args.run_id)
        print(json.dumps({"ok": result["passed"], **result}, ensure_ascii=False, indent=2))
        return 0 if result["passed"] else 1
    except (ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
