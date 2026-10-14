import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import { SqlJsSaver } from "./sqljs-saver"
import { wrapNativeLegacyHistory } from "./native-legacy-history"
import { captureNativeMessage } from "../agent/native-message-capture"
import { preflightFunctionConversationMessage } from "../agent/function-conversation-message-preflight"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(extra: Record<string, unknown> = {}, additional: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-legacy-native-history-"))
  const saver = new SqlJsSaver(join(directory, "checkpoint.sqlite"))
  cleanup.push(async () => { await saver.close(); await rm(directory, { recursive: true, force: true }) })
  const chunk = new AIMessageChunk({ id: "old-model", content: "saved response",
    additional_kwargs: additional,
    tool_calls: [{ id: "call", name: "echo", args: { text: "exact" }, type: "tool_call" }] })
  const checkpoint: Checkpoint = { v: 4, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages: [new HumanMessage({ id: "human", content: "hello" }), chunk], ...extra },
    channel_versions: { messages: 1 }, versions_seen: {} }
  const config = await saver.put({ configurable: { thread_id: "thread", checkpoint_ns: "" } },
    checkpoint, { source: "loop", step: 1, parents: {} })
  const controller = new AbortController()
  const wrapped = wrapNativeLegacyHistory(saver, saver, { threadId: "thread", namespace: "",
    assertCurrent: () => controller.signal.throwIfAborted() })
  return { saver, wrapped, config, chunk, controller }
}

it("normalizes only SQLite-read legacy channel history and preserves tool arguments", async () => {
  const f = await fixture()
  const read = await f.wrapped.getTuple(f.config)
  const messages = read!.checkpoint.channel_values.messages as AIMessage[]
  expect(Object.getPrototypeOf(messages[1])).toBe(AIMessage.prototype)
  expect(messages[1].id).toBe("old-model")
  expect(messages[1].content).toBe("saved response")
  expect(messages[1].tool_calls).toEqual(f.chunk.tool_calls)
  expect(() => preflightFunctionConversationMessage(messages[1], () => {})).not.toThrow()
  expect(() => captureNativeMessage(f.chunk)).toThrow("MODS_NATIVE_CAPTURE_INVALID")
  expect(() => preflightFunctionConversationMessage(f.chunk, () => {})).toThrow("MODS_NATIVE_CAPTURE_INVALID")
  const unchanged = await f.saver.getTuple(f.config)
  expect(Object.getPrototypeOf((unchanged!.checkpoint.channel_values.messages as AIMessage[])[1]))
    .toBe(AIMessageChunk.prototype)
})

it.each(["function_row", "function_row_invalid"])("rejects a marked legacy chunk: %s", async key => {
  const f = await fixture({}, { [key]: {} })
  await expect(f.wrapped.getTuple(f.config)).rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_CHANGED")
})

it("never converts an already protected checkpoint", async () => {
  const f = await fixture({ cmbFunctionConversation: { version: 1 } })
  const read = await f.wrapped.getTuple(f.config)
  const message = (read!.checkpoint.channel_values.messages as AIMessage[])[1]
  expect(Object.getPrototypeOf(message)).toBe(AIMessageChunk.prototype)
  expect(() => preflightFunctionConversationMessage(message, () => {})).toThrow("MODS_NATIVE_CAPTURE_INVALID")
})

it("does not normalize another scope and refuses after cancellation", async () => {
  const f = await fixture()
  const other = wrapNativeLegacyHistory(f.saver, f.saver, { threadId: "other", namespace: "",
    assertCurrent: () => {} })
  const read = await other.getTuple(f.config)
  expect(Object.getPrototypeOf((read!.checkpoint.channel_values.messages as AIMessage[])[1]))
    .toBe(AIMessageChunk.prototype)
  f.controller.abort()
  await expect(f.wrapped.getTuple(f.config)).rejects.toThrow()
})
