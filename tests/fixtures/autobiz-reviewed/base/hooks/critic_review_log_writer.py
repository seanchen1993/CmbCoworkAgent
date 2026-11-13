#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PostToolUse(task): archive the raw review-agent response as an optional log."""

from __future__ import print_function

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.specs_hook_context import feature_dir_from_env, is_specs_in_progress  # noqa: E402


TARGET_SUBAGENT_TYPES = ("critic-autodev", "critic-autodev-zh")


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def _tool_input(payload):
    return _as_dict(payload.get("tool_input") or payload.get("input"))


def _is_target(payload):
    tool_name = str(payload.get("tool_name") or payload.get("toolName") or "").lower()
    subagent = _tool_input(payload).get("subagent_type")
    return (
        tool_name == "task"
        and isinstance(subagent, str)
        and subagent.strip().lower() in TARGET_SUBAGENT_TYPES
    )


def _response(payload):
    if "tool_response" in payload:
        return payload["tool_response"]
    if "response" in payload:
        return payload["response"]
    return None


def _review_run_id(payload, response):
    tool_use_id = payload.get("tool_use_id") or payload.get("toolUseId")
    if tool_use_id:
        seed = str(tool_use_id)
    else:
        seed = json.dumps(
            {"toolInput": _tool_input(payload), "toolResponse": response},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    return "RV-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def _existing_run_ids(path):
    run_ids = set()
    if not path.is_file():
        return run_ids
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and isinstance(record.get("reviewRunId"), str):
            run_ids.add(record["reviewRunId"])
    return run_ids


def append_review(feature_dir, payload, response, now=None):
    path = Path(feature_dir) / ".runtime" / "CRITIC_REVIEWS.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    run_id = _review_run_id(payload, response)
    if run_id in _existing_run_ids(path):
        return path, False
    timestamp = (now or datetime.utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {
        "recordType": "critic_review",
        "reviewRunId": run_id,
        "timestamp": timestamp,
        "response": response,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return path, True


def run_hook(payload, feature_dir=None):
    if not _is_target(payload):
        return None
    response = _response(payload)
    if response is None:
        return None
    return append_review(feature_dir or feature_dir_from_env(), payload, response)


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or not _is_target(payload):
            return 0
        feature_dir = feature_dir_from_env()
        if not is_specs_in_progress(feature_dir):
            return 0
        result = run_hook(payload, feature_dir=feature_dir)
    except (TypeError, ValueError, OSError) as exc:
        print("CRITIC_REVIEW_SKIPPED {}".format(exc))
        return 0
    if result is not None:
        print(
            "CRITIC_REVIEW_RECORDED path={} changed={}".format(
                result[0], str(result[1]).lower()
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
