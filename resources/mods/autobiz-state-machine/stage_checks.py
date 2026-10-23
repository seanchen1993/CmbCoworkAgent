#!/usr/bin/env python3
"""Add stage evidence around the original AutoBiz lifecycle check, without replacing it."""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path


PROTOCOL = "devclaw.stage-check/v1"
MARKER = "DEVCLAW_STAGE_CHECK_V1 "
MAX_BYTES = 64 * 1024 * 1024
MAX_FILES = 128

# Additional mutable inputs whose content the named original validators inspect.
# Outputs are already governed by the complete original postcheck contract.
# Do not treat every required input as a validated output.
VALIDATED_INPUTS = {
    "plan_json_contract": {"plan.json", "PLAN.md"},
    "plan_finished_tasks": {"plan.json", "PLAN.md"},
    "plan_task_detail_schema": {"plan.json"},
    "plan_json_initial_tasks": {"plan.json"},
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def load_original(source):
    sys.path.insert(0, str(source))
    sys.path.insert(0, str(source / "hooks"))
    sys.path.insert(0, str(source / "skills" / "autodev" / "hooks"))
    from board_core.contracts import load_record_workflow_contracts, load_repo_workflow_contracts
    return load_record_workflow_contracts, load_repo_workflow_contracts


def compiled(source, workspace, record=None, profile="fullstack", decisions=None):
    by_record, by_profile = load_original(source)
    if record is not None:
        return by_record(source, record, workspace=workspace)
    return by_profile(source, workspace=workspace, profile=profile, workflow_decisions=decisions)


def contract_node(workflow, contract):
    nodes = [node for node in workflow.nodes if node.get("id") == contract.node_id
             and node.get("skill") == contract.skill]
    if len(nodes) != 1:
        raise ValueError("Effective stage contract is ambiguous or absent")
    return nodes[0]


def contract_value(contract, feature, check_id="postcheck", *, node):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", feature):
        raise ValueError("Invalid feature")
    extra = set().union(*(VALIDATED_INPUTS.get(key, set()) for key in contract.validators))
    artifacts = {item.id: item for item in contract.outputs}
    for item in contract.inputs:
        if item.path in extra:
            artifacts.setdefault(item.id, item)
    prefix = f".autobizdevops/features/{feature}/"
    paths = []
    for item in artifacts.values():
        path = prefix + item.path
        if item.kind in ("directory", "dir", "folder"):
            path = path.rstrip("/") + "/**/*"
        paths.append({"id": item.id, "path": path, **({"pattern": True} if "*" in path else {})})
    # Include every effective field, not just output names. Changing a validator or
    # workflow contract must invalidate previously frozen evidence.
    if node.get("id") != contract.node_id or node.get("skill") != contract.skill:
        raise ValueError("Effective stage contract identity changed")
    # Original SkillContract/ArtifactSpec dataclasses omit extension fields such as
    # output schemas and validatorBindings. Bind their complete effective raw node
    # as well, so a workspace overlay cannot reuse evidence from an older contract.
    value = {"protocol": PROTOCOL, "coverageVersion": 3, "checkId": check_id,
             "contract": dataclasses.asdict(contract),
             "effectiveNode": node,
             "artifacts": paths}
    return {"nodeId": contract.node_id, "checkId": check_id, "contractDigest": digest(value),
            "artifacts": paths, **({"checkOnly": True} if not paths and contract.validators else {})}


def contract_values(workflow, feature):
    values = []
    for contract in workflow.skill_contracts.values():
        node = contract_node(workflow, contract)
        if contract.outputs or contract.validators:
            values.append(contract_value(contract, feature, node=node))
        if contract.node_id in ("biz.discuss", "biz.prd"):
            check_id = "biz-discuss-validate" if contract.node_id == "biz.discuss" else "biz-prd-validate"
            values.append(contract_value(contract, feature, check_id, node=node))
    return values


def collect_receipt(contract, feature, workspace, check_id="postcheck", *, node):
    value = contract_value(contract, feature, check_id, node=node)
    artifacts = []
    size = 0
    for item in value["artifacts"]:
        pattern = item["path"]
        relative = Path(pattern)
        if relative.is_absolute() or ".." in relative.parts or "\\" in pattern:
            raise ValueError("Unsafe artifact path")
        matches = sorted(workspace.glob(pattern)) if item.get("pattern") else [workspace / relative]
        for path in matches:
            if not path.exists():
                continue  # Optional outputs may be absent; original required checks already ran.
            if path.is_dir():
                if not item.get("pattern"):
                    raise ValueError("A file contract cannot attest a directory")
                continue
            paths = [path]
            for file in paths:
                if file.is_dir():
                    continue
                if file.is_symlink() or file.resolve() != file.absolute() or not file.is_file():
                    raise ValueError("Unsafe artifact")
                before = file.stat()
                size += before.st_size
                if size > MAX_BYTES or len(artifacts) >= MAX_FILES:
                    raise ValueError("Artifact limit")
                data = file.read_bytes()
                after = file.stat()
                if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
                ):
                    raise ValueError("Artifact changed")
                artifacts.append({"id": item["id"], "path": file.relative_to(workspace).as_posix(),
                                  "digest": hashlib.sha256(data).hexdigest()})
    return {"apiVersion": PROTOCOL, "nodeId": value["nodeId"], "checkId": check_id,
            "contractDigest": value["contractDigest"], "outcome": "passed", "artifacts": artifacts}


