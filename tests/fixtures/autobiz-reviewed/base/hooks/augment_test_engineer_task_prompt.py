#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PreToolUse(task) hook: constrain post-implementation UTest assignments."""

from __future__ import print_function

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.utest_assignment_router import (  # noqa: E402
    UTestAssignmentError,
    validate_assignment_prompt_payload,
)


PREFIX = "[utest-task-prompt-augment]"
TARGET_SUBAGENT_TYPE = "test-engineer-autodev"
APPEND_MARKER = "autodev-utest-assignment"
ASSIGNMENT_MARKER = "<UTEST_ASSIGNMENT>"
APPEND_INSTRUCTION = """

<{marker}>

### Autodev UTest assignment contract

- This is post-implementation testing: `post_implementation=true`, `tdd_rebuild=false`. Preserve existing production implementation; do not apply the role's TDD deletion rule.
- Read `<AGENTS_INSTRUCTIONS>`, then resolve the assignment's `<SCOPE>`, `<SYSTEM>`, and `<UNIT>` references through tools before editing. `<SCOPE>` owns the deploy-unit and repository boundary; system/unit documents own framework constraints.
- Treat the supplied `<UTEST_ASSIGNMENT>` block as the complete testing context. Use `implementationPoints` as the required testing focus, exclude every `nonGoals` item, and use `validationLocations` only to confirm the assigned repo/cwd. `batchPlanPath` is traceability evidence; do not open plan.json to fetch, reconstruct, summarize, or replace fields.
- Treat `executionLane` and `workspaceRef` in that block as authoritative. Work only in the assigned workspace and do not combine backend and frontend lanes.
- Do not author or pass repository paths or cwd values to UTest scripts. Use repository/module paths returned by the environment inspector for file access; the runner resolves and validates its execution directory from the current binding and task.
- Resolve `framework` only from actually opened `<SYSTEM>`/`<UNIT>` documents. Resolve `runner` and package manager only from real manifests, lock files, and test config. A conflict is a blocking `contract_gap`; when the constraint is absent, fall back to repository facts and add a warning.
- You may edit only tests, fixtures, mocks, test helpers, and test-environment configuration under test-owned paths (or a recognized root test config). Do not edit dependency manifests, lock files, or production sources during Batch UTest.
- Route pure functions to `unit`, hooks/composables to `logic`, stores to `state`, components to `component`, and router/page/API adapters to `integration`. Real-browser, multi-page, or real-network coverage is an E2E handoff, not an implementation target.
- Classify every unresolved failure as exactly one of `test_bug`, `source_bug`, `contract_gap`, `environment`, `flaky`, or `unknown`. Repair `test_bug` within the write boundary at most once and rerun the same exact command once. A `source_bug` requires a machine-validated attestation bound to a FAIL target, non-zero Evidence, runner-resolved current task digest, generated UTest command ID, and real AC coverage; static observation and exit 0 are invalid. Return `source_fix_request` with the attestation, failing command, root cause, and Batch boundary; do not repair production code here and do not try another runner or test target. The Batch Workflow performs one controlled production repair, refreshes Review evidence, then resumes this exact UTest command. A repeated source bug, timeout, or unresolved environment after its one allowed repair is terminal and must be deferred; retain its evidence while later gate, candidate promotion, and final B-E2E continue.
- Run each exact behavior-test argv directly in Bash so compiler/test output and the process exit code are visible immediately; do not let `run_utest_command.py` spawn the test process. Pipe combined output through `tee` to a temporary file, capture `${PIPESTATUS[0]}` immediately, then call `run_utest_command.py --kind test --record-only --exit-code <captured-code> --output-file <temporary-output> ... -- <same argv>` to validate the Plan/TASK/test-file binding and persist the actual result, log, Evidence, and target JSON. If result recording fails, preserve the captured output and do not rerun the test. Existing Jest/Vitest runners must be reused. Missing supported test environments may be initialized only after the environment profile is reported by the inspector.

Return exactly these top-level fields in the final structured result: `status`, `assignment`, `constraint_files`, `lane`, `framework`, `runner`, `environment_initialization`, `test_targets`, `command_results`, `evidence_ids`, `failure_classification`, `source_bug_attestation`, `source_fix_request`, `e2e_handoff`, `warnings`.

</{marker}>""".format(marker=APPEND_MARKER)


