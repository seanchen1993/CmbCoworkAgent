#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Invalidate a verified candidate when its code digest changes."""

from __future__ import print_function

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.state_store import load_state_json_records_result  # noqa: E402
from hooks.candidate_digest import compute  # noqa: E402
from hooks.paths import get_plugin_output_workspace, resolve_env_feature  # noqa: E402
from hooks.rollback_stage import execute_stage_rollback, prepare_stage_rollback  # noqa: E402


# Final evidence is now sealed when Code completes.  ``verify_done`` and
# ``finish`` belonged to the retired standalone Verify workflow.
VERIFIED_CHECKPOINTS = {"code_done", "cicd_in_progress", "cicd_done"}


def invalidate_if_stale(workspace, feature):
    workspace = Path(workspace).resolve()
    state = load_state_json_records_result(workspace)
    record = state.records.get(feature) if not state.fatal_errors else None
    checkpoint = record.get("checkpoint") if isinstance(record, dict) else None
    if checkpoint not in VERIFIED_CHECKPOINTS:
        return None
    decision_path = workspace / ".autobizdevops" / "features" / feature / "VERIFY_DECISION.json"
    if not decision_path.is_file():
        return None
    try:
        decision = json.loads(decision_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    expected = decision.get("diffDigest") if isinstance(decision, dict) else None
    if not isinstance(expected, str) or not expected:
        return None
    actual = compute(workspace, feature)
    if actual == expected:
        return None
    plan = prepare_stage_rollback(
        workspace=workspace,
        feature=feature,
        stage="dev.code",
        state_mode="target_in_progress",
        code_source="keep",
    )
    if not plan.ok:
        raise ValueError("VERIFIED_DIGEST_STALE rollback prepare failed: {}".format(";".join(plan.errors)))
    result = execute_stage_rollback(plan)
    if not result.ok:
        raise ValueError("VERIFIED_DIGEST_STALE rollback failed: {}".format(";".join(result.errors)))
    return {"oldDigest": expected, "newDigest": actual, "checkpoint": plan.new_checkpoint}


def main():
    raw = sys.stdin.read()
    if raw.strip():
        try:
            json.loads(raw)
        except ValueError:
            return 0
    try:
        workspace = get_plugin_output_workspace()
        feature = resolve_env_feature(None, required=True)
        result = invalidate_if_stale(workspace, feature)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if result is not None:
        print("VERIFIED_DIGEST_STALE: candidate changed; Runtime downgraded to {}".format(result["checkpoint"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
