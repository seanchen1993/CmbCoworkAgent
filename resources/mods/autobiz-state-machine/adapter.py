#!/usr/bin/env python3
"""Plugin-owned state checks and prepared commit; no host authority is claimed."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).parent))
from journal import (assert_no_pending, linked, operation_id, policy_digest, read_record,
                     request_binding, write_record)

API = "autobiz.function-state/v1"
ROOT = Path(__file__).resolve().parents[3]
LIMIT = 262144


def digest(value):
    return hashlib.sha256(value).hexdigest()


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def bytes_at(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > LIMIT:
        raise ValueError("AUTOBIZ_STATE_FILE_INVALID")
    return path.read_bytes()


def snapshot(workspace, feature):
    from board_core.state_store import check_or_fix_state_sync
    if linked(workspace / ".autobizdevops"):
        raise ValueError("AUTOBIZ_STATE_FILE_INVALID")
    paths = [workspace / ".autobizdevops" / name for name in ("state.json", "STATE.md")]
    before = [bytes_at(path) for path in paths]
    current = check_or_fix_state_sync(workspace, fix=False)
    if not current.state_exists or current.errors or current.record_errors.get(feature):
        raise ValueError("AUTOBIZ_STATE_NOT_CANONICAL")
    if feature not in current.records:
        raise ValueError("AUTOBIZ_FEATURE_UNAVAILABLE")
    if before != [bytes_at(path) for path in paths]:
        raise ValueError("AUTOBIZ_STATE_CHANGED")
    return current, before


def prepare(workspace, request):
    feature = request["feature"]
    current, before = snapshot(workspace, feature)
    old = current.records[feature]["checkpoint"]
    if request.get("from") != old or request.get("expectedStateDigest") != digest(before[0]):
        raise ValueError("AUTOBIZ_STATE_CHANGED")
    bridge = load(Path(__file__).with_name("stage_checks.py"), "function_stage_checks")
    _observer, checks = bridge.install_original_postcheck(ROOT)
    update = load(ROOT / "hooks" / "update_checkpoint.py", "function_checkpoint")
    sync = update.check_or_fix_state_sync
    update.check_or_fix_state_sync = lambda root, **kwargs: sync(root, fix=False)
    bridge.validate_completed_biz(
        ROOT, workspace, feature, current.records[feature], checks,
        target_checkpoint=request["to"],
    )
    hook_rules = load(Path(__file__).with_name("hook_checks.py"), "function_transition_hooks")
    transition_hooks = hook_rules.validate_transition_hooks(ROOT, workspace, feature, request["to"])
    if transition_hooks["errors"]:
        return {"ok": False, "status": "not-applied", "errors": transition_hooks["errors"],
                "transitionHooks": transition_hooks["receipts"]}
    result = update.prepare_checkpoint_update(
        workspace=workspace, feature=feature, checkpoint=request["to"],
    )
    if not result.ok:
        return {"ok": False, "status": "not-applied", "errors": list(result.errors)}
    if checks.evidence_errors:
        raise ValueError("AUTOBIZ_STAGE_EVIDENCE_UNAVAILABLE")
    if before != snapshot(workspace, feature)[1]:
        raise ValueError("AUTOBIZ_STATE_CHANGED")
    return {"ok": True, "status": "prepared", "from": old, "to": request["to"],
            "stateDigest": digest(before[0]), "stageChecks": checks,
            "stageChecksDigest": digest(json.dumps(checks, ensure_ascii=False, sort_keys=True,
                                                   separators=(",", ":")).encode("utf-8")),
            "transitionHooks": transition_hooks["receipts"]}


def operation_path(workspace, request, *, create=False):
    key = request.get("requestKey", "")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", key):
        raise ValueError("AUTOBIZ_REQUEST_KEY_REQUIRED")
    operation = operation_id(request["feature"], key)
    journal_root = workspace / ".autobizdevops" / "function-state-journal"
    if linked(workspace / ".autobizdevops") or linked(journal_root):
        raise ValueError("AUTOBIZ_JOURNAL_INVALID")
    if create:
        journal_root.mkdir(exist_ok=True)
    return operation, journal_root, journal_root / (operation + ".json")


def reconcile(workspace, request):
    operation, journal_root, path = operation_path(workspace, request)
    if not path.exists():
        return {"ok": False, "status": "not-found", "operationId": operation}
    record = read_record(path)
    binding = record.get("request", {})
    if binding.get("feature") != request["feature"] or binding.get("requestKey") != request["requestKey"]:
        raise ValueError("AUTOBIZ_REQUEST_CONFLICT")
    if binding.get("policyDigest") != policy_digest(ROOT):
        return {"ok": False, "status": "unknown", "operationId": operation,
                "errors": ["AUTOBIZ_OPERATION_SOURCE_CHANGED"]}
    if "to" in request and binding != request_binding(ROOT, request):
        raise ValueError("AUTOBIZ_REQUEST_CONFLICT")
    hashes = [digest(bytes_at(workspace / ".autobizdevops" / name)) for name in ("state.json", "STATE.md")]
    receipt_path = journal_root / (operation + ".physical.json")
    physical = read_record(receipt_path) if receipt_path.exists() else None
    evidence = record.get("evidence", {})
    # A planned hash alone does not attribute a physical write to this operation.
    proven = (physical is not None and physical.get("operationId") == operation
              and physical.get("policyDigest") == binding["policyDigest"]
              and physical.get("after") == evidence.get("after")
              and physical.get("identities") == evidence.get("identities"))
    if proven:
        return {"ok": True, "status": "committed", "duplicate": True,
                "operationId": operation, "feature": request["feature"],
                "from": record.get("from"), "to": binding["to"],
                "currentMatches": hashes == physical["after"],
                "stateFingerprint": physical["after"][0],
                "markdownFingerprint": physical["after"][1]}
    if record.get("phase") == "not-applied" and hashes == record.get("before"):
        return {"ok": False, "status": "not-applied", "operationId": operation,
                "errors": record.get("errors", ["Previous attempt was not applied; use a new request key."])}
    return {"ok": False, "status": "unknown", "operationId": operation,
            "currentMatchesBefore": hashes == evidence.get("before"),
            "currentMatchesPlanned": hashes == evidence.get("after"),
            "errors": ["No attributable physical commit receipt; do not replay this operation."]}


def advance(workspace, request):
    operation, journal_root, path = operation_path(workspace, request, create=True)
    if path.exists():
        return reconcile(workspace, request)
    for pending in assert_no_pending(journal_root, request["feature"], operation):
        previous = read_record(journal_root / (pending + ".json"))
        observed = reconcile(workspace, {"feature": request["feature"],
                                         "requestKey": previous["request"]["requestKey"]})
        if observed["status"] != "committed":
            return {"ok": False, "status": "unknown", "operationId": pending,
                    "errors": ["Reconcile the previous operation before starting another."]}
    checked = prepare(workspace, request)
    if not checked["ok"]:
        return checked
    approved_checks = request.get("expectedChecksDigest", "")
    if request["to"] == "design_done" and (
            not re.fullmatch(r"[0-9a-f]{64}", approved_checks)
            or approved_checks != checked["stageChecksDigest"]):
        return {"ok": False, "status": "not-applied",
                "errors": ["AUTOBIZ_DESIGN_APPROVED_INPUT_CHANGED"]}
    binding = request_binding(ROOT, request)
    record = {"apiVersion": API, "phase": "intent", "operationId": operation,
              "request": binding, "from": request["from"],
              "before": [digest(value) for value in snapshot(workspace, request["feature"])[1]]}
    try:
        write_record(path, record, exclusive=True)
    except FileExistsError:
        return reconcile(workspace, request)
    process = None
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).with_name("commit.py")),
             str(ROOT), str(workspace), request["feature"], request["from"], request["to"],
             request["expectedStateDigest"], operation, "null", str(journal_root), binding["policyDigest"], approved_checks],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        evidence = None
        outcome = None
        for line in process.stdout:
            message = json.loads(line)
            if message.get("operationId") != operation:
                raise ValueError("AUTOBIZ_COMMIT_PROTOCOL_INVALID")
            if message.get("ready"):
                if evidence is not None:
                    raise ValueError("AUTOBIZ_COMMIT_PROTOCOL_INVALID")
                evidence = message["evidence"]
                record.update(phase="prepared", evidence=evidence,
                              transitionHooks=message.get("transitionHooks", []))
                write_record(path, record)
                process.stdin.write("commit:" + operation + "\n")
                process.stdin.flush()
            elif message.get("written"):
                if evidence is None:
                    raise ValueError("AUTOBIZ_COMMIT_PROTOCOL_INVALID")
                record["phase"] = "committed"
                write_record(path, record)
                process.stdin.write("release:" + operation + "\n")
                process.stdin.flush()
            elif "applied" in message:
                outcome = message
        process.wait(timeout=10)
        if process.returncode != 0 or outcome is None:
            raise ValueError("AUTOBIZ_COMMIT_UNKNOWN")
        if outcome.get("status") == "not-applied":
            record.update(phase="not-applied", errors=[outcome.get("reason", "Commit did not start.")])
            write_record(path, record)
        return {"ok": outcome.get("status") == "committed", **outcome}
    except Exception as error:
        # An intent exists; loss of the response is not evidence of no write.
        return {"ok": False, "status": "unknown", "operationId": operation,
                "errors": [str(error)[:1000]], "nextAction": "state_reconcile"}
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.communicate()


def main():
    raw = sys.stdin.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("AUTOBIZ_STATE_REQUEST_LIMIT")
    request = json.loads(raw)
    if request.get("apiVersion") != API or request.get("operation") not in ("read", "prepare", "advance", "reconcile"):
        raise ValueError("AUTOBIZ_STATE_REQUEST_INVALID")
    feature = request.get("feature")
    if not isinstance(feature, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", feature):
        raise ValueError("AUTOBIZ_FEATURE_INVALID")
    workspace = Path.cwd().resolve()
    os.environ.update(PLUGIN_WORKSPACE=str(workspace.parent), PROJECT_DIR=workspace.name,
                      FEATURE_ID=feature, PYTHONDONTWRITEBYTECODE="1")
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "hooks"))
    sys.path.insert(0, str(ROOT / "skills" / "autodev" / "hooks"))
    if request["operation"] == "read":
        current, before = snapshot(workspace, feature)
        result = {"ok": True, "status": "read", "feature": feature,
                  "record": current.records[feature], "state": json.loads(before[0]),
                  "stateDigest": digest(before[0]), "markdownDigest": digest(before[1])}
    elif request["operation"] == "reconcile":
        result = reconcile(workspace, request)
    else:
        if not re.fullmatch(r"[a-z_]{1,80}", request.get("to", "")):
            raise ValueError("AUTOBIZ_CHECKPOINT_INVALID")
        if not isinstance(request.get("expectedStateDigest"), str) or not re.fullmatch(r"[0-9a-f]{64}", request["expectedStateDigest"]):
            raise ValueError("AUTOBIZ_STATE_DIGEST_REQUIRED")
        result = prepare(workspace, request) if request["operation"] == "prepare" else advance(workspace, request)
    emit({"apiVersion": API, **result})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"apiVersion": API, "ok": False, "status": "not-applied", "errors": [str(error)[:1000]]})
        sys.exit(1)
