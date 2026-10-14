import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import {
  AIMessage, HumanMessage, RemoveMessage, ToolMessage, type BaseMessage
} from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  readFunctionConversationTranscriptStamp,
  isFunctionConversationHiddenNote
} from "../../shared/mods/v2/conversation-transcript"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import {
  FunctionConversationStore,
  type FunctionConversationRow,
  type FunctionConversationTranscriptWriter
} from "../db/function-conversation-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import {
  FUNCTION_CONVERSATION_CHANNEL,
  FunctionConversationDeliveryBridge,
  readFunctionConversationState
} from "../checkpointer/function-conversation-delivery"
import {
  createFunctionConversationMiddleware,
  captureFunctionConversationTaskBinding,
  functionConversationNoteMessage,
  functionConversationState,
  isFunctionConversationModelBoundary,
  prepareFunctionConversationIntake,
  readFunctionConversationIntakePublication,
  type FunctionConversationMiddlewareHost,
  type FunctionConversationGraphBinding
} from "./mods-conversation"
import { wrapFunctionConversationInvocation } from "./mods-conversation-invocation"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

/** Local LangChain provider: its actual graph requests are recorded, with no network or model fee. */
class Provider extends BaseChatModel {
  readonly calls: BaseMessage[][] = []

  constructor(private readonly respond: (count: number) => AIMessage =
    (count) => new AIMessage({ id: `provider-${count}`, content: "local answer" })) {
    super({})
  }

