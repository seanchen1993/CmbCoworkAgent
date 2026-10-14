import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { createAgent } from "langchain"
import ts from "typescript"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  assertCurrentRunMessagesDurablyPersisted,
  captureCurrentRunMessageQueueOwner,
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  getCurrentRunInjectedMessageIds,
  isCurrentRunMessageQueueOwner,
  peekCurrentRunMessageQueue,
  queueCurrentRunMessage,
  readCurrentRunCanonicalAssistantCompletion,
  registerCurrentRunCanonicalAssistantCompletion,
  registerCurrentRunCompletedAssistantRoute,
  resolveCurrentRunCompletedAssistantIdentity,
  resolveCurrentRunInjectionAnchorId,
  setCurrentRunInjectionNotifier,
  setCurrentRunMessageQueueOwner,
  type CurrentRunInjectionNotifier
} from "./current-run-message-queue"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { functionConversationCanonicalStamp } from
  "../checkpointer/function-conversation-checkpoint-membership"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"
import { sameFunctionConversationTranscriptStamp } from
  "../../shared/mods/v2/conversation-transcript"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot } from
  "./function-conversation-native-node"
import { captureLocalThreadRunLease, claimLocalThreadRunLease, getLocalThreadRunLease,
  releaseLocalThreadRunLease } from "./thread-run-lease"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "../db"

let directory = ""
const cleanup: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-current-run-canonical-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  setCurrentRunInjectionNotifier(() => undefined)
  for (const close of cleanup.splice(0).reverse()) await close()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Load the actual runtime notifier without importing unrelated Electron runtime factories. */
