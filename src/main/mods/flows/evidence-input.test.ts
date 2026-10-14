import { expect, it } from "vitest"
import {
  createAutobizPreset,
  withAutobizReportAction
} from "../../../shared/mods/flows/autobiz-presets"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"
import { flowEvidenceInput } from "./evidence-input"

function fixture(attempts: FlowAttempt[] = []): FlowRun {
  return {
    id: "run",
    threadId: "t",
    workspace: "w",
    status: "running",
    startedAt: 1,
    epoch: 1,
    failureCounts: {},
    attempts,
    flow: {
      definition: withAutobizReportAction(createAutobizPreset("repair-retest", "flow"), {
        pluginId: "report-plugin",
        plugin: "report",
        actionId: "report",
        digest: "a".repeat(64)
      }),
      revision: 1,
      digest: "digest",
      updatedAt: 1
    }
  }
}
const attempt = (stepId: string, native = false): FlowAttempt => ({
  stepId,
  executionId: `${stepId}-1`,
  attempt: 1,
  epoch: 1,
  status: "passed",
  startedAt: 1,
  result: {
    passed: true,
    summary: `summary for ${stepId}`,
    source: native ? "native-check" : "agent",
    ...(native ? { check: "unit-test", evidenceIds: [`${stepId}-receipt`] } : {})
  }
})

it("projects actual current review/native-test results into a compatible report action", () => {
  const run = fixture([attempt("review"), attempt("unit", true)])
  expect(parseFlowDefinition(run.flow.definition)).toEqual(run.flow.definition)
  const value = JSON.parse(flowEvidenceInput(run, "report"))
  expect(value.nativeProjectTests).toBe("passed")
  expect(value.results.map((row: { stepId: string }) => row.stepId)).toEqual(["review", "unit"])
  expect(value.results[1]).toMatchObject({ check: "unit-test", evidenceIds: ["unit-receipt"] })
})

it("excludes stale/skipped/future outcomes and never treats model claims as native tests", () => {
  const review = attempt("review")
  review.result!.summary = "model claims all tests passed"
  review.result!.evidenceIds = ["invented"]
  const run = fixture([
    review,
    { ...attempt("unit", true), invalidated: true },
    { ...attempt("retest", true), status: "skipped" },
    attempt("accept")
  ])
  const value = JSON.parse(flowEvidenceInput(run, "report"))
  expect(value.nativeProjectTests).toBe("not-run")
  expect(value.results).toHaveLength(1)
  expect(value.results[0].evidenceIds).toBeUndefined()
})

it("retains a current failure rather than hiding it behind an earlier passed attempt", () => {
  const failed = attempt("unit", true)
  failed.executionId = "unit-2"
  failed.status = "failed"
  failed.result!.passed = false
  const value = JSON.parse(flowEvidenceInput(fixture([attempt("unit", true), failed]), "report"))
  expect(value.nativeProjectTests).toBe("failed")
  expect(value.results).toHaveLength(1)
  expect(value.results[0]).toMatchObject({ executionId: "unit-2", passed: false })
})

it("refuses oversize evidence instead of truncating failed outcomes", () => {
  const failed = attempt("unit", true)
  failed.status = "failed"
  failed.result!.passed = false
  failed.result!.summary = "failure".repeat(5000)
  expect(() => flowEvidenceInput(fixture([failed]), "report")).toThrow(
    "FLOW_EVIDENCE_INPUT_TOO_LARGE"
  )
})

it("does not count forged agent source or legacy check records without a matching check kind", () => {
  const agent = attempt("review", true)
  const legacy = attempt("unit", true)
  delete legacy.result!.check
  const value = JSON.parse(flowEvidenceInput(fixture([agent, legacy]), "report"))
  expect(value.nativeProjectTests).toBe("not-run")
  expect(value.results.map((row: { source: string }) => row.source)).toEqual([
    "agent",
    "unverified-check"
  ])
  expect(value.results.every((row: { evidenceIds?: string[] }) => !row.evidenceIds)).toBe(true)
})

it("rejects contradictory host status and result rather than publishing a false pass", () => {
  const row = attempt("unit", true)
  row.result!.passed = false
  expect(() => flowEvidenceInput(fixture([row]), "report")).toThrow("FLOW_EVIDENCE_RESULT_INVALID")
})

it.each(["constructor", "__proto__", "nested.text", "text;echo", ""])(
  "rejects evidence field %s",
  (field) => {
    const run = fixture()
    const report = run.flow.definition.steps.find((step) => step.id === "report")!
    if (report.kind !== "plugin-action") throw Error("fixture")
    report.evidenceInput = { field }
    expect(() => parseFlowDefinition(run.flow.definition)).toThrow("顶层文本字段")
  }
)

it("rejects combining evidence and prior-output sources or attaching it to MCP", () => {
  const run = fixture()
  const report = run.flow.definition.steps.find((step) => step.id === "report")!
  if (report.kind !== "plugin-action") throw Error("fixture")
  report.inputFrom = { stepId: "review" }
  expect(() => parseFlowDefinition(run.flow.definition)).toThrow("不能同时引用")
  delete report.inputFrom
  Object.assign(report, { kind: "mcp-tool" })
  expect(() => parseFlowDefinition(run.flow.definition)).toThrow("仅支持插件动作")
})
