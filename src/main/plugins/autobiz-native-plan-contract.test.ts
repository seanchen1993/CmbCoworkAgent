import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { businessInput } from "./autobiz-native-fixture.test-helper"

const skill = resolve("resources/native-compositions/autobiz/modules/plan/SKILL.md")
const rules = resolve("resources/native-compositions/autobiz-rules/checks")
const reference = join(rules, "hooks/parallel_validation_ownership.py")
const helper = () => {
  const match = readFileSync(skill, "utf8").match(
    /<!-- autobiz-pipeline-helper:start -->\n```python\n([\s\S]*?)\n```\n<!-- autobiz-pipeline-helper:end -->/
  )
  if (!match) throw Error("PLAN_PIPELINE_HELPER_MISSING")
  return match[1]
}

interface Task {
  id: string
  executionMode: string
  scope: { paths: string[] }
  testPoints: string[]
  verificationIntent: string
  acceptanceCriteria: string[]
}
interface Batch {
  id: string
  path: string
  deps?: string[]
  taskIds: string[]
  workspaceRef: string
}
interface ProjectionInput {
  root: { batches: Batch[] }
  batches: Record<string, { tasks: Task[] }>
}
interface Pipeline {
  schemaVersion: string
  planRevision: string
  deliveryStages: string[]
  validationBatches: Array<Record<string, string>>
  validationOwnership: Record<string, Record<string, string>>
  finalization: { mode: string; forbidPostMergeDuplicateExecution: boolean }
}

// Deliberately only projection inputs: these are not asserted to be valid business plans.
function input(): ProjectionInput {
  const task = (id: string): Task => ({
    id,
    executionMode: "code",
    scope: { paths: ["src/订单.java", "src/校验.java"] },
    testPoints: ["拒绝空订单", "重复请求不得重复扣款"],
    verificationIntent: "验证正常、边界与失败行为",
    acceptanceCriteria: ["返回订单号", "拒绝请求且无副作用"]
  })
  return {
    root: {
      batches: [
        {
          id: "B001",
          path: "plans/B001/plan.json",
          deps: [],
          taskIds: ["T001", "T002"],
          workspaceRef: "default"
        },
        {
          id: "B002",
          path: "plans/B002/plan.json",
          deps: ["B001"],
          taskIds: ["T003"],
          workspaceRef: "backend"
        }
      ]
    },
    batches: {
      B001: { tasks: [task("T001"), task("T002")] },
      B002: { tasks: [task("T003")] }
    }
  }
}

function compare(inputs: ProjectionInput[]): Pipeline[] {
  const original = readFileSync(reference)
  const provenance = JSON.parse(readFileSync(join(rules, "provenance.json"), "utf8")) as Array<{
    target: string
    targetSha256: string
  }>
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    provenance.find((row) => row.target === "hooks/parallel_validation_ownership.py")?.targetSha256
  )
  const output = execFileSync(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      `
import ast,hashlib,json,sys
from typing import Any
payload=json.load(sys.stdin)
names={"PIPELINE_SCHEMA_VERSION","DELIVERY_STAGES","VALIDATION_BATCHES",
       "_canonical","_pipeline_revision","build_pipeline_contract"}
def definitions(source):
    nodes=[]
    for node in ast.parse(source).body:
        name=node.name if isinstance(node,ast.FunctionDef) else (
            node.targets[0].id if isinstance(node,ast.Assign)
            and isinstance(node.targets[0],ast.Name) else None)
        if name in names: nodes.append(node)
    return ast.Module(body=nodes,type_ignores=[])
legacy=definitions(payload["reference"])
assert ast.dump(legacy)==ast.dump(definitions(payload["helper"]))
original={"json":json,"hashlib":hashlib,"Any":Any}
exec(compile(legacy,"original-pipeline","exec"),original)
published={"__name__":"published_plan_helper"}
exec(compile(payload["helper"],"published-plan-helper","exec"),published)
results=[]
for case in payload["cases"]:
    before=json.dumps(case,ensure_ascii=False)
    expected=original["build_pipeline_contract"](case["root"],case["batches"])
    actual=published["build_pipeline_contract"](case["root"],case["batches"])
    assert actual==expected
    assert json.dumps(case,ensure_ascii=False)==before
    results.append(actual)
print(json.dumps(results,ensure_ascii=False))
`
    ],
    {
      input: JSON.stringify({
        reference: original.toString("utf8"),
        helper: helper(),
        cases: inputs
      }),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true
    }
  )
  return JSON.parse(output) as Pipeline[]
}

