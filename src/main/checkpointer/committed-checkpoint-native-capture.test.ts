import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { FunctionConversationStore, readFunctionConversationCheckpointReadOrigins } from "../db/function-conversation-store"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { createNativeCommittedMembershipAdmission, prepareNativeCommittedCheckpointCapture } from
  "./committed-checkpoint-native-capture"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture(messages: BaseMessage[] = [new AIMessage({ id: randomUUID(), content: "native" })]) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-committed-capture-"))
  const database = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  const incarnation = { token: randomUUID(), legacyCreatedAt: 1000 }
  database.run("INSERT INTO threads VALUES(?,?,?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: incarnation.token })])
  const store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId: "thread", workspace: directory, incarnation,
    checkpointNamespace: "" }, () => undefined)
  const id = randomUUID()
  const tuple: CheckpointTuple = {
    config: Object.freeze({ configurable: Object.freeze({ thread_id: "thread", checkpoint_id: id,
      checkpoint_ns: "" }) }),
    checkpoint: { v: 1, id, ts: new Date().toISOString(), channel_values: { messages,
      cmbFunctionConversation: { version: 1, logicalSessionId: target.logicalSessionId,
        conversationId: target.conversationId, branchId: target.branchId, frontier: 0 } },
    channel_versions: {}, versions_seen: {} }, metadata: { source: "loop", step: 0, parents: {} }
  }
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { database, store, target, tuple, messages,
    capture: () => prepareNativeCommittedCheckpointCapture(store, target, tuple) }
}

describe("lossless native committed checkpoint capture", () => {
  it("does not grant batch provenance to a caller-created runtime or invoke its accessors", () => {
    const f = fixture(), getter = vi.fn(() => undefined)
    const fake = Object.freeze(Object.defineProperty({}, "binding", { get: getter })) as
      Parameters<typeof createNativeCommittedMembershipAdmission>[0]
    expect(createNativeCommittedMembershipAdmission(fake, {} as never, {} as never)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(f.capture()).toBeDefined()
  })

  it("retrieves Store originals captured at class initialization despite a later override", () => {
    const original = readFunctionConversationCheckpointReadOrigins()
    const spy = vi.spyOn(FunctionConversationStore.prototype, "readCheckpointMembers")
      .mockImplementation(() => [])
    const read = readFunctionConversationCheckpointReadOrigins()
    expect(read).toBe(original)
    expect(read.readMembers).not.toBe(spy)
    expect(Object.isFrozen(read)).toBe(true)
    expect(Object.isFrozen(read.memberDescriptor)).toBe(true)
  })

  it("copies native human, AI and tool fields without invoking constructors or changing payloads", () => {
    const messages = [new HumanMessage({ id: randomUUID(), content: [{ type: "text", text: "hello" }] }),
      new AIMessage({ id: randomUUID(), content: "", tool_calls: [{ id: "call", name: "test", args: { x: 1 } }] }),
      new ToolMessage({ id: randomUUID(), content: "done", tool_call_id: "call", artifact: { n: 2 } })]
    const f = fixture(messages), capture = f.capture()
    expect(capture).toBeDefined()
    const copies = capture!.tuple.checkpoint.channel_values.messages as BaseMessage[]
    expect(copies).not.toBe(messages)
    for (let index = 0; index < messages.length; index++) {
      expect(copies[index]).not.toBe(messages[index])
      expect(Object.getPrototypeOf(copies[index])).toBe(Object.getPrototypeOf(messages[index]))
      expect(serializeFunctionConversationNativeMessage(copies[index]))
        .toBe(serializeFunctionConversationNativeMessage(messages[index]))
    }
    expect(() => capture!.assertCurrent()).not.toThrow()
  })

  it("preserves ID-less history, v1 AI fields, Dates, aliases and descriptor flags", () => {
    const human = new HumanMessage({ content: "actual", additional_kwargs: { cmb_visible_user_message: "alias" } })
    const ai = new AIMessage({ id: randomUUID(), content: [{ type: "text", text: "v1" }],
      response_metadata: { output_version: "v1" } })
    const f = fixture([human, ai])
    Object.defineProperty(ai.lc_kwargs, "privateField", { value: "preserved", enumerable: false })
    f.tuple.checkpoint.channel_values.date = new Date(1000)
    const capture = f.capture()
    expect(capture).toBeDefined()
    const copies = capture!.tuple.checkpoint.channel_values.messages as BaseMessage[]
    expect(JSON.stringify(copies[0].toDict())).toBe(JSON.stringify(human.toDict()))
    expect(copies[0].content).toBe("actual")
    expect(serializeFunctionConversationNativeMessage(copies[1]))
      .toBe(serializeFunctionConversationNativeMessage(ai))
    expect(Object.getOwnPropertyDescriptor(copies[1].lc_kwargs, "privateField"))
      .toEqual(Object.getOwnPropertyDescriptor(ai.lc_kwargs, "privateField"))
    expect(capture!.tuple.checkpoint.channel_values.date).toEqual(new Date(1000))
    capture!.assertCurrent()
  })

  it.each(["content", "same-value-message", "enumerable", "prototype", "array", "date", "copy"])(
    "rejects changed %s anywhere in the complete original or private graph", change => {
      const f = fixture()
      f.tuple.checkpoint.channel_values.date = new Date(1000)
      const capture = f.capture()!
      expect(capture).toBeDefined()
      if (change === "content") f.messages[0].content = "changed"
      if (change === "same-value-message") f.messages[0] = new AIMessage({
        id: f.messages[0].id, content: f.messages[0].content })
      if (change === "enumerable") Object.defineProperty(f.messages[0].lc_kwargs, "content", { enumerable: false })
      if (change === "prototype") Object.setPrototypeOf(f.messages[0].additional_kwargs, null)
      if (change === "array") f.tuple.checkpoint.channel_values.messages = [...f.messages]
      if (change === "date") (f.tuple.checkpoint.channel_values.date as Date).setTime(1001)
      if (change === "copy") (capture.tuple.checkpoint.channel_values.messages as BaseMessage[])[0].content = "changed"
      expect(() => capture.assertCurrent()).toThrow("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    })

  it.each(["own-method", "accessor", "proxy", "serializer", "store", "unsupported"])(
    "declines %s before executing any custom callback", change => {
      const f = fixture(), callback = vi.fn(() => "ai")
      if (change === "own-method") Object.defineProperty(f.messages[0], "getType", { value: callback })
      if (change === "accessor") Object.defineProperty(f.messages[0], "content", { get: callback })
      if (change === "proxy") f.messages[0] = new Proxy(f.messages[0], { get: callback })
      if (change === "serializer") vi.spyOn(BaseMessage.prototype, "toDict").mockImplementation(callback as never)
      if (change === "store") vi.spyOn(f.store, "readRowsAtCut").mockImplementation(callback as never)
      if (change === "unsupported") f.tuple.checkpoint.channel_values.custom = callback
      expect(f.capture()).toBeUndefined()
      expect(callback).not.toHaveBeenCalled()
    })

  it("fails closed if native dispatch changes after capture", () => {
    const f = fixture(), capture = f.capture()!
    vi.spyOn(BaseMessage.prototype, "toDict").mockImplementation(() => { throw undefined })
    expect(() => capture.assertCurrent()).toThrow("MODS_CONVERSATION_CHECKPOINT_CHANGED")
  })
})
