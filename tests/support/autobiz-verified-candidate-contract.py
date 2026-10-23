"""Read-only verified-candidate receipt boundary with actual changing fixture files."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

helper = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(helper))
spec = importlib.util.spec_from_file_location("verified_candidate_helper", helper / "hook_checks.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
checks = []


def rejected(name, callback, code):
    try:
        callback()
        raise AssertionError("Expected rejection: " + name)
    except ValueError as error:
        assert code in str(error), (name, str(error))
    checks.append(name)


with tempfile.TemporaryDirectory(prefix="autobiz-verified-contract-") as temporary:
    root = Path(temporary)
    source, workspace = root / "source", root / "workspace"
    hooks = source / "hooks"
    feature = workspace / ".autobizdevops/features/alpha"
    hooks.mkdir(parents=True)
    feature.mkdir(parents=True)
    (hooks / "__init__.py").write_text("", encoding="utf-8")
    # These fixture modules are the original-Hook dependency boundary, not the helper
    # under test. compute performs real reads; rollback is forbidden even on stale code.
    (hooks / "candidate_digest.py").write_text(
        "import hashlib\nfrom pathlib import Path\n"
        "def compute(workspace, feature):\n"
        "    data = (Path(workspace) / 'candidate.txt').read_bytes()\n"
        "    with (Path(__file__).parent / 'compute.log').open('a') as log:\n"
        "        log.write(hashlib.sha256(data).hexdigest() + '\\n')\n"
        "    return hashlib.sha256(data).hexdigest()\n", encoding="utf-8")
    (hooks / "rollback_stage.py").write_text(
        "from pathlib import Path\n"
        "def forbidden(*args, **kwargs):\n"
        "    (Path(__file__).parent / 'rollback.called').write_text('unsafe')\n"
        "    raise AssertionError('rollback must never run in a prepared Mod check')\n"
        "prepare_stage_rollback = forbidden\nexecute_stage_rollback = forbidden\n",
        encoding="utf-8")
    (hooks / "verified_digest_guard.py").write_text(
        "from hooks.candidate_digest import compute\n"
        "from hooks.rollback_stage import prepare_stage_rollback, execute_stage_rollback\n"
        "VERIFIED_CHECKPOINTS = {'code_done', 'cicd_in_progress', 'cicd_done'}\n",
        encoding="utf-8")
    candidate = workspace / "candidate.txt"
    candidate.write_bytes(b"actual candidate version one\n")
    state = workspace / ".autobizdevops/state.json"
    state.write_bytes(b'{"checkpoint":"code_done","readOnlySentinel":true}')
    state_before = state.read_bytes()
    decision = feature / "VERIFY_DECISION.json"
    expected_digest = hashlib.sha256(candidate.read_bytes()).hexdigest()

    def check(current="code_in_progress", target="code_done", expected=None):
        return module.validate_verified_candidate(source, workspace, "alpha", current, target,
                                                  expected=expected)

    def write_decision(value=None, pretty=False):
        decision.write_text(json.dumps(value if value is not None else
                                       {"diffDigest": expected_digest, "verdict": "PASS"},
                                       indent=2 if pretty else None), encoding="utf-8")

    outside = check("prd_in_progress", "prd_done")
    assert outside["result"] == "not-applicable"
    assert not (hooks / "compute.log").exists()
    checks.append("non-verified-checkpoints-do-not-compute")
    assert check()["result"] == "not-applicable"
    assert not (hooks / "compute.log").exists()
    checks.append("missing-decision-is-not-a-successful-verification")
    write_decision({"verdict": "PASS"})
    assert check()["result"] == "not-applicable"
    assert not (hooks / "compute.log").exists()
    checks.append("missing-original-digest-does-not-compute")

    write_decision()
    receipt = check()
    assert receipt["id"] == "original-verified-candidate"
    assert receipt["result"] == "passed"
    assert receipt["expectedDigest"] == receipt["actualDigest"] == expected_digest
    assert receipt["decisionDigest"] == hashlib.sha256(decision.read_bytes()).hexdigest()
    checks.append("real-candidate-and-decision-bytes-bound")
    assert check(expected=receipt) == receipt
    checks.append("unchanged-prepared-receipt-rechecks")
    assert check("code_done", "archived")["result"] == "passed"
    checks.append("current-verified-checkpoint-still-checks-unverified-target")
    assert check("plan_done", "cicd_done")["result"] == "passed"
    checks.append("target-verified-checkpoint-checks-unverified-current")

    candidate.write_bytes(b"actual candidate changed after prepare\n")
    rejected("stale-candidate-is-rejected", lambda: check(), "AUTOBIZ_VERIFIED_CANDIDATE_STALE")
    rejected("candidate-changed-before-ack-is-rejected", lambda: check(expected=receipt),
             "AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
    candidate.write_bytes(b"actual candidate version one\n")
    write_decision(pretty=True)
    assert check()["result"] == "passed"
    rejected("equivalent-json-with-different-bytes-needs-new-prepare", lambda: check(expected=receipt),
             "AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
    write_decision({"diffDigest": expected_digest, "verdict": "PASS", "newEvidence": "changed"})
    rejected("decision-replacement-before-ack-is-rejected", lambda: check(expected=receipt),
             "AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
    decision.unlink()
    rejected("applicable-decision-disappearing-is-rejected", lambda: check(expected=receipt),
             "AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
    write_decision({"verdict": "PASS"})
    rejected("applicable-digest-disappearing-is-rejected", lambda: check(expected=receipt),
             "AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
    write_decision()
    rejected("checkpoint-scope-changed-before-ack-is-rejected",
             lambda: check("prd_in_progress", "prd_done", expected=receipt),
             "AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
    rejected("feature-path-traversal-is-rejected",
             lambda: module.validate_verified_candidate(source, workspace, "../alpha", "code_done", "cicd_done"),
             "AUTOBIZ_VERIFIED_CANDIDATE_FEATURE_INVALID")
    decision.unlink()
    decision.mkdir()
    rejected("decision-directory-is-rejected", lambda: check(),
             "AUTOBIZ_VERIFIED_CANDIDATE_INPUT_INVALID")
    assert not (hooks / "rollback.called").exists()
    assert state.read_bytes() == state_before
    checks.append("all-checks-are-read-only-and-never-rollback")
    assert len((hooks / "compute.log").read_text().splitlines()) >= 8
    print(json.dumps({"passed": True, "checks": checks, "realCandidateBytesRead": True,
                      "rollbackCalled": False, "stateUnchanged": True}))
