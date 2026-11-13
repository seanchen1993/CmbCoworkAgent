#!/usr/bin/env python3
"""Durable stage state machine for staged parallel Batch execution."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import atomic_write_json, resolve_feature, resolve_workspace
from hooks.parallel_runtime import (
    append_event,
    DELIVERY_STAGES,
    load_manifest,
    run_dir,
    run_lock,
    save_manifest,
)


VALIDATION_STAGE_BY_BATCH = {"V-E2E": "e2e_test"}
STAGE_STATUSES = {"pending", "running", "passed", "failed", "stale", "skipped", "deferred", "needs_triage"}
FAILURE_NEXT_STAGE = {
    "implementation": "implement",
    "test_definition": "test",
    "documentation": "review",
    # Environment failures keep the same stage pending.  They are retryable
    # and must not invalidate previously-passed upstream evidence.
    "environment": "__retry__",
    "needs_triage": None,
}
# UTest is a bounded quality loop.  This value is mirrored by the Workflow
# runner and the scheduler so a model cannot keep a Batch in ``test`` merely
# by trying another command after the command-level timeout has fired.
UTEST_STAGE_TIMEOUT_SECONDS = 15 * 60


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def stage_names(batch: dict[str, Any]) -> tuple[str, ...]:
    batch_type = str(batch.get("type") or "delivery")
    if batch_type == "validation":
        stage = str(batch.get("validationStage") or VALIDATION_STAGE_BY_BATCH.get(str(batch.get("batchId")), "integration_test"))
        return ("prepare", stage)
    return DELIVERY_STAGES


def stage_template(batch: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        stage: {
            "status": "pending",
            "attempt": 0,
            "evidenceIds": [],
            "latestEvidenceId": None,
            "startedAt": None,
            "completedAt": None,
        }
        for stage in stage_names(batch)
    }


def _ensure_stage_states(batch: dict[str, Any]) -> dict[str, dict[str, Any]]:
    current = batch.get("stageStates")
    if not isinstance(current, dict):
        current = {}
        batch["stageStates"] = current
    for stage, template in stage_template(batch).items():
        value = current.get(stage)
        if not isinstance(value, dict):
            current[stage] = dict(template)
            continue
        value.setdefault("status", "pending")
        value.setdefault("attempt", 0)
        value.setdefault("evidenceIds", [])
        value.setdefault("latestEvidenceId", None)
        value.setdefault("startedAt", None)
        value.setdefault("completedAt", None)
    return current


def _pipeline(manifest: dict[str, Any]) -> dict[str, Any]:
    pipeline = manifest.get("pipeline")
    if not isinstance(pipeline, dict):
        raise ValueError("parallel_batch_pipeline_manifest_missing")
    return pipeline


def _batch(manifest: dict[str, Any], batch_id: str) -> dict[str, Any]:
    batch = manifest.get("batches", {}).get(batch_id)
    if not isinstance(batch, dict):
        batch = manifest.get("validationBatches", {}).get(batch_id)
    if not isinstance(batch, dict):
        raise ValueError(f"parallel_batch_not_found:{batch_id}")
    return batch


def _dependency_snapshot(manifest: dict[str, Any], batch: dict[str, Any]) -> dict[str, str]:
    snapshot: dict[str, str] = {}
    candidate_validation = batch.get("type") == "validation" and batch.get("validationStage") == "integration_test"
    for dependency in batch.get("dependencies", []):
        item = manifest.get("batches", {}).get(dependency)
        if isinstance(item, dict):
            sha = (item.get("commitSha") or item.get("mergeCommitSha")) if candidate_validation else (item.get("mergeCommitSha") or item.get("commitSha"))
            if isinstance(sha, str) and sha:
                snapshot[str(dependency)] = sha
    return snapshot


def reset_validation_batch(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    *,
    candidate_sha: str,
    candidate_base_sha: str,
    train_id: str,
    dependency_batch_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Start a new immutable validation attempt for a Merge Train candidate."""
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        if batch.get("type") != "validation":
            raise ValueError(f"parallel_validation_batch_required:{batch_id}")
        batch["status"] = "pending"
        batch["activeStage"] = None
        batch["candidateSha"] = candidate_sha
        batch["candidateBaseSha"] = candidate_base_sha
        batch["trainId"] = train_id
        if dependency_batch_ids is not None:
            batch["dependencies"] = sorted(set(dependency_batch_ids))
        batch["stageStates"] = stage_template(batch)
        save_manifest(workspace, feature, run_id, manifest)
    append_event(
        workspace,
        feature,
        run_id,
        "validation_batch_reset",
        batchId=batch_id,
        candidateSha=candidate_sha,
        candidateBaseSha=candidate_base_sha,
        trainId=train_id,
    )
    return {"batchId": batch_id, "status": "pending", "trainId": train_id}


