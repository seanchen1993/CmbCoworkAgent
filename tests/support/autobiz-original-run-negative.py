"""Read-only negative check against actual completed original Workflow inputs."""
from __future__ import annotations
import argparse
import copy
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--plugin-root", type=Path, required=True)
parser.add_argument("--workspace", type=Path, required=True)
parser.add_argument("--feature", required=True)
parser.add_argument("--run-id", required=True)
args = parser.parse_args()
sys.path.insert(0, str(args.plugin_root.resolve(strict=True)))
from hooks.parallel_runtime import load_manifest
from hooks.parallel_evidence_aggregate import _evidence_errors

manifest = load_manifest(args.workspace.resolve(strict=True), args.feature, args.run_id)
results = []
for batch_id, batch in manifest["batches"].items():
    if batch.get("type") != "delivery":
        continue
    assert not _evidence_errors(manifest, batch_id, batch), "actual accepted native evidence required"
    changed = copy.deepcopy(manifest)
    changed_batch = changed["batches"][batch_id]
    original = changed_batch["startSha"]
    changed_batch["startSha"] = ("0" if original[0] != "0" else "1") + original[1:]
    errors = _evidence_errors(changed, batch_id, changed_batch)
    assert f"{batch_id}.prepare_batch_commit_stale" in errors, errors
    del changed_batch["startSha"]
    missing = _evidence_errors(changed, batch_id, changed_batch)
    assert f"{batch_id}.prepare_repository_binding_invalid" in missing, missing
    results.append({"batchId": batch_id, "tamperedBaselineRejected": errors,
                    "missingBaselineRejected": missing})
assert results, "actual native delivery batches required"
print(json.dumps({"passed": True, "actualRunId": args.run_id, "results": results,
                  "originalNativeInputsUnchanged": True}))
