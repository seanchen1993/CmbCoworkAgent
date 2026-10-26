import { reconcileNativePartialQueuedMessages } from "../agent/native-partial-persistence"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { AIMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { captureLocalThreadRunLease, claimLocalThreadRunLease, getLocalThreadRunLease,
  releaseLocalThreadRunLease } from
  "../agent/thread-run-lease"
import { captureCurrentRunMessageQueueOwner, clearCurrentRunMessageQueue, isCurrentRunMessageQueueOwner,
  setCurrentRunMessageQueueOwner } from "../agent/current-run-message-queue"
import { getMessageProviderOccurrence, getMessageProviderSourceId } from
  "../../shared/message-role-collision"
import { resolveStreamTranscriptFlush, type QueuedStreamTranscriptMessage } from
  "./stream-transcript-flush"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "../db"

interface Pending {
  threadId: string
  runToken: string
  messages: QueuedStreamTranscriptMessage[]
  timer?: ReturnType<typeof setTimeout>
  requiredSnapshotProviderSourceId?: string
  requiredSnapshotProviderOccurrence?: number
}
interface ActualFlush {
  captureNativeConversationTranscriptFlush(threadId: string, runToken: string,
    signal: AbortSignal): (uuid: string) => void
  flushPendingStreamTranscriptMessages(threadId: string, runToken: string,
    options?: { throwOnError?: boolean }): void
  queueStreamTranscriptMessage(threadId: string, runToken: string,
    message: QueuedStreamTranscriptMessage): void
}

let directory = ""
const owners: Array<{ threadId: string; runToken: string }> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-uuid-flush-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  for (const { threadId, runToken } of owners.splice(0)) {
    releaseLocalThreadRunLease(threadId, "desktop", runToken)
    clearCurrentRunMessageQueue(threadId)
  }
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function actualFunctions(pending: Map<string, Pending>) {
  const source = ts.createSourceFile("agent.ts", readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
    ts.ScriptTarget.Latest, true)
  const names = ["pendingStreamTranscriptKey", "flushPendingStreamTranscriptMessages",
    "captureNativeConversationTranscriptFlush", "queueStreamTranscriptMessage",
    "isPhysicalStreamRunActive", "throwIfPhysicalStreamRunIsInactive"]
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) &&
    node.name && names.includes(node.name.text))
  if (declarations.length !== names.length) throw Error("ACTUAL_FLUSH_SOURCE_MISSING")
  const code = ts.transpileModule(`${declarations.map(node => node.getText(source)).join("\n")}
    ({captureNativeConversationTranscriptFlush,flushPendingStreamTranscriptMessages,queueStreamTranscriptMessage})`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  // The exact production functions run against native SQLite, the real resolver and lease/queue
  // ownership. Electron registration and unrelated application startup are outside this fixture.
  const api: ActualFlush = runInNewContext(code, { exports: {}, console, setTimeout, clearTimeout,
    STREAM_TRANSCRIPT_FLUSH_DEBOUNCE_MS: 250, pendingStreamTranscriptMessages: pending,
    streamTranscriptAssistantIdentities: new Map(), latestStreamAssistantCandidate: new Map(),
    streamAssistantRevision: 0, getMessageProviderSourceId, getMessageProviderOccurrence,
    captureLocalThreadRunLease, captureThreadIncarnation, matchesThreadIncarnation,
    getLocalThreadRunLease,
    captureCurrentRunMessageQueueOwner, isCurrentRunMessageQueueOwner, resolveStreamTranscriptFlush,
    reconcileNativePartialQueuedMessages,
    getDb: appDb.getDb, getThreadCore: (...args: Parameters<typeof appDb.getThreadCore>) =>
      appDb.getThreadCore(...args),
    getThreadRuntimeScope: (...args: Parameters<typeof appDb.getThreadRuntimeScope>) =>
      appDb.getThreadRuntimeScope(...args),
    getThreadMessageIdentityContext: appDb.getThreadMessageIdentityContext,
    partitionCanonicalThreadMessageEchoes: appDb.partitionCanonicalThreadMessageEchoes,
    appendThreadMessageTextDelta: appDb.appendThreadMessageTextDelta,
    upsertThreadMessages: (...args: Parameters<typeof appDb.upsertThreadMessages>) =>
      appDb.upsertThreadMessages(...args) })
  return api
}

