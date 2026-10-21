"""Exercise repaired projection with real Git and original evidence validation."""
from __future__ import annotations
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

plugin = Path(sys.argv[1]).resolve(strict=True)
sys.path.insert(0, str(plugin))
from hooks import parallel_runtime, parallel_evidence_aggregate, parallel_integration
from hooks.plan_writer import _verified_parallel_batch_merge
from hooks.parallel_batch_stage import FRONTEND_UTEST_SKIP_REASON

with tempfile.TemporaryDirectory(prefix="ab-proof-") as directory:
    workspace = Path(directory)
    repo = workspace / "repo"
    repo.mkdir()
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True,
                              capture_output=True, text=True).stdout.strip()
    git("init", "-b", "main")
    git("config", "user.name", "Local proof fixture")
    git("config", "user.email", "fixture@example.invalid")
    (repo / "source.txt").write_text("actual original gate fixture", "utf-8")
    git("add", ".")
    git("commit", "-m", "fixture")
    head = git("rev-parse", "HEAD")
    run = "cw-20261021-080000-001"
    stage_files = {}
    for stage in ("prepare", "implement", "review", "test"):
        evidence = {"inputs": {"planRevision": 1, "batchCommit": head, "dependencies": {}}}
        if stage == "prepare":
            evidence["inputs"].update({"commitScope": "repository_base", "repositoryRef": "default"})
        evidence["digest"] = parallel_evidence_aggregate._digest(evidence)
        path = workspace / (stage + ".json")
        path.write_text(json.dumps(evidence), "utf-8")
        stage_files[stage] = {"status": "passed", "evidencePath": str(path)}
    batch = {"batchId": "B001", "taskIds": ["T001"], "status": "merged",
             "repositoryRef": "default", "commitSha": head, "startSha": head,
             "mergeCommitSha": head, "stageStates": stage_files, "executionLane": "backend"}
    manifest = {"featureId": "alpha", "schemaVersion": 2, "integrationMode": "isolated",
                "pipeline": {"planRevision": 1}, "batches": {"B001": batch},
                "repositories": {"default": {"gitRoot": str(repo), "headSha": head}},
                "mergeTrains": {"wave1": {"repositoryRef": "default", "batchIds": ["B001"],
                  "candidateSha": head, "promotedSha": head, "deliveryCommits": {"B001": head},
                  "status": "promoted"}}}
    marker = workspace / "manifest.json"
    marker.write_text("{}", "utf-8")
    parallel_runtime.load_manifest = lambda *_: copy.deepcopy(manifest)
    parallel_runtime.manifest_path = lambda *_: marker
    # Native isolated binding is separately exercised by the full workflow. Here use real Git.
    parallel_integration.assert_integration = lambda binding: Path(binding["gitRoot"])
    previous = {"mergeCommitSha": head, "deliveryRunId": run, "mergedAt": "2026-10-21T08:00:00+00:00"}
    tasks = [{"id": "T001", "status": "done"}]
    def verified():
        return _verified_parallel_batch_merge(workspace, "alpha", "B001", previous, tasks)
    assert verified(), "valid native evidence and Git proof must project completion"
    batch["startSha"] = "0" * 40
    assert "B001.prepare_batch_commit_stale" in parallel_evidence_aggregate._evidence_errors(manifest, "B001", batch)
    assert not verified(), "tampered startSha must block Plan completion"
    del batch["startSha"]
    assert "B001.prepare_repository_binding_invalid" in parallel_evidence_aggregate._evidence_errors(manifest, "B001", batch)
    assert not verified(), "missing native baseline must fail closed"
    batch["startSha"] = head
    batch["executionLane"] = "frontend"
    test = batch["stageStates"]["test"]
    test.update({"status": "skipped", "skipReason": FRONTEND_UTEST_SKIP_REASON})
    test_path = Path(test["evidencePath"])
    evidence = json.loads(test_path.read_text("utf-8"))
    evidence.pop("digest")
    evidence["outcome"] = "SKIP"
    evidence["digest"] = parallel_evidence_aggregate._digest(evidence)
    test_path.write_text(json.dumps(evidence), "utf-8")
    assert verified(), "original explicit frontend skip with exact evidence is valid"
    test["skipReason"] = "caller_says_skip"
    assert not verified(), "arbitrary skip cannot replace UTest"
    test["skipReason"] = FRONTEND_UTEST_SKIP_REASON
    batch["executionLane"] = "backend"
    assert not verified(), "backend cannot claim frontend skip"
    batch["executionLane"] = "frontend"
    evidence["outcome"] = "PASS"
    evidence.pop("digest")
    evidence["digest"] = parallel_evidence_aggregate._digest(evidence)
    test_path.write_text(json.dumps(evidence), "utf-8")
    assert not verified(), "valid digest without original SKIP outcome is insufficient"
    test_path.unlink()
    assert not verified(), "missing evidence must block completion"
    print(json.dumps({"passed": True, "assertions": ["real-git-proof", "startSha-tamper-rejected",
          "missing-startSha-rejected", "valid-frontend-skip", "arbitrary-skip-rejected",
          "backend-skip-rejected", "wrong-outcome-rejected", "missing-proof-rejected"]}))