it("publishes the original pure pipeline definitions and matches multiple batches, Unicode and empty deps", () => {
  const missingDeps = input()
  delete missingDeps.root.batches[0].deps
  const external = input()
  external.batches.B001.tasks[1].executionMode = "external_dependency"
  const [normal, missing, dependency] = compare([input(), missingDeps, external])
  expect(missing).toEqual(normal)
  expect(normal.planRevision).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(normal.deliveryStages).toEqual(["prepare", "implement", "review", "test"])
  expect(normal.validationBatches).toEqual([
    {
      id: "V-E2E",
      type: "validation",
      stage: "e2e_test",
      dependsOn: "all_delivery",
      executionTarget: "merged_main"
    }
  ])
  expect(normal.validationOwnership["UTEST-T003"]).toEqual({
    ownerBatchId: "B002",
    stage: "test",
    kind: "utest_target",
    taskId: "T003",
    sourceBatchId: "B002"
  })
  expect(dependency.validationOwnership["UTEST-T002"]).toBeUndefined()
  expect(dependency.validationOwnership["REVIEW-B001"]).toEqual(
    normal.validationOwnership["REVIEW-B001"]
  )
  expect(normal.finalization).toEqual({
    mode: "evidence_aggregate_only",
    forbidPostMergeDuplicateExecution: true
  })
})

it("preserves array ordering and hashes changed verification inputs, but normalizes object key order", () => {
  const batchOrder = input()
  batchOrder.root.batches.reverse()
  const taskOrder = input()
  taskOrder.batches.B001.tasks.reverse()
  const pathOrder = input()
  pathOrder.batches.B001.tasks[0].scope.paths.reverse()
  const changedVerification = input()
  changedVerification.batches.B001.tasks[0].testPoints.push("增加真正业务检查")
  const keyOrder = input()
  const task = keyOrder.batches.B001.tasks[0]
  keyOrder.batches.B001.tasks[0] = {
    acceptanceCriteria: task.acceptanceCriteria,
    verificationIntent: task.verificationIntent,
    testPoints: task.testPoints,
    scope: task.scope,
    executionMode: task.executionMode,
    id: task.id
  }
  const [normal, ...changed] = compare([
    input(),
    batchOrder,
    taskOrder,
    pathOrder,
    changedVerification,
    keyOrder
  ])
  for (const result of changed.slice(0, 4))
    expect(result.planRevision).not.toBe(normal.planRevision)
  expect(changed[4]).toEqual(normal)
})