def _stage_input(manifest: dict[str, Any], batch: dict[str, Any], stage: str, metadata: dict[str, Any]) -> dict[str, Any]:
    pipeline = _pipeline(manifest)
    command = metadata.get("command") if isinstance(metadata.get("command"), dict) else metadata.get("commands")
    command_digest = (
        "sha256:" + hashlib.sha256(json.dumps(command, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if command is not None
        else None
    )
    toolchain = metadata.get("toolchain") if isinstance(metadata.get("toolchain"), dict) else {}
    toolchain_digest = "sha256:" + hashlib.sha256(
        json.dumps(toolchain, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "planRevision": pipeline.get("planRevision"),
        "batchCommit": metadata.get("batchCommit") or metadata.get("candidateSha") or batch.get("candidateSha") or batch.get("commitSha"),
        "dependencies": _dependency_snapshot(manifest, batch),
        "commandDigest": command_digest,
        "toolchainDigest": toolchain_digest,
        "stage": stage,
    }


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _evidence_path(workspace: Path, feature: str, run_id: str, batch_id: str, stage: str, attempt: int) -> Path:
    return run_dir(workspace, feature, run_id) / "stages" / batch_id / stage / f"{attempt:03d}.json"


def next_stage(workspace: Path, feature: str, run_id: str, batch_id: str) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        for stage in stage_names(batch):
            state = states[stage]
            if state.get("status") in {"pending", "stale", "failed", "needs_triage"}:
                save_manifest(workspace, feature, run_id, manifest)
                return {
                    "batchId": batch_id,
                    "stage": stage,
                    "status": state.get("status"),
                    "attempt": state.get("attempt", 0),
                    "stageStates": states,
                }
            if state.get("status") == "running":
                save_manifest(workspace, feature, run_id, manifest)
                return {"batchId": batch_id, "stage": stage, "status": "running", "stageStates": states}
        save_manifest(workspace, feature, run_id, manifest)
        return {"batchId": batch_id, "stage": None, "status": "complete", "stageStates": states}


def start_stage(workspace: Path, feature: str, run_id: str, batch_id: str, stage: str) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        if stage not in states:
            raise ValueError(f"parallel_batch_stage_unknown:{batch_id}:{stage}")
        state = states[stage]
        # Workflow retries are normal after a host interruption.  A completed
        # stage must keep its original evidence, and a running stage must not
        # acquire a second attempt merely because the coordinator retried.
        if state.get("status") in {"passed", "skipped", "deferred"}:
            save_manifest(workspace, feature, run_id, manifest)
            return {
                "batchId": batch_id,
                "stage": stage,
                "attempt": state.get("attempt", 0),
                "status": state.get("status"),
                "reused": True,
            }
        if state.get("status") == "running":
            save_manifest(workspace, feature, run_id, manifest)
            return {
                "batchId": batch_id,
                "stage": stage,
                "attempt": state.get("attempt", 0),
                "status": "running",
                "reused": True,
            }
        expected = next(
            (
                name for name in stage_names(batch)
                if states[name].get("status") not in {"passed", "skipped", "deferred"}
            ),
            None,
        )
        if expected is None:
            raise ValueError(f"parallel_batch_stage_already_complete:{batch_id}")
        if expected != stage:
            raise ValueError(f"parallel_batch_stage_out_of_order:{batch_id}:expected={expected}:actual={stage}")
        if state.get("status") == "needs_triage":
            raise ValueError(f"parallel_batch_stage_needs_triage:{batch_id}:{stage}")
        state.update({"status": "running", "attempt": int(state.get("attempt", 0)) + 1, "startedAt": _utc_now(), "completedAt": None})
        batch["activeStage"] = stage
        save_manifest(workspace, feature, run_id, manifest)
    append_event(workspace, feature, run_id, "batch_stage_started", batchId=batch_id, stage=stage, attempt=state["attempt"])
    return {"batchId": batch_id, "stage": stage, "attempt": state["attempt"], "status": "running"}


def complete_stage(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    stage: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = dict(metadata or {})
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states.get(stage)
        if isinstance(state, dict) and state.get("status") in {"passed", "skipped", "deferred"}:
            return {
                "batchId": batch_id,
                "stage": stage,
                "status": state.get("status"),
                "evidenceId": state.get("latestEvidenceId"),
                "reused": True,
            }
        if not isinstance(state, dict) or state.get("status") != "running":
            raise ValueError(f"parallel_batch_stage_not_running:{batch_id}:{stage}")
        attempt = int(state.get("attempt", 0))
        inputs = _stage_input(manifest, batch, stage, metadata)
        evidence_id = f"STAGE-{batch_id}-{stage.upper()}-{attempt:03d}"
        evidence = {
            "evidenceId": evidence_id,
            "batchId": batch_id,
            "stage": stage,
            "attempt": attempt,
            "createdAt": _utc_now(),
            "inputs": inputs,
            "validity": {
                "type": "content_based",
                "invalidateOn": ["planRevision", "batchCommit", "dependencies", "commandDigest", "toolchainDigest"],
            },
            "metadata": metadata,
        }
        evidence["digest"] = _digest(evidence)
        path = _evidence_path(workspace, feature, run_id, batch_id, stage, attempt)
        atomic_write_json(path, evidence)
        repaired_failure = None
        if metadata.get("repairDisposition") == "single_repair_accepted":
            prior_failure = state.get("failure")
            if isinstance(prior_failure, dict):
                repaired_failure = dict(prior_failure)
            elif isinstance(metadata.get("repairedFailure"), dict):
                repaired_failure = dict(metadata["repairedFailure"])
        state.update({
            "status": "passed",
            "completedAt": evidence["createdAt"],
            "latestEvidenceId": evidence_id,
            "evidenceIds": [*state.get("evidenceIds", []), evidence_id],
            "inputDigest": _digest(inputs),
            "evidencePath": str(path),
            "failure": None,
        })
        if repaired_failure is not None:
            state["repairResolution"] = {
                "disposition": "single_repair_accepted",
                "failure": repaired_failure,
                "resolvedAt": evidence["createdAt"],
            }
        batch["activeStage"] = None
        save_manifest(workspace, feature, run_id, manifest)
    append_event(workspace, feature, run_id, "batch_stage_completed", batchId=batch_id, stage=stage, evidenceId=evidence_id)
    return {"batchId": batch_id, "stage": stage, "status": "passed", "evidenceId": evidence_id, "evidence": evidence}


def validate_review_result(workspace: Path, feature: str, run_id: str, batch_id: str) -> dict[str, Any]:
    """Return the durable Review decision in one canonical JSON shape.

    Review is made by a model, but the model's prose or tool-return text must
    never be the source of truth for the next Workflow transition.  In
    particular, an implementation finding resets Review to ``pending`` so the
    repaired commit can regenerate all evidence.  The logical decision is
    nevertheless a failed Review and must retain its original finding.
    """
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states.get("review")
        if not isinstance(state, dict):
            raise ValueError(f"parallel_batch_stage_unknown:{batch_id}:review")
        state_status = str(state.get("status") or "pending")
        failure = state.get("failure") if isinstance(state.get("failure"), dict) else None
        if state_status in {"passed", "skipped", "deferred"}:
            return {
                "success": True,
                "batchId": batch_id,
                "stage": "review",
                "status": "passed",
                "evidenceId": state.get("latestEvidenceId"),
                "reused": state_status != "passed",
            }
        if failure and isinstance(failure.get("type"), str) and isinstance(failure.get("message"), str) and failure["message"].strip():
            return {
                "success": True,
                "batchId": batch_id,
                "stage": "review",
                # ``fail_stage`` resets an implementation finding to pending
                # so the rework can rebuild prepare/implement/review evidence.
                # Expose the decision, not that transient reset state.
                "status": "needs_triage" if failure.get("type") == "needs_triage" else "failed",
                "nextStage": failure.get("nextStage"),
                "failure": dict(failure),
                "durableState": state_status,
            }
        return {
            "success": False,
            "batchId": batch_id,
            "stage": "review",
            "status": "incomplete",
            "durableState": state_status,
            "error": f"parallel_review_result_not_final:{batch_id}:{state_status}",
        }


def record_single_repair_resolution(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    *,
    failed_stage: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Replay the evidence sequence after one accepted repair through one CLI.

    This replaces a model-directed sequence of ``start``/``complete`` calls.
    A host interruption remains safely retryable because every transition is
    idempotent and each individual stage has durable evidence.
    """
    stages_by_failure = {
        "review": ("prepare", "implement", "review"),
        # A production defect first proven by UTest invalidates the code and
        # review evidence, but deliberately leaves ``test`` pending.  The
        # Workflow must rerun the exact failing command after the repair.
        "test": ("prepare", "implement", "review"),
    }
    stages = stages_by_failure.get(failed_stage)
    if stages is None:
        raise ValueError(f"parallel_single_repair_stage_invalid:{batch_id}:{failed_stage}")
    if not isinstance(metadata, dict):
        raise ValueError("parallel_single_repair_metadata_must_be_object")
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        failed_state = states.get(failed_stage)
        repaired_failure = (
            dict(failed_state.get("failure"))
            if isinstance(failed_state, dict) and isinstance(failed_state.get("failure"), dict)
            else None
        )
    # A test-proven source defect rebuilds prepare/implement/review but leaves
    # the test itself pending for its exact-command retry. Persist the accepted
    # repair marker on that rebuilt Review evidence, which is also where later
    # UTest failures can reliably determine that the one repair was used.
    repair_marker_stage = failed_stage if failed_stage in stages else stages[-1]
    completed: list[dict[str, Any]] = []
    for stage in stages:
        start_stage(workspace, feature, run_id, batch_id, stage)
        stage_metadata = dict(metadata)
        if stage == repair_marker_stage:
            stage_metadata["repairDisposition"] = "single_repair_accepted"
            if repaired_failure is not None:
                stage_metadata["repairedFailure"] = repaired_failure
        completed.append(complete_stage(
            workspace,
            feature,
            run_id,
            batch_id,
            stage,
            metadata=stage_metadata,
        ))
    final = completed[-1]
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        review = states.get("review") if isinstance(states.get("review"), dict) else {}
        resolution = review.get("repairResolution") if isinstance(review.get("repairResolution"), dict) else {}
        if resolution.get("disposition") != "single_repair_accepted":
            raise ValueError(f"parallel_single_repair_resolution_missing:{batch_id}:{failed_stage}")
    return {
        "success": True,
        "batchId": batch_id,
        "failedStage": failed_stage,
        "status": "success",
        "stage": final.get("stage"),
        "stageEvidenceId": final.get("evidenceId"),
        "stages": completed,
    }


def fail_stage(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    stage: str,
    *,
    failure_type: str,
    message: str,
) -> dict[str, Any]:
    # Test/environment failures are final only after UTest has exhausted its
    # bounded local retry.  A production defect found by a real failing test
    # follows the ordinary implementation-repair path below: it resets stale
    # delivery evidence and returns the Batch to the same Worktree for repair.
    if stage == "test" and failure_type != "implementation":
        return record_test_failure(
            workspace,
            feature,
            run_id,
            batch_id,
            failure_type=failure_type,
            message=message,
        )
    if stage == "test" and failure_type == "implementation":
        # A source failure proven by UTest gets exactly one controlled
        # production repair. If the original command still proves the same
        # class of source failure after that repair, close it as a visible
        # UTest deferral rather than restarting another repair/compile loop.
        with run_lock(workspace, feature, run_id):
            manifest = load_manifest(workspace, feature, run_id)
            batch = _batch(manifest, batch_id)
            states = _ensure_stage_states(batch)
            review = states.get("review") if isinstance(states.get("review"), dict) else {}
            resolution = review.get("repairResolution") if isinstance(review.get("repairResolution"), dict) else {}
            repair_already_used = resolution.get("disposition") == "single_repair_accepted"
        if repair_already_used:
            return record_test_failure(
                workspace,
                feature,
                run_id,
                batch_id,
                failure_type=failure_type,
                message=message,
            )
    if failure_type not in FAILURE_NEXT_STAGE:
        raise ValueError(f"parallel_batch_failure_type_invalid:{failure_type}")
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states.get(stage)
        if not isinstance(state, dict) or state.get("status") != "running":
            raise ValueError(f"parallel_batch_stage_not_running:{batch_id}:{stage}")
        next_name = FAILURE_NEXT_STAGE[failure_type]
        validation_repair = batch.get("type") == "validation" and failure_type == "implementation"
        if validation_repair:
            next_name = "create_repair_batch"
        state.update({
            "status": "needs_triage" if failure_type == "needs_triage" else "failed",
            "completedAt": _utc_now(),
            "failure": {"type": failure_type, "message": message, "nextStage": next_name},
        })
        if validation_repair:
            batch["activeStage"] = None
            batch["status"] = "blocked"
        elif next_name == "__retry__":
            state.update({"status": "pending", "completedAt": None})
            state["failure"]["nextStage"] = stage
            batch["activeStage"] = None
            # A UTest agent can fail after it has re-sealed test assets. Keep
            # that delivery releasable and recoverable rather than downgrading
            # it to ``running`` and then rejecting `release --final-status
            # sealed` for the same lease.
            batch["status"] = "sealed" if batch.get("commitSha") else "running"
            next_name = stage
        elif next_name is not None:
            # A production repair changes the delivery commit.  All delivery
            # evidence must be regenerated against that new commit, not only
            # the downstream stage that first reported the issue.
            reset_from = (
                "prepare"
                if failure_type == "implementation" and stage in {"review", "test"}
                else next_name
            )
            reset = False
            for name in stage_names(batch):
                if name == reset_from:
                    reset = True
                if reset:
                    states[name].update({"status": "pending", "latestEvidenceId": None, "completedAt": None})
            batch["activeStage"] = None
            batch["status"] = "sealed" if batch.get("commitSha") else "running"
        else:
            batch["status"] = "blocked" if failure_type == "needs_triage" else "failed"
        save_manifest(workspace, feature, run_id, manifest)
    append_event(workspace, feature, run_id, "batch_stage_failed", batchId=batch_id, stage=stage, failureType=failure_type)
    return {
        "batchId": batch_id,
        "stage": stage,
        "status": state["status"],
        "nextStage": next_name,
        # The Workflow needs the original finding to distinguish a genuine
        # follow-up issue from an unchanged review result after a repair.
        # Returning it also keeps the recovery decision evidence-bound.
        "failure": dict(state.get("failure") or {}),
    }


def record_test_failure(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    *,
    failure_type: str,
    message: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Durably defer a non-repairable UTest failure without claiming a pass.

    This is the terminal escape hatch for an exhausted test/environment retry
    budget. It keeps the evidence and lets this delivery continue as an
    explicitly unverified candidate. The final B-E2E remains mandatory and
    the deferred UTest finding remains visible in the run result.
    """
    if failure_type not in FAILURE_NEXT_STAGE:
        raise ValueError(f"parallel_batch_failure_type_invalid:{failure_type}")
    metadata = dict(metadata or {})
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states.get("test")
        if not isinstance(state, dict) or state.get("status") != "running":
            raise ValueError(f"parallel_batch_stage_not_running:{batch_id}:test")
        failure = {
            "type": failure_type,
            "message": message,
            "nextStage": None,
        }
        issue_index = 1 + sum(
            1
            for item in manifest.get("deferredIssues", [])
            if isinstance(item, dict)
            and item.get("batchId") == batch_id
            and item.get("stage") == "test"
            and item.get("kind") == "test_failure"
        )
        issue_id = f"TEST-FAILED-{batch_id}-{issue_index:03d}"

    # Record the failure in normal immutable stage evidence before changing
    # state to ``deferred``.  This lets aggregate/reporting distinguish it
    # from a passed UTest without treating it as a successful test run.
    completed = complete_stage(
        workspace,
        feature,
        run_id,
        batch_id,
        "test",
        metadata={
            **metadata,
            "testFailure": failure,
            "testFailureDisposition": "recorded_deferred",
            "testFailureIssueId": issue_id,
        },
    )
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states["test"]
        if state.get("status") != "passed" or state.get("latestEvidenceId") != completed.get("evidenceId"):
            raise ValueError(f"parallel_batch_test_failure_completion_changed:{batch_id}")
        issue = {
            "issueId": issue_id,
            "kind": "test_failure",
            "batchId": batch_id,
            "stage": "test",
            "failureType": failure_type,
            "message": message,
            "disposition": "recorded_deferred",
            "blocksWorkflow": False,
            "status": "open",
            "evidenceId": completed["evidenceId"],
            "batchCommit": (completed.get("evidence") or {}).get("inputs", {}).get("batchCommit"),
            "createdAt": _utc_now(),
        }
        issues = manifest.setdefault("deferredIssues", [])
        if not isinstance(issues, list):
            raise ValueError("parallel_deferred_issues_invalid")
        issues.append(issue)
        state.update({
            "status": "deferred",
            "failure": failure,
            "deferredIssueId": issue_id,
            "deferredDisposition": "test_failure_recorded_deferred",
        })
        batch["activeStage"] = None
        save_manifest(workspace, feature, run_id, manifest)
    append_event(
        workspace,
        feature,
        run_id,
        "batch_test_failure_recorded",
        batchId=batch_id,
        stage="test",
        issueId=issue_id,
        failureType=failure_type,
    )
    return {"success": True, "batchId": batch_id, "stage": "test", "status": "deferred", "issue": issue}


def defer_stage(
    workspace: Path,
    feature: str,
    run_id: str,
    batch_id: str,
    stage: str,
    *,
    disposition: str,
) -> dict[str, Any]:
    """Persist an unresolved implementation finding and advance the pipeline."""
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states.get(stage)
        if not isinstance(state, dict) or state.get("status") not in {"pending", "failed"}:
            raise ValueError(f"parallel_batch_stage_not_deferable:{batch_id}:{stage}")
        failure = dict(state.get("failure") or {})
        if failure.get("type") != "implementation" or failure.get("nextStage") != "implement":
            raise ValueError(f"parallel_batch_stage_deferred_failure_invalid:{batch_id}:{stage}")
        issue_index = 1 + sum(
            1
            for item in manifest.get("deferredIssues", [])
            if isinstance(item, dict) and item.get("batchId") == batch_id and item.get("stage") == stage
        )
        issue_id = f"DEFERRED-{batch_id}-{stage.upper()}-{issue_index:03d}"

    # Write ordinary, content-bound evidence first.  The state is then made
    # explicitly ``deferred`` so it cannot be mistaken for a successful review.
    start_stage(workspace, feature, run_id, batch_id, stage)
    completed = complete_stage(
        workspace,
        feature,
        run_id,
        batch_id,
        stage,
        metadata={"deferredIssueId": issue_id, "deferredDisposition": disposition, "failure": failure},
    )
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states[stage]
        if state.get("status") != "passed" or state.get("latestEvidenceId") != completed.get("evidenceId"):
            raise ValueError(f"parallel_batch_stage_defer_completion_changed:{batch_id}:{stage}")
        issue = {
            "issueId": issue_id,
            "kind": "implementation_finding",
            "batchId": batch_id,
            "stage": stage,
            "failureType": failure["type"],
            "message": str(failure.get("message") or "implementation_issue"),
            "disposition": disposition,
            "blocksWorkflow": True,
            "status": "open",
            "evidenceId": completed["evidenceId"],
            "batchCommit": (completed.get("evidence") or {}).get("inputs", {}).get("batchCommit"),
            "createdAt": _utc_now(),
        }
        issues = manifest.setdefault("deferredIssues", [])
        if not isinstance(issues, list):
            raise ValueError("parallel_deferred_issues_invalid")
        issues.append(issue)
        state.update({"status": "deferred", "failure": failure, "deferredIssueId": issue_id})
        batch["activeStage"] = None
        save_manifest(workspace, feature, run_id, manifest)
    append_event(workspace, feature, run_id, "batch_stage_deferred", batchId=batch_id, stage=stage, issueId=issue_id, disposition=disposition)
    return {"success": True, "batchId": batch_id, "stage": stage, "status": "deferred", "issue": issue}


def gate_batch(workspace: Path, feature: str, run_id: str, batch_id: str) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        deferred = [stage for stage in stage_names(batch) if states[stage].get("status") == "deferred"]
        # UTest is the only delivery stage that may defer without stopping its
        # Batch. It is explicitly carried to an `allow-unverified` candidate
        # and final B-E2E. Deferred prepare/implement/review findings still
        # represent unresolved production-quality issues and block the gate.
        blocking_deferred = [stage for stage in deferred if stage != "test"]
        if blocking_deferred:
            batch["status"] = "blocked"
            batch["activeStage"] = None
            save_manifest(workspace, feature, run_id, manifest)
            return {
                "success": False,
                "batchId": batch_id,
                "error": "parallel_batch_stage_gate_deferred_findings",
                "deferredStages": blocking_deferred,
            }
        missing = [
            stage
            for stage in stage_names(batch)
            if states[stage].get("status") not in {"passed", "skipped"}
            and stage not in deferred
        ]
        if missing:
            return {"success": False, "batchId": batch_id, "error": "parallel_batch_stage_gate_incomplete", "missingStages": missing}
        if str(batch.get("type") or "delivery") == "validation":
            batch["status"] = "verified"
        elif not isinstance(batch.get("commitSha"), str) or not batch.get("commitSha"):
            return {"success": False, "batchId": batch_id, "error": "parallel_batch_stage_gate_delivery_not_sealed"}
        else:
            batch["status"] = "ready_to_candidate"
        batch["activeStage"] = None
        save_manifest(workspace, feature, run_id, manifest)
    append_event(workspace, feature, run_id, "batch_stage_gate_passed", batchId=batch_id, status=batch["status"])
    return {
        "success": True,
        "batchId": batch_id,
        "status": batch["status"],
        "continuedTestFailureStages": [stage for stage in deferred if stage == "test"],
    }


def triage_failure(workspace: Path, feature: str, run_id: str, batch_id: str, stage: str, failure_type: str) -> dict[str, Any]:
    with run_lock(workspace, feature, run_id):
        manifest = load_manifest(workspace, feature, run_id)
        batch = _batch(manifest, batch_id)
        states = _ensure_stage_states(batch)
        state = states.get(stage)
        if not isinstance(state, dict) or state.get("status") != "needs_triage":
            raise ValueError(f"parallel_batch_stage_not_waiting_for_triage:{batch_id}:{stage}")
        message = str((state.get("failure") or {}).get("message") or "triaged")
        # ``fail_stage`` is intentionally the only function that records the
        # classification.  Restore the transient running state so it can
        # apply the normal failure transition under a fresh lock.
        state["status"] = "running"
        save_manifest(workspace, feature, run_id, manifest)
    return fail_stage(workspace, feature, run_id, batch_id, stage, failure_type=failure_type, message=message)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Advance a staged parallel Batch")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("next", "start", "complete", "fail", "record-test-failure", "defer", "gate", "triage-failure", "reset-validation", "validate-review-result", "record-single-repair"):
        item = sub.add_parser(name)
        item.add_argument("--workspace")
        item.add_argument("--feature", required=True)
        item.add_argument("--run-id", required=True)
        item.add_argument("--batch-id", required=True)
        if name in {"start", "complete", "fail", "defer", "triage-failure"}:
            item.add_argument("--stage", required=True)
        if name == "complete":
            item.add_argument("--metadata-json", default="{}")
        if name in {"fail", "record-test-failure", "triage-failure"}:
            item.add_argument("--failure-type", required=True, choices=tuple(FAILURE_NEXT_STAGE))
        if name in {"fail", "record-test-failure"}:
            item.add_argument("--message", required=True)
        if name == "record-test-failure":
            item.add_argument("--metadata-json", default="{}")
        if name == "defer":
            item.add_argument("--disposition", required=True, choices=("repeated_feedback", "repair_limit_reached", "no_new_commit"))
        if name == "reset-validation":
            item.add_argument("--candidate-sha", required=True)
            item.add_argument("--candidate-base-sha", required=True)
            item.add_argument("--train-id", required=True)
        if name == "record-single-repair":
            item.add_argument("--failed-stage", required=True)
            item.add_argument("--metadata-json", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
        if args.command == "next":
            result = next_stage(workspace, feature, args.run_id, args.batch_id)
        elif args.command == "start":
            result = start_stage(workspace, feature, args.run_id, args.batch_id, args.stage)
        elif args.command == "complete":
            metadata = json.loads(args.metadata_json)
            if not isinstance(metadata, dict):
                raise ValueError("parallel_batch_stage_metadata_must_be_object")
            result = complete_stage(workspace, feature, args.run_id, args.batch_id, args.stage, metadata=metadata)
        elif args.command == "fail":
            result = fail_stage(workspace, feature, args.run_id, args.batch_id, args.stage, failure_type=args.failure_type, message=args.message)
        elif args.command == "record-test-failure":
            metadata = json.loads(args.metadata_json)
            if not isinstance(metadata, dict):
                raise ValueError("parallel_batch_stage_metadata_must_be_object")
            result = record_test_failure(
                workspace,
                feature,
                args.run_id,
                args.batch_id,
                failure_type=args.failure_type,
                message=args.message,
                metadata=metadata,
            )
        elif args.command == "defer":
            result = defer_stage(workspace, feature, args.run_id, args.batch_id, args.stage, disposition=args.disposition)
        elif args.command == "triage-failure":
            result = triage_failure(workspace, feature, args.run_id, args.batch_id, args.stage, args.failure_type)
        elif args.command == "reset-validation":
            result = reset_validation_batch(
                workspace,
                feature,
                args.run_id,
                args.batch_id,
                candidate_sha=args.candidate_sha,
                candidate_base_sha=args.candidate_base_sha,
                train_id=args.train_id,
            )
        elif args.command == "validate-review-result":
            result = validate_review_result(workspace, feature, args.run_id, args.batch_id)
        elif args.command == "record-single-repair":
            metadata = json.loads(args.metadata_json)
            result = record_single_repair_resolution(
                workspace,
                feature,
                args.run_id,
                args.batch_id,
                failed_stage=args.failed_stage,
                metadata=metadata,
            )
        else:
            result = gate_batch(workspace, feature, args.run_id, args.batch_id)
        print(json.dumps({"ok": result.get("success", True), **result}, ensure_ascii=False, indent=2))
        return 0 if result.get("success", True) else 1
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
