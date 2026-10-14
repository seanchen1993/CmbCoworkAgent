import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { createAgent } from "langchain"
import { afterEach, describe, expect, it } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import {
  isFunctionConversationHiddenNote,
  readFunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import {
  FunctionConversationStore,
  type FunctionConversationRef,
  type FunctionConversationTranscriptWriter
} from "../db/function-conversation-store"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import {
  markActualCompletedConversationBoundary,
  productionMainCheckpointOptions
} from "../checkpointer/function-conversation-runtime.test-fixture"
import {
  FUNCTION_CONVERSATION_CHANNEL,
  FunctionConversationDeliveryBridge,
  readFunctionConversationState
} from "../checkpointer/function-conversation-delivery"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation
} from "../services/thread-incarnation"
import {
  createFunctionConversationMiddleware,
  functionConversationState,
  prepareFunctionConversationIntake
} from "./mods-conversation"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

/** Actual LangChain requests through createAgent; no HTTP, external provider or model fee. */
class LocalProvider extends BaseChatModel {
  readonly calls: BaseMessage[][] = []
  private readonly generation = randomUUID()

  constructor() {
    super({})
  }

  _llmType() {
    return "conversation-restart-local"
  }

  bindTools(): this {
    return this
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push([...messages])
    const message = new AIMessage({
      id: `${this.generation}:${this.calls.length}`,
      content: "actual local graph answer"
    })
    return { generations: [{ message, text: "actual local graph answer" }] }
  }
}

function messageRows(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw new TypeError("Actual checkpoint messages are required")
  return value
}

function exactConfig(config: RunnableConfig): RunnableConfig {
  const facts = config.configurable
  if (facts?.thread_id !== "thread" || facts.checkpoint_ns !== "" ||
    typeof facts.checkpoint_id !== "string" || !facts.checkpoint_id)
    throw new TypeError("Actual completed root checkpoint config is required")
  return { configurable: {
    thread_id: facts.thread_id,
    checkpoint_ns: facts.checkpoint_ns,
    checkpoint_id: facts.checkpoint_id
  } }
}

