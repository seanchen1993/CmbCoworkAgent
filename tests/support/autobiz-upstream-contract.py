"""Current producer contracts must match physically committed, file-bound evidence."""

import copy
import dataclasses
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types

sys.path.insert(0, sys.argv[1])
import compiled_contract
from stage_checks import canonical, collect_receipt, contract_value, strict_handoff_nodes


# Match the original kernel's lossy dataclasses: schema and validatorBindings are
# intentionally absent, so this regression cannot pass by hashing that dataclass alone.
@dataclasses.dataclass(frozen=True)
class ArtifactSpec:
    id: str
    label: str
    path: str
    kind: str = "file"
    required: bool = True
    extract: object = None


@dataclasses.dataclass(frozen=True)
class SkillContract:
    node_id: str
    label: str
    group: str
    skill: str
    checkpoints: tuple
    inputs: tuple
    outputs: tuple
    validators: tuple
    guards: tuple


producer = {
    "id": "custom.convert", "label": "Convert", "group": "Biz", "skill": "convert",
    "checkpoints": ["convert_active", "convert_done"],
    "artifacts": {"inputs": [], "outputs": [{
        "id": "normalized", "path": "NORMALIZED.json", "schemaVersion": "1.0.0",
        "schema": {"type": "object", "required": ["requirements"], "properties": {
            "requirements": {"type": "array", "minItems": 1}}}}]},
    "validators": ["business:custom.convert"],
    "validatorBindings": {"business:custom.convert": {"path": "check.py", "function": "validate"}}
}
consumer = {
    "id": "prd", "skill": "prd", "checkpoints": ["prd_active", "prd_done"],
    "artifacts": {"inputs": [{"id": "normalized", "path": "NORMALIZED.json", "required": True}],
                  "outputs": []}
}
contract = SkillContract("custom.convert", "Convert", "Biz", "convert",
                         ("convert_active", "convert_done"), (),
                         (ArtifactSpec("normalized", "Normalized", "NORMALIZED.json"),),
                         ("business:custom.convert",), ())
workflow = types.SimpleNamespace(nodes=[producer, consumer],
                                 contract_for_skill=lambda skill: contract)
sys.modules["board_core.contracts"] = types.SimpleNamespace(
    load_record_workflow_contracts=lambda *args, **kwargs: workflow)
compiled_contract.policy_digest = lambda _: "a" * 64
checks = 0


def accepted(root, target="prd_active"):
    global checks
    compiled_contract.assert_verified_inputs(root, root, "F1", {"checkpoint": "convert_done"}, target)
    checks += 1


def rejected(root, message="AUTOBIZ_UPSTREAM_ARTIFACT_CHANGED"):
    global checks
    try:
        compiled_contract.assert_verified_inputs(root, root, "F1", {"checkpoint": "convert_done"}, "prd_active")
    except ValueError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("Expected a stale producer contract to be rejected")
    checks += 1


with tempfile.TemporaryDirectory(prefix="autobiz-upstream-") as temporary:
    root = Path(temporary).resolve()
    artifact = root / ".autobizdevops/features/F1/NORMALIZED.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text('{"requirements":["one"]}', encoding="utf-8")
    journal = root / ".autobizdevops/function-state-journal"
    journal.mkdir()

    def publish(receipt):
        evidence = [receipt]
        row = {"operationId": "op1", "phase": "committed", "request": {
            "feature": "F1", "to": "convert_done", "policyDigest": "a" * 64,
            "workflowDigest": "a-previous-record-specific-workflow"}, "stageChecks": evidence}
        physical = {"operationId": "op1", "policyDigest": "a" * 64,
                    "stageChecksDigest": hashlib.sha256(canonical(evidence).encode()).hexdigest(),
                    "strictHandoffNodes": ["custom.convert"],
                    "strictHandoffDigest": hashlib.sha256(canonical({
                        "stageChecks": evidence, "strictHandoffNodes": ["custom.convert"]
                    }).encode()).hexdigest()}
        (journal / "op1.json").write_text(json.dumps(row), encoding="utf-8")
        (journal / "op1.physical.json").write_text(json.dumps(physical), encoding="utf-8")

    original = copy.deepcopy(producer)
    receipt = collect_receipt(contract, "F1", root, node=producer)
    assert set(receipt) == {"apiVersion", "nodeId", "checkId", "contractDigest", "outcome", "artifacts"}
    assert strict_handoff_nodes(workflow, [receipt]) == ["custom.convert"]
    publish(receipt)
    accepted(root)
    # Consumer changes and normal record/checkpoint progression do not change the
    # producing stage's contract. Whole-workflow digest equality would fail here.
    consumer["label"] = "Updated consumer description"
    accepted(root, "prd_done")
    producer["artifacts"]["outputs"][0]["schema"]["properties"]["requirements"]["minItems"] = 2
    # The original dataclass is unchanged, yet the effective raw contract is stricter.
    assert contract_value(contract, "F1", node=producer)["contractDigest"] != receipt["contractDigest"]
    rejected(root)
    producer.clear()
    producer.update(copy.deepcopy(original))
    producer["artifacts"]["outputs"][0]["schemaVersion"] = "2.0.0"
    rejected(root)
    producer.clear()
    producer.update(copy.deepcopy(original))
    producer["validatorBindings"]["business:custom.convert"]["function"] = "validate_v2"
    rejected(root)
    producer.clear()
    producer.update(copy.deepcopy(original))
    del producer["validatorBindings"]
    del producer["artifacts"]["outputs"][0]["schema"]
    # Removing today's schema/bindings must not downgrade a published strict handoff.
    rejected(root)
    producer["checkpoints"] = ["renamed_active", "renamed_done"]
    rejected(root)
    producer.clear()
    producer.update(copy.deepcopy(original))
    historical = copy.deepcopy(receipt)
    historical["contractDigest"] = "old-lossy-dataclass-contract"
    publish(historical)
    rejected(root)
    publish(receipt)
    artifact.write_text('{"requirements":["replaced"]}', encoding="utf-8")
    rejected(root)
    artifact.write_text('{"requirements":["one"]}', encoding="utf-8")
    physical_path = journal / "op1.physical.json"
    physical = json.loads(physical_path.read_text(encoding="utf-8"))
    physical["stageChecksDigest"] = "incorrect"
    physical_path.write_text(json.dumps(physical), encoding="utf-8")
    rejected(root)
    publish(receipt)
    physical = json.loads(physical_path.read_text(encoding="utf-8"))
    physical["strictHandoffNodes"] = []
    physical_path.write_text(json.dumps(physical), encoding="utf-8")
    rejected(root)
    publish(receipt)
    physical = json.loads(physical_path.read_text(encoding="utf-8"))
    physical["strictHandoffDigest"] = "incorrect"
    physical_path.write_text(json.dumps(physical), encoding="utf-8")
    rejected(root)
    publish(receipt)
    accepted(root)
    # An original legacy producer without new extension metadata or published
    # strict evidence keeps its original validation path.
    producer.pop("validatorBindings")
    producer["artifacts"]["outputs"][0].pop("schema")
    for path in journal.iterdir():
        path.unlink()
    accepted(root)
    assert artifact.read_text(encoding="utf-8") == '{"requirements":["one"]}'

assert checks == 14, checks
print(json.dumps({"passed": True, "checks": checks, "rawEffectiveProducerContract": True,
                  "publicReceipt": receipt}))