  _llmType() { return "conversation-local-fixture" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push([...messages])
    const message = this.respond(this.calls.length)
    return { generations: [{ message, text: typeof message.content === "string" ? message.content : "" }] }
  }
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(options: {
  prepareNote?: FunctionConversationMiddlewareHost["prepareNote"]
  initialState?: boolean
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-conversation-graph-"))
  const db = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  db.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
  db.run("CREATE TABLE projection (uuid TEXT PRIMARY KEY, payload TEXT NOT NULL)")
  const token = randomUUID()
  db.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: token })])
  const store = new FunctionConversationStore(db)
  const target = store.ensureMain({ threadId: "thread", workspace: directory,
    incarnation: { token, legacyCreatedAt: 1000 }, checkpointNamespace: "" }, () => undefined)
  const controller = new AbortController()
  const saver = new SqlJsSaver(join(directory, "graph.sqlite"))
  const config = { configurable: { thread_id: "thread", checkpoint_ns: "" } }
  let live = true
  let admission: FunctionConversationGraphBinding["admission"]
  let forcedRuntimeNamespace: string | undefined
  const guard = () => {
    controller.signal.throwIfAborted()
    if (!live) throw Error("actual graph owner expired")
  }
  const write: FunctionConversationTranscriptWriter = (database, _target, row) => {
    expect(database).toBe(db)
    expect(database.inTransaction).toBe(true)
    database.run("INSERT INTO projection VALUES (?, ?)", [row.uuid, JSON.stringify(row.message)])
  }
  const verify: FunctionConversationTranscriptWriter = (database, _target, row) => {
    expect(database).toBe(db)
    expect(database.exec("SELECT payload FROM projection WHERE uuid = ?", [row.uuid])[0].values)
      .toEqual([[JSON.stringify(row.message)]])
  }
  const note = (text = "hidden literal /goal @file") => {
    const uuid = randomUUID()
    return store.commit(target, { uuid, inputDigest: `digest:${uuid}`, door: "note",
      origin: { kind: "plugin", name: "P" },
      message: { type: "user", role: "user", isMeta: true,
        content: [{ type: "text", text }] },
      nativePayload: serializeFunctionConversationNativeMessage(new HumanMessage({ id: uuid,
        content: [{ type: "text", text }], additional_kwargs: { isMeta: true } })),
      orderAnchor: { batch: "native-graph-batch" }, inbox: true, sdk: true },
    guard, write, verify)
  }
  const seenNamespaces: string[] = []
  const middleware = createFunctionConversationMiddleware({
    store, prepareNote: options.prepareNote,
    capture(runtime) {
      guard()
      expect(runtime.configurable?.thread_id).toBe(config.configurable.thread_id)
      // LangGraph supplies a task namespace and an actual parent checkpoint map.
      // The host graph config above fixes its parent; no string splitting derives that identity.
      const nativeMap = runtime.configurable?.checkpoint_map as Record<string, unknown> | undefined
      expect(typeof nativeMap?.[config.configurable.checkpoint_ns]).toBe("string")
      const namespace = runtime.configurable?.checkpoint_ns
      expect(typeof namespace).toBe("string")
      seenNamespaces.push(namespace as string)
      return { target, checkpointThreadId: config.configurable.thread_id,
        runtimeCheckpointNamespace: forcedRuntimeNamespace ?? namespace as string,
        signal: controller.signal, assertCurrent: guard,
        ...(options.initialState === false ? {} : { initialState: functionConversationState(target) }),
        ...(admission ? { admission } : {}) }
    }
  })
  const bridge = new FunctionConversationDeliveryBridge(store, (nativeConfig) => {
    expect(nativeConfig.configurable?.thread_id).toBe(config.configurable.thread_id)
    expect(nativeConfig.configurable?.checkpoint_ns ?? "").toBe(config.configurable.checkpoint_ns)
    return { target, checkpointThreadId: config.configurable.thread_id,
      signal: controller.signal, assertCurrent: guard }
  })
  cleanups.push(async () => {
    controller.abort()
    await saver.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { db, store, target, controller, saver, config, middleware, bridge, note, seenNamespaces,
    expire() { live = false },
    setAdmission(value: FunctionConversationGraphBinding["admission"]) { admission = value },
    setRuntimeNamespace(value: string) { forcedRuntimeNamespace = value },
    pending() { return db.exec("SELECT COUNT(*) FROM function_conversation_inbox")[0].values[0][0] }
  }
}

function kept(messages: readonly BaseMessage[]) {
  return messages.filter(isFunctionConversationHiddenNote)
}

function publicationInput(f: ReturnType<typeof fixture>) {
  return { store: f.store, target: f.target, state: functionConversationState(f.target),
    signal: f.controller.signal, publish: true,
    assertCurrent: () => f.controller.signal.throwIfAborted() }
}

describe("actual SQLite intake publication provenance", () => {
  it("keeps publication opt-in and never claims a delivery or starts a model", async () => {
    const f = fixture(), input = publicationInput(f)
    expect((await prepareFunctionConversationIntake(input, [])).publication).toBeUndefined()
    const row = f.note("only the actual admitted note")
    const legacy = await prepareFunctionConversationIntake({ ...input, publish: false }, [])
    expect(legacy.publication).toBeUndefined()
    const admitted = await prepareFunctionConversationIntake(input, [])
    if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    const read = readFunctionConversationIntakePublication(admitted.publication, f.store, f.target)
    expect(read.notes[0]).toBe(admitted.notes[0])
    expect(read.rows).toEqual([row])
    read.assertCurrent()
    expect(admitted.state.frontier).toBe(row.sequence)
    expect(f.pending()).toBe(1)
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values)
      .toEqual([[0]])
  })

  it("rejects copied publication brands and different actual Store or target objects", async () => {
    const f = fixture(), foreign = fixture()
    f.note()
    const admitted = await prepareFunctionConversationIntake(publicationInput(f), [])
    if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    const sameDatabaseStore = new FunctionConversationStore(f.db)
    for (const [publication, store, target] of [
      [{ ...admitted.publication }, f.store, f.target],
      [admitted.publication, sameDatabaseStore, f.target],
      [admitted.publication, f.store, { ...f.target }],
      [admitted.publication, foreign.store, foreign.target]
    ] as const) {
      expect(() => readFunctionConversationIntakePublication(publication, store, target))
        .toThrow("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
    }
    expect(f.pending()).toBe(1)
    expect(foreign.pending()).toBe(0)
  })

  it.each(["content", "metadata", "stamp"] as const)(
    "rejects changes to an actual published note's %s", async field => {
      const f = fixture(), row = f.note()
      const admitted = await prepareFunctionConversationIntake(publicationInput(f), [])
      if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
      const note = admitted.notes[0]
      if (field === "content") note.content = "changed after publication"
      else if (field === "metadata") note.response_metadata = { changed: true }
      else note.additional_kwargs = { ...note.additional_kwargs,
        function_row: { ...readFunctionConversationTranscriptStamp(note),
          origin: { kind: "plugin", name: "foreign" } } }
      expect(() => readFunctionConversationIntakePublication(admitted.publication!, f.store, f.target))
        .toThrow("MODS_CONVERSATION_INTAKE_PUBLICATION_INVALID")
      expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
      expect(f.pending()).toBe(1)
    }
  )

  it("rejects a prepared note content accessor without invoking it or minting a publication", async () => {
    const f = fixture(), row = f.note()
    let getters = 0
    const input = { ...publicationInput(f), prepareNote: async (
      actualRow: FunctionConversationRow, target: typeof f.target
    ) => {
      const note = functionConversationNoteMessage(actualRow, target)
      Object.defineProperty(note, "content", { configurable: true, enumerable: true,
        get() { getters += 1; return "must never execute" } })
      return note
    } }
    await expect(prepareFunctionConversationIntake(input, []))
      .rejects.toThrow("MODS_NATIVE_CAPTURE_ACCESSOR")
    expect(getters).toBe(0)
    expect(f.pending()).toBe(1)
    expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
  })

  it("keeps unmarked ordinary history without provider IDs usable before a published note", async () => {
    const f = fixture(), row = f.note("the actual new note")
    const user = new HumanMessage("legacy user without an ID")
    const assistant = new AIMessage("legacy assistant without a provider ID")
    expect(user.id).toBeUndefined()
    expect(assistant.id).toBeUndefined()
    const admitted = await prepareFunctionConversationIntake(publicationInput(f), [user, assistant])
    if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    expect(readFunctionConversationIntakePublication(admitted.publication, f.store, f.target)
      .rows.map(actual => actual.uuid)).toEqual([row.uuid])
    expect(user.id).toBeUndefined()
    expect(assistant.id).toBeUndefined()
    expect(readFunctionConversationTranscriptStamp(user)).toBeUndefined()
    expect(readFunctionConversationTranscriptStamp(assistant)).toBeUndefined()
    expect(f.pending()).toBe(1)
  })

  it("rejects a post-publication accessor before any raw getter or serializer executes", async () => {
    const f = fixture()
    f.note()
    const admitted = await prepareFunctionConversationIntake(publicationInput(f), [])
    if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    let getters = 0
    Object.defineProperty(admitted.notes[0], "content", { configurable: true, enumerable: true,
      get() { getters += 1; return "must never execute" } })
    expect(() => readFunctionConversationIntakePublication(admitted.publication!, f.store, f.target))
      .toThrow("MODS_NATIVE_CAPTURE_ACCESSOR")
    expect(getters).toBe(0)
    expect(f.pending()).toBe(1)
  })

  it.each(["source", "abort"] as const)(
    "preserves the original %s failure and leaves the actual inbox untouched", async mode => {
      const f = fixture(), failure = Error("ORIGINAL_NATIVE_SOURCE_CUT")
      f.note()
      let live = true
      const input = { ...publicationInput(f), assertCurrent: () => {
        if (!live) throw failure
      } }
      const admitted = await prepareFunctionConversationIntake(input, [])
      if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
      if (mode === "source") live = false
      else f.controller.abort(failure)
      expect(() => readFunctionConversationIntakePublication(admitted.publication!, f.store, f.target))
        .toThrow(failure)
      expect(f.pending()).toBe(1)
      expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values)
        .toEqual([[0]])
    }
  )

  it("does not expand an actual publication's high-water while native preparation is held", async () => {
    const f = fixture(), entered = deferred(), held = deferred(), first = f.note("captured")
    const pending = prepareFunctionConversationIntake({ ...publicationInput(f),
      prepareNote: async (row, target) => {
        entered.resolve()
        await held.promise
        return functionConversationNoteMessage(row, target)
      } }, [])
    await entered.promise
    const future = f.note("after the actual admission")
    held.resolve()
    const admitted = await pending
    if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    const read = readFunctionConversationIntakePublication(admitted.publication, f.store, f.target)
    expect(read.rows.map(row => row.uuid)).toEqual([first.uuid])
    expect(read.notes.map(note => note.id)).toEqual([first.uuid])
    expect(admitted.state.frontier).toBe(first.sequence)
    expect(f.store.captureInbox(f.target, 0).rows.map(row => row.uuid)).toEqual([first.uuid, future.uuid])
    expect(f.pending()).toBe(2)
  })

  it("keeps a real saved checkpoint cut separate from a future pending note publication", async () => {
    const f = fixture(), provider = new Provider(), first = f.note("in the exact saved checkpoint")
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await agent.invoke({ messages: [new HumanMessage("actual first turn")] }, f.config)
    const saved = await agent.graph.getState(f.config)
    const checkpointId = saved.config?.configurable?.checkpoint_id
    if (typeof checkpointId !== "string") throw Error("ACTUAL_SAVED_CHECKPOINT_REQUIRED")
    const proof = f.store.readCheckpointRecoverySnapshot(f.target, {
      checkpointThreadId: f.config.configurable.thread_id, checkpointIncarnation: f.target.incarnation,
      checkpointId
    }, () => f.controller.signal.throwIfAborted()).snapshot
    const future = f.note("pending after the exact checkpoint")
    const old = await prepareFunctionConversationIntake({ ...publicationInput(f),
      state: readFunctionConversationState(saved.values[FUNCTION_CONVERSATION_CHANNEL]),
      highWater: proof.cut.highWater }, saved.values.messages)
    expect(old.notes).toEqual([])
    expect(old.publication).toBeUndefined()
    expect(old.state.frontier).toBe(first.sequence)
    const current = await prepareFunctionConversationIntake({ ...publicationInput(f),
      state: old.state }, saved.values.messages)
    if (!current.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    expect(readFunctionConversationIntakePublication(current.publication, f.store, f.target)
      .rows.map(row => row.uuid)).toEqual([future.uuid])
    expect(kept(saved.values.messages).map(message => message.id)).toEqual([first.uuid])
    expect(provider.calls).toHaveLength(1)
    expect(f.pending()).toBe(1)
  })

  it("keeps the publication's original creation-time cut when a newer note exists", async () => {
    const f = fixture(), clock = vi.spyOn(Date, "now").mockReturnValue(1000)
    const first = f.note("before the actual time cut")
    clock.mockReturnValue(2000)
    const future = f.note("after the actual time cut")
    const admitted = await prepareFunctionConversationIntake({ ...publicationInput(f),
      notAfterCreatedAt: 1500 }, [])
    if (!admitted.publication) throw Error("ACTUAL_PUBLICATION_REQUIRED")
    const read = readFunctionConversationIntakePublication(admitted.publication, f.store, f.target)
    expect(read.rows.map(row => row.uuid)).toEqual([first.uuid])
    expect(admitted.state.frontier).toBe(first.sequence)
    clock.mockReturnValue(3000)
    read.assertCurrent()
    expect(read.rows.map(row => row.uuid)).not.toContain(future.uuid)
    expect(f.pending()).toBe(2)
  })
})

describe("function conversation actual graph/checkpoint intake", () => {
  it("keeps the original ordinary graph usable without a loaded conversation binding", async () => {
    const f = fixture(), provider = new Provider()
    const assertCurrent = vi.spyOn(f.store, "assertCurrent")
    const highWater = vi.spyOn(f.store, "highWater")
    const middleware = createFunctionConversationMiddleware({ store: f.store,
      capture: () => undefined })
    const agent = createAgent({ model: provider, tools: [], middleware: [middleware] })
    await agent.invoke({ messages: [new HumanMessage("ordinary old chat")] }, f.config)
    expect(provider.calls).toHaveLength(1)
    expect(assertCurrent).not.toHaveBeenCalled()
    expect(highWater).not.toHaveBeenCalled()
  })

  it("refuses an actual retained conversation channel without its original binding before a model", async () => {
    const f = fixture(), provider = new Provider(), row = f.note("original saved note")
    const middleware = createFunctionConversationMiddleware({ store: f.store,
      capture: () => undefined })
    const agent = createAgent({ model: provider, tools: [], middleware: [middleware] })
    await expect(agent.invoke({ messages: [new HumanMessage("ordinary input")],
      [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(f.target) }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_UNAVAILABLE")
    expect(provider.calls).toHaveLength(0)
    expect(f.store.captureInbox(f.target, 0).rows.map(item => item.uuid)).toEqual([row.uuid])
  })

  it.each(["direct", "reader"] as const)(
    "cancels actual %s streamEvents during held native getState with zero provider calls", async mode => {
      const f = fixture(), provider = new Provider(), caller = new AbortController()
      const binding: FunctionConversationGraphBinding = { target: f.target,
        checkpointThreadId: f.config.configurable.thread_id, runtimeCheckpointNamespace: "",
        signal: f.controller.signal, initialState: functionConversationState(f.target),
        assertCurrent: () => f.controller.signal.throwIfAborted() }
      const native = createAgent({ model: provider, tools: [], middleware: [f.middleware],
        checkpointer: f.bridge.wrap(f.saver) })
      const readState = native.graph.getState.bind(native.graph)
      const entered = deferred(), held = deferred()
      let captured: AbortSignal | undefined
      vi.spyOn(native.graph, "getState").mockImplementation(async config => {
        const snapshot = await readState(config)
        captured = config.signal
        entered.resolve()
        await held.promise
        return snapshot
      })
      const agent = wrapFunctionConversationInvocation(native, { store: f.store, binding })
      const events = agent.streamEvents({ messages: [new HumanMessage("actual cancelled user")] },
        { ...f.config, version: "v2", signal: caller.signal })
      const reader = mode === "reader" ? events.getReader() : undefined
      const read = reader?.read()
      await entered.promise
      const cancelled = reader ? reader.cancel("actual reader stop") : events.cancel("actual stop")
      expect(captured?.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
      expect(f.controller.signal.aborted).toBe(false)
      expect(provider.calls).toHaveLength(0)
      const terminal: unknown = Reflect.get(events, FUNCTION_STREAM_TERMINAL)
      if (!(terminal instanceof Promise)) throw Error("ACTUAL_EVENT_TERMINAL_REQUIRED")
      let settled = false
      void terminal.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      held.resolve()
      await cancelled
      if (read) expect(await read).toEqual({ done: true, value: undefined })
      await terminal
      expect(settled).toBe(true)
      expect(provider.calls).toHaveLength(0)
    }
  )

  it.each(["invoke", "stream", "streamEvents"] as const)(
    "uses the actual production %s adapter to put notes before the explicit user", async method => {
      const f = fixture(), row = f.note("actual invocation adapter"), provider = new Provider()
      const binding: FunctionConversationGraphBinding = { target: f.target,
        checkpointThreadId: f.config.configurable.thread_id, runtimeCheckpointNamespace: "",
        signal: f.controller.signal, initialState: functionConversationState(f.target),
        assertCurrent: () => f.controller.signal.throwIfAborted() }
      const middleware = createFunctionConversationMiddleware({ store: f.store,
        capture: runtime => captureFunctionConversationTaskBinding(runtime, binding) })
      const native = createAgent({ model: provider, tools: [], middleware: [middleware],
        checkpointer: f.bridge.wrap(f.saver) })
      const agent = wrapFunctionConversationInvocation(native, { store: f.store, binding })
      expect(provider.calls).toHaveLength(0)
      const user = new HumanMessage({ id: "actual-adapter-user", content: "new explicit user" })
      if (method === "streamEvents") {
        const events = agent.streamEvents({ messages: [user] }, { ...f.config, version: "v2" })
        expect(typeof events.getReader).toBe("function")
        for await (const _event of events) {
          void _event
          // Drain actual event-level streaming without changing its native ReadableStream shape.
        }
      } else if (method === "stream") {
        for await (const _chunk of await agent.stream({ messages: [user] }, f.config)) {
          void _chunk
          // Drain the real graph through its actual checkpoint observer.
        }
      } else await agent.invoke({ messages: [user] }, f.config)
      expect(provider.calls).toHaveLength(1)
      expect(provider.calls[0].slice(0, 2).map(message => message.id)).toEqual([row.uuid, user.id])
      expect(f.pending()).toBe(0)
      const state = await native.graph.getState(f.config)
      expect(state.values[FUNCTION_CONVERSATION_CHANNEL]).toEqual(functionConversationState(f.target, 1))
      await agent.invoke({ messages: [new HumanMessage("second real turn")] }, f.config)
      expect(provider.calls).toHaveLength(2)
      expect(kept(provider.calls[1]).map(message => message.id)).toEqual([row.uuid])
    }
  )
  it("puts idle notes before the new explicit user in the same actual graph input and checkpoint", async () => {
    const f = fixture(), row = f.note("idle pending note"), provider = new Provider()
    const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.target,
      state: functionConversationState(f.target), signal: f.controller.signal,
      assertCurrent: () => f.controller.signal.throwIfAborted() }, [])
    expect(provider.calls).toHaveLength(0)
    expect(f.pending()).toBe(1)
    const user = new HumanMessage({ id: "real-new-user", content: "new user input" })
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await agent.invoke({ messages: [...intake.notes, user],
      [FUNCTION_CONVERSATION_CHANNEL]: intake.state }, f.config)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].slice(0, 2).map(message => message.id)).toEqual([row.uuid, user.id])
    const saved = await agent.graph.getState(f.config)
    const tuple = await f.saver.getTuple(saved.config)
    expect(tuple?.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
      .toEqual(functionConversationState(f.target, 1))
    const messages = tuple?.checkpoint.channel_values.messages as BaseMessage[]
    expect(messages.slice(0, 2).map(message => message.id)).toEqual([row.uuid, user.id])
    expect(f.pending()).toBe(0)
  })

  it("keeps literal note and frontier in one real graph checkpoint before the provider request", async () => {
    const f = fixture(), row = f.note(), provider = new Provider()
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    const result = await agent.invoke({ messages: [new HumanMessage("explicit user")] }, f.config)
    expect(provider.calls).toHaveLength(1)
    const received = kept(provider.calls[0])
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe(row.uuid)
    expect(received[0].content).toEqual([{ type: "text", text: "hidden literal /goal @file" }])
    expect(readFunctionConversationTranscriptStamp(received[0])?.origin)
      .toEqual({ kind: "plugin", name: "P" })
    expect(kept(result.messages).map(message => message.id)).toEqual([row.uuid])
    const actual = await agent.graph.getState(f.config)
    const tuple = await f.saver.getTuple(actual.config)
    expect(tuple?.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
      .toEqual(functionConversationState(f.target, 1))
    const persisted = tuple?.checkpoint.channel_values.messages as BaseMessage[]
    expect(kept(persisted).map(message => message.id)).toEqual([row.uuid])
    expect(f.pending()).toBe(0)
    expect(f.seenNamespaces[0]).not.toBe(f.target.checkpointNamespace)
    expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
  })

  it("saving after a completed turn makes no model request and the next explicit turn consumes once", async () => {
    const f = fixture(), provider = new Provider()
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await agent.invoke({ messages: [new HumanMessage("first")] }, f.config)
    const row = f.note("after completed answer")
    await Promise.resolve()
    expect(provider.calls).toHaveLength(1)
    expect(f.pending()).toBe(1)
    await agent.invoke({ messages: [new HumanMessage("second")] }, f.config)
    await agent.invoke({ messages: [new HumanMessage("third")] }, f.config)
    expect(provider.calls).toHaveLength(3)
    expect(kept(provider.calls[1]).map(message => message.id)).toEqual([row.uuid])
    expect(kept(provider.calls[2]).map(message => message.id)).toEqual([row.uuid])
    expect(f.store.readRows(f.target)).toHaveLength(1)
    expect(f.pending()).toBe(0)
  })

  it("takes a note after the actual tool result at the next natural model request without jumping", async () => {
    const f = fixture()
    let row: FunctionConversationRow | undefined
    const nativeTool = tool(async () => {
      row = f.note("during real tool")
      return "actual tool result"
    }, { name: "local_tool", description: "local fixture", schema: z.object({}) })
    const provider = new Provider(count => count === 1
      ? new AIMessage({ id: "provider-tool", content: "", tool_calls: [
        { id: "tool-1", name: "local_tool", args: {} }
      ] }) : new AIMessage({ id: "provider-final", content: "done" }))
    const agent = createAgent({ model: provider, tools: [nativeTool], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await agent.invoke({ messages: [new HumanMessage("run local tool")] }, f.config)
    expect(provider.calls).toHaveLength(2)
    expect(kept(provider.calls[0])).toEqual([])
    const second = provider.calls[1]
    const call = second.findIndex(message => message.id === "provider-tool")
    const result = second.findIndex(message => ToolMessage.isInstance(message) &&
      message.tool_call_id === "tool-1")
    const note = second.findIndex(message => message.id === row?.uuid)
    expect(call).toBeGreaterThanOrEqual(0)
    expect(result).toBeGreaterThan(call)
    expect(note).toBeGreaterThan(result)
    expect(f.pending()).toBe(0)
  })

  it("advances only the recovery-time prefix and leaves future rows for a later genuine request", async () => {
    const f = fixture(), provider = new Provider()
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000)
    const first = f.note("old note")
    clock.mockReturnValue(2000)
    const future = f.note("future note")
    clock.mockRestore()
    f.setAdmission({ highWater: 2, notAfterCreatedAt: 1500 })
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await agent.invoke({ messages: [new HumanMessage("restore boundary")] }, f.config)
    expect(kept(provider.calls[0]).map(message => message.id)).toEqual([first.uuid])
    expect(f.pending()).toBe(1)
    const actual = await agent.graph.getState(f.config)
    expect(readFunctionConversationState(actual.values[FUNCTION_CONVERSATION_CHANNEL]).frontier).toBe(1)
    f.setAdmission(undefined)
    await agent.invoke({ messages: [new HumanMessage("new actual turn")] }, f.config)
    expect(kept(provider.calls[1]).map(message => message.id)).toEqual([first.uuid, future.uuid])
    expect(f.pending()).toBe(0)
  })

  it("a note committed after the captured high-water stays pending until the next request", async () => {
    const gate = deferred(), entered = deferred()
    const f = fixture({ prepareNote: async (row, target) => {
      entered.resolve()
      await gate.promise
      return functionConversationNoteMessage(row, target)
    } })
    const first = f.note("captured"), provider = new Provider()
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    const pending = agent.invoke({ messages: [new HumanMessage("first turn")] }, f.config)
    await entered.promise
    const late = f.note("arrived during preparation")
    gate.resolve()
    await pending
    expect(kept(provider.calls[0]).map(message => message.id)).toEqual([first.uuid])
    expect(f.pending()).toBe(1)
    await agent.invoke({ messages: [new HumanMessage("second turn")] }, f.config)
    expect(kept(provider.calls[1]).map(message => message.id)).toEqual([first.uuid, late.uuid])
    expect(f.pending()).toBe(0)
  })

  it("does not reinsert an intentionally removed note when its actual checkpoint frontier survives", async () => {
    const f = fixture(), row = f.note(), provider = new Provider()
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await agent.invoke({ messages: [new HumanMessage("first turn")] }, f.config)
    await agent.graph.updateState(f.config, { messages: [new RemoveMessage({ id: row.uuid })] })
    await agent.invoke({ messages: [new HumanMessage("after compaction")] }, f.config)
    expect(kept(provider.calls[1])).toEqual([])
    const state = await agent.graph.getState(f.config)
    expect(readFunctionConversationState(state.values[FUNCTION_CONVERSATION_CHANNEL]).frontier).toBe(1)
    expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
  })

  it("rejects an expired actual owner during note preparation with no provider or delivery ACK", async () => {
    const gate = deferred(), entered = deferred()
    const f = fixture({ prepareNote: async (row, target) => {
      entered.resolve()
      await gate.promise
      return functionConversationNoteMessage(row, target)
    } })
    f.note()
    const provider = new Provider()
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    const pending = agent.invoke({ messages: [new HumanMessage("actual input")] }, f.config)
    const rejected = expect(pending).rejects.toThrow("actual graph owner expired")
    await entered.promise
    f.expire()
    gate.resolve()
    await rejected
    expect(provider.calls).toHaveLength(0)
    expect(f.pending()).toBe(1)
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values[0][0]).toBe(0)
  })

  it("does not silently migrate a legacy checkpoint without a host-verified initial state", async () => {
    const f = fixture({ initialState: false }), provider = new Provider()
    f.note()
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await expect(agent.invoke({ messages: [new HumanMessage("legacy input")] }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(provider.calls).toHaveLength(0)
    expect(f.pending()).toBe(1)
  })

  it("pins the original task namespace instead of accepting a different same-thread node", async () => {
    const f = fixture(), provider = new Provider()
    f.setRuntimeNamespace("foreign-node:actual-other-task")
    const agent = createAgent({ model: provider, tools: [], middleware: [f.middleware],
      checkpointer: f.bridge.wrap(f.saver) })
    await expect(agent.invoke({ messages: [new HumanMessage("input")] }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    expect(provider.calls).toHaveLength(0)
  })

  it("leaves an incomplete or duplicated actual tool batch closed to note intake", () => {
    const ai = new AIMessage({ content: "", tool_calls: [
      { id: "tool-a", name: "a", args: {} }, { id: "tool-b", name: "b", args: {} }
    ] })
    const a = new ToolMessage({ content: "a", tool_call_id: "tool-a" })
    const b = new ToolMessage({ content: "b", tool_call_id: "tool-b" })
    expect(isFunctionConversationModelBoundary([ai, a])).toBe(false)
    expect(isFunctionConversationModelBoundary([ai, a, b])).toBe(true)
    expect(isFunctionConversationModelBoundary([ai, a, a, b])).toBe(false)
    const duplicate = new AIMessage({ content: "", tool_calls: [
      { id: "tool-a", name: "a", args: {} }, { id: "tool-a", name: "b", args: {} }
    ] })
    expect(isFunctionConversationModelBoundary([duplicate, a])).toBe(false)
  })
})
