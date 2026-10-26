"""Read-only rules extracted from hooks/implementation_scope.py. See provenance.json."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any

SCOPE_FILENAME = "IMPLEMENTATION_SCOPE.json"


VALID_SCOPES = frozenset({"full_stack", "backend_only", "frontend_only"})


DEFAULT_SCOPE = "full_stack"


def scope_path(feature_dir: Path) -> Path:
    return feature_dir / SCOPE_FILENAME


def validate_scope_payload(payload: Any, *, feature: str | None = None) -> list[str]:
    if not isinstance(payload, dict):
        return ["implementation_scope_root_must_be_object"]
    scope = payload.get("implementationScope")
    errors: list[str] = []
    if scope not in VALID_SCOPES:
        errors.append("implementationScope_invalid")
    if feature is not None and payload.get("featureId") != feature:
        errors.append("implementationScope_feature_mismatch")
    source = payload.get("source")
    if not isinstance(source, str) or not source.strip():
        errors.append("implementationScope_source_missing")
    return errors


def load_scope(feature_dir: Path, *, required: bool = False) -> tuple[str, list[str]]:
    """Return (scope, errors); absent legacy scopes default to full_stack."""

    path = scope_path(feature_dir)
    if not path.is_file():
        if required:
            return DEFAULT_SCOPE, ["implementation_scope_missing"]
        return DEFAULT_SCOPE, []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return DEFAULT_SCOPE, [f"implementation_scope_unreadable:{exc}"]
    errors = validate_scope_payload(payload, feature=feature_dir.name)
    return str(payload.get("implementationScope", DEFAULT_SCOPE)), errors
