#!/usr/bin/env python3
"""Deterministic first-pass classification for staged Batch failures."""

from __future__ import annotations

import argparse
import json
import re
from typing import Any


RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("environment", re.compile(r"\b(timeout|timed out|econnrefused|connection refused|network is unreachable|temporary failure)\b", re.I)),
    ("implementation", re.compile(r"\b(compilation failed|compile error|type error|cannot find symbol|syntaxerror|module not found)\b", re.I)),
    ("documentation", re.compile(r"\b(lint|format(?:ting)?|prettier|checkstyle|comment)\b", re.I)),
    ("test_definition", re.compile(r"\b(test fixture|test setup|invalid test|test definition)\b", re.I)),
)


def classify_failure(stage: str, logs: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a conservative classification; ambiguity always needs triage."""
    _ = context
    for failure_type, pattern in RULES:
        if pattern.search(logs or ""):
            confidence = 0.9 if failure_type == "environment" else 0.8
            return {"failureType": failure_type, "confidence": confidence, "source": "rule", "stage": stage}
    return {"failureType": "needs_triage", "confidence": 0.0, "source": "fallback", "stage": stage}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Classify a staged Batch failure")
    parser.add_argument("--stage", required=True)
    parser.add_argument("--logs", required=True)
    parser.add_argument("--context-json", default="{}")
    args = parser.parse_args(argv)
    try:
        context = json.loads(args.context_json)
        if not isinstance(context, dict):
            raise ValueError("parallel_failure_context_must_be_object")
        print(json.dumps({"ok": True, **classify_failure(args.stage, args.logs, context)}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
