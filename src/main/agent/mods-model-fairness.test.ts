import { setImmediate } from "node:timers"
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { expect, it } from "vitest"
import { createModModelBoundary, type FunctionModelStreamHost } from "./mods-model-boundary"
import { dispatchFunctionStream } from "../mods/v2/stream-dispatcher"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"

class BufferedModel extends BaseChatModel {
  _llmType() {
    return "owned-buffered-fairness-fixture"
  }
  async _generate(): Promise<ChatResult> {
    throw Error("Streaming required")
  }
  async *_streamResponseChunks() {
    for (let index = 0; index < 100; index++) {
      // Model an already-buffered provider with measurable synchronous per-frame work.
      const until = performance.now() + 0.3
      while (performance.now() < until) {
        /* bounded CPU fixture, no I/O */
      }
      yield new ChatGenerationChunk({
        text: `part-${index};`,
        message: new AIMessageChunk({ id: "same-provider-id", content: `part-${index};` })
      })
    }
  }
}

it("gives pending I/O a turn before draining a buffered protected model stream", async () => {
  const owners = new ModRuntimeAuthorities()
  const { authority } = owners.create({
    workspace: "/fairness",
    threadId: "thread",
    agentId: "main",
    turnId: "turn"
  })
  const manager: FunctionModelStreamHost = {
    functionModelStream: async (_authority, input, core, signal) =>
      dispatchFunctionStream([], input, { core, signal })
  }
  try {
    const boundary = createModModelBoundary(new BufferedModel({}), manager, authority, {
      turnId: "turn",
      model: "fixture"
    })
    const stream = await boundary.stream([new HumanMessage("fixture")])
    let count = 0,
      observedAt = -1
    const immediate = new Promise<void>((done) =>
      setImmediate(() => {
        observedAt = count
        done()
      })
    )
    const messages: AIMessageChunk[] = []
    for await (const message of stream) {
      messages.push(message as AIMessageChunk)
      count++
    }
    await immediate
    expect(observedAt).toBeGreaterThanOrEqual(0)
    expect(observedAt).toBeLessThan(100)
    expect(messages).toHaveLength(100)
    expect(new Set(messages.map((message) => message.id))).toEqual(new Set(["same-provider-id"]))
    expect(messages.map((message) => message.content).join("")).toBe(
      Array.from({ length: 100 }, (_, index) => `part-${index};`).join("")
    )
  } finally {
    owners.close()
  }
})

it.each(["cancel", "revoke"] as const)(
  "does not publish queued frames after %s during an I/O turn",
  async (kind) => {
    const owners = new ModRuntimeAuthorities()
    const { authority } = owners.create({
      workspace: "/fairness",
      threadId: "thread",
      agentId: "main",
      turnId: "turn"
    })
    const controller = new AbortController()
    const manager: FunctionModelStreamHost = {
      functionModelStream: async (_authority, input, core, signal) =>
        dispatchFunctionStream([], input, { core, signal })
    }
    let count = 0,
      stoppedAt = -1
    try {
      const boundary = createModModelBoundary(new BufferedModel({}), manager, authority, {
        turnId: "turn",
        model: "fixture"
      })
      const stream = await boundary.stream([new HumanMessage("fixture")], {
        signal: controller.signal
      })
      const immediate = new Promise<void>((done) =>
        setImmediate(() => {
          stoppedAt = count
          if (kind === "cancel") controller.abort()
          else owners.close()
          done()
        })
      )
      await expect(
        (async () => {
          for await (const message of stream) {
            expect(message.id).toBe("same-provider-id")
            count++
          }
        })()
      ).rejects.toThrow()
      await immediate
      expect(stoppedAt).toBeLessThan(100)
      expect(count).toBe(stoppedAt)
    } finally {
      owners.close()
    }
  }
)
