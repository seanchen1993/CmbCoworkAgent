#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Integrity and completion gates for Autodev evidence streams."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
HOOKS_DIR = ROOT / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from evidence_store import (  # noqa: E402
    EVIDENCE_ID_RE,
    EvidenceStoreError,
    index_path,
    load_index,
    read_records,
    snapshot,
    stream_path,
    validate_record,
)
from evidence_kernel import check_record_artifacts  # noqa: E402
from plan_json import (  # noqa: E402
    blocked_tasks,
    defer_to_test_stages_enabled,
    failed_tasks,
    load_and_validate_plan,
    plan_json_path,
    task_ids,
    tasks,
    unfinished_tasks,
)
PASS_RESULTS = {"pass", "passed", "success", "ok", "PASS", "PASS_WITH_WARNINGS"}


def _expected_evidence_id(index: int) -> str:
    return f"ev_{index:04d}"


def check_integrity(target_feature_dir: Path, *, require_index: bool = True) -> list[str]:
    errors: list[str] = []
    path = stream_path(target_feature_dir)
    if not path.is_file() or path.stat().st_size <= 0:
        return ["missing_evidence_stream"]

    try:
        records = read_records(path)
    except EvidenceStoreError as exc:
        return [str(exc)]
    if not records:
        errors.append("empty_evidence_stream")

    seen: set[str] = set()
    for line_no, record in enumerate(records, start=1):
        for reason in validate_record(record):
            errors.append(f"line={line_no}:{reason}")
        evidence_id = record.get("evidenceId")
        if isinstance(evidence_id, str):
            if evidence_id in seen:
                errors.append(f"duplicate_evidence_id:{evidence_id}")
            seen.add(evidence_id)
            if evidence_id != _expected_evidence_id(line_no):
                errors.append(f"non_sequential_evidence_id:line={line_no}:id={evidence_id}")
        task_id = record.get("taskId")
        if isinstance(task_id, str) and task_id and not task_id.startswith("T"):
            errors.append(f"line={line_no}:invalid_task_id:{task_id}")
        errors.extend(check_record_artifacts(target_feature_dir, record))

    try:
        index = load_index(target_feature_dir)
    except EvidenceStoreError as exc:
        errors.append(str(exc))
        index = None
    if index is None:
        if require_index:
            errors.append(f"missing_evidence_index:{index_path(target_feature_dir)}")
    else:
        snap = snapshot(target_feature_dir)
        if index.get("lineCount") != snap.line_count:
            errors.append("evidence_index_mismatch:lineCount")
        if index.get("lastEvidenceId") != snap.last_evidence_id:
            errors.append("evidence_index_mismatch:lastEvidenceId")
        if index.get("sha256") != snap.sha256:
            errors.append("evidence_stream_rewritten_or_truncated:sha256")
    return errors


def _validation_passed(record: dict[str, Any]) -> bool:
    if record.get("action") != "validation":
        return False
    validation = record.get("validation")
    if not isinstance(validation, dict):
        return False
    result = validation.get("result")
    if isinstance(result, str) and result.strip():
        return result.strip() in PASS_RESULTS and validation.get("exitCode") == 0
    exit_code = validation.get("exitCode")
    return exit_code == 0


def check_plan_evidence_refs(target_feature_dir: Path) -> list[str]:
    errors: list[str] = []
    plan, plan_errors = load_and_validate_plan(plan_json_path(target_feature_dir))
    if plan_errors:
        return [f"plan_json:{error}" for error in plan_errors]
    if plan is None:
        return ["missing_plan_json"]

    records = read_records(stream_path(target_feature_dir))
    known_evidence_ids = {
        evidence_id
        for evidence_id in (record.get("evidenceId") for record in records)
        if isinstance(evidence_id, str)
    }
    known_tasks = task_ids(plan)
    for record in records:
        task_id = record.get("taskId")
        if isinstance(task_id, str) and task_id and task_id not in known_tasks:
            errors.append(f"unknown_evidence_task_id:{task_id}")
    for task in tasks(plan):
        task_id = str(task.get("id", ""))
        evidence_ids = task.get("evidenceIds")
        if not isinstance(evidence_ids, list):
            continue
        for evidence_id in evidence_ids:
            if not isinstance(evidence_id, str) or not EVIDENCE_ID_RE.match(evidence_id):
                errors.append(f"{task_id}.invalid_evidence_id:{evidence_id}")
            elif evidence_id not in known_evidence_ids:
                errors.append(f"{task_id}.unknown_evidence_id:{evidence_id}")
    return errors


