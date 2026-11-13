#!/usr/bin/env python3
"""Compatibility-free name for the staged pipeline's evidence-only finalizer."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import resolve_feature, resolve_workspace
from hooks.parallel_evidence_aggregate import aggregate_evidence


def verify_final(workspace: Path, feature: str, run_id: str) -> dict:
    """Aggregate current evidence; this intentionally runs no test command."""
    return aggregate_evidence(workspace, feature, run_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Aggregate final staged Batch evidence")
    parser.add_argument("--workspace")
    parser.add_argument("--feature", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    try:
        result = verify_final(resolve_workspace(args.workspace), resolve_feature(args.feature), args.run_id)
        print(json.dumps({"ok": result["passed"], **result}, ensure_ascii=False, indent=2))
        return 0 if result["passed"] else 1
    except (ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
