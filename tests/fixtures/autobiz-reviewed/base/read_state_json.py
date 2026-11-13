#!/usr/bin/env python3
"""Read .autobizdevops/state.json without falling back to STATE.md.

Usage:
    PLUGIN_WORKSPACE=<collection-workspace> PROJECT_DIR=<project> python read_state_json.py
    PLUGIN_WORKSPACE=<collection-workspace> PROJECT_DIR=<project> FEATURE_ID=<slug> python read_state_json.py --feature <slug>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.paths import (  # type: ignore[import-untyped]
    STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR,
    contains_workspace_argument,
    get_plugin_output_workspace,
    resolve_env_feature,
)
from board_core.state_store import (  # type: ignore[import-untyped]
    get_state_json_path,
    load_state_json_records_result,
)


SCHEMA_VERSION = "autobizdevops.state.read.v1"


def _build_payload(workspace: Path) -> tuple[dict[str, Any], int]:
    result = load_state_json_records_result(workspace)
    state_json_path = get_state_json_path(workspace)
    errors = list(result.fatal_errors)

    if not result.exists:
        errors.append(f"state.json 未找到: {state_json_path}")

    payload: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "workspace": str(workspace),
        "stateJsonPath": str(state_json_path),
        "source": result.source,
        "exists": result.exists,
        "ok": result.exists and not errors,
        "errors": errors,
        "recordErrors": result.record_errors,
    }

    payload["records"] = result.records

    return payload, 0 if payload["ok"] else 1


def _read_feature_checkpoint(workspace: Path, feature: str) -> tuple[str, int]:
    result = load_state_json_records_result(workspace)
    state_json_path = get_state_json_path(workspace)

    if not result.exists:
        print(f"state.json 未找到: {state_json_path}", file=sys.stderr)
        return "", 1

    if result.fatal_errors:
        for error in result.fatal_errors:
            print(error, file=sys.stderr)
        return "", 1

    record = result.records.get(feature)
    if record is None and result.record_errors.get(feature):
        for error in result.record_errors[feature]:
            print(error, file=sys.stderr)
        return "", 1
    if record is None:
        print(f"feature '{feature}' 未在 state.json 中找到", file=sys.stderr)
        return "", 1

    return record.get("checkpoint", ""), 0


def main(argv: list[str] | None = None) -> int:
    raw_args = list(sys.argv[1:] if argv is None else argv)
    if contains_workspace_argument(raw_args):
        print(STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR, file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="Read .autobizdevops/state.json only",
        allow_abbrev=False,
    )
    parser.add_argument("--feature", default=None, help="feature slug")
    args = parser.parse_args(raw_args)

    try:
        workspace = get_plugin_output_workspace()
        feature = resolve_env_feature(args.feature, required=True) if args.feature is not None else None
    except ValueError as exc:
        print(f"state.json 读取失败: {exc}", file=sys.stderr)
        return 1

    if feature is not None:
        checkpoint, exit_code = _read_feature_checkpoint(workspace, feature)
        if exit_code == 0:
            print(checkpoint)
        return exit_code

    payload, exit_code = _build_payload(workspace)
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