def check_code_done(target_feature_dir: Path) -> list[str]:
    errors = check_integrity(target_feature_dir, require_index=True)
    plan_path = plan_json_path(target_feature_dir)
    if not errors:
        errors.extend(check_plan_evidence_refs(target_feature_dir))

    plan, plan_errors = load_and_validate_plan(plan_path, require_all_done=True)
    if plan_errors:
        errors.extend(f"plan_json:{error}" for error in plan_errors)
        diagnostic_plan, _ = load_and_validate_plan(plan_path)
        if diagnostic_plan is not None:
            blocked = blocked_tasks(diagnostic_plan)
            if blocked:
                errors.append("unresolved_blocker:" + ",".join(blocked))
        return errors
    if plan is None:
        errors.append("missing_plan_json")
        return errors

    unfinished = unfinished_tasks(plan)
    if unfinished:
        errors.append("plan_json_unfinished_tasks:" + ",".join(unfinished))
    failed = failed_tasks(plan)
    if failed:
        errors.append("plan_json_failed_tasks:" + ",".join(failed))
    blocked = blocked_tasks(plan)
    if blocked:
        errors.append("unresolved_blocker:" + ",".join(blocked))

    try:
        records = read_records(stream_path(target_feature_dir))
    except EvidenceStoreError as exc:
        errors.append(str(exc))
        records = ()
    errors.extend(_check_completion(plan, records, feature_dir=target_feature_dir))
    return errors


def _check_completion(
    plan: dict[str, Any],
    records: tuple[dict[str, Any], ...],
    *,
    feature_dir: Path | None = None,
) -> list[str]:
    """Validate Code completion evidence for deferred validation."""
    errors: list[str] = []
    by_id = {
        str(record.get("evidenceId")): record
        for record in records
        if isinstance(record.get("evidenceId"), str)
    }
    if not defer_to_test_stages_enabled(plan):
        return ["taskValidationPolicy_not_supported"]

    for task in tasks(plan):
        task_id = str(task.get("id", ""))
        implementation_ids = task.get("implementationEvidenceIds")
        implementation_ids = implementation_ids if isinstance(implementation_ids, list) else []
        latest_implementation = task.get("latestImplementationEvidenceId")
        if not implementation_ids:
            errors.append(f"{task_id}.implementation_evidence_missing")
        if latest_implementation not in implementation_ids:
            errors.append(f"{task_id}.latest_implementation_evidence_invalid")
        elif latest_implementation != implementation_ids[-1]:
            errors.append(f"{task_id}.latest_implementation_evidence_not_latest")
        for evidence_id in implementation_ids:
            record = by_id.get(str(evidence_id))
            if (
                not isinstance(record, dict)
                or record.get("action") != "implementation"
                or record.get("taskId") != task_id
            ):
                errors.append(f"{task_id}.implementation_evidence_invalid:{evidence_id}")

        expected_files = task.get("expectedFiles")
        expected_files = expected_files if isinstance(expected_files, list) else []
        latest_record = by_id.get(str(latest_implementation))
        latest_changed_files = (
            latest_record.get("changedFiles", []) if isinstance(latest_record, dict) else []
        )
        evidence_files = {
            str(value).replace("\\", "/").lstrip("./")
            for value in latest_changed_files
            if isinstance(value, str) and value.strip()
        }
        for expected_file in expected_files:
            if not isinstance(expected_file, str) or not expected_file.strip():
                continue
            normalized = expected_file.replace("\\", "/").lstrip("./")
            if normalized not in evidence_files:
                errors.append(f"{task_id}.expected_file_not_in_latest_implementation_evidence:{expected_file}")

        completion_ids = task.get("completionEvidenceIds")
        completion_ids = completion_ids if isinstance(completion_ids, list) else []
        for evidence_id in completion_ids:
            record = by_id.get(str(evidence_id))
            if record is None:
                errors.append(f"{task_id}.completion_evidence_missing:{evidence_id}")
                continue
            if record.get("taskId") != task_id:
                errors.append(
                    f"{task_id}.evidence_task_mismatch:{evidence_id}:{record.get('taskId')}"
                )
            if not _validation_passed(record):
                errors.append(f"{task_id}.completion_evidence_not_pass:{evidence_id}")
                continue
            if record.get("detailVersion") != 2:
                errors.append(f"{task_id}.completion_evidence_requires_detail_v2:{evidence_id}")
                continue
    errors.extend(_check_batch_completion(plan, by_id, feature_dir=feature_dir))
    return errors


