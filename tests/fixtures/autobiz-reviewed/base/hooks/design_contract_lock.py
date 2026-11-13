#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Design-owned immutable contract lock used by the Plan stage.

The Design stage validates ``design.md`` and then materializes this snapshot.
Plan consumers deliberately read only the snapshot: they do not re-parse or
re-validate the Design document.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.artifact_ref_validator import design_contract_snapshot, load_design_contract
from hooks.json_writer_common import (
    WriterResult,
    atomic_write_json,
    feature_dir,
    load_json,
    render_result,
    resolve_feature,
    resolve_workspace,
)


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


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


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


def sync_design_contract_lock(workspace: Path, feature: str) -> WriterResult:
    base = feature_dir(workspace, feature)
    contract, errors = load_design_contract(base)
    if errors:
        return WriterResult(ok=False, path=base / "design.md", errors=errors)
    path = design_contract_lock_path(base)
    snapshot = design_contract_snapshot(contract)
    current: dict[str, Any] | None = None
    try:
        loaded = load_json(path) if path.is_file() else None
        current = loaded if isinstance(loaded, dict) else None
    except Exception:
        current = None
    payload = {
        "version": 1,
        "featureId": feature,
        "designContract": snapshot,
        "lockedAt": _utc_now(),
        "lockOwner": "dev.design",
    }
    if current is not None and current.get("designContract") == snapshot and current.get("featureId") == feature:
        payload["lockedAt"] = current.get("lockedAt", payload["lockedAt"])
    changed = atomic_write_json(path, payload)
    return WriterResult(
        ok=True,
        path=path,
        changed=changed,
        data={"featureId": feature, "designContract": snapshot},
    )


def _cmd_sync(args: argparse.Namespace) -> int:
    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
    except Exception as exc:
        return render_result(WriterResult(ok=False, errors=[{"reason": "path_resolution_failed", "detail": str(exc)}]))
    return render_result(sync_design_contract_lock(workspace, feature))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Materialize the Design-owned contract lock")
    subparsers = parser.add_subparsers(dest="command", required=True)
    sync = subparsers.add_parser("sync")
    sync.add_argument("--workspace")
    sync.add_argument("--feature")
    sync.set_defaults(func=_cmd_sync)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
