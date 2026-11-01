import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, expect, it } from "vitest"
import { program } from "../../../resources/native-compositions/autobiz-lean/providers/rules/mods/check-program"
import { rules } from "../../../resources/native-compositions/autobiz-lean/providers/rules/mods/rules-bundle"
import { businessInput } from "./autobiz-native-fixture.test-helper"
import { baselineDefinitionFields, baselineFixture } from "./autobiz-lean-baseline.test-helper"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "lean-baseline-"))
  roots.push(workspace)
  const old = businessInput()
  const baseline = baselineFixture(old.normalized.feature, old.normalized.requirements, "fixture")
  const specs = { "order-query": old.specs.files["specs/order-query/spec.md"] }
  const definition = {
    feature: baseline.feature,
    ...baselineDefinitionFields(baseline, specs),
    requirements: baseline.requirements.map((item) => item.text),
    prd: old.prd.files["PRD.md"].replace(
      "来源：NORMALIZED_REQUIREMENTS.json",
      "来源：Definition.json.requirements"
    ),
    scope: JSON.parse(old.prd.files["IMPLEMENTATION_SCOPE.json"]),
    ui: JSON.parse(old.specs.files["UI_CONTEXT.json"]),
    proposal: old.specs.files["proposal.md"],
    specs
  }
  const save = () => {
    writeFileSync(join(workspace, "RequestBaseline.json"), JSON.stringify(baseline))
    writeFileSync(join(workspace, "Definition.json"), JSON.stringify(definition))
  }
  save()
  const provenance = {
    protocol: baseline.request.protocol,
    projectId: baseline.request.projectId,
    bytes: baseline.request.bytes,
    sha256: baseline.request.sha256
  }
  function reference(stage = "definition", extra = false) {
    const selected =
      stage === "baseline"
        ? [["baseline", "RequestBaseline.json"]]
        : [
            ["baseline", "RequestBaseline.json"],
            ["definition", "Definition.json"]
          ]
    if (extra) selected.unshift(["conversion", "Converted.json"])
    const rows = selected.map(([artifactId, path]) => {
      const raw = readFileSync(join(workspace, path))
      return { artifactId, path, maxBytes: 131072, bytes: raw.length, sha256: sha(raw) }
    })
    return {
      protocol: "devclaw.artifact-input/v1",
      projectId: "fixture",
      stageId: stage,
      version: 1,
      pluginDigest: "a".repeat(64),
      workspaceIdentity: "b".repeat(64),
      current: rows.at(-1),
      sources: rows.slice(0, -1),
      requestProvenance: provenance
    }
  }
  function run(
    action: string,
    input = reference(action === "baseline.verify" ? "baseline" : "definition"),
    artifactRoles = action === "baseline.verify"
      ? { baseline: "baseline" }
      : { baseline: "baseline", definition: "definition" }
  ) {
    const executed = spawnSync("python", ["-I", "-B", "-X", "utf8", "-c", program], {
      cwd: workspace,
      encoding: "utf8",
      input: JSON.stringify({ action, reference: input, config: { artifactRoles }, rules })
    })
    expect(executed.error).toBeUndefined()
    expect(executed.stderr).toBe("")
    return JSON.parse(executed.stdout) as {
      passed: boolean
      errors: Array<{ code: string }>
      inputDigests: Record<string, string>
    }
  }
  return { workspace, baseline, definition, provenance, reference, run, save }
}

it("checks full original request bytes against Host metadata and rejects invented provenance", () => {
  const f = fixture()
  expect(f.run("baseline.verify").passed).toBe(true)
  f.baseline.request.text = "订单查询即可"
  f.baseline.request.bytes = Buffer.byteLength(f.baseline.request.text)
  f.baseline.request.sha256 = sha(f.baseline.request.text)
  f.baseline.requirements[0].text = f.baseline.request.text
  f.baseline.requirements[0].sourceQuote = f.baseline.request.text
  f.save()
  expect(f.run("baseline.verify").errors).toContainEqual({
    code: "LEAN_REQUEST_PROVENANCE_CHANGED"
  })
})