def _check_batch_completion(
    plan: dict[str, Any],
    by_id: dict[str, dict[str, Any]],
    *,
    feature_dir: Path | None = None,
) -> list[str]:
    """Validate the delivery closure used by the Code done gate."""
    errors: list[str] = []
    if not defer_to_test_stages_enabled(plan):
        return ["taskValidationPolicy_not_supported"]
    batch_plans = plan.get("_bundleBatches")
    if not isinstance(batch_plans, dict):
        return ["missing_batch_plan_projection"]

    # Multi-Batch Code is executed exclusively through the fixed DAG workflow.
    # Only the merger records the delivery and transitions the task from
    # implemented to done. Requiring a succeeded runtime manifest prevents a
    # manually edited plan from bypassing the merge and final verification
    # barriers.
    if len(batch_plans) > 1:
        run_ids: set[str] = set()
        for batch_id, batch in batch_plans.items():
            if not isinstance(batch, dict):
                continue
            merge_sha = batch.get("mergeCommitSha")
            if not isinstance(merge_sha, str) or not merge_sha.strip():
                errors.append(f"{batch_id}.parallel_merge_commit_missing")
            run_id = batch.get("deliveryRunId")
            if not isinstance(run_id, str) or not run_id.strip():
                errors.append(f"{batch_id}.parallel_delivery_run_missing")
            else:
                run_ids.add(run_id)
        if feature_dir is None:
            errors.append("parallel_delivery_feature_dir_missing")
        else:
            for run_id in sorted(run_ids):
                manifest_path = feature_dir / ".parallel-runs" / run_id / "manifest.json"
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    errors.append(f"parallel_delivery_manifest_missing:{run_id}")
                    continue
                verification = manifest.get("finalVerification") if isinstance(manifest, dict) else None
                if manifest.get("status") != "succeeded" or not isinstance(verification, dict) or verification.get("passed") is not True:
                    errors.append(f"parallel_delivery_not_verified:{run_id}")
    return errors


def _cmd_check(args: argparse.Namespace) -> int:
    target = Path(args.feature_dir).resolve()
    errors = check_integrity(target, require_index=not args.allow_missing_index)
    if args.refs:
        errors.extend(check_plan_evidence_refs(target))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"EVIDENCE_INTEGRITY_PASS path={stream_path(target)}")
    return 0


def _cmd_code_done(args: argparse.Namespace) -> int:
    target = Path(args.feature_dir).resolve()
    errors = check_code_done(target)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"CODE_DONE_EVIDENCE_PASS path={stream_path(target)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check Autodev evidence integrity")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("check")
    check.add_argument("--feature-dir", required=True)
    check.add_argument("--allow-missing-index", action="store_true")
    check.add_argument("--refs", action="store_true", help="Also validate plan.json evidence references")
    check.set_defaults(func=_cmd_check)

    code_done = subparsers.add_parser("code-done")
    code_done.add_argument("--feature-dir", required=True)
    code_done.set_defaults(func=_cmd_code_done)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