def strict_handoff_nodes(workflow, receipts):
    """Private commit metadata; never extend the public stage-check/v1 receipt."""
    covered = {receipt["nodeId"] for receipt in receipts
               if receipt.get("checkId") == "postcheck" and receipt.get("outcome") == "passed"}
    return sorted(node["id"] for node in workflow.nodes if node["id"] in covered and (
        node.get("validatorBindings") or any(
            "schema" in item for item in node.get("artifacts", {}).get("outputs", []))))


def validate_completed_biz(source, workspace, feature, record, receipts, target_checkpoint=None):
    """Original Biz validation runs at its original done checkpoint, before leaving that stage.

    The caller holds both canonical state files against writes. No historical validation is
    replayed at terminal, and this receipt is separate from the original postcheck evidence.
    """
    stages = {"discuss_done": ("biz.discuss", "discuss", "biz-discuss-validate"),
              "prd_done": ("biz.prd", "prd", "biz-prd-validate")}
    requested = [stages[record["checkpoint"]]] if record.get("checkpoint") in stages else []
    if not requested and target_checkpoint not in stages:
        return
    workflow = compiled(source, workspace, record)
    if target_checkpoint in stages and workflow.nodes:
        terminal = next((item for item in workflow.skill_contracts.values()
                         if item.node_id == workflow.nodes[-1].get("id")), None)
        candidate = stages[target_checkpoint]
        if (terminal is not None and terminal.node_id == candidate[0]
                and terminal.checkpoints and terminal.checkpoints[-1] == target_checkpoint
                and candidate not in requested):
            requested.append(candidate)
    for node_id, method, check_id in requested:
        validate_biz_stage(source, workspace, feature, workflow, receipts, node_id, method, check_id)