function actualRuntimeNotifier(bindings: Record<string, unknown>): CurrentRunInjectionNotifier {
  const file = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8")
  const source = ts.createSourceFile("runtime.ts", file, ts.ScriptTarget.Latest, true)
  const calls = source.statements.flatMap(statement => ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    statement.expression.expression.getText(source) === "setCurrentRunInjectionNotifier"
    ? [statement.expression] : [])
  if (calls.length !== 1 || calls[0].arguments.length !== 1)
    throw Error("EXACT_RUNTIME_NOTIFIER_REQUIRED")
  const code = ts.transpileModule(`export const notifier = ${calls[0].arguments[0].getText(source)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exported: Record<string, unknown> = {}
  const run = new Function("bindings", "exports",
    `const { ${Object.keys(bindings).join(", ")} } = bindings;\n${code}`)
  run(bindings, exported)
  if (typeof exported.notifier !== "function") throw Error("ACTUAL_NOTIFIER_FUNCTION_REQUIRED")
  return exported.notifier as CurrentRunInjectionNotifier
}

class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly produce: (call: number) => AIMessage) { super({}) }
  _llmType(): string { return "current-run-canonical-local" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = this.produce(this.requests.length)
    return { generations: [{ message, text: typeof message.content === "string"
      ? message.content : "actual native blocks" }] }
  }
}

function fixture() {
  const threadId = randomUUID(), runToken = randomUUID(), database = appDb.getDb()
  const thread = appDb.createThread(threadId), incarnation = captureThreadIncarnation(thread)
  if (!claimLocalThreadRunLease({ threadId, runId: runToken, owner: "desktop" }).acquired)
    throw Error("ACTUAL_PHYSICAL_RUN_REQUIRED")
  const ownsLease = captureLocalThreadRunLease(threadId)!
  const guard = () => {
    if (appDb.getDb() !== database || !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation) ||
      !ownsLease()) throw Error("ACTUAL_CURRENT_RUN_CHANGED")
  }
  setCurrentRunMessageQueueOwner(threadId, runToken)
  const store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId, incarnation, workspace: directory,
    checkpointNamespace: "" }, guard)
  const saver = new SqlJsSaver(join(directory, `${threadId}.sqlite`), undefined,
    { maxRootCheckpoints: 3 })
  const input = new HumanMessage({ id: randomUUID(), content: "original user input" })
  appDb.upsertThreadMessages(threadId, [{ id: input.id!, role: "user", content: "original user input",
    created_at: new Date() }])
  const sends: Array<{ channel: string; payload: unknown }> = []
  const replace = vi.fn(appDb.replaceThreadMessageId), move = vi.fn(appDb.moveThreadMessagesAfterAnchor)
  const upsert = vi.fn(appDb.upsertThreadMessages)
  const strict = vi.fn(() => appDb.flushStrict())
  const notify = actualRuntimeNotifier({
    flushTranscriptBeforeCurrentRunInjection: (actualThread: string, actualRun: string) => {
      guard()
      if (actualThread !== threadId || actualRun !== runToken) throw Error("ACTUAL_RUN_REQUIRED")
    },
    readCurrentRunCanonicalAssistantCompletion,
    sameFunctionConversationTranscriptStamp,
    readCanonicalThreadMessageSnapshot: appDb.readCanonicalThreadMessageSnapshot,
    partitionCanonicalThreadMessageEchoes: appDb.partitionCanonicalThreadMessageEchoes,
    getThreadMessageIdentityContext: appDb.getThreadMessageIdentityContext,
    resolveCurrentRunInjectionAnchorId,
    resolveCurrentRunCompletedAssistantIdentity,
    replaceThreadMessageId: replace,
    upsertThreadMessages: upsert,
    assertCurrentRunMessagesDurablyPersisted,
    moveThreadMessagesAfterAnchor: move,
    moveThreadMessagesAfterLastNonAssistant: appDb.moveThreadMessagesAfterLastNonAssistant,
    flushStrict: strict,
    isCurrentRunMessageQueueOwner,
    captureCurrentRunMessageQueueOwner,
    registerCurrentRunCompletedAssistantRoute,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => {
        sends.push({ channel, payload })
      } } }] }
  })
  setCurrentRunInjectionNotifier(notify)
  cleanup.push(async () => {
    clearCurrentRunMessageQueue(threadId)
    const lease = getLocalThreadRunLease(threadId)
    if (lease) releaseLocalThreadRunLease(threadId, lease.owner, lease.runId)
    await saver.close()
  })
  const commit = (message: AIMessage) => {
    guard()
    if (!message.id || typeof message.content !== "string") throw Error("ACTUAL_TEXT_AI_REQUIRED")
    const body = message.content
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
      role: "assistant", content: body, ...(message.name ? { name: message.name } : {}),
      created_at: new Date(row.createdAt) }))
    const row = store.commit(target, { uuid: message.id, inputDigest: randomUUID(),
      door: "response", origin: { kind: "model", model: "actual-local-model" },
      message: { type: "assistant", role: "assistant", content: [{ type: "text", text: body }] },
      nativePayload: serializeFunctionConversationNativeMessage(message),
      orderAnchor: { kind: "actual-completed-node" }, sdk: false, inbox: false },
      guard, access.write, access.verify)
    message.additional_kwargs = { ...message.additional_kwargs,
      function_row: functionConversationCanonicalStamp(target, row) }
    return row
  }
  const raw = (uuid: string) => database.exec(
    "SELECT * FROM thread_messages WHERE thread_id=? AND message_id=?", [threadId, uuid])
  return { threadId, runToken, database, store, target, saver, input, guard, notify, commit,
    raw, sends, replace, move, upsert, strict }
}

function graph(f: ReturnType<typeof fixture>, finalize?: (raw: AIMessage, call: number) => AIMessage) {
  const queuedId = randomUUID()
  const provider = new LocalModel(call => {
    if (call === 1) expect(queueCurrentRunMessage(f.threadId, { id: queuedId,
      content: "prepared steering payload", displayContent: "visible steering input" }, f.runToken)).toBe(true)
    if (call > 2) throw Error("MODEL_MUST_NOT_REPLAY")
    return new AIMessage({ id: "reused-raw-provider-id", content: call === 1 ? "raw provider body" : "reply 2" })
  })
  const agent = createAgent({ model: provider, checkpointer: f.saver,
    middleware: [createCurrentRunMessageQueueMiddleware(f.runToken)] })
  let safe: AIMessage | undefined, before: unknown
  if (finalize) {
    let count = 0
    const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "model_request",
      assertCurrent: f.guard, finalize: async slot => {
        const message = readFunctionConversationNativeNodeSlot(slot).message
        if (!(message instanceof AIMessage)) throw Error("ACTUAL_AI_NODE_REQUIRED")
        const result = finalize(message, ++count)
        if (count === 1) {
          safe = result
          before = f.raw(result.id!)
        }
        return result
      } })
    cleanup.push(async () => { control.close(); await control.whenDrained() })
  }
  const config = { configurable: { thread_id: f.threadId, checkpoint_ns: "" } }
  const run = () => agent.invoke({ messages: [f.input] }, config)
  return { provider, agent, queuedId, config, run, safe: () => safe, before: () => before }
}

function complete(f: ReturnType<typeof fixture>, raw: AIMessage, text = "safe canonical body") {
  const safe = new AIMessage({ id: randomUUID(), content: text, name: raw.name,
    response_metadata: raw.response_metadata, additional_kwargs: raw.additional_kwargs })
  f.commit(safe)
  registerCurrentRunCanonicalAssistantCompletion(f.threadId, f.runToken, safe, f.guard)
  return safe
}

describe("canonical current-run completion on actual queue, AppDB and graph", () => {
  it("keeps the actual canonical AI ID and raw columns while steering only the user row", async () => {
    const f = fixture(), g = graph(f, raw => complete(f, raw))
    const result = await g.run(), safe = g.safe()
    if (!safe?.id) throw Error("ACTUAL_CANONICAL_AI_REQUIRED")
    expect(g.provider.requests).toHaveLength(2)
    expect(g.provider.requests[1].find(message => message.id === safe.id)).toBe(safe)
    expect(g.provider.requests[1].at(-1)?.content).toBe("prepared steering payload")
    expect(safe.content).toBe("safe canonical body")
    expect(f.raw(safe.id)).toEqual(g.before())
    expect(f.replace).not.toHaveBeenCalled()
    expect(f.move).toHaveBeenCalledWith(f.threadId, safe.id, [g.queuedId])
    expect(f.upsert.mock.calls.flatMap(call => call[1]).map(message => message.role)).toEqual(["user"])
    expect(getCurrentRunInjectedMessageIds(f.threadId)).toEqual([g.queuedId])
    expect(f.sends.some(event => JSON.stringify(event.payload).includes("message_id_alias"))).toBe(false)
    const tuple = await f.saver.getTuple(g.config)
    if (!tuple) throw Error("ACTUAL_COMMITTED_CHECKPOINT_REQUIRED")
    const checkpoint = await f.saver.getTuple(tuple.config)
    if (!checkpoint) throw Error("EXACT_COMMITTED_CHECKPOINT_REQUIRED")
    const messages: unknown = checkpoint.checkpoint.channel_values.messages
    if (!Array.isArray(messages) || !messages.every(BaseMessage.isInstance))
      throw Error("ACTUAL_GRAPH_MESSAGES_REQUIRED")
    const persisted = messages.find(message => message.id === safe.id)
    expect(persisted).toBeDefined()
    if (!persisted) throw Error("ACTUAL_CANONICAL_CHECKPOINT_REQUIRED")
    expect(serializeFunctionConversationNativeMessage(persisted))
      .toBe(serializeFunctionConversationNativeMessage(safe))
    expect(result.messages.some(message => message.id === safe.id)).toBe(true)
  })

  it("retains the original legacy renumbering and visible/model user payload split", async () => {
    const f = fixture(), g = graph(f)
    await g.run()
    expect(g.provider.requests).toHaveLength(2)
    const first = g.provider.requests[1].find(message => message instanceof AIMessage)
    expect(first?.id?.startsWith("current-run-assistant:")).toBe(true)
    expect(f.sends.some(event => JSON.stringify(event.payload).includes("message_id_alias"))).toBe(true)
    expect(appDb.getThreadMessagesByIds(f.threadId, [g.queuedId])[0]?.content)
      .toBe("visible steering input")
    expect(g.provider.requests[1].at(-1)?.content).toBe("prepared steering payload")
  })

  it("rejects a reconstructed marked AI instead of granting its copied stamp a handoff", async () => {
    const f = fixture(), g = graph(f, raw => {
      const safe = complete(f, raw)
      return new AIMessage({ id: safe.id, content: safe.content, name: safe.name,
        additional_kwargs: safe.additional_kwargs, response_metadata: safe.response_metadata })
    })
    await expect(g.run()).rejects.toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
    expect(g.provider.requests).toHaveLength(1)
    expect(f.upsert).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
    expect(peekCurrentRunMessageQueue(f.threadId)).toHaveLength(1)
  })

  it("rejects mutation of the same registered instance without changing the sealed DB row", async () => {
    const f = fixture(), g = graph(f, raw => {
      const safe = complete(f, raw)
      safe.content = "late modified content"
      return safe
    })
    await expect(g.run()).rejects.toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
    expect(g.provider.requests).toHaveLength(1)
    expect(appDb.getThreadMessages(f.threadId).find(message => message.role === "assistant")?.content)
      .toBe("safe canonical body")
    expect(f.upsert).not.toHaveBeenCalled()
    expect(f.sends).toEqual([])
  })

  it("does not turn a private completion into a missing canonical DB receipt", async () => {
    const f = fixture(), g = graph(f, raw => {
      const safe = complete(f, raw)
      f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?", [f.threadId])
      return safe
    })
    await expect(g.run()).rejects.toThrow()
    expect(g.provider.requests).toHaveLength(1)
    expect(f.upsert).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
    expect(peekCurrentRunMessageQueue(f.threadId)).toHaveLength(1)
  })

  it("rejects a queued user borrowing a kept canonical ID before any reorder or write", async () => {
    const f = fixture(), g = graph(f, raw => {
      const safe = complete(f, raw)
      if (!safe.id) throw Error("ACTUAL_CANONICAL_AI_REQUIRED")
      expect(queueCurrentRunMessage(f.threadId, { id: safe.id, content: "forged user occurrence" },
        f.runToken)).toBe(true)
      return safe
    })
    await expect(g.run()).rejects.toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    const safe = g.safe()
    if (!safe?.id) throw Error("ACTUAL_CANONICAL_AI_REQUIRED")
    expect(f.raw(safe.id)).toEqual(g.before())
    expect(g.provider.requests).toHaveLength(1)
    expect(f.upsert).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
    expect(f.move).not.toHaveBeenCalled()
    expect(f.sends).toEqual([])
    expect(peekCurrentRunMessageQueue(f.threadId)).toHaveLength(2)
  })

  it("rejects an owner handoff during real strict flush before notifying or running model two", async () => {
    const f = fixture(), g = graph(f, raw => complete(f, raw))
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    f.strict.mockImplementation(async () => {
      await appDb.flushStrict()
      entered.resolve()
      await gate.promise
    })
    const run = g.run(), rejected = expect(run).rejects.toThrow("owner changed")
    void rejected.catch(() => undefined)
    await entered.promise
    setCurrentRunMessageQueueOwner(f.threadId, randomUUID())
    gate.resolve()
    await rejected
    expect(g.provider.requests).toHaveLength(1)
    expect(f.sends).toEqual([])
    expect(peekCurrentRunMessageQueue(f.threadId)).toEqual([])
    expect(appDb.getThreadMessagesByIds(f.threadId, [g.queuedId])).toHaveLength(1)
  })

  it("rejects original physical lease ABA even when the public run token is reused", async () => {
    const f = fixture(), g = graph(f, raw => {
      const safe = complete(f, raw)
      releaseLocalThreadRunLease(f.threadId, "desktop", f.runToken)
      expect(claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: f.runToken })
        .acquired).toBe(true)
      return safe
    })
    await expect(g.run()).rejects.toThrow("ACTUAL_CURRENT_RUN_CHANGED")
    expect(g.provider.requests).toHaveLength(1)
    expect(f.upsert).not.toHaveBeenCalled()
    expect(f.sends).toEqual([])
  })

  it("uses only the original private notifier record and rejects queue-owner ABA", async () => {
    const f = fixture(), g = graph(f, raw => complete(f, raw))
    setCurrentRunInjectionNotifier(async (threadId, queued, context) => {
      const completed = context?.completedAssistantMessage
      const receipt = readCurrentRunCanonicalAssistantCompletion(completed, threadId, f.runToken)
      if (!completed || !receipt) throw Error("ACTUAL_PRIVATE_COMPLETION_REQUIRED")
      expect(receipt.message).toBe(g.safe())
      expect(readCurrentRunCanonicalAssistantCompletion({ ...completed }, threadId, f.runToken))
        .toBeUndefined()
      expect(() => readCurrentRunCanonicalAssistantCompletion(completed, randomUUID(), f.runToken))
        .toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
      const originalOwner = captureCurrentRunMessageQueueOwner(threadId, f.runToken)
      clearCurrentRunMessageQueue(threadId, f.runToken)
      setCurrentRunMessageQueueOwner(threadId, f.runToken)
      expect(() => originalOwner()).toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
      expect(() => receipt.assertCurrent()).toThrow("MODS_CONVERSATION_COMPLETION_INVALID")
      expect(queued).toHaveLength(1)
      throw Error("ACTUAL_COMPLETION_OWNER_RETIRED")
    })
    await expect(g.run()).rejects.toThrow("ACTUAL_COMPLETION_OWNER_RETIRED")
    expect(g.provider.requests).toHaveLength(1)
    expect(f.upsert).not.toHaveBeenCalled()
    expect(peekCurrentRunMessageQueue(f.threadId)).toEqual([])
  })
})