function fixture() {
  vi.useFakeTimers()
  const threadId = randomUUID(), runToken = randomUUID(), controller = new AbortController()
  appDb.createThread(threadId, { workspacePath: directory })
  expect(claimLocalThreadRunLease({ threadId, owner: "desktop", runId: runToken }).acquired).toBe(true)
  setCurrentRunMessageQueueOwner(threadId, runToken)
  owners.push({ threadId, runToken })
  const pending = new Map<string, Pending>(), api = actualFunctions(pending)
  const key = `${threadId}\u0000${runToken}`
  const flush = api.captureNativeConversationTranscriptFlush(threadId, runToken, controller.signal)
  const queue = (id: string, content: string): QueuedStreamTranscriptMessage => {
    const message: QueuedStreamTranscriptMessage = { id, role: "assistant", content,
      provider_source_id: id, provider_occurrence: 1, created_at: new Date(100),
      streamContentMode: "snapshot", streamToolCallChunks: [] }
    api.queueStreamTranscriptMessage(threadId, runToken, message)
    return message
  }
  return { threadId, runToken, controller, pending, api, key, flush, queue }
}

it("flushes only the exact UUID and leaves other entries plus their original timer untouched", () => {
  const f = fixture(), one = randomUUID(), other = randomUUID()
  f.queue(one, "Only this occurrence")
  const remaining = f.queue(other, "Later occurrence")
  const original = f.pending.get(f.key), timer = original?.timer
  f.flush(one)
  expect(appDb.getThreadMessages(f.threadId).map(message => message.id)).toEqual([one])
  expect(f.pending.get(f.key)).toBe(original)
  expect(original?.messages).toEqual([remaining])
  expect(original?.timer).toBe(timer)
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(250)
  expect(appDb.getThreadMessages(f.threadId).map(message => message.id)).toEqual([one, other])
  expect(f.pending.has(f.key)).toBe(false)
})

it.each(["recreate", "malformed"] as const)(
  "keeps full history untouched while the actual flush scope rejects %s", mode => {
    const f = fixture(), uuid = randomUUID()
    const row = appDb.getThreadCore(f.threadId)!
    appDb.updateThread(f.threadId, { metadata: JSON.stringify({ ...JSON.parse(row.metadata!),
      llmFileHistory: { content: "中文😀".repeat(40_000) }, kept: "original" }) })
    const original = appDb.getThreadCore(f.threadId)!.metadata
    const full = vi.spyOn(appDb, "getThreadCore")
    const scope = vi.spyOn(appDb, "getThreadRuntimeScope")
    const flush = f.api.captureNativeConversationTranscriptFlush(f.threadId, f.runToken,
      f.controller.signal)
    f.queue(uuid, "Real persisted content")
    flush(uuid)
    expect(full).not.toHaveBeenCalled()
    expect(scope.mock.results.length).toBeGreaterThanOrEqual(3)
    for (const result of scope.mock.results) {
      expect(result.type).toBe("return")
      expect(result.value?.metadata).not.toContain("llmFileHistory")
    }
    expect(appDb.getThreadMessages(f.threadId).map(message => message.id)).toEqual([uuid])
    expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(original)
    if (mode === "recreate") {
      appDb.deleteThread(f.threadId)
      appDb.createThread(f.threadId, { workspacePath: directory })
      appDb.getDb().run("UPDATE threads SET created_at=? WHERE thread_id=?",
        [row.created_at, f.threadId])
    } else appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", ["{broken", f.threadId])
    const pending = f.queue(randomUUID(), "Must remain pending")
    expect(() => flush(pending.id)).toThrow()
    expect(f.pending.get(f.key)?.messages).toContain(pending)
  }
)

it("does not disturb a missing UUID, another run or its timer", () => {
  const f = fixture(), otherRun = randomUUID(), otherKey = `${f.threadId}\u0000${otherRun}`
  const message = f.queue(randomUUID(), "Original run")
  const pending = f.pending.get(f.key), timer = pending?.timer
  f.pending.set(otherKey, { threadId: f.threadId, runToken: otherRun, messages: [message] })
  f.flush(randomUUID())
  expect(f.pending.get(f.key)).toBe(pending)
  expect(pending?.timer).toBe(timer)
  expect(f.pending.has(otherKey)).toBe(true)
  expect(appDb.getThreadMessages(f.threadId)).toHaveLength(0)
})

it("preserves all selected and unrelated entries when the real writer fails", () => {
  const f = fixture(), one = randomUUID(), other = randomUUID()
  f.queue(one, "Held selected")
  f.queue(other, "Unrelated held")
  const original = f.pending.get(f.key), timer = original?.timer
  const error = Error("ACTUAL_WRITE_FAILED")
  const upsert = vi.spyOn(appDb, "upsertThreadMessages").mockImplementation(() => { throw error })
  expect(() => f.flush(one)).toThrow(error)
  expect(f.pending.get(f.key)).toBe(original)
  expect(original?.messages.map(message => message.id)).toEqual([one, other])
  expect(original?.timer).toBe(timer)
  expect(appDb.getThreadMessages(f.threadId)).toHaveLength(0)
  upsert.mockRestore()
  f.flush(one)
  expect(original?.messages.map(message => message.id)).toEqual([other])
})

it("counts an actual canonical snapshot without rewriting it or rejecting ordinary changed=0", () => {
  const f = fixture(), database = appDb.getDb(), uuid = randomUUID()
  const thread = appDb.getThreadCore(f.threadId)
  if (!thread) throw Error("ACTUAL_THREAD_MISSING")
  const store = new FunctionConversationStore(database)
  const ref = store.ensureMain({ threadId: f.threadId, workspace: directory,
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, () => undefined)
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({
    id: row.uuid, role: "assistant", content: "Actual protected result", content_mode: "snapshot",
    provider_source_id: uuid, provider_occurrence: 1, created_at: new Date(row.createdAt) }))
  const native = new AIMessage({ id: uuid, content: "Actual protected result" })
  store.commit(ref, { uuid, inputDigest: uuid, door: "response", origin: { kind: "model", model: "Actual" },
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "Actual protected result" }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "actual-native-occurrence" }, sdk: false, inbox: false },
  () => store.assertCurrent(ref), access.write, access.verify)
  const snapshot = appDb.readCanonicalThreadMessageSnapshot(f.threadId, uuid)
  if (!snapshot) throw Error("ACTUAL_CANONICAL_MISSING")
  expect(appDb.upsertThreadMessages(f.threadId, [snapshot])).toBe(0)
  f.api.queueStreamTranscriptMessage(f.threadId, f.runToken, { ...snapshot,
    streamContentMode: "snapshot", streamToolCallChunks: [] })
  const run = vi.spyOn(database, "run")
  expect(() => f.flush(uuid)).not.toThrow()
  expect(run).not.toHaveBeenCalled()
  expect(f.pending.has(f.key)).toBe(false)
  expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, uuid)).toEqual(snapshot)
})

