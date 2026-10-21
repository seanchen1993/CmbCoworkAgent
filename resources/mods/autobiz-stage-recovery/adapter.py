"""AutoBiz-owned recovery protocol. The host does not interpret AutoBiz checkpoints.

The original rollback CLI owns all state/artifact/archive semantics. This adapter only
relocates a private output copy, rejects unsafe repository ownership, and verifies facts.
It never writes a checkpoint or suppresses the original Hook validators.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

PROTOCOL = "devclaw.plugin-stage-recovery-result/v1"
def plugin_root():
    """Resolve this explicitly declared adapter within its own package namespace."""
    script = Path(__file__).resolve(strict=True)
    for parent in script.parents:
        if parent.name != "mods":
            continue
        relative = script.relative_to(parent).parts
        if not relative or relative[0] not in ("business", "stage-recovery"):
            continue
        candidate = parent.parent
        declaration = candidate / "devclaw.stage-recovery-adapter.json"
        if not declaration.is_file():
            raise ValueError("AUTOBIZ_RECOVERY_PACKAGE_DECLARATION_REQUIRED")
        configured = json.loads(declaration.read_text(encoding="utf-8-sig"))
        entry = Path(configured.get("entry", ""))
        if entry.is_absolute() or ".." in entry.parts or (candidate / entry).resolve() != script:
            raise ValueError("AUTOBIZ_RECOVERY_PACKAGE_SCOPE_CHANGED")
        if not (candidate / "hooks/rollback_stage.py").is_file() or not (candidate / "board_core/board_config.json").is_file():
            raise ValueError("AUTOBIZ_RECOVERY_ORIGINAL_RESOURCES_REQUIRED")
        return candidate
    raise ValueError("AUTOBIZ_RECOVERY_PACKAGE_SCOPE_CHANGED")


ROOT = plugin_root()
KEYS = (
    "feature", "requestedStage", "targetNodeId", "previousNodeId", "stateMode",
    "oldCheckpoint", "newCheckpoint", "plannedArtifacts", "codeInScope", "codeSource",
    "plannedSourceFiles", "sourceConflicts", "codeResetTasks",
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def contained(root, target):
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def inspect_copy(workspace, source, *, relocate):
    """Never carry a live lease, an external Git binding or a .git pointer into recovery."""
    rewrites = []
    for path in sorted(workspace.rglob("*")):
        if path.is_symlink():
            raise ValueError("AUTOBIZ_RECOVERY_LINK_NOT_SUPPORTED")
        if path.name.lower() == ".git":
            raise ValueError("AUTOBIZ_RECOVERY_GIT_REQUIRES_PRIVATE_CLONE")
        if path.is_dir() and path.name in ("worktrees", ".parallel-runs") and any(path.iterdir()):
            raise ValueError("AUTOBIZ_RECOVERY_WORKTREE_REBIND_REQUIRED")
        if not path.is_file() or path.suffix.lower() != ".json":
            continue
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("AUTOBIZ_RECOVERY_JSON_LIMIT")
        raw = path.read_text(encoding="utf-8-sig")
        value = json.loads(raw)
        relative_parts = path.relative_to(workspace).parts
        if isinstance(value, dict) and (
            ".task-runs" in relative_parts or "workflows" in relative_parts
        ) and value.get("status") in ("running", "queued", "leased", "starting", "in_progress"):
            raise ValueError("AUTOBIZ_RECOVERY_ACTIVE_EXECUTION_NOT_SETTLED")

        def visit(item, key="", parents=()):
            if isinstance(item, dict):
                return {name: visit(child, name, (*parents, key.lower())) for name, child in item.items()}
            if isinstance(item, list):
                return [visit(child, key, parents) for child in item]
            if not isinstance(item, str):
                return item
            candidate = Path(item)
            lowered = key.lower()
            repository_context = any("repositor" in parent for parent in parents)
            repository_path = lowered in (
                "gitroot", "reporoot", "repositoryroot", "localrepopath", "worktreepath",
                "codeworkspace", "codeworkspaces", "repositorypath", "repopath", "cwd",
                "workspace", "workspacepath", "repositories",
            ) or (repository_context and lowered in ("path", "root"))
            if (parents and parents[-1] == "repositories" and
                    lowered not in ("id", "name", "description", "repository", "repositoryid",
                                    "repositoryref", "status", "branchname", "basebranch",
                                    "headcommit", "indextree", "url", "remoteurl") and
                    (candidate.anchor or "/" in item or "\\" in item or "${" in item)):
                repository_path = True
            if repository_path and not item.strip():
                return item
            if repository_path and "${" in item:
                raise ValueError("AUTOBIZ_RECOVERY_EXTERNAL_REPOSITORY_REBIND_REQUIRED")
            if candidate.is_absolute() or candidate.anchor or repository_path:
                resolved = (candidate if candidate.anchor else workspace / candidate).resolve()
                if contained(source, resolved):
                    return str(workspace / resolved.relative_to(source))
                if contained(workspace, resolved):
                    # Repository roots must not depend on a later Hook's working directory.
                    return str(resolved) if repository_path else item
                if (repository_path or
                        ("knowledge" not in lowered and lowered.endswith(("root", "path", "dir", "directory", "workspace")))):
                    raise ValueError("AUTOBIZ_RECOVERY_EXTERNAL_REPOSITORY_REBIND_REQUIRED")
            # Native project output references may also appear within a JSON prompt value.
            return item.replace(str(source), str(workspace)).replace(source.as_posix(), workspace.as_posix())

        mapped = visit(value)
        if mapped != value:
            if not relocate:
                raise ValueError("AUTOBIZ_RECOVERY_STALE_SOURCE_REFERENCE")
            rewrites.append(path.relative_to(workspace).as_posix())
            # Relocation is adapter-owned; the original state checkpoint is left unchanged.
            path.write_text(json.dumps(mapped, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return rewrites


def rollback(request, apply):
    workspace = Path(request["workspace"]).resolve(strict=True)
    env = dict(os.environ)
    env.update({"PLUGIN_WORKSPACE": str(workspace.parent), "PROJECT_DIR": workspace.name,
                "FEATURE_ID": request["featureId"], "SESSION_WORKSPACE_PATH": str(workspace),
                "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"})
    completed = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", str(ROOT / "hooks/rollback_stage.py"),
         "--feature", request["featureId"], "--to-stage", request["stageId"],
         "--state-mode", request["stateMode"], "--code-source", "keep",
         "--apply" if apply else "--dry-run", "--json"],
        cwd=workspace, env=env, capture_output=True, text=True, encoding="utf-8", timeout=90,
    )
    try:
        result = json.loads(completed.stdout)
    except ValueError as error:
        raise ValueError("AUTOBIZ_RECOVERY_ORIGINAL_CLI_RESULT_INVALID") from error
    if completed.returncode or not result.get("ok"):
        raise ValueError("AUTOBIZ_RECOVERY_ORIGINAL_CLI_BLOCKED: " + "; ".join(result.get("errors", [])))
    return result


def preserved_context(workspace):
    """Knowledge/UI/config inputs are compared across original rollback, not recreated."""
    selected = {}
    for path in sorted(workspace.rglob("*")):
        if path.is_file() and (
            path.name == "UI_CONTEXT.json" or
            any("knowledge" in part.lower() for part in path.relative_to(workspace).parts) or
            path.name in ("project.json", "config.json", "board_config.json")
        ):
            selected[path.relative_to(workspace).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return selected


def execute(request):
    if request.get("apiVersion") != "devclaw.plugin-stage-recovery-request/v1":
        raise ValueError("AUTOBIZ_RECOVERY_PROTOCOL_INVALID")
    if request.get("codeSource") != "keep":
        raise ValueError("AUTOBIZ_RECOVERY_CODE_RESTORE_REQUIRES_PRIVATE_CLONE")
    workspace = Path(request["workspace"]).resolve(strict=True)
    # Verification after adoption uses the frozen original path only as a relocation
    # boundary. A finished private branch must not read or depend on its former source.
    source = Path(request["sourceWorkspace"]).resolve(strict=request["operation"] != "verify")
    if workspace == source or contained(source, workspace) or contained(workspace, source):
        raise ValueError("AUTOBIZ_RECOVERY_PRIVATE_COPY_REQUIRED")
    operation = request["operation"]
    if operation not in ("plan", "apply", "verify"):
        raise ValueError("AUTOBIZ_RECOVERY_OPERATION_INVALID")
    rewrites = inspect_copy(workspace, source, relocate=operation == "plan")
    if operation == "plan":
        plan = rollback(request, False)
        evidence = {"plan": {key: plan.get(key) for key in KEYS},
                    "preservedContext": preserved_context(workspace), "relocatedFiles": rewrites}
    else:
        evidence = request.get("planEvidence", {})
        expected = evidence.get("plan")
        if not isinstance(expected, dict) or expected.get("feature") != request["featureId"]:
            raise ValueError("AUTOBIZ_RECOVERY_FROZEN_PLAN_REQUIRED")
        if operation == "apply":
            fresh = rollback(request, False)
            if {key: fresh.get(key) for key in KEYS} != expected:
                raise ValueError("AUTOBIZ_RECOVERY_PLAN_CHANGED")
            result = rollback(request, True)
            if result.get("newCheckpoint") != expected["newCheckpoint"]:
                raise ValueError("AUTOBIZ_RECOVERY_RESULT_CHANGED")
        # Use the original parser and workflow contracts to validate the actual recovered state.
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from board_core.state_store import load_state_json_records_result
        from board_core.contracts import load_record_workflow_contracts
        loaded = load_state_json_records_result(workspace)
        if loaded.errors or request["featureId"] not in loaded.records:
            raise ValueError("AUTOBIZ_RECOVERY_STATE_INVALID")
        record = loaded.records[request["featureId"]]
        if record.get("checkpoint") != expected["newCheckpoint"]:
            raise ValueError("AUTOBIZ_RECOVERY_CHECKPOINT_NOT_APPLIED")
        load_record_workflow_contracts(ROOT, record, workspace=workspace)
        if preserved_context(workspace) != evidence.get("preservedContext"):
            raise ValueError("AUTOBIZ_RECOVERY_CONTEXT_NOT_PRESERVED")
        inspect_copy(workspace, source, relocate=False)
    return {"apiVersion": PROTOCOL, "ok": True,
            "summary": f"{request['stageId']}: {evidence['plan']['oldCheckpoint']} → {evidence['plan']['newCheckpoint']}（保留业务源码；独立副本）",
            "affectedArtifacts": evidence["plan"].get("plannedArtifacts", []),
            "diagnostics": [], "evidence": evidence}


if __name__ == "__main__":
    try:
        print(json.dumps(execute(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"apiVersion": PROTOCOL, "ok": False, "summary": "AutoBiz 阶段恢复被阻止",
                          "affectedArtifacts": [], "diagnostics": [str(error)], "evidence": {}}, ensure_ascii=False))
        sys.exit(1)