it("accepts the author's bundle through stdin and emits only the derived object without writing files", () => {
  const source = input()
  const bundle = {
    feature: "orders",
    stage: "plan",
    files: Object.fromEntries([
      ["plan.json", JSON.stringify(source.root)],
      ...source.root.batches.map((batch) => [batch.path, JSON.stringify(source.batches[batch.id])])
    ])
  }
  const directory = mkdtempSync(join(tmpdir(), "autobiz-plan-projection-"))
  try {
    const output = execFileSync("python", ["-I", "-B", "-X", "utf8", "-c", helper()], {
      input: JSON.stringify(bundle),
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true
    })
    expect(JSON.parse(output)).toEqual(compare([source])[0])
    expect(readdirSync(directory)).toEqual([])
    expect(bundle.files["plan.json"]).toBe(JSON.stringify(source.root))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function publishedExampleDocument(marker: "root" | "batch"): Record<string, unknown> {
  const source = readFileSync(skill, "utf8")
  const pattern = new RegExp(
    `<!-- autobiz-plan-example-${marker}:start -->\\n\x60\x60\x60json\\n([\\s\\S]*?)\\n\x60\x60\x60\\n<!-- autobiz-plan-example-${marker}:end -->`
  )
  const match = source.match(pattern)
  if (!match) throw Error(`PLAN_EXAMPLE_${marker.toUpperCase()}_MISSING`)
  return JSON.parse(match[1]) as Record<string, unknown>
}

it("checks the complete published teaching plan with the original checker and rejects invalid contracts", () => {
  const provenance = JSON.parse(readFileSync(join(rules, "provenance.json"), "utf8")) as Array<{
    target: string
    targetSha256: string
  }>
  for (const target of [
    "hooks/plan_json.py",
    "hooks/artifact_ref_validator.py",
    "hooks/plan_granularity.py",
    "hooks/plan_write_ownership.py",
    "hooks/utest_command_policy.py",
    "hooks/parallel_validation_ownership.py"
  ]) {
    expect(createHash("sha256").update(readFileSync(join(rules, target))).digest("hex")).toBe(
      provenance.find((row) => row.target === target)?.targetSha256
    )
  }
  const root = publishedExampleDocument("root")
  const batch = publishedExampleDocument("batch")
  const upstream = businessInput()
  const output = execFileSync(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      `
import copy,json,sys
sys.path.insert(0,sys.argv[1])
from check import run
from hooks.plan_json import validate_plan_data,validate_batch_plan_data
from hooks.parallel_validation_ownership import build_pipeline_contract
from hooks.plan_write_ownership import is_test_asset_path
payload=json.load(sys.stdin)
root,batch=payload["root"],payload["batch"]
assert validate_plan_data(root,require_initial_status=True)==[]
assert validate_batch_plan_data(batch,expected_feature_id="orders",expected_batch_id="B001",
    require_initial_status=True,defer_to_test_stages=True)==[]
assert root["parallelBatchPipeline"]==build_pipeline_contract(root,{"B001":batch})
assert batch["taskCount"]==1 and root["batches"][0]["taskIds"]==["T001"]
task=batch["tasks"][0]
assert "pom.xml" in task["expectedFiles"]
assert task["scope"]["workspaceRoots"]=={"default":"."}
assert not any(is_test_asset_path(p) for p in task["scope"]["paths"]+task["expectedFiles"])
assert all(not task.get(field,[]) for field in
    ("evidenceIds","completionEvidenceIds","implementationEvidenceIds","validationEvidenceIds"))
def check(r,b,refresh=True):
    if refresh:r["parallelBatchPipeline"]=build_pipeline_contract(r,{"B001":b})
    bundle={"feature":"orders","stage":"plan","files":{
        "plan.json":json.dumps(r,ensure_ascii=False),
        "plans/B001/plan.json":json.dumps(b,ensure_ascii=False)}}
    assert all(len(text.encode("utf-8"))<=20000 for text in bundle["files"].values())
    assert len(json.dumps(bundle,ensure_ascii=False).encode("utf-8"))<=28000
    return run({**payload["upstream"],"stage":"plan","current":bundle})
valid=check(copy.deepcopy(root),copy.deepcopy(batch),False)
assert valid["passed"] is True and valid["errors"]==[],valid
results=[{"case":"published-complete-example","passed":True}]
def rejected(name,mutate,expected,refresh=True):
    r,b=copy.deepcopy(root),copy.deepcopy(batch)
    mutate(r,b)
    report=check(r,b,refresh)
    assert report["passed"] is False,(name,report)
    assert expected in json.dumps(report["errors"],ensure_ascii=False),(name,report)
    results.append({"case":name,"passed":False})
rejected("execution-mode-inline",lambda r,b:b["tasks"][0].update(executionMode="inline"),"executionMode_invalid")
rejected("invented-lane",lambda r,b:b.update(executionLane="sequential_single_workspace"),"executionLane_invalid")
for kind in ("vertical_slice","verification_harness"):
    rejected("invented-delivery-"+kind,lambda r,b:b.update(deliveryKind=kind),"deliveryKind_invalid")
rejected("invented-completion",lambda r,b:b["tasks"][0].update(completionPolicy="evidence_required"),"completionPolicy_invalid")
for field in ("modules","entrypoints","pages","dataObjects"):
    rejected("missing-scope-"+field,lambda r,b:b["tasks"][0]["scope"].pop(field),"scope."+field+"_must_be_string_array")
rejected("missing-workspace-roots",lambda r,b:b["tasks"][0]["scope"].pop("workspaceRoots"),"scope.workspaceRoots_missing")
rejected("string-acceptance",lambda r,b:b["tasks"][0].update(acceptanceCriteria=["返回订单"]),"acceptanceCriteria[0]_must_be_object")
rejected("acceptance-mixed-requirement",lambda r,b:b["tasks"][0]["acceptanceCriteria"][0]["scenarioRefs"].append(
    "specs/order-query/spec.md#REQ-001"),"scenarioRefs_missing_scenario_id")
rejected("design-heading-reference",lambda r,b:b["tasks"][0].update(
    designRefs=["design.md#整体架构"]),"invalid_artifact_ref_format")
rejected("root-task-projection",lambda r,b:r["batches"][0].update(taskIds=["T002"]),"taskIds_mismatch")
def four_tasks(r,b):
    seed=copy.deepcopy(b["tasks"][0]);b["tasks"]=[]
    rationale="同一订单查询交付必须作为不可分割的原子闭环验证"
    for entry in (r["batches"][0],b):
        entry.update(deliveryKind="atomic_group",atomicGroupId="AG001",batchRationale=rationale)
    for n in range(1,5):
        task=copy.deepcopy(seed);task["id"]=f"T{n:03}"
        task["acceptanceCriteria"][0]["id"]=f"AC-T{n:03}-01"
        task["atomicGroup"]={"id":"AG001","rationale":rationale}
        b["tasks"].append(task)
    b["taskCount"]=4;r["batches"][0]["taskIds"]=[t["id"] for t in b["tasks"]]
    batch_errors=validate_batch_plan_data(b,require_initial_status=True,defer_to_test_stages=True)
    assert "B001.batch_task_limit_exceeded:4>3" in batch_errors,batch_errors
    assert not any("single_task" in error for error in batch_errors),batch_errors
rejected("four-task-batch",four_tasks,"atomic_group_task_limit_invalid")
rejected("wrong-scenario-path",lambda r,b:b["tasks"][0].update(specRefs=[
    "specs/order-query/spec.md#REQ-001","specs/wrong-capability/spec.md#SCN-001"]),"missing_plan_scenario_coverage")
rejected("stale-derived-pipeline",lambda r,b:b["tasks"][0]["testPoints"].append("中文新增验收😀"),
    "parallel_batch_pipeline_revision_stale",False)
# Exercise actual command ownership, not a duplicated test-only approximation.
for name,phase,argv,paths,expected in [
    ("production-pom","compile",["mvn","compile"],["pom.xml"],True),
    ("production-cannot-write-tests","compile",["mvn","compile"],["src/test/java/Check.java"],False),
    ("test-author-cannot-patch-pom","test",["mvn","test"],["pom.xml"],False),
    ("independent-test-assets","test",["mvn","test"],["src/test/java/Check.java"],True),
    ("direct-java-is-not-test-entry","test",["java","Check"],["src/test/java/Check.java"],False)]:
    report=run({"stage":"command-policy","current":{
        "phase":phase,"argv":argv,"changedPaths":paths,"trackedPaths":paths}})
    assert report["passed"] is expected,(name,report)
    if name in ("production-cannot-write-tests","test-author-cannot-patch-pom"):
        assert {"code":"CODE_PRODUCTION_TEST_WRITE_BOUNDARY"} in report["errors"]
    results.append({"case":name,"passed":expected})
print(json.dumps(results,ensure_ascii=False))
`,
      rules
    ],
    {
      input: JSON.stringify({ root, batch, upstream }),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true
    }
  )
  const results = JSON.parse(output) as Array<{ case: string; passed: boolean }>
  expect(results).toHaveLength(23)
  expect(results).toContainEqual({ case: "acceptance-mixed-requirement", passed: false })
  expect(results).toContainEqual({ case: "design-heading-reference", passed: false })
  expect(results[0]).toEqual({ case: "published-complete-example", passed: true })
  expect(results.filter((row) => row.passed).map((row) => row.case)).toEqual([
    "published-complete-example",
    "production-pom",
    "independent-test-assets"
  ])
})
