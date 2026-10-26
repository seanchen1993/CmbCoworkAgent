"""Read-only rules extracted from hooks/design_contract_lock.py. See provenance.json."""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any
from hooks.artifact_ref_validator import load_design_contract, design_contract_snapshot
def load_json(path):
    return json.loads(path.read_text(encoding='utf-8'))

DESIGN_CONTRACT_LOCK_FILE = ".design-contract.lock.json"


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


_ID_PATTERNS = {
    "apiIds": re.compile(r"^API-\d{3}$"),
    "dataIds": re.compile(r"^DATA-\d{3}$"),
    "decisionIds": re.compile(r"^D-\d{3}$"),
}


def design_contract_lock_path(base: Path) -> Path:
    return base / DESIGN_CONTRACT_LOCK_FILE


def _issue(reason: str, detail: str = "") -> dict[str, Any]:
    result: dict[str, Any] = {
        "reason": reason,
        "repairTarget": "design_revision",
        "repairable": False,
        "designMutationAllowed": False,
        "repairSuggestion": "回到 /autodev-design 校验并重新锁定 design.md，然后再进入 Plan。",
    }
    if detail:
        result["detail"] = detail
    return result


def _normalize_snapshot(value: Any) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if not isinstance(value, dict):
        return None, [_issue("design_contract_lock_invalid", "designContract_missing")]
    sha256 = value.get("sha256")
    if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
        return None, [_issue("design_contract_lock_invalid", "designContract.sha256_invalid")]

    ids: dict[str, set[str]] = {"API": set(), "DATA": set(), "D": set()}
    for field, kind in (("apiIds", "API"), ("dataIds", "DATA"), ("decisionIds", "D")):
        raw_ids = value.get(field)
        if not isinstance(raw_ids, list) or any(
            not isinstance(item, str) or not _ID_PATTERNS[field].fullmatch(item)
            for item in raw_ids
        ):
            return None, [_issue("design_contract_lock_invalid", f"designContract.{field}_invalid")]
        if len(raw_ids) != len(set(raw_ids)):
            return None, [_issue("design_contract_lock_invalid", f"designContract.{field}_duplicate")]
        ids[kind] = set(raw_ids)

    no_http_api = value.get("noHttpApi")
    no_sql = value.get("noSql")
    if not isinstance(no_http_api, bool) or not isinstance(no_sql, bool):
        return None, [_issue("design_contract_lock_invalid", "designContract.marker_invalid")]
    if no_http_api and ids["API"]:
        return None, [_issue("design_contract_lock_invalid", "noHttpApi_conflicts_with_apiIds")]
    if no_sql and ids["DATA"]:
        return None, [_issue("design_contract_lock_invalid", "noSql_conflicts_with_dataIds")]

    return {
        "sha256": sha256,
        "ids": ids,
        "noHttpApi": no_http_api,
        "noSql": no_sql,
    }, []


def load_confirmed_design_contract(base: Path, feature: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load the Design-approved snapshot without reading ``design.md``."""

    path = design_contract_lock_path(base)
    if not path.is_file() or path.stat().st_size <= 0:
        return {}, [_issue("design_contract_lock_missing", str(path))]
    try:
        payload = load_json(path)
    except Exception as exc:
        return {}, [_issue("design_contract_lock_invalid", f"error={exc}")]
    if not isinstance(payload, dict):
        return {}, [_issue("design_contract_lock_invalid", "root_not_object")]
    if payload.get("version") != 1:
        return {}, [_issue("design_contract_lock_invalid", f"version={payload.get('version')!r}")]
    if payload.get("featureId") != feature:
        return {}, [_issue(
            "design_contract_lock_invalid",
            f"featureId={payload.get('featureId')!r};expected={feature}",
        )]
    if payload.get("lockOwner") != "dev.design":
        return {}, [_issue(
            "design_contract_lock_invalid",
            f"lockOwner={payload.get('lockOwner')!r};expected=dev.design",
        )]
    if not isinstance(payload.get("lockedAt"), str) or not payload["lockedAt"].strip():
        return {}, [_issue("design_contract_lock_invalid", "lockedAt_missing")]
    return _normalize_snapshot(payload.get("designContract"))


def validate_design_contract_lock(base: Path, feature: str) -> list[dict[str, Any]]:
    """Design-stage proof that its persisted snapshot matches valid design.md."""

    contract, design_errors = load_design_contract(base)
    if design_errors:
        return design_errors
    locked, lock_errors = load_confirmed_design_contract(base, feature)
    if lock_errors:
        return lock_errors
    expected = design_contract_snapshot(contract)
    actual = design_contract_snapshot(locked)
    if actual != expected:
        return [_issue(
            "design_contract_lock_outdated",
            f"expected={expected['sha256']};actual={actual['sha256']}",
        )]
    return []
