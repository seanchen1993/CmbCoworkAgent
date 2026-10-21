"""Journal protocol fault tests only; this does not claim original business acceptance."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


source = Path(sys.argv[1]).resolve()
checks = []
with tempfile.TemporaryDirectory(prefix="ab-state-journal-") as temporary:
    parent = Path(temporary)
    root = parent / "plugin"
    own = root / "mods" / "business" / "autobiz.state-machine"
    shutil.copytree(source, own)
    for relative in ("plugin.json", "hooks/hooks.json", "hooks/update_checkpoint.py",
                     "board_core/state_store.py", "board_core/board_config.json"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}" if path.suffix == ".json" else "# Journal fixture only\n", encoding="utf-8")
    (root / "devclaw.business-assembly.json").write_text(json.dumps({
        "apiVersion": "devclaw.business-assembly/v1",
        "files": [{"path": str(path.relative_to(root)).replace("\\", "/")}
                  for path in root.rglob("*") if path.is_file()]
    }), encoding="utf-8")
    sys.path.insert(0, str(own))
    journal = load(own / "journal.py", "journal")
    adapter = load(own / "adapter.py", "state_adapter_fault_fixture")
    workspace = parent / "project"
    control = workspace / ".autobizdevops"
    directory = control / "function-state-journal"
    directory.mkdir(parents=True)
    before = [b'{"checkpoint":"prd_in_progress"}', b"before markdown"]
    after = [b'{"checkpoint":"prd_done"}', b"after markdown"]
    hashes = lambda values: [hashlib.sha256(value).hexdigest() for value in values]
    state_paths = [control / name for name in ("state.json", "STATE.md")]
    for path, value in zip(state_paths, after):
        path.write_bytes(value)
    request = {"feature": "alpha", "requestKey": "original-1", "from": "prd_in_progress",
               "to": "prd_done", "expectedStateDigest": hashes(before)[0]}
    operation = journal.operation_id(request["feature"], request["requestKey"])
    binding = journal.request_binding(root, request)
    evidence = {"before": hashes(before), "after": hashes(after), "identities": ["fixture-json", "fixture-md"]}
    record = {"phase": "prepared", "operationId": operation, "request": binding,
              "from": request["from"], "before": hashes(before), "evidence": evidence}
    path = directory / (operation + ".json")
    journal.write_record(path, record, exclusive=True)

    observed = adapter.reconcile(workspace, request)
    assert observed["status"] == "unknown" and observed["currentMatchesPlanned"] is True
    checks.append("planned hashes without a physical receipt remain unknown")

    current_bytes = lambda: {str(path.relative_to(workspace)): path.read_bytes()
                            for path in workspace.rglob("*") if path.is_file()}
    unchanged = current_bytes()
    blocked = adapter.advance(workspace, {**request, "requestKey": "different-2"})
    assert blocked["status"] == "unknown" and current_bytes() == unchanged
    checks.append("a different key cannot pass an unresolved same-feature intent")

    physical = directory / (operation + ".physical.json")
    journal.write_record(physical, {"operationId": operation, "policyDigest": binding["policyDigest"],
                                   "after": evidence["after"], "identities": evidence["identities"]}, exclusive=True)
    unchanged = current_bytes()
    observed = adapter.reconcile(workspace, request)
    assert observed["status"] == "committed" and observed["duplicate"] is True and observed["currentMatches"] is True
    assert adapter.advance(workspace, request) == observed and current_bytes() == unchanged
    checks.append("a lost response uses the exact durable receipt without replay or journal writes")

    try:
        adapter.advance(workspace, {**request, "to": "specs_in_progress"})
        raise AssertionError("same request key accepted changed input")
    except ValueError as error:
        assert str(error) == "AUTOBIZ_REQUEST_CONFLICT"
    assert current_bytes() == unchanged
    checks.append("a request key cannot be reused with different input")

    state_paths[0].write_bytes(b'{"checkpoint":"later"}')
    unchanged = current_bytes()
    observed = adapter.reconcile(workspace, request)
    assert observed["status"] == "committed" and observed["currentMatches"] is False
    assert current_bytes() == unchanged
    checks.append("historical committed evidence does not claim the current state is unchanged")

    (own / "graph.ts").write_text("// A different business policy\n", encoding="utf-8")
    unchanged = current_bytes()
    observed = adapter.reconcile(workspace, request)
    assert observed["status"] == "unknown" and observed["errors"] == ["AUTOBIZ_OPERATION_SOURCE_CHANGED"]
    assert current_bytes() == unchanged
    checks.append("replacement policy cannot adopt an old operation")

    # Inject a transport failure after intent persistence, separately from business checks.
    adapter.prepare = lambda workspace, request: {"ok": True}
    adapter.snapshot = lambda workspace, feature: (None, after)
    def failed_start(*args, **kwargs):
        raise OSError("injected lost process response")
    adapter.subprocess.Popen = failed_start
    failed_request = {**request, "feature": "beta", "requestKey": "transport-failure"}
    failed = adapter.advance(workspace, failed_request)
    assert failed["status"] == "unknown" and failed["nextAction"] == "state_reconcile"
    failed_operation = journal.operation_id("beta", "transport-failure")
    assert journal.read_record(directory / (failed_operation + ".json"))["phase"] == "intent"
    checks.append("an exception after durable intent is never reported as proof of no write")

print(json.dumps({"passed": True, "checks": checks}))
