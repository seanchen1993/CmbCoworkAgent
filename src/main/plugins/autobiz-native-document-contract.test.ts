import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const rules = resolve("resources/native-compositions/autobiz-rules/checks")
const feature = "example-feature"
const normalized = { feature, revision: 2, requirements: ["结构回归需求"] }
type Bundle = { feature: string; stage: string; files: Record<string, string> }
type Report = { passed: boolean; errors: unknown[]; warnings: string[] }
interface UiContext {
  decisionStatus: string
  capabilities: Array<{ pageRefs?: string[]; specRefs?: string[] }>
}

function excerpt(stage: string, tag: string, language: string): string {
  const skill = readFileSync(
    resolve(`resources/native-compositions/autobiz/modules/${stage}/SKILL.md`),
    "utf8"
  ).replace(/\r\n/g, "\n")
  const start = `<!-- ${tag}:start -->\n\`\`\`${language}\n`
  const end = `\n\`\`\`\n<!-- ${tag}:end -->`
  const at = skill.indexOf(start)
  if (at < 0 || skill.indexOf(end, at) < 0) throw Error(`DOCUMENT_CONTRACT_MISSING:${tag}`)
  return skill.slice(at + start.length, skill.indexOf(end, at))
}

function python<T>(program: string, input: unknown): T {
  return JSON.parse(
    execFileSync("python", ["-I", "-B", "-X", "utf8", "-c", program, rules], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
  ) as T
}

function check(stage: string, prd: Bundle, specs?: Bundle, design?: Bundle): Report {
  return python(
    "import sys,json; sys.path.insert(0,sys.argv[1]); from check import run; print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=False))",
    { stage, normalized, prd, specs, current: design ?? specs ?? prd }
  )
}

// Synthetic syntax fixtures only. These never write the active acceptance workspace or claim
// that the illustrative decisions are real user decisions or sufficient business requirements.
function prdBundle(sourceSection = "无"): Bundle {
  return {
    feature,
    stage: "prd",
    files: {
      "PRD.md": `# 结构回归\n结构回归需求\n来源：NORMALIZED_REQUIREMENTS.json\n## 当前实现范围\nbackend_only\n## 外部资料与实现约束\n${sourceSection}\n`,
      "IMPLEMENTATION_SCOPE.json": excerpt("prd", "autobiz-prd-scope", "json"),
      "UI_CONTEXT.json": excerpt("prd", "autobiz-prd-ui-none", "json")
    }
  }
}

function specsBundle(ui = excerpt("specs", "autobiz-specs-ui-locked", "json")): Bundle {
  return {
    feature,
    stage: "specs",
    files: {
      "proposal.md": excerpt("specs", "autobiz-specs-proposal", "markdown"),
      "specs/example-capability/spec.md": excerpt("specs", "autobiz-specs-document", "markdown"),
      "UI_CONTEXT.json": ui
    }
  }
}

const sourceTable = [
  "| ID | 类型 | 名称 | 地址/路径 | 约束范围 | 状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| SRC-001 | 业务资料 | 测试资料 | sources/SRC-001/reference.txt | 结构回归 | 已读取 |"
].join("\n")

it("accepts the published no-materials PRD branch without fabricated source records", () => {
  const prd = prdBundle()
  expect(prd.files["source-context.json"]).toBeUndefined()
  expect(check("prd", prd)).toMatchObject({ passed: true, errors: [], warnings: [] })
})

it("checks the exact source-context version, snapshot path and honest unavailable branch", () => {
  const prd = prdBundle(sourceTable)
  const source = JSON.parse(excerpt("prd", "autobiz-prd-source-context", "json")) as {
    version: number
    sources: Array<{
      availability: string
      readStatus: string
      freshness: string
      path?: string
    }>
  }
  const update = () => (prd.files["source-context.json"] = JSON.stringify(source))
  update()
  prd.files["sources/SRC-001/reference.txt"] = "真实规则回归中的固定测试资料，不是业务证据。"
  expect(check("prd", prd)).toMatchObject({ passed: true, errors: [], warnings: [] })
  source.version = 2
  update()
  expect(check("prd", prd).passed).toBe(false)
  source.version = 1
  source.sources[0].availability = "available"
  source.sources[0].readStatus = "read"
  delete source.sources[0].path
  update()
  const malformed = check("prd", prd)
  expect(malformed.warnings.length).toBeGreaterThanOrEqual(3)
  source.sources[0].availability = "never_provided"
  source.sources[0].readStatus = "unreadable"
  delete prd.files["sources/SRC-001/reference.txt"]
  prd.files["PRD.md"] = prd.files["PRD.md"].replace("已读取", "从未提供")
  update()
  const unavailable = check("prd", prd)
  expect(unavailable.passed).toBe(true)
  expect(unavailable.warnings.length).toBeGreaterThan(0)
  expect(source.sources[0].path).toBeUndefined()
  // A warning is deliberately not asserted to resolve the underlying missing dependency.
})

it("validates the published locked UI and actual REQ/SCN syntax, rejecting missing references", () => {
  const prd = prdBundle()
  const ui = JSON.parse(excerpt("specs", "autobiz-specs-ui-locked", "json")) as UiContext
  const confirmed = structuredClone(ui)
  confirmed.decisionStatus = "confirmed"
  for (const capability of confirmed.capabilities) delete capability.specRefs
  prd.files["UI_CONTEXT.json"] = JSON.stringify(confirmed)
  expect(check("prd", prd).passed).toBe(true)
  expect(check("specs", prd, specsBundle())).toMatchObject({ passed: true, errors: [] })
  ui.capabilities[0].specRefs = ["specs/example-capability/spec.md#REQ-999"]
  expect(check("specs", prd, specsBundle(JSON.stringify(ui))).passed).toBe(false)
  ui.capabilities[0].specRefs = ["REQ-001", "SCN-001"]
  delete ui.capabilities[0].pageRefs
  expect(check("specs", prd, specsBundle(JSON.stringify(ui))).passed).toBe(false)
})

it("locks the confirmed no-UI branch without inventing pages or capabilities", () => {
  const prd = prdBundle()
  const ui = JSON.parse(prd.files["UI_CONTEXT.json"]) as UiContext
  ui.decisionStatus = "locked"
  expect(check("specs", prd, specsBundle(JSON.stringify(ui)))).toMatchObject({
    passed: true,
    errors: []
  })
})

it("derives Design locks from exact UTF-8 text and compares the original implementation", () => {
  const prd = prdBundle()
  const ui = JSON.parse(prd.files["UI_CONTEXT.json"]) as UiContext
  ui.decisionStatus = "locked"
  const specs = specsBundle(JSON.stringify(ui))
  for (const definitions of [false, true]) {
    const design = [
      "# 结构测试设计",
      "## Context / 输入上下文",
      "结构测试输入，关联 DEC-001。",
      "## Code Evidence",
      "独立合成测试，不对应真实项目。",
      "## Spec Traceability",
      "REQ-001 SCN-001",
      "## API Decisions",
      `x-auto-no-http-api: ${!definitions}`,
      ...(definitions ? ["| API-002 | 第二个接口 |", "| API-001 | 第一个接口 |"] : []),
      "## Data Decisions",
      `x-auto-no-sql: ${!definitions}`,
      ...(definitions ? ["| DATA-001 | 数据 |"] : []),
      "## Technical Design",
      ...(definitions ? ["| D-002 | 第二个决策 |", "| D-001 | 第一个决策 |"] : ["无额外决策"]),
      "## Risks / Open Questions",
      "仅证明结构契约；不证明业务正确。",
      ""
    ].join("\n")
    const result = python<{ lock: unknown; original: unknown; errors: unknown[] }>(
      `import sys,json,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from hooks.artifact_ref_validator import load_design_contract,design_contract_snapshot
payload=json.load(sys.stdin)
namespace={"__name__":"contract_test"}
exec(payload["helper"],namespace)
lock=namespace["derive_design_lock"](payload["input"])
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    (root/"design.md").write_bytes(payload["input"]["design"].encode("utf-8"))
    contract,errors=load_design_contract(root)
    print(json.dumps({"lock":lock,"original":design_contract_snapshot(contract),"errors":errors},ensure_ascii=False))`,
      {
        helper: excerpt("design", "autobiz-design-lock-helper", "python"),
        input: { feature, lockedAt: "2026-10-26T00:00:00Z", design }
      }
    )
    expect(result.errors).toEqual([])
    expect(result.lock).toMatchObject({ designContract: result.original })
    const bundle: Bundle = {
      feature,
      stage: "design",
      files: { "design.md": design, ".design-contract.lock.json": JSON.stringify(result.lock) }
    }
    expect(check("design", prd, specs, bundle)).toMatchObject({ passed: true, errors: [] })
    bundle.files["design.md"] += "字节变化\n"
    expect(check("design", prd, specs, bundle).passed).toBe(false)
  }
})
