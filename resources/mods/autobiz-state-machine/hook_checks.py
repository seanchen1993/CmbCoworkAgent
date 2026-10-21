"""Invoke original conditional business rules explicitly for the new Mod entry."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _json(path, inputs=None):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("AUTOBIZ_PERFORMANCE_INPUT_INVALID")
    data = path.read_bytes()
    if inputs is not None:
        inputs[path] = data
    return json.loads(data)


def _git(root, *args):
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, timeout=30)
    if result.returncode != 0 or len(result.stdout) > 4 * 1024 * 1024:
        raise ValueError("AUTOBIZ_PERFORMANCE_GIT_SCOPE_UNRESOLVED")
    return result.stdout


def validate_transition_hooks(source, workspace, feature, target):
    """Return {receipts, errors}; neither run the old CLI nor mutate business state."""
    receipt = {"id": "original-code-performance", "validatorVersion": "original-234/v1"}
    if target != "code_done":
        return {"receipts": [{**receipt, "result": "not-applicable", "reason": "other-checkpoint"}], "errors": []}
    try:
        source, workspace = Path(source).resolve(), Path(workspace).resolve()
        sys.path.insert(0, str(source / "hooks"))
        feature_root = workspace / ".autobizdevops" / "features" / feature
        ui_path, plan_path = feature_root / "UI_CONTEXT.json", feature_root / "plan.json"
        inputs = {}
        ui, plan = _json(ui_path, inputs), _json(plan_path, inputs)

        def assert_inputs():
            for path, original_bytes in inputs.items():
                if path.is_symlink() or path.read_bytes() != original_bytes:
                    raise ValueError("AUTOBIZ_PERFORMANCE_INPUT_CHANGED")
        ui_rules = _load(source / "hooks" / "ui_context.py", "mod_original_ui_context")
        errors = ui_rules.validate_ui_context_data(ui, feature_id=feature, require_locked=True)
        if errors:
            return {"receipts": [], "errors": errors}
        if ui["uiRequired"] is False and plan.get("implementationScope") == "backend_only":
            assert_inputs()
            return {"receipts": [{**receipt, "result": "not-applicable", "reason": "locked-api-only",
                                   "evidenceDigest": hashlib.sha256(inputs[ui_path] + inputs[plan_path]).hexdigest()}], "errors": []}
        if ui["uiRequired"] is not True or plan.get("implementationScope") not in ("frontend_only", "full_stack"):
            raise ValueError("AUTOBIZ_PERFORMANCE_SCOPE_UNRESOLVED")
        resolver = _load(source / "hooks" / "candidate_digest.py", "mod_original_candidate_digest")
        repos = resolver._plan_repositories(workspace, feature)
        original = _load(source / "hooks" / "performance_checker.py", "mod_original_performance")
        run_ids = {batch.get("deliveryRunId") for batch in plan.get("batches", []) if batch.get("deliveryRunId")}
        if not run_ids:
            raise ValueError("AUTOBIZ_PERFORMANCE_DELIVERY_BINDING_REQUIRED")
        manifests = []
        for run_id in sorted(run_ids):
            if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", run_id):
                raise ValueError("AUTOBIZ_PERFORMANCE_DELIVERY_BINDING_INVALID")
            manifest = _json(feature_root / ".parallel-runs" / run_id / "manifest.json", inputs)
            if manifest.get("featureId") != feature or manifest.get("runId") != run_id:
                raise ValueError("AUTOBIZ_PERFORMANCE_DELIVERY_BINDING_INVALID")
            manifests.append(manifest)
        facts, findings = [], []
        for root, refs in repos:
            before_head = _git(root, "rev-parse", "HEAD")
            paths = set(original._get_changed_files(str(root)))
            # The original helper scans unstaged files only. Completed delivery commits
            # additionally require the real, manifest-bound base..HEAD scope.
            for manifest in manifests:
                for ref in refs:
                    binding = manifest.get("repositories", {}).get(ref)
                    if not isinstance(binding, dict) or Path(binding.get("gitRoot", "")).resolve() != root:
                        raise ValueError("AUTOBIZ_PERFORMANCE_REPOSITORY_BINDING_INVALID")
                    base = binding.get("baseSha", "")
                    if not isinstance(base, str) or not re.fullmatch(r"[a-fA-F0-9]{40,64}", base):
                        raise ValueError("AUTOBIZ_PERFORMANCE_BASE_REQUIRED")
                    _git(root, "merge-base", "--is-ancestor", base, "HEAD")
                    paths.update(_git(root, "diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD").decode().split("\0"))
            paths.update(_git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").decode().split("\0"))
            paths.update(_git(root, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0"))
            if len(paths) > 512:
                raise ValueError("AUTOBIZ_PERFORMANCE_FILE_LIMIT")
            for name in sorted(paths - {""}):
                relative = Path(name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("AUTOBIZ_PERFORMANCE_FILE_SCOPE_INVALID")
                if relative.suffix.lower() not in original.FRONTEND_EXTENSIONS:
                    continue
                path = root / relative
                if path.resolve() != path.absolute() or not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
                    raise ValueError("AUTOBIZ_PERFORMANCE_FILE_SCOPE_INVALID")
                data = path.read_bytes()
                results = original.run_check(data.decode("utf-8"))
                facts.append({"repository": str(root), "path": name, "digest": hashlib.sha256(data).hexdigest()})
                findings.extend({**item, "file": name, "repository": str(root)} for item in results)
                if path.read_bytes() != data:
                    raise ValueError("AUTOBIZ_PERFORMANCE_INPUT_CHANGED")
            if _git(root, "rev-parse", "HEAD") != before_head:
                raise ValueError("AUTOBIZ_PERFORMANCE_INPUT_CHANGED")
        if findings:
            return {"receipts": [], "errors": ["AUTOBIZ_ORIGINAL_PERFORMANCE_FINDINGS"], "findings": findings}
        assert_inputs()
        input_digests = {str(path): hashlib.sha256(data).hexdigest() for path, data in inputs.items()}
        evidence = json.dumps([ui, plan, input_digests, facts], sort_keys=True, ensure_ascii=False).encode()
        return {"receipts": [{**receipt, "result": "passed", "files": facts,
                               "evidenceDigest": hashlib.sha256(evidence).hexdigest()}], "errors": []}
    except Exception as error:
        return {"receipts": [], "errors": [str(error)[:1000]]}