it("accepts an exact UTF-8 calculation copy but rejects execution wrappers or later feedback as the original request", () => {
  const f = fixture()
  const original = f.baseline.request.text
  const copy = join(f.workspace, "request-calculation.txt")
  writeFileSync(copy, original, "utf8")
  const bytes = readFileSync(copy)
  Object.assign(f.baseline.request, {
    text: bytes.toString("utf8"),
    bytes: bytes.length,
    sha256: sha(bytes)
  })
  f.save()
  expect(f.run("baseline.verify").passed).toBe(true)

  for (const appended of [
    "\n\n<CMBDEVCLAW-SKILL-USE-V1>\n<instruction>执行当前阶段</instruction>",
    "\n验收者后续澄清：未知项返回默认值。"
  ]) {
    const combined = original + appended
    Object.assign(f.baseline.request, {
      text: combined,
      bytes: Buffer.byteLength(combined),
      sha256: sha(combined)
    })
    f.save()
    expect(f.run("baseline.verify").errors).toContainEqual({
      code: "LEAN_REQUEST_PROVENANCE_CHANGED"
    })
  }
})

it("requires same-project Host provenance and a real original quote", () => {
  const f = fixture()
  const input = f.reference("baseline")
  input.requestProvenance = { ...input.requestProvenance, projectId: "other-project" }
  expect(f.run("baseline.verify", input).passed).toBe(false)
  Object.assign(input, { requestProvenance: undefined })
  expect(f.run("baseline.verify", input).errors).toContainEqual({
    code: "LEAN_REQUEST_PROVENANCE_REQUIRED"
  })
  f.baseline.requirements[0].sourceQuote = "用户从未提出的内容"
  f.save()
  expect(f.run("baseline.verify").errors).toContainEqual({
    code: "LEAN_BASELINE_REQUIREMENT_INVALID"
  })
})

it("resolves renamed artifact paths from the bound roles instead of sample filenames", () => {
  const f = fixture()
  const baselineText = JSON.stringify(f.baseline)
  const definitionText = JSON.stringify({
    ...f.definition,
    prd: f.definition.prd.replace(
      "来源：Definition.json.requirements",
      "来源：Requirements.json.requirements"
    )
  })
  writeFileSync(join(f.workspace, "BoundRequest.json"), baselineText)
  writeFileSync(join(f.workspace, "Requirements.json"), definitionText)
  const input = f.reference()
  Object.assign(input.sources[0], {
    path: "BoundRequest.json",
    bytes: Buffer.byteLength(baselineText),
    sha256: sha(baselineText)
  })
  Object.assign(input.current!, {
    path: "Requirements.json",
    bytes: Buffer.byteLength(definitionText),
    sha256: sha(definitionText)
  })
  const result = f.run("definition.verify", input)
  expect(result.passed).toBe(true)
  expect(Object.keys(result.inputDigests)).toEqual(["BoundRequest.json", "Requirements.json"])
})

it("rejects jointly deleting a difficult requirement from Definition and its PRD/specs", () => {
  const f = fixture()
  f.baseline.requirements.push({ id: "USR-002", text: "查询订单", sourceQuote: "订单查询" })
  Object.assign(f.definition, baselineDefinitionFields(f.baseline, f.definition.specs))
  f.definition.requirements = f.baseline.requirements.map((item) => item.text)
  f.save()
  f.definition.requirements = ["查询订单"]
  f.definition.requirementIds = ["USR-002"]
  delete f.definition.requirementCoverage["USR-001"]
  f.definition.prd = f.definition.prd.replace("订单查询必须在2秒内返回", "查询订单")
  f.definition.specs["order-query"] = f.definition.specs["order-query"].replaceAll(
    "2秒",
    "合理时间"
  )
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_BASELINE_REQUIREMENTS_CHANGED"
  })
})

it("binds Definition to exact baseline bytes and rejects missing or invented scenario links", () => {
  const f = fixture()
  expect(f.run("definition.verify").passed).toBe(true)
  writeFileSync(join(f.workspace, "RequestBaseline.json"), JSON.stringify(f.baseline) + "\n")
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_BASELINE_REQUIREMENTS_CHANGED"
  })
  f.save()
  f.definition.requirementCoverage["USR-001"] = [
    "specs/order-query/spec.md#REQ-001",
    "specs/order-query/spec.md#SCN-999"
  ]
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_REQUIREMENT_REFERENCE_MISSING"
  })
})

