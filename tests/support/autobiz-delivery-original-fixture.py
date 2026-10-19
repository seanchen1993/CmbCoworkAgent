#!/usr/bin/env python3
"""Controlled contract fixture using real AutoBiz init, checks and one transition.

No state/checkpoint/ManagedRun/approval receipt is fabricated. This deliberately
stops at specs_done. It is not a completed AutoBiz business acceptance.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import io
import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--feature", required=True)
    args = parser.parse_args()
    source = Path(args.source).resolve(strict=True)
    parent = Path(args.workspace).resolve()
    if args.project in {"", ".", ".."} or any(c in args.project for c in "/\\:"):
        raise ValueError("project must be a directory name")
    project = parent / args.project
    if project.exists():
        raise ValueError("Fixture requires a new project directory")
    project.mkdir(parents=True)
    sys.path.insert(0, str(source))
    from hooks.init_workspace import create_feature, init_workspace
    from hooks.stage_gate import validate_stage
    from hooks.inspect_workflow_templates import _closure_payload
    from board_core.contracts import load_board_config
    from board_core.state_store import load_state_json_records
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        init_workspace(project)
        create_feature(project, args.feature, workflow_template="custom", workflow_nodes=["dev.specs", "dev.code", "ops.archive"])
        missing = validate_stage(workspace=project, feature=args.feature, stage="dev.specs")
    if missing.ok:
        raise AssertionError("Original empty-spec gate must fail")
    state_path = project / ".autobizdevops/state.json"
    initial_state = state_path.read_bytes()
    env = {**os.environ, "PLUGIN_WORKSPACE": str(parent), "PROJECT_DIR": args.project, "FEATURE_ID": args.feature,
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    def transition(checkpoint: str) -> dict:
        completed = subprocess.run([sys.executable, "-B", "-X", "utf8", str(source / "hooks/update_checkpoint.py"),
                                    "--checkpoint", checkpoint, "--json"], env=env, cwd=source,
                                   capture_output=True, text=True, encoding="utf-8", check=False)
        return {"checkpoint": checkpoint, "exitCode": completed.returncode,
                "stdout": completed.stdout, "stderr": completed.stderr}
    denied = transition("specs_done")
    if denied["exitCode"] == 0 or state_path.read_bytes() != initial_state:
        raise AssertionError("Missing artifacts must not advance the original checkpoint")
    feature_dir = project / ".autobizdevops/features" / args.feature
    (feature_dir / "specs/mods-report").mkdir(parents=True)
    proposal = "# Controlled Mods delivery contract fixture\n\n## Capabilities\n\n- `mods-report`: Inspect real state and output a reviewable report.\n"
    spec = "# Controlled Mods contract fixture\n\n### Requirement REQ-001: Preserve actual evidence\n\nThe report SHALL read the declared files and preserve SHA256.\n\n#### Scenario SCN-001: A report remains pending review\n\n- **WHEN** the report is generated\n- **THEN** qualityStatus is needs_review and the checkpoint is unchanged\n"
    (feature_dir / "proposal.md").write_text(proposal, encoding="utf-8")
    (feature_dir / "specs/mods-report/spec.md").write_text(spec, encoding="utf-8")
    (feature_dir / "UI_CONTEXT.json").write_text(json.dumps({"version": 1, "featureId": args.feature,
        "uiRequired": False, "decisionStatus": "locked", "decisionSource": "user_confirmed",
        "notApplicableReason": "Controlled API-only contract fixture; not native human approval evidence",
        "lockedAtCheckpoint": "specs_done", "pages": [], "interactions": [], "visualSources": [], "capabilities": []}), encoding="utf-8")
    with contextlib.redirect_stdout(captured):
        checked = validate_stage(workspace=project, feature=args.feature, stage="dev.specs")
    if not checked.ok:
        raise AssertionError("Original specs contract rejected controlled fixture: " + json.dumps(dataclasses.asdict(checked), default=str))
    advanced = transition("specs_done")
    if advanced["exitCode"] != 0:
        raise AssertionError("Original lawful specs transition rejected: " + json.dumps(advanced))
    records, errors, exists = load_state_json_records(project)
    if not exists or errors or records[args.feature]["checkpoint"] != "specs_done":
        raise AssertionError("Original state normalizer did not observe specs_done")
    config = load_board_config()
    result = {"source": str(source), "workspace": str(parent), "project": args.project, "feature": args.feature,
              "projectRoot": str(project), "statePath": str(state_path), "checkpoint": "specs_done",
              "selectedNodes": records[args.feature]["workflowNodes"], "record": records[args.feature],
              "gates": {"missing": dataclasses.asdict(missing), "beforeSeedTransition": denied,
                        "seeded": dataclasses.asdict(checked), "lawfulTransition": advanced},
              "artifactPaths": [str(feature_dir / p) for p in ["proposal.md", "specs/mods-report/spec.md", "UI_CONTEXT.json"]],
              "dependencyPreview": _closure_payload(config, ["dev.specs", "dev.code", "ops.archive"], auto_include=False),
              "fullDependencyPreview": _closure_payload(config, ["dev.specs", "dev.code", "ops.archive"], auto_include=True),
              "limits": ["Controlled contract documents only, not business quality acceptance",
                         "Native model/tool/human approval not exercised by this Python fixture",
                         "Not terminal: code and archive have not executed; do not emit a terminal handoff or ManagedRun"]}
    if captured.getvalue():
        print(captured.getvalue(), file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
