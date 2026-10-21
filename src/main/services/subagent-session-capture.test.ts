import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import type { SubagentExportTarget } from "../../shared/subagent-session-export"
import {
  getCapturedSubagentSession,
  subagentSessionCallbacks,
  withSubagentSessionCapture
} from "./subagent-session-capture"
import { getCapturedRawApiCall, withRawApiCallCapture } from "./llm-api-request-capture"

async function recordMessages(messages: (HumanMessage | AIMessage | ToolMessage)[]): Promise<void> {
  const callbacks = subagentSessionCallbacks([])
  if (!Array.isArray(callbacks)) throw new Error("Expected capture callbacks")
  for (const callback of callbacks) {
    await callback.handleChainEnd?.({ messages }, "test-run")
  }
}

function workerTarget(workerThreadId: string): SubagentExportTarget {
  return { kind: "worker", threadId: "parent", workerThreadId }
}

describe("Worker session export capture", () => {
  it("retains prior turns, tool details, reasoning, and the latest submitted request", async () => {
    const target = workerTarget("worker-continuation")
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"))
    const send = withRawApiCallCapture(fetchImpl, "parent")
    const first = new HumanMessage({ content: "implement", id: "user-1" })
    const assistant = new AIMessage({
      content: "",
      id: "assistant-1",
      additional_kwargs: { reasoning_content: "inspect formatting" },
      tool_calls: [{ id: "call-1", name: "edit_file", args: { file_path: "/src/file.ts" } }]
    })
    const result = new ToolMessage({ content: "edited", tool_call_id: "call-1", id: "tool-1" })
    await withSubagentSessionCapture(target, "implementation", async () => {
      await recordMessages([first, assistant, result])
      await send("https://example.test", { body: JSON.stringify({ messages: ["first"] }) })
    })
    const initial = getCapturedSubagentSession(target)!
    const request = JSON.stringify({ messages: [{ role: "system", content: "format rules" }] })
    await withSubagentSessionCapture(target, "implementation", async () => {
      await recordMessages([first, new HumanMessage({ content: "continue", id: "user-2" })])
      await send("https://example.test", { body: request })
    })
    const captured = getCapturedSubagentSession(target)!
    expect(captured.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "tool-1",
      "user-2"
    ])
    expect(captured.messages[1].additional_kwargs).toEqual({
      reasoning_content: "inspect formatting"
    })
    expect(captured.messages[1].tool_calls).toEqual(assistant.tool_calls)
    expect(captured.messages[2].content).toBe("edited")
    expect(captured.rawApiCall).toBe(request)
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.body).toBe(request)
    expect(captured.createdAt).toBe(initial.createdAt)
    expect(captured.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(getCapturedRawApiCall("parent")).toBe("")
  })

  it("isolates simultaneous workers and retains requests when execution fails", async () => {
    const send = withRawApiCallCapture(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")),
      "parent"
    )
    const targets = [workerTarget("worker-a"), workerTarget("worker-b")]
    const results = await Promise.allSettled(
      targets.map((target, index) =>
        withSubagentSessionCapture(target, `worker ${index}`, async () => {
          await recordMessages([
            new HumanMessage({ content: `task ${index}`, id: `user-${index}` })
          ])
          await send("https://example.test", { body: `request-${index}` })
          if (index === 1) throw new Error("worker failed")
          return "done"
        })
      )
    )
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    targets.forEach((target, index) => {
      const captured = getCapturedSubagentSession(target)!
      expect(captured.messages.map((message) => message.content)).toEqual([`task ${index}`])
      expect(captured.rawApiCall).toBe(`request-${index}`)
    })
    expect(getCapturedRawApiCall("parent")).toBe("")
  })

  it("keeps existing task and workflow capture replacement behavior", async () => {
    const targets: SubagentExportTarget[] = [
      { kind: "multi", threadId: "parent", subagentId: "task" },
      { kind: "workflow", threadId: "parent", runId: "run", agentIndex: 1 }
    ]
    for (const target of targets) {
      for (const content of ["old", "new"]) {
        await withSubagentSessionCapture(target, "agent", () =>
          recordMessages([new HumanMessage({ content, id: content })])
        )
      }
      expect(
        getCapturedSubagentSession(target)!.messages.map((message) => message.content)
      ).toEqual(["new"])
    }
  })

  it("does not attribute an evicted worker request to the parent", async () => {
    const target = workerTarget("evicted-worker")
    const send = withRawApiCallCapture(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")),
      "parent"
    )
    await withSubagentSessionCapture(target, "old worker", async () => {
      for (let index = 0; index < 10; index++) {
        withSubagentSessionCapture(workerTarget(`evict-${index}`), "worker", () => undefined)
      }
      await send("https://example.test", { body: "evicted request" })
    })
    expect(getCapturedSubagentSession(target)).toBeNull()
    expect(getCapturedRawApiCall("parent")).toBe("")
  })
})
