#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run advisory smoke tests and record non-blocking smoke evidence."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
HOOKS_DIR = ROOT / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from board_core.state_store import load_state_json_records_result  # noqa: E402
from evidence_store import EvidenceStoreError, append_evidence  # noqa: E402
from paths import get_plugin_output_workspace, resolve_env_feature  # noqa: E402


OUTPUT_TAIL_LIMIT = 4000
DEFAULT_TIMEOUT_SECONDS = 300


def _tail_output(stdout: str, stderr: str) -> str:
    combined = "\n".join(part for part in [stdout.strip(), stderr.strip()] if part)
    return combined[-OUTPUT_TAIL_LIMIT:]


def _feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def _current_checkpoint(workspace: Path, feature: str) -> str:
    result = load_state_json_records_result(workspace)
    if result.exists and not result.errors:
        record = result.records.get(feature)
        if isinstance(record, dict) and isinstance(record.get("checkpoint"), str):
            return record["checkpoint"]
    return "code_in_progress"


def _load_smoke_plan(feature_dir: Path) -> dict[str, Any]:
    path = feature_dir / "SMOKE_TEST_PLAN.json"
    if not path.is_file() or path.stat().st_size <= 0:
        return {
            "version": 1,
            "featureId": feature_dir.name,
            "flowBlocking": False,
            "skipReason": "SMOKE_TEST_PLAN.json missing",
            "tests": [],
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid SMOKE_TEST_PLAN.json: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("invalid SMOKE_TEST_PLAN.json: root must be object")
    return data


def _run_command(command: str, *, cwd: Path, timeout: int) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            shell=True,
            text=True,
            capture_output=True,
            env={**os.environ, "PYTHONUTF8": "1"},
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = _tail_output(exc.stdout or "", exc.stderr or "")
        return 124, "blocked", output or f"command timed out after {timeout} seconds"
    except OSError as exc:
        return 127, "blocked", str(exc)

    output = _tail_output(completed.stdout, completed.stderr)
    return completed.returncode, "pass" if completed.returncode == 0 else "fail", output


def _git_repo_root(root: Path) -> Path | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return Path(value).resolve() if value else None


def _git_source_errors(workspace: Path, source_path: str) -> list[str]:
    repo_root = _git_repo_root(workspace)
    if repo_root is None:
        return []
    absolute_path = (workspace / source_path).resolve()
    try:
        rel = absolute_path.relative_to(repo_root).as_posix()
    except ValueError:
        return []
    errors: list[str] = []
    try:
        tracked = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "--error-unmatch", "--", rel],
            text=True,
            capture_output=True,
            check=False,
        ).returncode == 0
        ignored = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "--quiet", "--no-index", "--", rel],
            text=True,
            capture_output=True,
            check=False,
        ).returncode == 0
    except OSError:
        return []
    if tracked:
        errors.append(f"sourcePath is tracked by git: {source_path}")
    if not ignored:
        errors.append(f"sourcePath is not git-ignored: {source_path}")
    return errors


def _result_verdict(results: list[dict[str, Any]]) -> str:
    if not results:
        return "NOT_APPLICABLE"
    statuses = {str(item.get("result", "")).lower() for item in results}
    if "fail" in statuses:
        return "FAIL"
    if "blocked" in statuses:
        return "BLOCKED"
    if "skipped" in statuses:
        return "SKIPPED"
    return "PASS"


def _preflight_tests(workspace: Path, tests: list[Any]) -> list[str]:
    errors: list[str] = []
    for index, raw_test in enumerate(tests):
        context = f"tests[{index}]"
        if not isinstance(raw_test, dict):
            errors.append(f"{context} must be object")
            continue
        test_id = raw_test.get("id")
        if not isinstance(test_id, str) or not test_id.strip():
            errors.append(f"{context}.id missing")
        command = raw_test.get("command")
        if not isinstance(command, str) or not command.strip():
            errors.append(f"{context}.command missing")
        source_path = raw_test.get("sourcePath")
        if not isinstance(source_path, str) or not source_path.strip():
            errors.append(f"{context}.sourcePath missing")
        elif not (workspace / source_path).is_file():
            errors.append(f"{context}.sourcePath missing on disk: {source_path}")
        else:
            errors.extend(f"{context}.{error}" for error in _git_source_errors(workspace, source_path))
    return errors