it("cannot capture a new flush from queue ownership with a different actual lease run", () => {
  const f = fixture(), wrongRun = randomUUID()
  expect(releaseLocalThreadRunLease(f.threadId, "desktop", f.runToken)).toBe(true)
  expect(claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: wrongRun })
    .acquired).toBe(true)
  owners.push({ threadId: f.threadId, runToken: wrongRun })
  expect(() => f.api.captureNativeConversationTranscriptFlush(f.threadId, f.runToken,
    f.controller.signal)).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  expect(appDb.getThreadMessages(f.threadId)).toHaveLength(0)
})

it.each(["cancel", "owner", "owner-aba", "lease-aba", "thread-incarnation"])(
  "refuses the captured old %s before writing or clearing pending entries", reason => {
    const f = fixture(), uuid = randomUUID()
    f.queue(uuid, "Must remain pending")
    const pending = f.pending.get(f.key), timer = pending?.timer
    if (reason === "cancel") f.controller.abort()
    else if (reason === "owner") setCurrentRunMessageQueueOwner(f.threadId, randomUUID())
    else if (reason === "owner-aba") {
      clearCurrentRunMessageQueue(f.threadId)
      setCurrentRunMessageQueueOwner(f.threadId, f.runToken)
    }
    else if (reason === "lease-aba") {
      expect(releaseLocalThreadRunLease(f.threadId, "desktop", f.runToken)).toBe(true)
      expect(claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: f.runToken }).acquired).toBe(true)
    } else appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ workspacePath: directory, cmb_thread_incarnation: randomUUID() }), f.threadId])
    expect(() => f.flush(uuid)).toThrow()
    expect(appDb.getThreadMessages(f.threadId)).toHaveLength(0)
    expect(f.pending.get(f.key)).toBe(pending)
    expect(pending?.timer).toBe(timer)
  })
