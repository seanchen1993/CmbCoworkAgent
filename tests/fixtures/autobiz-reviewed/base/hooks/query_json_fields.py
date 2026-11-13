#!/usr/bin/env python3
"""Read selected fields from a JSON file without emitting the full document.

Selectors use dotted object keys and bracketed array indexes, for example:
``batches.T001.status`` or ``deferredIssues[0].message``. ``*`` selects all
immediate children of an object or array while retaining their shape.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


_TOKEN = re.compile(r"(?:^|\.)([^.\[\]]+)|\[(\d+)\]")


class QueryError(ValueError):
    """A selector cannot be applied to the supplied JSON value."""


def _parse_selector(selector: str) -> list[str | int]:
    tokens: list[str | int] = []
    position = 0
    for match in _TOKEN.finditer(selector):
        if match.start() != position:
            raise QueryError(f"invalid field selector: {selector}")
        key, index = match.groups()
        tokens.append(int(index) if index is not None else key)
        position = match.end()
    if not tokens or position != len(selector):
        raise QueryError(f"invalid field selector: {selector}")
    return tokens


def _select(value: Any, tokens: list[str | int], selector: str) -> Any:
    if not tokens:
        return value
    token, rest = tokens[0], tokens[1:]
    if token == "*":
        if isinstance(value, dict):
            return {key: _select(child, rest, selector) for key, child in value.items()}
        if isinstance(value, list):
            return [_select(child, rest, selector) for child in value]
        raise QueryError(f"{selector}: wildcard requires an object or array")
    if isinstance(token, int):
        if not isinstance(value, list) or token >= len(value):
            raise QueryError(f"{selector}: array index {token} does not exist")
        return _select(value[token], rest, selector)
    if not isinstance(value, dict) or token not in value:
        raise QueryError(f"{selector}: field {token!r} does not exist")
    return _select(value[token], rest, selector)


def query_fields(document: Any, selectors: list[str]) -> dict[str, Any]:
    return {selector: _select(document, _parse_selector(selector), selector) for selector in selectors}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path, help="JSON file to query")
    parser.add_argument(
        "--field", action="append", required=True, dest="fields",
        help="field path to return; repeat to request multiple fields",
    )
    args = parser.parse_args(argv)
    try:
        document = json.loads(args.file.read_text(encoding="utf-8"))
        result = query_fields(document, args.fields)
    except (OSError, json.JSONDecodeError, QueryError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "fields": result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
