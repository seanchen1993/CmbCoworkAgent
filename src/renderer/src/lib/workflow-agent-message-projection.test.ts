import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import { ElectronIPCTransport } from "./electron-transport"
import { createWorkflowAgentMessageProjector } from "./workflow-agent-message-projection"

function message(index: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `message-${index}`,
    role: "assistant",
    content: `answer-${index}`,
    created_at: new Date(index),
    ...overrides
  }
}

describe("workflow complete snapshot projection", () => {
  it("applies corrections outside the last 32 messages without duplicating the tail", () => {
    const project = createWorkflowAgentMessageProjector()
    const before = Array.from({ length: 40 }, (_, index) => message(index))
    const initial = project(before, "agent-1")
    const after = before.map((item) => ({ ...item }))
    after[0] = message(0, { content: "corrected" })
    after[39] = message(39, { content: "answer-0" })
    const result = project(after, "agent-1")
    expect(result[0].content).toBe("corrected")
    expect(result.filter((item) => item.content === "answer-0")).toHaveLength(1)
    expect(result).not.toBe(initial)
    expect(result[1]).toBe(initial[1])
    expect(initial[0].content).toBe("answer-0")
  })

  it("handles replacement, reordering, clearing, append and empty snapshots", () => {
    const project = createWorkflowAgentMessageProjector()
    const before = Array.from({ length: 40 }, (_, index) => message(index))
    project(before, "agent")
    const after = before.slice()
    after[0] = message(100)
    after[1] = before[2]
    after[2] = before[1]
    after[3] = message(3, { content: "" })
    expect(project(after, "agent")).toEqual(after)
    expect(project(after.slice(0, 7), "agent")).toEqual(after.slice(0, 7))
    expect(project(after, "agent")).toEqual(after)
    expect(project([], "agent")).toEqual([])
    expect(project(before, "agent")).toEqual(before)
  })

  it("updates reasoning, tool arguments, cleared calls, result identity and errors", () => {
    const updates: Partial<Message>[] = [
      { reasoning: "corrected thinking" },
      { tool_calls: [{ id: "call", name: "read_file", args: { path: "new" } }] },
      { tool_calls: [] },
      { content: [{ type: "text", text: "new block" }] },
      { provider_source_id: "new-source", provider_occurrence: 2 },
      { role: "tool", tool_call_id: "new-call", name: "read_file", status: "error", is_error: true }
    ]
    for (const update of updates) {
      const project = createWorkflowAgentMessageProjector()
      const before = Array.from({ length: 40 }, (_, index) => message(index))
      before[0].tool_calls = [{ id: "call", name: "read_file", args: { path: "old" } }]
      project(before, "agent")
      const after = before.slice()
      after[0] = { ...before[0], ...update }
      expect(project(after, "agent")[0]).toEqual(after[0])
    }
  })

  it("refreshes every tool-result field independently even when prose is unchanged", () => {
    const project = createWorkflowAgentMessageProjector()
    let current = message(0, {
      role: "tool",
      tool_call_id: "call",
      name: "read_file",
      status: "success"
    })
    project([current], "agent")
    for (const update of [
      { tool_call_id: "other" },
      { name: "execute" },
      { status: "error" },
      { is_error: true }
    ]) {
      current = { ...current, ...update }
      expect(project([current], "agent")[0]).toBe(current)
    }
  })

  it("scopes reuse by parent, run and agent rather than provider id or prose", () => {
    const project = createWorkflowAgentMessageProjector()
    const old = project([message(0)], "parent-1/run-1/agent-1")
    for (const scope of [
      "parent-2/run-1/agent-1",
      "parent-2/run-2/agent-1",
      "parent-2/run-2/agent-2"
    ]) {
      const incoming = [message(0)]
      expect(project(incoming, scope)[0]).toBe(incoming[0])
      expect(project(incoming, scope)).not.toBe(old)
    }
  })

  it("keeps repeated authoritative prose and distinct provider occurrences lossless", () => {
    const transport = new ElectronIPCTransport()
    const project = createWorkflowAgentMessageProjector()
    const wire = (content: string) => ({
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { id: "shared", content }
    })
    const convert = () =>
      transport.convertWorkflowAgentValuesSnapshot(
        [wire("same answer"), wire("same answer"), wire("ha ha")],
        "wfagent:run:0"
      )
    const first = project(convert(), "parent/run/0")
    const repeated = project(convert(), "parent/run/0")
    expect(repeated).toBe(first)
    expect(new Set(repeated.map((item) => item.id)).size).toBe(3)
    expect(repeated.map((item) => item.content)).toEqual(["same answer", "same answer", "ha ha"])
  })

  it("reuses unchanged history under maximum-size frames without accumulating snapshots", () => {
    const project = createWorkflowAgentMessageProjector()
    const before = Array.from({ length: 400 }, (_, index) =>
      message(index, {
        content: `${index}:` + "x".repeat(2_200)
      })
    )
    const initial = project(before, "agent")
    for (let frame = 0; frame < 500; frame += 1) {
      const incoming = before.map((item) => ({ ...item, created_at: new Date(frame + 10_000) }))
      incoming[399] = message(399, { content: `frame-${frame}` })
      const result = project(incoming, "agent")
      expect(result).toHaveLength(400)
      expect(result[0]).toBe(initial[0])
      expect(result[367]).toBe(initial[367])
      expect(result[398]).toBe(initial[398])
      expect(result[399].content).toBe(`frame-${frame}`)
      expect(project(incoming, "agent")).toBe(result)
    }
    expect(initial[399].content).toBe(before[399].content)
  })
})