it("selects roles by artifact ID while retaining and validating an extra preceding input", () => {
  const f = fixture()
  writeFileSync(join(f.workspace, "Converted.json"), JSON.stringify({ original: "真实转换输入" }))
  const input = f.reference("definition", true)
  input.sources[1].artifactId = "accepted-requirements"
  input.current!.artifactId = "business-definition"
  const roles = { baseline: "accepted-requirements", definition: "business-definition" }
  const result = f.run("definition.verify", input, roles)
  expect(result.passed).toBe(true)
  expect(result.inputDigests["Converted.json"]).toBe(
    sha(readFileSync(join(f.workspace, "Converted.json")))
  )
  writeFileSync(join(f.workspace, "Converted.json"), JSON.stringify({ original: "替换的转换输入" }))
  expect(f.run("definition.verify", input, roles).errors).toContainEqual({
    code: "LEAN_REFERENCE_CHANGED"
  })
})

it("rejects missing roles, duplicate role bindings and path traversal", () => {
  const f = fixture()
  expect(f.run("definition.verify", f.reference(), { baseline: "baseline" }).passed).toBe(false)
  expect(
    f.run("definition.verify", f.reference(), { baseline: "definition", definition: "definition" })
      .passed
  ).toBe(false)
  const input = f.reference()
  input.sources[0].path = "../RequestBaseline.json"
  expect(f.run("definition.verify", input).errors).toContainEqual({
    code: "LEAN_REFERENCE_PATH_INVALID"
  })
})

it("preserves accepted clarification decisions and rejects deletion, rewriting or unmapped decisions", () => {
  const f = fixture()
  f.baseline.decisions.push({
    id: "DECISION-001",
    text: "仅授权用户可以查询订单，缺少权限时明确拒绝。",
    requirementIds: ["USR-001"]
  })
  Object.assign(f.definition, baselineDefinitionFields(f.baseline, f.definition.specs))
  f.save()
  expect(f.run("definition.verify").passed).toBe(true)
  f.definition.baselineDecisions = []
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_BASELINE_DECISIONS_CHANGED"
  })
  Object.assign(f.definition, baselineDefinitionFields(f.baseline, f.definition.specs))
  f.definition.baselineDecisions[0].text = "所有用户都可以查询。"
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_BASELINE_DECISIONS_CHANGED"
  })
  Object.assign(f.definition, baselineDefinitionFields(f.baseline, f.definition.specs))
  f.definition.decisionCoverage = {}
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_DECISION_COVERAGE_INVALID"
  })
})

it("requires each accepted decision to cover real REQ and SCN of every linked requirement", () => {
  const f = fixture()
  f.baseline.requirements.push({ id: "USR-002", text: "查询订单", sourceQuote: "订单查询" })
  f.baseline.decisions.push({
    id: "DECISION-001",
    text: "两项要求必须同时满足，不用单项覆盖代替另一项。",
    requirementIds: ["USR-001", "USR-002"]
  })
  f.definition.specs["order-query"] += "\n#### Scenario SCN-002: 第二项要求的独立场景\n"
  Object.assign(f.definition, baselineDefinitionFields(f.baseline, f.definition.specs))
  f.definition.requirements = f.baseline.requirements.map((item) => item.text)
  f.definition.requirementCoverage["USR-002"] = [
    "specs/order-query/spec.md#REQ-001",
    "specs/order-query/spec.md#SCN-002"
  ]
  f.definition.decisionCoverage["DECISION-001"] = [
    "specs/order-query/spec.md#REQ-001",
    "specs/order-query/spec.md#SCN-001"
  ]
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_DECISION_REQUIREMENT_REFERENCE_INVALID"
  })
  f.definition.decisionCoverage["DECISION-001"] = [
    "specs/order-query/spec.md#REQ-001",
    "specs/order-query/spec.md#SCN-999"
  ]
  f.save()
  expect(f.run("definition.verify").errors).toContainEqual({
    code: "LEAN_DECISION_REQUIREMENT_REFERENCE_INVALID"
  })
})
