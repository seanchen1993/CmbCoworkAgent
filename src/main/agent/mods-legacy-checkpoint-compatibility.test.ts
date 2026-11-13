import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, expect, it, vi } from "vitest"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import type { FunctionConversationGraphBinding } from "./mods-conversation"
import { wrapFunctionConversationInvocation } from "./mods-conversation-invocation"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function legacyFixture(options: { messages?: BaseMessage[]; interrupt?: boolean;
  fork?: boolean; checkpointId?: string; timestamp?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mods-legacy-checkpoint-"))
  const path = join(directory, "original.sqlite")
  const threadId = options.fork ? "legacy-fork" : "legacy-original"
  const saver = new SqlJsSaver(path)
  cleanup.push(async () => { await saver.close(); rmSync(directory, { recursive: true, force: true }) })
  const oldMessages = options.messages ?? [new HumanMessage({ id: "old-user", content: "original question" }),
    new AIMessage({ id: "old-answer", content: "original answer" })]
  const oldCheckpoint: Checkpoint = { v: 1, id: options.checkpointId ?? "original-checkpoint", ts: options.timestamp ?? "2026-08-01T00:00:00Z",
    channel_values: { messages: oldMessages,
      ...(options.interrupt ? { __interrupt__: [{ value: "original approval" }] } : {}) },
    channel_versions: { messages: 1 }, versions_seen: {} }
  const [type, payload] = await saver.serde.dumpsTyped(oldCheckpoint)
  const [, metadata] = await saver.serde.dumpsTyped({ source: "loop", step: 1, parents: {} } as CheckpointMetadata)
  // Historical inline schema, before external message snapshots or runtime projections existed.
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE checkpoints(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,type TEXT,checkpoint TEXT,metadata TEXT,
    PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
    CREATE TABLE writes(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,task_id TEXT NOT NULL,idx INTEGER NOT NULL,channel TEXT NOT NULL,
    type TEXT,value TEXT,PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));`)
  legacy.prepare("INSERT INTO checkpoints VALUES(?, '', ?, NULL, ?, ?, ?)")
    .run(threadId, oldCheckpoint.id, type, payload, metadata)
  legacy.close()
  const config: RunnableConfig = { configurable: { thread_id: threadId, checkpoint_ns: "",
    checkpoint_id: oldCheckpoint.id } }
  let live = true
  const assertCurrent = () => { if (!live) throw Error("ORIGINAL_RUNTIME_REPLACED") }
  const target = { logicalSessionId: "native-host-session", conversationId: "native-host-conversation",
    branchId: "native-host-branch", kind: "main" as const, threadId, workspace: directory,
    checkpointNamespace: "", incarnation: { token: "host-token", legacyCreatedAt: 1 } }
  const binding: FunctionConversationGraphBinding = { target, checkpointThreadId: threadId,
    runtimeCheckpointNamespace: "", signal: new AbortController().signal, assertCurrent,
    initialState: { version: 1, logicalSessionId: target.logicalSessionId,
      conversationId: target.conversationId, branchId: target.branchId, frontier: 0 } }
  const store = { assertCurrent, highWater: () => 0,
    captureInbox: () => ({ highWater: 0, frontier: 0, rows: [] }) } as unknown as FunctionConversationStore
  const native = {
    getState: vi.fn(async (point: RunnableConfig) => {
      const tuple = await saver.getTuple(point)
      return { values: tuple?.checkpoint.channel_values ?? {}, config: tuple?.config }
    }),
    invoke: vi.fn(async (input: unknown, point: RunnableConfig) => ({ input, point }))
  }
  const graph = wrapFunctionConversationInvocation(native, { store, binding,
    history: { saver, assertCurrent, register: () => {} } })
  return { path, graph, native, saver, config, oldMessages, binding, retire: () => { live = false } }
}

it.each([false, true])("admits an original ordinary inline checkpoint after upgrade (fork=%s)", async fork => {
  const f = await legacyFixture({ fork })
  const user = new HumanMessage({ id: "new-user", content: "continue" })
  const result = await f.graph.invoke({ messages: [user] }, f.config)
  expect((result.input as { messages: BaseMessage[] }).messages).toEqual([user])
  expect(result.input).toMatchObject({ cmbFunctionConversation: f.binding.initialState })
  const original = await f.saver.getTuple(f.config)
  expect(original?.checkpoint.channel_values.cmbFunctionConversation).toBeUndefined()
  expect((original?.checkpoint.channel_values.messages as BaseMessage[]).map(row => row.content))
    .toEqual(["original question", "original answer"])
})

it.each([null, new Command({ resume: "original decision" })])(
  "keeps native interrupt/resume input for an authenticated old checkpoint", async input => {
    const call = new AIMessage({ id: "old-call", content: "", tool_calls: [
      { id: "original-tool", name: "read_file", args: { path: "original.txt" } }
    ] })
    const f = await legacyFixture({ messages: [new HumanMessage("original"), call], interrupt: true })
    const result = await f.graph.invoke(input, f.config)
    expect(result.input).toBe(input)
    const tuple = await f.saver.getTuple(f.config)
    expect(tuple?.checkpoint.channel_values.__interrupt__).toEqual([{ value: "original approval" }])
  }
)

it("compares complete tool calls and results before admitting old history", async () => {
  const f = await legacyFixture({ messages: [
    new AIMessage({ id: "call", content: "", tool_calls: [
      { id: "tool", name: "read_file", args: { path: "old.txt" } }
    ] }), new ToolMessage({ id: "result", content: "original result", tool_call_id: "tool" })
  ] })
  f.native.getState.mockImplementation(async () => {
    const tuple = await f.saver.getTuple(f.config)
    const messages = tuple!.checkpoint.channel_values.messages as BaseMessage[]
    ;(messages[0] as AIMessage).tool_calls![0].args.path = "replaced.txt"
    return { values: { messages }, config: tuple!.config }
  })
  await expect(f.graph.invoke({ messages: [new HumanMessage("new")] }, f.config))
    .rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  expect(f.native.invoke).not.toHaveBeenCalled()
})

it("rejects orphan native stamps without promoting them to ordinary history", async () => {
  const f = await legacyFixture({ messages: [new HumanMessage({ id: "claimed", content: "claim",
    additional_kwargs: { function_row: { conversationId: "claimed", branchId: "claimed",
      uuid: "claimed", sequence: 1, door: "note", messageType: "user", origin: { kind: "native" } } } })] })
  await expect(f.graph.invoke({ messages: [new HumanMessage("new")] }, f.config))
    .rejects.toThrow()
  expect(f.native.invoke).not.toHaveBeenCalled()
})

it("does not authenticate a mutated message merely because an exposed Saver cache contains it", async () => {
  const f = await legacyFixture()
  const config = await f.saver.put(f.config, { v: 1, id: "external-ordinary", ts: "2026-08-02T00:00:00Z",
    channel_values: { messages: f.oldMessages }, channel_versions: { messages: 2 }, versions_seen: {} },
  { source: "loop", step: 2, parents: {} })
  f.native.getState.mockImplementation(async () => {
    const tuple = await f.saver.getTuple(config)
    const messages = tuple!.checkpoint.channel_values.messages as BaseMessage[]
    messages[0].content = "forged cache content"
    return { values: { messages }, config: tuple!.config }
  })
  await expect(f.graph.invoke({ messages: [new HumanMessage("new")] }, config))
    .rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  expect(f.native.invoke).not.toHaveBeenCalled()
})

it.each(["scope", "source", "missing"])("refuses a changed legacy %s", async reason => {
  const f = await legacyFixture()
  if (reason === "scope") f.config.configurable!.thread_id = "other-thread"
  if (reason === "source") f.retire()
  if (reason === "missing") f.config.configurable!.checkpoint_id = "missing"
  await expect(f.graph.invoke({ messages: [new HumanMessage("new")] }, f.config)).rejects.toThrow()
  expect(f.native.invoke).not.toHaveBeenCalled()
})


it.each([
  "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "1ef65ac0-7777-6000-8000-000000000000",
  "z-old-non-temporal-id"
])("keeps new root checkpoints when upgrading an old ID %s", async checkpointId => {
  const f = await legacyFixture({ checkpointId })
  expect((await f.saver.getTuple({ configurable: { thread_id: f.config.configurable!.thread_id } }))
    ?.checkpoint.id).toBe(checkpointId)
  const next = await f.saver.put(f.config, { v: 1, id: "new-root", ts: "2026-08-02T00:00:00.000Z",
    channel_values: { messages: [...f.oldMessages, new HumanMessage("continue")] },
    channel_versions: { messages: 2 }, versions_seen: {} },
  { source: "loop", step: 2, parents: {} })
  const latest = { configurable: { thread_id: f.config.configurable!.thread_id } }
  expect((await f.saver.getTuple(latest))?.checkpoint.id).toBe("new-root")
  expect((await f.saver.getLatestRuntimeTuple(latest))?.checkpoint.id).toBe("new-root")
  expect((await f.saver.getTuple(next))?.checkpoint.channel_values.messages).toHaveLength(3)
  const listed: string[] = []
  for await (const tuple of f.saver.list(latest)) listed.push(tuple.checkpoint.id)
  expect(listed).toEqual(["new-root"])
})


it("does not let an unknown historical timestamp prune a new valid root", async () => {
  const f = await legacyFixture({ checkpointId: "z-malformed-old", timestamp: "not-a-time" })
  const next = await f.saver.put(f.config, { v: 1, id: "new-valid-root", ts: "2026-08-02T00:00:00.000Z",
    channel_values: { messages: f.oldMessages }, channel_versions: { messages: 2 }, versions_seen: {} },
  { source: "loop", step: 2, parents: {} })
  const latest = { configurable: { thread_id: f.config.configurable!.thread_id } }
  expect((await f.saver.getTuple(latest))?.checkpoint.id).toBe("new-valid-root")
  expect((await f.saver.getLatestRuntimeTuple(latest))?.checkpoint.id).toBe("new-valid-root")
  expect((await f.saver.getTuple(next))?.checkpoint.channel_values.messages).toHaveLength(2)
})


it.each(["same-connection", "external-connection"])(
  "expires a captured legacy tuple after a %s database change", async writer => {
    const f = await legacyFixture()
    const captured = await f.saver.getExactTupleForLegacyMigration(f.config)
    captured.assertCurrent()
    if (writer === "same-connection") {
      await f.saver.put(f.config, { v: 1, id: "replacement", ts: "2026-08-02T00:00:00.000Z",
        channel_values: { messages: f.oldMessages }, channel_versions: { messages: 2 }, versions_seen: {} },
      { source: "loop", step: 2, parents: {} })
    } else {
      const external = new DatabaseSync(f.path)
      external.prepare("DELETE FROM checkpoints WHERE checkpoint_id = ?")
        .run(f.config.configurable!.checkpoint_id)
      external.close()
    }
    expect(() => captured.assertCurrent()).toThrow("SQLJS_SAVER_LEGACY_CHECKPOINT_CHANGED")
  }
)