function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-conversation-restart-"))
  const appPath = join(directory, "app.sqlite")
  const graphPath = join(directory, "graph.sqlite")
  const generations: Array<{ close(): Promise<void> }> = []
  const baseConfig: RunnableConfig = { configurable: { thread_id: "thread", checkpoint_ns: "" } }

  const open = () => {
    const db = openNativeSqliteDatabase(appPath).database
    db.run("CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
    // A strict synchronous transcript writer seam, not an in-memory conversation backend.
    // The full application's thread_messages adapter is covered by its separate integration suite.
    db.run("CREATE TABLE IF NOT EXISTS projection (uuid TEXT PRIMARY KEY, payload TEXT NOT NULL, native_payload TEXT NOT NULL)")
    const readThread = () => {
      const row = db.exec("SELECT created_at, metadata FROM threads WHERE thread_id = ?", ["thread"])[0]?.values[0]
      if (!row || typeof row[0] !== "number" || typeof row[1] !== "string")
        throw new TypeError("Actual persisted thread identity is required")
      return { created_at: row[0], metadata: row[1] }
    }
    if (!db.exec("SELECT 1 FROM threads WHERE thread_id = ?", ["thread"])[0]?.values.length)
      db.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1000,
        JSON.stringify({ cmb_thread_incarnation: randomUUID() })])
    const incarnation = captureThreadIncarnation(readThread())
    expect(incarnation.token).toBeTypeOf("string")
    const controller = new AbortController()
    let closed = false
    const guard = () => {
      controller.signal.throwIfAborted()
      if (closed || !matchesThreadIncarnation(readThread(), incarnation))
        throw new Error("Actual database generation expired")
    }
    const store = new FunctionConversationStore(db)
    const target = store.ensureMain({ threadId: "thread", workspace: directory,
      incarnation, checkpointNamespace: "" }, guard)
    const saver = new SqlJsSaver(graphPath, undefined, productionMainCheckpointOptions())
    const write: FunctionConversationTranscriptWriter = (actual, _target, row) => {
      expect(actual).toBe(db)
      expect(actual.inTransaction).toBe(true)
      actual.run("INSERT INTO projection VALUES (?, ?, ?)",
        [row.uuid, JSON.stringify(row.message), row.nativePayload])
    }
    const verify: FunctionConversationTranscriptWriter = (actual, _target, row) => {
      expect(actual).toBe(db)
      expect(actual.exec("SELECT payload, native_payload FROM projection WHERE uuid = ?", [row.uuid])[0]?.values)
        .toEqual([[JSON.stringify(row.message), row.nativePayload]])
    }
    const commit = (destination: FunctionConversationRef, text: string, notice = false) => {
      const uuid = randomUUID()
      const message: ModObject = notice
        ? { type: "system", content: [{ type: "text", text }] }
        : { type: "user", role: "user", isMeta: true, content: [{ type: "text", text }] }
      return store.commit(destination, {
        uuid, inputDigest: `actual-input:${uuid}`, door: notice ? "notice" : "note",
        origin: { kind: "plugin", name: "P" }, message,
        nativePayload: serializeFunctionConversationNativeMessage(notice ?
          new SystemMessage({ id: uuid, content: [{ type: "text", text }] }) :
          new HumanMessage({ id: uuid, content: [{ type: "text", text }],
            additional_kwargs: { isMeta: true } })),
        orderAnchor: { batch: "actual-graph-boundary" }, inbox: !notice, sdk: !notice
      }, guard, write, verify)
    }
    const close = async () => {
      if (closed) return
      closed = true
      controller.abort(new Error("Actual database generation closed"))
      try {
        await saver.close()
      } finally {
        db.close()
      }
    }
    generations.push({ close })
    return { db, store, target, saver, controller, guard, commit, close }
  }
  cleanups.push(async () => {
    try {
      for (const generation of generations.reverse()) await generation.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return { open, baseConfig }
}

type DatabaseGeneration = ReturnType<ReturnType<typeof databaseFixture>["open"]>

function actualGraph(generation: DatabaseGeneration, target = generation.target) {
  const provider = new LocalProvider()
  const middleware = createFunctionConversationMiddleware({
    store: generation.store,
    capture(runtime) {
      generation.guard()
      generation.store.assertCurrent(target)
      expect(runtime.configurable?.thread_id).toBe(target.threadId)
      const parentMap = runtime.configurable?.checkpoint_map as Record<string, unknown> | undefined
      expect(typeof parentMap?.[target.checkpointNamespace]).toBe("string")
      const namespace = runtime.configurable?.checkpoint_ns
      if (typeof namespace !== "string") throw new TypeError("Actual task namespace is required")
      return { target, checkpointThreadId: target.threadId, runtimeCheckpointNamespace: namespace,
        signal: generation.controller.signal, assertCurrent: generation.guard }
    }
  })
  const bridge = new FunctionConversationDeliveryBridge(generation.store, (config) => {
    generation.guard()
    expect(config.configurable?.thread_id).toBe(target.threadId)
    expect(config.configurable?.checkpoint_ns ?? "").toBe(target.checkpointNamespace)
    return { target, checkpointThreadId: target.threadId,
      signal: generation.controller.signal, assertCurrent: generation.guard }
  })
  const protectedSaver = bridge.wrap(generation.saver)
  const committed: RunnableConfig[] = []
  // Record only the config returned after the real native put and private delivery ACK.
  // Neither values events nor a hand-built checkpoint enters the receipt list.
  const checkpointer = new Proxy(protectedSaver, { get(actual, key) {
    if (key === "put") return async (
      config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata
    ) => {
      const saved = await actual.put(config, checkpoint, metadata)
      committed.push(exactConfig(saved))
      return saved
    }
    const value: unknown = Reflect.get(actual, key, actual)
    return typeof value === "function" ? value.bind(actual) : value
  } })
  const agent = createAgent({ model: provider, tools: [], middleware: [middleware], checkpointer })
  return { generation, target, provider, agent, committed }
}

type ActualGraph = ReturnType<typeof actualGraph>

async function committedCheckpoint(graph: ActualGraph) {
  const config = graph.committed.at(-1)
  if (!config) throw new TypeError("An actual graph put must complete first")
  const tuple = await graph.generation.saver.getTuple(config)
  if (!tuple || tuple.checkpoint.id !== config.configurable?.checkpoint_id)
    throw new TypeError("The exact committed checkpoint must exist")
  const messages = messageRows(tuple.checkpoint.channel_values.messages)
  const state = readFunctionConversationState(tuple.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
  expect(state.logicalSessionId).toBe(graph.target.logicalSessionId)
  expect(state.conversationId).toBe(graph.target.conversationId)
  expect(state.branchId).toBe(graph.target.branchId)
  expect(graph.generation.db.exec(`SELECT frontier FROM function_conversation_deliveries
    WHERE conversation_id = ? AND branch_id = ? AND checkpoint_id = ?`, [
    graph.target.conversationId, graph.target.branchId, tuple.checkpoint.id
  ])[0]?.values).toEqual([[state.frontier]])
  return { config, tuple, messages, state }
}

async function explicitTurn(graph: ActualGraph, config: RunnableConfig, text: string) {
  graph.generation.guard()
  const calls = graph.provider.calls.length
  const checkpointId = config.configurable?.checkpoint_id
  const tuple = checkpointId === undefined ? undefined : await graph.generation.saver.getTuple(config)
  if (checkpointId !== undefined && tuple?.checkpoint.id !== checkpointId)
    throw new TypeError("An exact resume checkpoint is required")
  const state = tuple
    ? readFunctionConversationState(tuple.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
    : functionConversationState(graph.target)
  const before = tuple ? messageRows(tuple.checkpoint.channel_values.messages) : []
  const intake = await prepareFunctionConversationIntake({
    store: graph.generation.store, target: graph.target, state,
    signal: graph.generation.controller.signal, assertCurrent: graph.generation.guard
  }, before)
  expect(graph.provider.calls).toHaveLength(calls)
  const user = new HumanMessage({ id: randomUUID(), content: text })
  await graph.agent.invoke({ messages: [...intake.notes, user],
    [FUNCTION_CONVERSATION_CHANNEL]: intake.state }, config)
  expect(graph.provider.calls).toHaveLength(calls + 1)
  const saved = await committedCheckpoint(graph)
  await markActualCompletedConversationBoundary({
    saver: graph.generation.saver, config: saved.config,
    controller: graph.generation.controller, assertCurrent: graph.generation.guard
  })
  for (const note of intake.notes) {
    const noteIndex = graph.provider.calls[calls].findIndex(row => row.id === note.id)
    const userIndex = graph.provider.calls[calls].findIndex(row => row.id === user.id)
    expect(noteIndex).toBeGreaterThanOrEqual(0)
    expect(userIndex).toBeGreaterThan(noteIndex)
  }
  return { ...saved, user }
}

function noteIds(messages: BaseMessage[]) {
  return messages.filter(isFunctionConversationHiddenNote).map(row => row.id)
}

describe("function conversation durable restart and exact graph branch foundations", () => {
  it("reopens both real SQLite files and consumes the pending note once before the new user", async () => {
    const f = databaseFixture(), first = f.open(), graph = actualGraph(first)
    const a = first.commit(first.target, "already kept A")
    const cpA = await explicitTurn(graph, f.baseConfig, "first real user")
    expect(noteIds(cpA.messages)).toEqual([a.uuid])
    expect(cpA.state.frontier).toBe(a.sequence)
    const b = first.commit(first.target, "pending B before shutdown")
    const notice = first.commit(first.target, "NOTICE_NEVER_MODEL", true)
    expect(graph.provider.calls).toHaveLength(1)
    expect(first.db.exec("SELECT COUNT(*) FROM function_conversation_inbox")[0].values).toEqual([[1]])
    await first.close()
    expect(() => first.guard()).toThrow("Actual database generation closed")

    const second = f.open(), resumed = actualGraph(second)
    expect(Object.is(second.db, first.db)).toBe(false)
    expect(Object.is(second.saver, first.saver)).toBe(false)
    expect(Object.is(second.store, first.store)).toBe(false)
    expect(second.target).toEqual(first.target)
    expect(second.store.readReceipt(second.target, b.uuid)).toEqual(b)
    expect(second.store.readReceipt(second.target, notice.uuid)).toEqual(notice)
    const cpB = await explicitTurn(resumed, cpA.config, "new user after actual reopen")
    expect(resumed.provider.calls).toHaveLength(1)
    expect(noteIds(resumed.provider.calls[0])).toEqual([a.uuid, b.uuid])
    expect(noteIds(cpB.messages)).toEqual([a.uuid, b.uuid])
    expect(cpB.state.frontier).toBe(notice.sequence)
    expect(JSON.stringify(resumed.provider.calls)).not.toContain("NOTICE_NEVER_MODEL")
    expect(readFunctionConversationTranscriptStamp(cpB.messages.find(row => row.id === b.uuid)))
      .toMatchObject({ uuid: b.uuid, sequence: b.sequence, branchId: second.target.branchId,
        messageType: "user", isMeta: true, origin: { kind: "plugin", name: "P" } })
    expect(second.db.exec("SELECT COUNT(*) FROM function_conversation_inbox")[0].values).toEqual([[0]])
    await second.close()

    const third = f.open(), again = actualGraph(third)
    expect(third.target).toEqual(first.target)
    const cpC = await explicitTurn(again, cpB.config, "third real user after another reopen")
    expect(noteIds(again.provider.calls[0])).toEqual([a.uuid, b.uuid])
    expect(noteIds(cpC.messages)).toEqual([a.uuid, b.uuid])
    expect(cpC.state.frontier).toBe(notice.sequence)
    expect(third.store.readRows(third.target).map(row => row.uuid)).toEqual([a.uuid, b.uuid, notice.uuid])
    expect(third.db.exec("SELECT COUNT(*) FROM projection")[0].values).toEqual([[3]])
  })

  it("forks the actual old graph checkpoint without reading future parent or sibling notes", async () => {
    // This is a same-thread checkpoint branch; the application's new-thread UI fork is separate.
    const f = databaseFixture(), generation = f.open(), parent = actualGraph(generation)
    const a = generation.commit(parent.target, "shared history A")
    const cpA = await explicitTurn(parent, f.baseConfig, "first parent user")
    const b = generation.commit(parent.target, "future parent B")
    const cpB = await explicitTurn(parent, cpA.config, "later parent user")
    expect(noteIds(cpB.messages)).toEqual([a.uuid, b.uuid])
    const old = await generation.saver.getTuple(cpA.config)
    expect(old?.checkpoint.id).toBe(cpA.tuple.checkpoint.id)
    expect(noteIds(messageRows(old?.checkpoint.channel_values.messages))).toEqual([a.uuid])
    const branch = generation.store.forkBranch(parent.target, {
      parentFrontier: cpA.state.frontier, checkpointId: cpA.tuple.checkpoint.id
    }, generation.guard)
    expect(branch.conversationId).toBe(parent.target.conversationId)
    expect(branch.branchId).not.toBe(parent.target.branchId)
    const child = actualGraph(generation, branch)
    const branchState = functionConversationState(branch, cpA.state.frontier)
    // A real graph identity update leaves messages intact and does not pretend a note was consumed.
    const forkConfig = await child.agent.graph.updateState(cpA.config, {
      [FUNCTION_CONVERSATION_CHANNEL]: branchState
    })
    const migrated = await generation.saver.getTuple(forkConfig)
    expect(migrated?.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]).toEqual(branchState)
    expect(noteIds(messageRows(migrated?.checkpoint.channel_values.messages))).toEqual([a.uuid])
    expect(child.provider.calls).toHaveLength(0)
    expect(parent.provider.calls).toHaveLength(2)
    const c = generation.commit(branch, "branch-only C")
    const cpChild = await explicitTurn(child, exactConfig(forkConfig), "branch user")
    expect(noteIds(child.provider.calls[0])).toEqual([a.uuid, c.uuid])
    expect(noteIds(cpChild.messages)).toEqual([a.uuid, c.uuid])
    expect(cpChild.state).toEqual(functionConversationState(branch, c.sequence))
    expect(JSON.stringify(child.provider.calls)).not.toContain("future parent B")
    expect(generation.store.readRows(branch).map(row => row.uuid)).toEqual([a.uuid, c.uuid])
    expect(generation.store.readRows(parent.target).map(row => row.uuid)).toEqual([a.uuid, b.uuid])

    // The parent's exact cpB remains the starting point even after the child saved a newer checkpoint.
    const cpParent = await explicitTurn(parent, cpB.config, "parent continues independently")
    expect(noteIds(parent.provider.calls[2])).toEqual([a.uuid, b.uuid])
    expect(noteIds(cpParent.messages)).toEqual([a.uuid, b.uuid])
    expect(JSON.stringify(parent.provider.calls[2])).not.toContain("branch-only C")
    expect(cpParent.state.branchId).toBe(parent.target.branchId)
    expect(cpParent.state.frontier).toBe(c.sequence)
    expect(readFunctionConversationTranscriptStamp(cpChild.messages.find(row => row.id === c.uuid)))
      .toMatchObject({ uuid: c.uuid, branchId: branch.branchId, sequence: c.sequence })
    expect(generation.db.exec("SELECT COUNT(*) FROM function_conversation_inbox")[0].values).toEqual([[0]])
    expect(generation.db.exec("SELECT COUNT(*) FROM projection")[0].values).toEqual([[3]])
  })
})
