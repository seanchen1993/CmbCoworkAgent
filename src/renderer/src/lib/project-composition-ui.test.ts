import { describe, expect, it } from "vitest"
import type {
  CompositionRun,
  ProjectCompositionCatalogEntry
} from "../../../shared/project-runtime/composition-api"
import {
  addCompositionEntry,
  changeCompositionOrder,
  compositionApprovalInput,
  compositionDraftIssues,
  compositionDraftKey,
  compositionRunLabel,
  compositionRunBelongsTo,
  compositionProblem,
  emptyCompositionDraft,
  readCompositionDraft
} from "./project-composition-ui"

const scope = { projectId: "project", threadId: "thread", expectedWorkspace: "C:/fixture" }
describe("plain language composition problems", () => {
  it.each([
    ["COMPOSITION_SOURCE_CHANGED", "插件来源、配置或运行状态已变化。"],
    ["COMPOSITION_EXECUTION_WORKSPACE_MISSING", "暂时无法打开本步骤的运行文件夹。"],
    ["COMPOSITION_WORKSPACE_OPEN_FAILED", "暂时无法打开本步骤的运行文件夹。"],
    ["COMPOSITION_WORKSPACE_OWNER_CHANGED", "暂时无法打开本步骤的运行文件夹。"],
    ["COMPOSITION_UNIT_UNKNOWN", "暂时无法打开本步骤的运行文件夹。"],
    ["COMPOSITION_HANDOFF_UNVERIFIED", "结果文件或交接资料未通过核对。"],
    ["STAGE_CHECK_ARTIFACT_CHANGED", "结果文件或交接资料未通过核对。"],
    ["COMPOSITION_APPROVAL_REJECTED", "本次操作未获批准，流程没有继续。"],
    ["COMPOSITION_LEGACY_REQUIRED_CHECK_UNPROVEN", "原流程还有未完成或未核实的检查。"],
    ["COMPOSITION_FLOW_NOT_COMPLETED", "原流程还有未完成或未核实的检查。"],
    ["COMPOSITION_STAGE_CHECK_ADAPTER_UNSUPPORTED", "这个插件暂不满足完整流程组合的要求。"]
  ])("explains %s while retaining its original detail", (code, message) => {
    const raw = `Error invoking remote method: Error: ${code}`
    expect(compositionProblem(new Error(raw))).toMatchObject({ message, detail: raw })
    expect(compositionProblem(raw).nextStep).toBeTruthy()
  })
  it("prioritizes unknown execution and never recommends automatic retry", () => {
    const problem = compositionProblem("COMPOSITION_SOURCE_CHANGED", "unknown")
    expect(problem.message).toBe("运行结果尚未确认。")
    expect(problem.nextStep).toContain("不要直接重新启动")
    expect(problem.nextStep).not.toMatch(/自动重试|自动恢复/)
    expect(compositionProblem("AUTOBIZ_COMMIT_UNKNOWN").message).toBe(problem.message)
  })
  it.each(["CAPABILITY_PACKAGE_TIMEOUT", "COMPOSITION_CATALOG_BUSY"])(
    "explains temporary catalog pressure without discarding a running task: %s",
    (code) => {
      const problem = compositionProblem(code)
      expect(problem.message).toBe("能力目录核对暂时超时，最新状态尚未确认。")
      expect(problem.nextStep).toContain("原运行不会因这次核对超时而停止")
      expect(problem.nextStep).toContain("已有记录已保留")
      expect(problem.nextStep).not.toMatch(/重装|重新选择|重新预览|来源.*变化/)
      expect(problem.detail).toBe(code)
      expect(compositionProblem(code, "unknown").message).toBe("运行结果尚未确认。")
    }
  )
  it("keeps actionable Chinese plugin errors and handles unknown technical errors", () => {
    expect(compositionProblem("报告缺少测试结论，请补齐后重新检查。")).toEqual({
      message: "报告缺少测试结论，请补齐后重新检查。"
    })
    expect(compositionProblem("COMPOSITION_NEW_ERROR")).toMatchObject({
      message: "这次操作未能完成。",
      detail: "COMPOSITION_NEW_ERROR"
    })
  })
})
it("returns opaque legacy gate and run CAS without echoing display-only project identities", () => {
  expect(
    compositionApprovalInput(
      scope,
      { id: "run", version: 7 },
      {
        kind: "legacy-human-gate",
        unitId: "unit",
        gateId: "gate",
        projectId: "internal-project",
        featureId: "internal-feature",
        sourceThreadId: "internal-thread",
        message: "Please inspect"
      },
      "approved"
    )
  ).toEqual({
    scope,
    runId: "run",
    unitId: "unit",
    kind: "legacy-human-gate",
    gateId: "gate",
    expectedVersion: 7,
    decision: "approved"
  })
  expect(
    compositionApprovalInput(
      scope,
      { id: "run", version: 7 },
      {
        unitId: "unit",
        operationId: "operation",
        operationVersion: 3,
        inputFingerprint: "original-input",
        stageTitle: "Review",
        checks: [],
        artifacts: []
      },
      "rejected"
    )
  ).toEqual({
    scope,
    runId: "run",
    unitId: "unit",
    operationId: "operation",
    expectedVersion: 3,
    inputFingerprint: "original-input",
    decision: "rejected"
  })
})
const entry: ProjectCompositionCatalogEntry = {
  source: { pluginId: "plugin", capabilityId: "check", packageDigest: "a".repeat(64) },
  sourceName: "Example",
  title: "检查",
  kind: "flow",
  available: true,
  reasons: [],
  inputs: [],
  outputs: [{ id: "report", title: "报告", path: "report.json" }]
}
describe("project composition editor", () => {
  it("requires a visible task and preserves it even before choosing a flow", () => {
    const empty = emptyCompositionDraft(scope)
    empty.definition.goal = "检查项目资料\n输出报告"
    expect(readCompositionDraft(scope, JSON.stringify(empty)).definition.goal).toBe(
      empty.definition.goal
    )
    const selected = addCompositionEntry(emptyCompositionDraft(scope), entry, "first")
    expect(compositionDraftIssues(selected, [entry])).toContain("请填写这次要完成的任务。")
    selected.definition.goal = empty.definition.goal
    expect(compositionDraftIssues(selected, [entry])).toEqual([])
  })
  it("keeps saved choices when a source changes and separates thread drafts", () => {
    const draft = addCompositionEntry(emptyCompositionDraft(scope), entry, "first")
    expect(readCompositionDraft(scope, JSON.stringify(draft))).toEqual(draft)
    expect(compositionDraftIssues(draft, [])).toContainEqual(
      expect.stringContaining("原选择已保留")
    )
    expect(compositionDraftKey(scope)).not.toBe(
      compositionDraftKey({ ...scope, threadId: "other" })
    )
    expect(() =>
      readCompositionDraft({ ...scope, projectId: "other" }, JSON.stringify(draft))
    ).toThrow()
  })
  it("rejects reordering or removing the producer of an explicit handoff", () => {
    const first = addCompositionEntry(emptyCompositionDraft(scope), entry, "first")
    const draft = addCompositionEntry(
      first,
      { ...entry, inputs: [{ id: "input", title: "报告", required: true }] },
      "second"
    )
    expect(
      compositionDraftIssues(draft, [
        { ...entry, inputs: [{ id: "input", title: "报告", required: true }] }
      ])
    ).toHaveLength(3)
    draft.definition.units[1].inputs = [
      { inputId: "input", fromUnitId: "first", artifactId: "report" }
    ]
    expect(() => changeCompositionOrder(draft, [...draft.definition.units].reverse())).toThrow(
      "资料交接"
    )
    expect(() => changeCompositionOrder(draft, draft.definition.units.slice(1))).toThrow("资料交接")
  })
  it("does not show unsupported or unverified completion as success", () => {
    expect(() =>
      addCompositionEntry(emptyCompositionDraft(scope), { ...entry, available: false }, "first")
    ).toThrow()
    const definition = addCompositionEntry(emptyCompositionDraft(scope), entry, "first").definition
    const run = {
      status: "succeeded",
      definition,
      units: [{ id: "first", status: "succeeded" }]
    } as CompositionRun
    expect(
      compositionRunBelongsTo(
        { ...run, definition: { ...definition, workspace: "C:\\fixture" } },
        scope
      )
    ).toBe(true)
    expect(compositionRunLabel(run)).toBe("完成结果待核对")
    expect(compositionRunLabel({ ...run, status: "failed" })).toBe("执行失败")
    expect(compositionRunLabel({ ...run, status: "waiting-approval" })).toBe("等待原流程确认")
  })
})