def read_stdin_text():
    raw = sys.stdin.buffer.read()
    if not raw:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode(sys.stdin.encoding or "utf-8", errors="replace")


def as_dict(value):
    return value if isinstance(value, dict) else {}


def get_tool_input(payload):
    return as_dict(payload.get("tool_input") or payload.get("input"))


def is_target_subagent(tool_input):
    subagent_type = tool_input.get("subagent_type")
    if not isinstance(subagent_type, str):
        return False
    return subagent_type.strip().lower() == TARGET_SUBAGENT_TYPE.lower()


def validate_assignment_block(description, stream):
    start = description.find(ASSIGNMENT_MARKER)
    close_marker = "</UTEST_ASSIGNMENT>"
    end = description.find(close_marker, start + len(ASSIGNMENT_MARKER))
    if start < 0 or end < 0:
        print(
            "{} incomplete UTEST_ASSIGNMENT block. 修复：使用 router 输出的 promptContent 原文。".format(
                PREFIX
            ),
            file=stream,
        )
        return False
    raw_payload = description[start + len(ASSIGNMENT_MARKER) : end].strip()
    try:
        payload = json.loads(raw_payload)
    except (TypeError, ValueError) as exc:
        print(
            "{} invalid UTEST_ASSIGNMENT JSON: {}. 修复：不要改写 router promptContent。".format(
                PREFIX, exc
            ),
            file=stream,
        )
        return False
    try:
        validate_assignment_prompt_payload(payload)
    except (UTestAssignmentError, TypeError, ValueError, OSError) as exc:
        print(
            "{} invalid UTEST_ASSIGNMENT: {}".format(PREFIX, exc),
            file=stream,
        )
        return False
    return True


def build_updated_input(payload, stream):
    tool_input = get_tool_input(payload)
    if not is_target_subagent(tool_input):
        print(
            "{} skipped; subagent_type must be {}".format(
                PREFIX, TARGET_SUBAGENT_TYPE
            ),
            file=stream,
        )
        return None

    description = tool_input.get("description")
    if not isinstance(description, str) or not description.strip():
        print(
            "{} description missing; pass the UTest assignment in "
            "tool_input.description. 修复：传入 router 生成的最小 promptContent。".format(PREFIX),
            file=stream,
        )
        return None

    if ASSIGNMENT_MARKER not in description:
        print(
            "{} description missing {}; refusing an unbound summary. "
            "修复：运行 utest_assignment_router.py，并把 assignment.promptContent 原样放入 description。".format(
                PREFIX, ASSIGNMENT_MARKER
            ),
            file=stream,
        )
        return None

    if not validate_assignment_block(description, stream):
        return None

    if APPEND_MARKER in description:
        print(
            "{} skipped; UTest assignment contract already present".format(PREFIX),
            file=stream,
        )
        return None

    updated_description = description + APPEND_INSTRUCTION
    print(
        "{} appended {} to {} description".format(
            PREFIX, APPEND_MARKER, TARGET_SUBAGENT_TYPE
        ),
        file=stream,
    )
    return {"updatedInput": {"description": updated_description}}


def emit_updated_input(payload, output_stream, error_stream):
    result = build_updated_input(payload, error_stream)
    if result is None:
        return False
    json.dump(result, output_stream, ensure_ascii=False, separators=(",", ":"))
    output_stream.write("\n")
    return True


def main():
    raw_input = read_stdin_text()
    if not raw_input.strip():
        print(
            "{} empty stdin; verify CMBDevClaw passes the PreToolUse task "
            "payload to command hooks. 修复：把 task payload 作为 JSON 写入 stdin。".format(PREFIX),
            file=sys.stderr,
        )
        return 0

    try:
        payload = json.loads(raw_input)
    except (TypeError, ValueError) as error:
        print(
            "{} invalid JSON: {}. 修复：捕获原始 PreToolUse payload 并修正 JSON。".format(
                PREFIX, error
            ),
            file=sys.stderr,
        )
        return 0

    if not isinstance(payload, dict):
        print(
            "{} payload is not an object. 修复：从 PreToolUse 传入单个 JSON object。".format(
                PREFIX
            ),
            file=sys.stderr,
        )
        return 0

    emit_updated_input(payload, sys.stdout, sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