def _append_smoke_evidence(
    *,
    feature_dir: Path,
    feature: str,
    checkpoint: str,
    test: dict[str, Any],
    exit_code: int,
    result: str,
    output_tail: str,
) -> dict[str, Any]:
    source_path = test.get("sourcePath")
    record = {
        "featureId": feature,
        "checkpoint": checkpoint,
        "nodeId": "dev.code",
        "skill": "autodev-code",
        "taskId": test.get("taskId"),
        "action": "smoke",
        "specRefs": test.get("scenarioRefs") if isinstance(test.get("scenarioRefs"), list) else [],
        "designRefs": [],
        "changedFiles": [source_path] if isinstance(source_path, str) and source_path.strip() else [],
        "smoke": {
            "testId": test.get("id"),
            "command": test.get("command"),
            "exitCode": exit_code,
            "result": result,
        },
    }
    return append_evidence(feature_dir, record, output_tail=output_tail)


def run_advisory_smoke(workspace: Path, feature: str) -> int:
    feature_dir = _feature_dir(workspace, feature)
    plan = _load_smoke_plan(feature_dir)
    raw_tests = plan.get("tests")
    if not isinstance(raw_tests, list):
        raise ValueError("invalid advisory smoke plan: tests must be array")
    tests = raw_tests
    checkpoint = _current_checkpoint(workspace, feature)

    preflight_errors = _preflight_tests(workspace, tests)
    if preflight_errors:
        raise ValueError("invalid advisory smoke plan: " + "; ".join(preflight_errors))

    results: list[dict[str, Any]] = []
    for raw_test in tests:
        test_id = raw_test.get("id")
        command = raw_test.get("command")
        timeout = raw_test.get("timeoutSeconds")
        timeout_seconds = timeout if isinstance(timeout, int) and timeout > 0 else DEFAULT_TIMEOUT_SECONDS

        exit_code, result, output_tail = _run_command(str(command), cwd=workspace, timeout=timeout_seconds)

        appended = _append_smoke_evidence(
            feature_dir=feature_dir,
            feature=feature,
            checkpoint=checkpoint,
            test=raw_test,
            exit_code=exit_code,
            result=result,
            output_tail=output_tail,
        )
        smoke = appended.get("smoke") if isinstance(appended.get("smoke"), dict) else {}
        result_row = {
            "testId": test_id,
            "taskId": raw_test.get("taskId"),
            "command": command,
            "exitCode": exit_code,
            "result": result,
            "evidenceId": appended.get("evidenceId"),
            "outputTailPath": smoke.get("outputTailPath"),
        }
        if result in {"fail", "blocked"}:
            result_row["failureSummary"] = (
                output_tail.splitlines()[-1]
                if output_tail.splitlines()
                else f"{result}: command exited {exit_code}"
            )
        results.append(result_row)

    result_payload = {
        "version": 1,
        "featureId": feature,
        "flowBlocking": False,
        "verdict": _result_verdict(results),
        "results": results,
    }
    if not tests:
        result_payload["skipReason"] = plan.get("skipReason") or "no advisory smoke tests planned"
    (feature_dir / "SMOKE_RESULT.json").write_text(
        json.dumps(result_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result_payload, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run advisory smoke tests without blocking flow on test failures")
    parser.add_argument("--workspace", help="Project workspace. Defaults to PLUGIN_WORKSPACE/PROJECT_DIR.")
    parser.add_argument("--feature", help="Feature id. Defaults to FEATURE_ID.")
    args = parser.parse_args(argv)

    try:
        workspace = Path(args.workspace).resolve() if args.workspace else get_plugin_output_workspace()
        feature = resolve_env_feature(args.feature, required=args.feature is None)
        if feature is None:
            raise ValueError("feature 不能为空")
        return run_advisory_smoke(workspace, feature)
    except (ValueError, EvidenceStoreError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
