"""Real original performance rules on committed, modified and unresolved code scopes."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

source, helper = [Path(value).resolve() for value in sys.argv[1:]]
spec = importlib.util.spec_from_file_location("checked_hooks", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="abmod-hook-") as temporary:
    workspace = Path(temporary)
    feature = workspace / ".autobizdevops/features/alpha"
    feature.mkdir(parents=True)
    repo = workspace / "code"
    repo.mkdir()

    def git(*args):
        result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def commit(message):
        git("add", ".")
        git("-c", "user.name=Local Fixture", "-c", "user.email=fixture@localhost",
            "-c", "commit.gpgsign=false", "commit", "-m", message)

    git("init", "--initial-branch=main")
    (repo / "view.ts").write_text("export const view = 1\n", encoding="utf-8")
    commit("base")
    base = git("rev-parse", "HEAD")
    ui = {"version": 1, "featureId": "alpha", "uiRequired": True,
          "decisionStatus": "locked", "decisionSource": "user_confirmed",
          "pages": [], "interactions": [], "visualSources": [],
          "capabilities": [{"capabilityId": "view", "uiRequired": True,
                            "specRefs": ["REQ-001 SCN-001"], "pageRefs": [], "interactionRefs": []}]}
    plan = {"featureId": "alpha", "implementationScope": "frontend_only",
            "codeWorkspaces": {"default": str(repo)},
            "batches": [{"id": "B001", "deliveryRunId": "cw-native-fixture"}]}
    manifest = {"featureId": "alpha", "runId": "cw-native-fixture",
                "repositories": {"default": {"gitRoot": str(repo), "baseSha": base}}}
    manifest_path = feature / ".parallel-runs/cw-native-fixture/manifest.json"
    manifest_path.parent.mkdir(parents=True)

    def save():
        (feature / "UI_CONTEXT.json").write_text(json.dumps(ui), encoding="utf-8")
        (feature / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def check():
        return module.validate_transition_hooks(source, workspace, "alpha", "code_done")

    save()
    result = check()
    assert result["errors"] == [], result
    assert result["receipts"][0]["result"] == "passed"
    # Commit the bad frontend file: the original helper's unstaged diff is now empty.
    # The explicit native base..HEAD binding must still invoke its unchanged rules.
    (repo / "view.ts").write_text("setInterval(() => {\n  fetch('/status')\n}, 1000)\n", encoding="utf-8")
    commit("bad timer")
    result = check()
    assert result["errors"] == ["AUTOBIZ_ORIGINAL_PERFORMANCE_FINDINGS"], result
    assert result["findings"] and all(item["rule_id"] for item in result["findings"])
    (repo / "view.ts").write_text("export const view = 2\n", encoding="utf-8")
    commit("fix timer")
    assert check()["errors"] == []
    manifest["repositories"]["default"]["gitRoot"] = str(workspace)
    save()
    assert check()["errors"] == ["AUTOBIZ_PERFORMANCE_REPOSITORY_BINDING_INVALID"]
    manifest["repositories"]["default"]["gitRoot"] = str(repo)
    plan["batches"] = []
    save()
    assert check()["errors"] == ["AUTOBIZ_PERFORMANCE_DELIVERY_BINDING_REQUIRED"]
    ui.update(uiRequired=False, decisionSource="default_false", notApplicableReason="API only",
              capabilities=[])
    plan["implementationScope"] = "backend_only"
    save()
    assert check()["receipts"][0]["reason"] == "locked-api-only"
    ui["decisionStatus"] = "defaulted"
    save()
    assert "ui_context_not_locked" in check()["errors"]
    (feature / "UI_CONTEXT.json").unlink()
    assert check()["errors"] == ["AUTOBIZ_PERFORMANCE_INPUT_INVALID"]
    assert module.validate_transition_hooks(source, workspace, "alpha", "prd_done")["receipts"][0]["reason"] == "other-checkpoint"
    print(json.dumps({"passed": True, "assertions": 9,
                      "originalRulesExecuted": True, "realGitCommittedChangeChecked": True}))
