import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

const script = readFileSync(resolve(
  "resources/native-compositions/autobiz-lean/project/workflows/lean-code.workflow.js"
), "utf8")
const begin = script.indexOf("// BEGIN PURE CONTEXT CONTRACT")
const end = script.indexOf("// END PURE CONTEXT CONTRACT")
if (begin < 0 || end <= begin) throw Error("WORKFLOW_CONTEXT_CONTRACT_MISSING")
type Context = {
  dependencyBatchIds: string[]
  specs: Record<string, string>
  decisions: Record<string, string>
  proposal: string
  provenance: unknown
  requirements: string[]
  baselineDecisions: unknown[]
  decisionCoverage: unknown
  batches?: Array<{ id: string }>
}
const buildContext = runInNewContext(
  `${script.slice(begin, end)}\nbuildBatchContext`, {}
) as (definition: unknown, solution: unknown, id: string | string[], sources: unknown, contract: unknown) => Context

function fixture() {
  const definition = {
    feature: "orders",
    requirements: ["授权用户查询订单必须在两秒内返回"],
    requirementCoverage: {},
    baselineDecisions: [{ id: "DECISION-001", text: "仅授权用户可查询", requirementIds: ["USR-001"] }],
    decisionCoverage: { "DECISION-001": ["specs/auth/spec.md#REQ-001", "specs/auth/spec.md#SCN-001"] },
    scope: { implementationScope: "backend_only" },
    ui: {},
    specs: {
      auth: "### Requirement REQ-001: 授权\n### Scenario SCN-001: 无权拒绝\n采用 DEC-001。",
      cache: "### Requirement REQ-002: 缓存\n### Scenario SCN-002: 缓存失效",
      orders: "### Requirement REQ-003: 查询\n### Scenario SCN-003: 成功返回",
      unrelated: "### Requirement REQ-004: 无关导出"
    },
    proposal: "# 方案\n所有查询必须保留租户隔离。\n## DEC-001: 授权规则\n检查真实租户身份。\n## DEC-002: 无关选型\n导出使用独立格式。\n"
  }
  const solution = {
    plan: { batches: [
      { id: "B001", deps: [] as string[] },
      { id: "B002", deps: ["B001"] },
      { id: "B003", deps: ["B002"] },
      { id: "B004", deps: [] as string[] }
    ] },
    batches: {
      B001: { tasks: [{ id: "T001", specRefs: ["specs/auth/spec.md#SCN-001"] }] },
      B002: { tasks: [{ id: "T002", specRefs: ["specs/cache/spec.md#REQ-002"] }] },
      B003: { tasks: [{ id: "T003", specRefs: ["specs/orders/spec.md#SCN-003"] }] },
      B004: { tasks: [{ id: "T004", specRefs: ["specs/unrelated/spec.md#REQ-004"] }] }
    },
    design: "按已确认的接口边界实现。",
    designLock: { digest: "fixed" }
  }
  const provenance = { paths: { definition: "Definition.json" }, digests: { "Definition.json": "a".repeat(64) } }
  return { definition, solution, provenance }
}

describe("lean workflow context preserves declared business dependencies", () => {
  it("carries transitive specs and decision bodies without unrelated capability prose", () => {
    const f = fixture()
    const context = buildContext(f.definition, f.solution, "B003", f.provenance, {})
    expect(context.dependencyBatchIds).toEqual(["B001", "B002"])
    expect(Object.keys(context.specs)).toEqual(["auth", "cache", "orders"])
    expect(context.specs.auth).toBe(f.definition.specs.auth)
    expect(context.decisions).toEqual({ "DEC-001": "## DEC-001: 授权规则\n检查真实租户身份。\n" })
    expect(context.proposal).toContain("所有查询必须保留租户隔离")
    expect(context.proposal).not.toContain("无关选型")
    expect(context.requirements).toEqual(f.definition.requirements)
    expect(context.baselineDecisions).toEqual(f.definition.baselineDecisions)
    expect(context.decisionCoverage).toEqual(f.definition.decisionCoverage)
    expect(context.provenance).toEqual(f.provenance)
  })

  it("gives final E2E authors the union of repository batches and their required decisions and origins", () => {
    const f = fixture()
    const context = buildContext(f.definition, f.solution, ["B002", "B003"], f.provenance, {})
    expect(context.batches?.map((row) => row.id)).toEqual(["B002", "B003"])
    expect(context.dependencyBatchIds).toEqual(["B001"])
    expect(Object.keys(context.specs)).toEqual(["auth", "cache", "orders"])
    expect(context.decisions["DEC-001"]).toContain("真实租户身份")
    expect(context.baselineDecisions).toEqual(f.definition.baselineDecisions)
    expect(context.proposal).toContain("租户隔离")
    expect(context.provenance).toEqual(f.provenance)
    expect(script).toContain("...buildBatchContext(definition, solution,")
  })

  it.each(["missing-batch", "cycle", "missing-scenario", "missing-decision", "duplicate-decision", "nested-decision"])(
    "blocks %s rather than silently reducing required context", (kind) => {
      const f = fixture()
      if (kind === "missing-batch") f.solution.plan.batches[1].deps = ["B999"]
      if (kind === "cycle") f.solution.plan.batches[0].deps = ["B003"]
      if (kind === "missing-scenario") f.solution.batches.B001.tasks[0].specRefs = ["specs/auth/spec.md#SCN-099"]
      if (kind === "missing-decision") f.definition.proposal = "# 方案\n未定义决策。"
      if (kind === "duplicate-decision") f.definition.proposal += "## DEC-001: 另一个定义\n冲突。"
      if (kind === "nested-decision") f.definition.proposal = f.definition.proposal.replace("## DEC-002", "### DEC-002")
      expect(() => buildContext(f.definition, f.solution, "B003", f.provenance, {})).toThrow(/LEAN_/)
    }
  )

  it("rejects an oversized dependency body without truncating it", () => {
    const f = fixture()
    f.definition.specs.auth += "必要约束".repeat(20000)
    expect(() => buildContext(f.definition, f.solution, "B003", f.provenance, {}))
      .toThrow("LEAN_BATCH_CONTEXT_LIMIT")
  })

  it.each(["global", "decision"])("includes %s decision dependencies transitively", (kind) => {
    const f = fixture()
    f.definition.proposal = f.definition.proposal.replace(
      kind === "global" ? "所有查询必须保留租户隔离。" : "检查真实租户身份。",
      "同时遵守 DEC-002。"
    ) + "## DEC-003: 传递约束\n必须原子提交，并遵守 DEC-001。\n"
    f.definition.proposal = f.definition.proposal.replace("导出使用独立格式。", "依赖 DEC-003。")
    const value = buildContext(f.definition, f.solution, "B003", f.provenance, {})
    expect(Object.keys(value.decisions).sort()).toEqual(["DEC-001", "DEC-002", "DEC-003"])
    expect(value.decisions["DEC-003"]).toContain("必须原子提交")
  })
})
