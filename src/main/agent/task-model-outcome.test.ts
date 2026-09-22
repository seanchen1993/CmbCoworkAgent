import { AIMessage, type BaseMessage, HumanMessage, isToolMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import { expect, it, vi } from "vitest"
import { createTaskModelOutcomeMiddleware, withTaskModelOutcome } from "./task-model-outcome"
import { ModelRefusalError } from "./model-refusal"

function graph(refused: boolean, includeTool = false) {
  const execute = vi.fn(() => "executed")
  class Model extends FakeChatModel {
    bindTools() {
      return this
    }
    async _generate(messages: BaseMessage[]) {
      if (isToolMessage(messages.at(-1)!)) {
        const message = new AIMessage("after tool")
        return { generations: [{ message, text: "after tool" }] }
      }
      const message = new AIMessage({
        content: refused ? "provider refused" : "answer",
        ...(refused ? { response_metadata: { finish_reason: "content_filter" } } : {}),
        ...(includeTool
          ? { tool_calls: [{ id: "write", name: "write", args: {}, type: "tool_call" as const }] }
          : {})
      })
      return { generations: [{ message, text: String(message.content) }] }
    }
  }
  const agent = createAgent({
    model: new Model({}),
    tools: [tool(execute, { name: "write", description: "write", schema: z.object({}) })],
    middleware: [createTaskModelOutcomeMiddleware()]
  })
  return {
    run: () => agent.invoke({ messages: [new HumanMessage("inspect")] }, { recursionLimit: 6 }),
    execute
  }
}

it("isolates concurrent task outcomes and reports actual refusal as an error without Mods", async () => {
  const refused = graph(true)
  const answered = graph(false)
  const [a, b] = await Promise.allSettled([
    withTaskModelOutcome(refused.run),
    withTaskModelOutcome(answered.run)
  ])
  expect(a.status).toBe("rejected")
  if (a.status === "rejected") expect(a.reason).toBeInstanceOf(ModelRefusalError)
  expect(b.status).toBe("fulfilled")
})

it("ends a refused graph before tools in that same response execute", async () => {
  const f = graph(true, true)
  await expect(withTaskModelOutcome(f.run)).rejects.toBeInstanceOf(ModelRefusalError)
  expect(f.execute).not.toHaveBeenCalled()
})

it("does not poison a parent that catches a nested task refusal", async () => {
  const value = await withTaskModelOutcome(async () => {
    await expect(withTaskModelOutcome(graph(true).run)).rejects.toBeInstanceOf(ModelRefusalError)
    return graph(false).run()
  })
  expect(value.messages.at(-1)?.content).toBe("answer")
})

it("gives actual cancellation priority over observed refusal", async () => {
  const controller = new AbortController()
  const abort = new DOMException("cancelled", "AbortError")
  await expect(
    withTaskModelOutcome(async () => {
      await graph(true).run()
      controller.abort(abort)
    }, controller.signal)
  ).rejects.toBe(abort)
})

it("makes detached callbacks inert after their invocation closes", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = graph(true, true)
  let detached!: Promise<unknown>
  await withTaskModelOutcome(async () => {
    detached = gate.then(f.run)
  })
  release()
  await expect(detached).resolves.toHaveProperty("messages")
  expect(f.execute).toHaveBeenCalledOnce()
  await expect(withTaskModelOutcome(graph(false).run)).resolves.toHaveProperty("messages")
})

it("preserves cancellation when the underlying task also throws", async () => {
  const controller = new AbortController()
  const abort = new DOMException("cancelled", "AbortError")
  await expect(
    withTaskModelOutcome(async () => {
      controller.abort(abort)
      throw new Error("provider failure")
    }, controller.signal)
  ).rejects.toBe(abort)
})
