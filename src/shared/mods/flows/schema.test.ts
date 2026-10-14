import { describe, expect, it } from "vitest"
import { parseFlowDefinition } from "./schema"
import { createAutobizFlow } from "./templates"

describe("DIY flow definition", () => {
  it("preserves selected order and typed routing without executable expressions", () => {
    const flow = createAutobizFlow("autobiz")
    const parsed = parseFlowDefinition(flow)
    expect(parsed.steps.map((step) => step.id)).toEqual(flow.steps.map((step) => step.id))
    expect(parsed.steps.find((step) => step.id === "review")?.onFailure?.stepId).toBe("implement")
    expect(
      (
        parseFlowDefinition({ ...flow, script: "process.exit()" }) as unknown as Record<
          string,
          unknown
        >
      ).script
    ).toBeUndefined()
  })
  it.each([
    [
      "duplicate",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[1].id = flow.steps[0].id
      }
    ],
    [
      "missing route",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[2].onSuccess = "missing"
      }
    ],
    [
      "success loop",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[4].onSuccess = "implement"
      }
    ],
    [
      "disabled dependency",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[2].when = { stepId: "design", outcome: "passed" }
      }
    ],
    [
      "future dependency",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[2].when = { stepId: "unit", outcome: "passed" }
      }
    ],
    [
      "unbounded retry",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[3].onFailure!.maxRetries = 11
      }
    ],
    [
      "empty enabled list",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps.forEach((step) => {
          step.enabled = false
        })
      }
    ],
    [
      "missing stage identity",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[7].enabled = true
      }
    ],
    [
      "approval fallback",
      (flow: ReturnType<typeof createAutobizFlow>) => {
        flow.steps[6].onFailure = { stepId: "implement", maxRetries: 1 }
      }
    ]
  ])("rejects %s", (_name, mutate) => {
    const flow = createAutobizFlow("autobiz")
    mutate(flow)
    expect(() => parseFlowDefinition(flow)).toThrow()
  })
  it("requires stage commits to be terminal and unique", () => {
    const flow = createAutobizFlow("autobiz")
    flow.feature = "order-export"
    flow.stageStart = "requirements_eval_in_progress"
    flow.steps[7].enabled = true
    expect(parseFlowDefinition(flow).steps.at(-1)?.kind).toBe("autobiz-stage")
    flow.steps.push({
      id: "late",
      name: "too late",
      kind: "agent",
      enabled: true,
      prompt: "rewrite"
    })
    expect(() => parseFlowDefinition(flow)).toThrow("最后")
  })
})
