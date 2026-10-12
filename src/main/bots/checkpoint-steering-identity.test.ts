import { afterEach, expect, it, vi } from "vitest"
import { createAgent } from "langchain"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  queueCurrentRunMessage,
  setCurrentRunInjectionNotifier,
  setCurrentRunMessageQueueOwner
} from "../agent/current-run-message-queue"
import {
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY
} from "../../shared/message-role-collision"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"

const stores: BotStore[] = []
const owners: { threadId: string; token: string }[] = []
afterEach(() => {
  vi.restoreAllMocks()
  setCurrentRunInjectionNotifier(() => {})
  for (const { threadId, token } of owners.splice(0)) clearCurrentRunMessageQueue(threadId, token)
  for (const store of stores.splice(0)) store.close()
})

for (const mode of ["durable", "desktop"] as const) {
  for (const chunk of [false, true]) {
    it(`persists ${mode} afterModel steering identities without mutating the previous ${chunk ? "AIMessageChunk" : "AIMessage"} checkpoint`, async () => {
      const store = new BotStore(":memory:")
      stores.push(store)
      const { conversationId } = store.createBot({ nonce: "bot", name: "Steering checkpoint" })
      store.send({ nonce: "task", conversationId, text: "Original task" })
      const { run, lease } = store.claim("host", 300_000)!
      const saver = new BotCheckpointSaver(store, lease, run.id)
      const token = "physical-run"
      owners.push({ threadId: run.id, token })
      setCurrentRunMessageQueueOwner(run.id, token)
      let delivered = false
      let calls = 0
      const message = chunk
        ? new AIMessageChunk({
            id: "provider-reused",
            content: "First reply",
            response_metadata: { preserved: true }
          })
        : new AIMessage({
            id: "provider-reused",
            content: "First reply",
            response_metadata: { preserved: true }
          })
      const firstPut = vi.spyOn(saver, "put")
      const modelReply = new Map<string, BaseMessage>()
      firstPut.mockImplementation(async function (...args) {
        const last = args[1].channel_values.messages
        const result = await BotCheckpointSaver.prototype.put.apply(saver, args)
        if (Array.isArray(last) && last.at(-1) === message)
          modelReply.set(String(result.configurable?.checkpoint_id), message)
        return result
      })
      class Model extends FakeChatModel {
        bindTools() {
          return this
        }
        async _generate() {
          calls++
          if (calls === 1 && mode === "desktop")
            expect(
              queueCurrentRunMessage(run.id, { id: "steered", content: "Clarification" }, token)
            ).toBe(true)
          const reply =
            calls === 1
              ? message
              : new AIMessage({ id: "provider-reused", content: "Second reply" })
          return { generations: [{ message: reply, text: String(reply.content) }] }
        }
      }
      const notified: string[] = []
      setCurrentRunInjectionNotifier(async (_thread, _messages, context) => {
        notified.push(context?.completedAssistantMessage?.id ?? "missing")
        return {
          completedAssistantIdentity: { providerSourceId: "provider-reused", providerOccurrence: 1 }
        }
      })
      const middleware = createCurrentRunMessageQueueMiddleware(
        token,
        mode === "durable"
          ? {
              take: async ({ phase }) => {
                if (phase !== "afterModel" || delivered) return []
                delivered = true
                return [new HumanMessage({ id: "steered", content: "Clarification" })]
              }
            }
          : undefined
      )
      const agent = createAgent({
        model: new Model({}),
        tools: [],
        middleware: [middleware],
        checkpointer: saver
      })
      const config = { configurable: { thread_id: run.id } }
      const result = await agent.invoke(
        { messages: [new HumanMessage({ id: "original", content: "Original task" })] },
        config
      )
      const fresh = new BotCheckpointSaver(store, lease, run.id)
      const saved = (await fresh.getTuple(config))!.checkpoint.channel_values
        .messages as BaseMessage[]
      expect(calls).toBe(2)
      expect(saved.map((item) => ({ id: item.id, content: item.content }))).toEqual(
        result.messages.map((item) => ({ id: item.id, content: item.content }))
      )
      expect(saved.map((item) => item.content)).toEqual([
        "Original task",
        "First reply",
        "Clarification",
        "Second reply"
      ])
      expect(saved[1].id).toMatch(/^current-run-assistant:/)
      expect(saved[1].response_metadata).toEqual({ preserved: true })
      expect(message.id).toBe("provider-reused")
      expect(modelReply.size).toBe(1)
      const originalId = [...modelReply.keys()][0]
      const prior = (await fresh.getTuple({
        configurable: { thread_id: run.id, checkpoint_id: originalId }
      }))!
      expect((prior.checkpoint.channel_values.messages as BaseMessage[]).at(-1)?.id).toBe(
        "provider-reused"
      )
      if (mode === "desktop") {
        expect(notified).toEqual([saved[1].id])
        expect(saved[1].additional_kwargs).toMatchObject({
          [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "provider-reused",
          [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 1
        })
      }
    })
  }
}
