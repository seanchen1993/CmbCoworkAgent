import { describe, expect, it } from "vitest"
import { receiveProjectAgentEvent, type ProjectAgentRunState } from "./use-project-agent-run"

describe("long-running project Agent progress", () => {
  it("continues showing current model replies after many retries and releases old previews", () => {
    let state: ProjectAgentRunState = {
      steps: [],
      text: "",
      replies: {},
      startedAt: 1,
      outcome: "running"
    }
    for (let i = 0; i < 220; i++) {
      const id = `step-${i}`
      state = receiveProjectAgentEvent(state, {
        type: "step",
        step: { id, kind: "model", title: `第 ${i} 次`, status: "running", startedAt: i }
      })
      state = receiveProjectAgentEvent(state, {
        type: "text",
        stepId: id,
        text: `正文 ${i}`,
        answer: false
      })
    }
    expect(state.steps.at(-1)?.id).toBe("step-219")
    expect(state.replies["step-219"]).toBe("正文 219")
    expect(state.steps).toHaveLength(180)
    expect(Object.keys(state.replies)).toHaveLength(180)
    expect(state.replies["step-0"]).toBeUndefined()
    expect(state.historyTruncated).toBe(true)
    expect(state.text).toBe("")
    state = { ...state, outcome: "cancelled" }
    expect(
      receiveProjectAgentEvent(state, { type: "text", stepId: "step-219", text: "迟到文本" })
    ).toBe(state)
  })
})