def validate_biz_stage(source, workspace, feature, workflow, receipts, node_id, method, check_id):
    """A terminal Biz stage has no later transition; validate before its locked done commit."""
    contract = next((item for item in workflow.skill_contracts.values() if item.node_id == node_id), None)
    if contract is None:
        raise ValueError("Completed Biz stage is absent from the original contract")
    spec = importlib.util.spec_from_file_location("devclaw_original_biz_validate",
                                                source / "skills/autobiz/hooks/biz_validate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sync = module.check_or_fix_state_sync
    module.check_or_fix_state_sync = lambda path, **kwargs: sync(path, fix=False)
    node = contract_node(workflow, contract)
    before = collect_receipt(contract, feature, workspace, check_id, node=node)
    result = getattr(module, "validate_" + method)(feature, workspace)
    if result.get("ok") is not True or result.get("skipped"):
        raise ValueError("; ".join([result.get("message", "Original Biz validation failed"),
                                   *result.get("errors", [])]))
    after = collect_receipt(contract, feature, workspace, check_id, node=node)
    if canonical(before) != canonical(after):
        raise ValueError("Biz artifacts changed during the original validation")
    receipts.append(after)


def install_original_postcheck(source):
    load_original(source)
    spec = importlib.util.spec_from_file_location("state_checkpoint", source / "hooks" / "state_checkpoint.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    original = module.run_postcheck
    class Receipts(list):
        evidence_errors = False
    receipts = Receipts()

    def checked(repo_root, workspace_root, skill, slug, **kwargs):
        from compiled_contract import install_bound_validators, validate_output_schemas
        effective = compiled(repo_root, workspace_root, kwargs.get("workflow_record"),
                             kwargs.get("workflow_profile", module.BASE_WORKFLOW_PROFILE),
                             kwargs.get("workflow_decisions"))
        install_bound_validators(repo_root, effective)
        before = None
        try:
            workflow = compiled(repo_root, workspace_root, kwargs.get("workflow_record"),
                                kwargs.get("workflow_profile", module.BASE_WORKFLOW_PROFILE),
                                kwargs.get("workflow_decisions"))
            contract = workflow.contract_for_skill(skill)
            before = collect_receipt(contract, slug, workspace_root,
                                     node=contract_node(workflow, contract))
        except Exception:
            # Still run the original check with exactly its original arguments.
            pass
        # No preflight rewrite, changed arguments, validator override or terminal replay.
        result = original(repo_root, workspace_root, skill, slug, **kwargs)
        if result[0] == 0:
            node = next(item for item in effective.nodes if item.get("skill") == skill)
            validate_output_schemas(workspace_root, slug, node)
            try:
                if kwargs.get("validators_override") is not None or kwargs.get("required_outputs_override") is not None:
                    raise ValueError("Overridden contract is not eligible")
                workflow = compiled(repo_root, workspace_root, kwargs.get("workflow_record"),
                                    kwargs.get("workflow_profile", module.BASE_WORKFLOW_PROFILE),
                                    kwargs.get("workflow_decisions"))
                contract = workflow.contract_for_skill(skill)
                receipt = collect_receipt(contract, slug, workspace_root,
                                          node=contract_node(workflow, contract))
                if before is None or canonical(before) != canonical(receipt):
                    raise ValueError("Checked artifacts changed while the original validator ran")
                encoded = base64.b64encode(canonical(receipt).encode("utf-8")).decode("ascii")
                if len(encoded) > 64 * 1024 or len(receipts) >= 32:
                    raise ValueError("Receipt limit")
                receipts.append(receipt)
            except Exception as error:
                receipts.evidence_errors = True
                # Evidence failure cannot weaken or replace the original Hook decision.
                # No receipt means the host cannot certify this stage or hand off outputs.
                print(f"DevClaw stage evidence unavailable: {type(error).__name__}", file=sys.stderr)
        return result

    module.run_postcheck = checked
    return module, receipts


def validate_added_completion(source, workspace, feature, record, target, observer):
    """Added module contracts are checked before marking done, also when terminal."""
    workflow = compiled(source, workspace, record)
    for node in workflow.nodes:
        outputs = node.get("artifacts", {}).get("outputs", [])
        if (node.get("checkpoints", [None])[-1] != target
                or not (node.get("validatorBindings") or any("schema" in item for item in outputs))):
            continue
        code, message = observer.run_postcheck(source, workspace, node["skill"], feature,
                                               workflow_record=record, target_checkpoint=target)
        if code:
            raise ValueError(message)


def run_hook(source, argv):
    module, receipts = install_original_postcheck(source)
    result = module.main(argv)
    if result == 0:
        for receipt in receipts:
            print(MARKER + base64.b64encode(canonical(receipt).encode("utf-8")).decode("ascii"))
    return result


def main():
    source = Path(__file__).resolve().parents[1]
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "contracts":
        workspace = Path(args[1]).resolve()
        feature = args[2]
        # Read JSON without the original inspector's repair-on-read behavior.
        state = json.loads((workspace / ".autobizdevops" / "state.json").read_text(encoding="utf-8"))
        record = state["features"][feature]
        workflow = compiled(source, workspace, record)
        print(canonical(contract_values(workflow, feature)))
        return 0
    if len(args) == 1 and args[0] in ("state-done", "autodev-lifecycle"):
        return run_hook(source, args)
    raise ValueError("Expected contracts <workspace> <feature> or an original lifecycle command")


if __name__ == "__main__":
    raise SystemExit(main())
