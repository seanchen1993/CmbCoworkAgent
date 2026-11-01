import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { rules } from "../../../resources/native-compositions/autobiz-lean/providers/rules/mods/rules-bundle"
import { businessInput } from "./autobiz-native-fixture.test-helper"

it("validates the published task and rejects the live-discovered contract mistakes", () => {
  const contract = readFileSync(
    resolve("resources/native-compositions/autobiz-lean/project/contracts/solution.md"),
    "utf8"
  ).replace(/\r\n/g, "\n")
  const example = contract.match(
    /<!-- lean-solution-task-example:start -->\n```json\n([\s\S]*?)\n```\n<!-- lean-solution-task-example:end -->/
  )
  expect(example).not.toBeNull()
  const task = JSON.parse(example![1])
  const batch = JSON.parse(businessInput().plan.files["plans/B001/plan.json"])
  batch.tasks = [task]
  const result = spawnSync(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      String.raw`
import copy,json,sys,tempfile
from pathlib import Path
payload=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="lean-solution-contract-") as scratch:
    root=Path(scratch)
    for name,text in payload["rules"].items():
        target=root/name
        assert target.resolve().is_relative_to(root.resolve())
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(text,encoding="utf-8")
    sys.path.insert(0,str(root))
    from hooks.plan_json import validate_batch_plan_data
    from hooks.artifact_ref_validator import validate_artifact_ref,ArtifactRefError
    from hooks.plan_write_ownership import write_ownership_error_codes
    batch=payload["batch"]
    def validate(value):
        return validate_batch_plan_data(value,expected_feature_id="orders",
            expected_batch_id="B001",require_initial_status=True,defer_to_test_stages=True)
    assert validate(batch)==[],validate(batch)
    task=batch["tasks"][0]
    checked=[]
    for field in ("blockers","evidenceIds","completionEvidenceIds"):
        assert task[field]==[]
        for mutation in ("missing",None,"not-an-array"):
            changed=copy.deepcopy(batch)
            if mutation=="missing":changed["tasks"][0].pop(field)
            else:changed["tasks"][0][field]=mutation
            errors=validate(changed)
            assert any(field+"_must_be_string_array" in e for e in errors),errors
            checked.append(field+":"+str(mutation))
    (root/"design.md").write_text("# Design\n| D-001 | 内存索引查询 |\n",encoding="utf-8")
    assert task["designRefs"]==["design.md#D-001"]
    assert task["decisionIds"]==["D-001"]
    validate_artifact_ref(root,task["designRefs"][0],design=True)
    for ref in ("Design: Technical Design","design.md#Technical Design","design.md#D-999"):
        try:validate_artifact_ref(root,ref,design=True)
        except ArtifactRefError:checked.append(ref)
        else:raise AssertionError("invalid reference accepted: "+ref)
    assert write_ownership_error_codes([task])==[]
    other=copy.deepcopy(task)
    other["id"]="T002"
    other["deps"]=["T001"]
    owners={"T001":"B001","T002":"B002"}
    errors=write_ownership_error_codes([task,other],ownership_scope_by_task=owners)
    assert any("shared_write_path_requires_single_owner" in e for e in errors),errors
    checked.append("cross-batch-file-owner-with-dependency")
    # Preserve the original rules' legal same-batch and disjoint-symbol cases.
    assert write_ownership_error_codes([task,other],ownership_scope_by_task={
        "T001":"B001","T002":"B001"})==[]
    first=copy.deepcopy(task)
    first["writeTargets"]=[{"path":"src/orders.js","symbols":["query"]}]
    other["writeTargets"]=[{"path":"src/orders.js","symbols":["parse"]}]
    assert write_ownership_error_codes([first,other],ownership_scope_by_task=owners)==[]
    print(json.dumps({"rejected":checked,"publishedTaskPassed":True}))
`
    ],
    {
      input: JSON.stringify({ rules, batch }),
      encoding: "utf8"
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.publishedTaskPassed).toBe(true)
  expect(report.rejected).toHaveLength(13)
})
