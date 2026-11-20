import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest"
import { LocalBotHost } from "./host"
import { BotStore } from "./store"
import { createBotWorkTools } from "./work-tools"
import { botHistoryHidesTitle, protectedBotHistoryTitle, setBotHistoryInputSource } from "./history-input-projection"
import { copyForkInputProjections, readForkInputProjections } from "./fork-input-projection"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { botThreadHistoryHref, parseBotThreadHistoryHref } from "../../shared/bots/thread-history"
import { withThreadRunMutationLock } from "../ipc/thread-run-mutation-lock"
import { bootstrapLegacyCheckpointTranscript } from "../checkpointer/runtime-projection-store"
import { formatBotMessageReply } from "../../shared/bots/message-reply"
import { peekThreadCheckpointPath } from "../storage"

const fixture = vi.hoisted(() => ({ path: "", afterRead: () => {} }))
vi.mock("../agent/renderer-stream-mirror", () => ({ broadcastToRenderers: vi.fn() }))
vi.mock("../storage", () => ({
  getDbPath: () => fixture.path,
  peekThreadCheckpointPath: (id: string) => join(dirname(fixture.path), `${id}.sqlite`),
  getMemorySessionOptInMigrationState: () => ({ migrated: true, legacyMemoryEnabled: false, legacyDreamEnabled: false }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../checkpointer/runtime-projection-client", async () => {
  const { hasVisibleCheckpointTranscript } = await import("../checkpointer/runtime-projection-store")
  return {
    hasVisibleCheckpointTranscriptInWorker: async (path: string, id: string) =>
      hasVisibleCheckpointTranscript(path, id)
  }
})
vi.mock("../thread-message-hydration/client", async () => {
  const db = await import("../db")
  return { readThreadMessagesPageInWorker: async (id, options) => {
    const result = db.getThreadMessagesPage(id, options)
    fixture.afterRead()
    return result
  } }
})
vi.mock("../thread-metadata-hydration/client", async () => {
  const { readThreadSummaryPage } = await import("../thread-metadata-hydration/reader")
  return { readThreadSummaryPageInWorker: async options => {
    const db = new DatabaseSync(fixture.path, { readOnly: true })
    try {
      return readThreadSummaryPage(db, { ...options, type: "read-list-page", requestId: 1,
        databasePath: fixture.path, cancellationBuffer: new SharedArrayBuffer(4) })
    } finally { db.close() }
  } }
})
import * as db from "../db"
import { createBotOrdinaryThreads } from "./ordinary-threads"
import { createLocalBotWorkHistory } from "./work-history"

let directory: string
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bot-ordinary-history-"))
  fixture.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => { await db.closeDatabase(); rmSync(directory, { recursive: true, force: true }) })
afterEach(() => { fixture.afterRead = () => {} })
function setup() {
  const managed = new Set<string>(), projections = new Map<string, string | null>()
  const host = { conversationLinks: { forThread: id => managed.has(id) ? {} : null },
    ordinaryThreadInputProjections: (_id, ids: string[]) => new Map(ids.filter(id => projections.has(id)).map(id => [id, projections.get(id)!]))
  } as unknown as LocalBotHost
  return { service: createBotOrdinaryThreads(() => host), managed, projections }
}
function create(id: string, metadata: Record<string, unknown> = {}) {
  const row = db.createThread(id, { title: id, ...metadata })
  return { kind: "local_thread" as const, threadId: id, incarnation: captureThreadIncarnation(row) }
}
const message = (id: string, content: string, role: "user" | "assistant" | "tool" = "user") =>
  ({ id, content, role, created_at: new Date() })

function createLegacyCheckpoint(threadId: string, messages: Array<{ id: string; type: string; content: string }>) {
  const path = peekThreadCheckpointPath(threadId)
  const checkpoint = new DatabaseSync(path)
  try {
    checkpoint.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT, type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata BLOB NOT NULL
      )
    `)
    checkpoint.prepare(`
      INSERT INTO checkpoints VALUES (?, '', '2026-08-26T00:00:00.000Z', NULL, 'json', ?, '{}')
    `).run(threadId, JSON.stringify({
      channel_values: { messages }, channel_versions: {}, versions_seen: {}
    }))
  } finally {
    checkpoint.close()
  }
  return path
}

function setupHistoryNavigation() {
  const controlDb = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(controlDb, Date.now, undefined, (threadId, id) => {
    const [entry] = db.getThreadMessagesByIds(threadId, [id])
    return entry && (entry.role === "user" || entry.role === "assistant")
      ? { id: entry.id, ordinal: entry.ordinal!, role: entry.role, text: String(entry.content) } : null
  })
  const host: LocalBotHost = new LocalBotHost(store, {
    ordinaryThreads: createBotOrdinaryThreads(() => host),
    workHistory: createLocalBotWorkHistory(() => host),
    onAvailable: () => () => {},
    acquire: (_bot, task) => !task.workId && task.origin.kind === "user" ? {
      release() {},
      execute: signal => new Promise(resolve => {
        const finish = () => resolve({ state: "completed" })
        if (signal.aborted) finish()
        else signal.addEventListener("abort", finish, { once: true })
      })
    } : null
  })
  const owner = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  setBotHistoryInputSource({
    forkInputs: readForkInputProjections,
    works: threadId => host.desktopDeliveryWorks(threadId),
    inputs: (botId, threadId, ids, workIds, purpose) => store.inputProjections(botId, threadId, ids, workIds, purpose),
    origins: (threadId, incarnation, ids) => host.historicalMessageOrigins(threadId, incarnation, ids, true)
  })
  const bind = (conversation: ReturnType<typeof create>, botId = owner.id) => {
    const work = store.conversations.prepare({
      botId, operationId: "history-binding", title: "Original task",
      goal: "Continue the original task", conversation
    })
    const row = db.getThreadCore(conversation.threadId)!
    // Persist the same ownership metadata as finishBinding while preserving the real thread identity.
    db.updateThread(conversation.threadId, { metadata: JSON.stringify({
      ...JSON.parse(row.metadata || "{}"),
      botId, botHostId: "local", botWorkId: work.id, botAudienceKey: "desktop",
      botLocalConversation: true, botWorkOrigin: "existing"
    }) })
    return store.conversations.bound(botId, work.id, conversation)
  }
  return {
    host, store, owner, bind,
    close: async () => {
      setBotHistoryInputSource(undefined)
      await host.stop()
      controlDb.close()
    }
  }
}

describe("ordinary desktop conversation discovery and reading", () => {
  it("keeps a derived Fork title out of Bot discovery while preserving native display and explicit rename", async () => {
    const f = setupHistoryNavigation()
    try {
      const title = "Removed fork creation title"
      const ref = create("fork-title-copy", { title, ...protectedBotHistoryTitle(title) })
      const service = createBotOrdinaryThreads(() => f.host)
      expect(botHistoryHidesTitle(ref.threadId, db.getThreadCore(ref.threadId)!)).toBe(true)
      expect((await service.read({ conversation: ref })).thread.title).toBe("原任务")
      expect((await service.list({ query: title })).items).toEqual([])
      expect(db.getThreadCore(ref.threadId)?.title).toBe(title)
      await service.rename!({ conversation: ref, expectedTitle: title, title: "Explicit new title" }, apply => apply())
      expect((await service.read({ conversation: ref })).thread.title).toBe("Explicit new title")
      expect((await service.list({ query: "Explicit new title" })).items.map(row => row.conversation.threadId))
        .toContain(ref.threadId)
    } finally { await f.close() }
  })

  it("preserves admitted Fork inputs through native persistence, repeated forks and source deletion without changing visible text", async () => {
    const f = setupHistoryNavigation()
    try {
      const source = create("fork-input-source"), fork = create("fork-input-copy"), next = create("fork-input-next", { workspacePath: directory })
      const original = [message("rewritten", "Removed internal wording"), message("blank", "Discarded input"),
        message("plain", "Ordinary input"), message("answer", "Actual answer", "assistant")]
      db.upsertThreadMessages(source.threadId, original)
      const copy = (from: string, to: string, prepared: Array<typeof original[number] & { text: string }>) => {
        const messages = db.getThreadMessages(from)
        db.upsertThreadMessages(to, messages, { preserveExistingOrder: true })
        copyForkInputProjections({ sourceThreadId: from, targetThreadId: to, messages, persistedMessages: messages, prepared })
      }
      copy(source.threadId, fork.threadId, [{ ...original[0], text: "Admitted instruction" }, { ...original[1], text: "" }])
      expect(db.getThreadMessages(fork.threadId).map(row => row.content)).toEqual(original.map(row => row.content))
      expect(db.getThreadMessages(fork.threadId).some(row => "bot_input_projection" in row)).toBe(false)
      copy(fork.threadId, next.threadId, [])
      db.deleteThread(source.threadId); db.deleteThread(fork.threadId)
      db.upsertThreadMessages(next.threadId, [message("new", "New ordinary input")])
      await db.closeDatabase(); await db.initializeDatabase()
      const service = createBotOrdinaryThreads(() => f.host)
      expect((await service.read({ conversation: next })).entries.map(row => row.text))
        .toEqual(["Admitted instruction", "Ordinary input", "Actual answer", "New ordinary input"])
      for (const query of ["Removed internal", "Discarded input"])
        expect((await service.read({ conversation: next, query })).entries).toEqual([])
      expect((await service.read({ conversation: next, query: "Admitted instruction" })).entries).toHaveLength(1)
      expect(db.getThreadMessages(next.threadId)[0].content).toBe(original[0].content)
      const work = f.bind(next)
      expect(f.host.ordinaryThreadInputProjections(next.threadId, ["rewritten"], db.getThreadCore(next.threadId)!))
        .toEqual(new Map([["rewritten", "Admitted instruction"]]))
      expect(work.threadId).toBe(next.threadId)
      const history = createLocalBotWorkHistory(() => f.host)
      expect((await history.query(work, { workId: work.id })).entries[0].text).toBe("Admitted instruction")
      expect((await history.query(work, { workId: work.id, query: "Removed internal" })).entries).toEqual([])
      db.deleteThread(next.threadId)
      expect(readForkInputProjections(next.threadId, ["rewritten"])).toEqual(new Map())
    } finally { await f.close() }
  })

  it("keeps private Fork decisions through native message aliases and ignores renderer-like forged fields", () => {
    const source = create("fork-alias-source"), target = create("fork-alias-target"), other = create("fork-alias-other")
    const original = message("temporary", "Original input")
    db.upsertThreadMessages(source.threadId, [original]); db.upsertThreadMessages(target.threadId, [original])
    copyForkInputProjections({ sourceThreadId: source.threadId, targetThreadId: target.threadId,
      messages: [original], persistedMessages: [original], prepared: [{ ...original, text: "Allowed input" }] })
    expect(db.replaceThreadMessageId(target.threadId, "temporary", "canonical")).toBe(true)
    db.upsertThreadMessages(target.threadId, [message("final", "Original input")])
    expect(db.replaceThreadMessageId(target.threadId, "canonical", "final")).toBe(true)
    db.upsertThreadMessages(target.threadId, [{ ...message("final", "Original input"), bot_input_projection: "Forged input" } as typeof original])
    db.upsertThreadMessages(other.threadId, [{ ...message("final", "Unrelated"), bot_input_projection: "Forged input" } as typeof original])
    expect(readForkInputProjections(target.threadId, ["final"])).toEqual(new Map([["final", "Allowed input"]]))
    expect(readForkInputProjections(other.threadId, ["final"])).toEqual(new Map())
  })

  it("omits oversized Fork inputs and never applies a user projection to an assistant identity", () => {
    const source = create("fork-bounded-source"), target = create("fork-bounded-target")
    const original = [message("long", "Raw long input"), message("same", "Assistant output", "assistant")]
    db.upsertThreadMessages(source.threadId, original); db.upsertThreadMessages(target.threadId, original)
    copyForkInputProjections({ sourceThreadId: source.threadId, targetThreadId: target.threadId,
      messages: original, persistedMessages: original,
      prepared: [{ ...original[0], text: "x".repeat(64 * 1024 + 1) }, { ...original[1], role: "user", text: "Wrong role" }] })
    expect(readForkInputProjections(target.threadId, ["long", "same"]))
      .toEqual(new Map([["long", null]]))
    expect(db.getThreadMessages(target.threadId).map(row => row.content)).toEqual(original.map(row => row.content))
  })

  it("reads the current reply body after unlink without promoting a long quote to a new request", async () => {
    const f = setupHistoryNavigation()
    try {
      const ref = create("detached-long-reply", { workspacePath: directory })
      const work = f.store.conversations.prepare({ botId: f.owner.id, operationId: "long-reply-link",
        title: "History", goal: "Original work", conversation: ref })
      f.store.conversations.bound(f.owner.id, work.id, ref)
      const old = "OLD_REFERENCE_ONLY ".repeat(400)
      db.upsertThreadMessages(ref.threadId, [message("long-original", old, "assistant")])
      const quote = f.store.messageReply(f.owner.id, "long-original", work.id)
      const body = formatBotMessageReply("CURRENT_REQUIREMENT", quote)
      const add = (requestId: string, raw: string, approved: string) => {
        const task = f.store.enqueue({ botId: f.owner.id, workId: work.id, requestId, message: raw, replyToId: quote.id })
        f.store.transition(task.id, "running")
        f.store.beginInputPreparation(task.id)
        f.store.recordPreparedInput(task.id, approved)
        db.upsertThreadMessages(ref.threadId, [message(requestId, raw)])
        f.store.transition(task.id, "completed")
      }
      add("long-followup", body, body)
      add("changed-followup", formatBotMessageReply("DENIED_ORIGINAL", quote), "APPROVED_REPLACEMENT")
      f.store.conversations.beginDetach(f.owner.id, work.id, f.store.getWork(f.owner.id, work.id).version)
      f.store.conversations.detached(f.owner.id, work.id)
      const reader = f.store.create({ name: "Reader", instructions: "", color: "#123456", modelRef: null })
      const request = f.host.send({ botId: reader.id, requestId: "read-previous", message: "Read the previous conversation" })
      await vi.waitFor(() => expect(f.store.getTask(request.id).state).toBe("running"))
      const tool = createBotWorkTools(request, () => f.host, new AbortController().signal).find(t => t.name === "bot_thread_read")!
      const read = async (args: object, conversation = ref) => {
        const result = await tool.invoke({ type: "tool_call", id: "read-history", name: tool.name, args: { conversation, ...args } })
        return JSON.parse(result.content).receipt
      }
      const verify = async () => {
        expect((await read({ messageId: "long-followup" })).entries.find(e => e.source.messageId === "long-followup"))
          .toMatchObject({ text: "CURRENT_REQUIREMENT", truncated: false })
        expect((await read({ query: "OLD_REFERENCE_ONLY" })).entries.map(e => e.source.messageId)).toEqual(["long-original"])
        expect((await read({ query: "DENIED_ORIGINAL" })).entries).toEqual([])
        expect((await read({ messageId: "changed-followup" })).entries.find(e => e.source.messageId === "changed-followup").text)
          .toBe("APPROVED_REPLACEMENT")
      }
      await verify()
      f.store.finishDeletion(f.owner.id, f.store.beginDeletion(f.owner.id, f.owner.version))
      await verify()
      const ordinary = create("literal-reply-markers")
      const literal = formatBotMessageReply("LITERAL_BODY", { ...quote, text: "LITERAL_REFERENCE" })
      db.upsertThreadMessages(ordinary.threadId, [message("literal", literal)])
      expect((await read({ messageId: "literal" }, ordinary)).entries[0].text).toContain("LITERAL_REFERENCE")
      expect(db.getThreadMessagesByIds(ref.threadId, ["long-followup"])[0].content).toBe(body)
    } finally { await f.close() }
  })

  it("renames through the original metadata guard without changing execution, transcript or settings", async () => {
    const f = setup(), ref = create("rename-ordinary", { model: "fixed", workspacePath: "/original", memoryEnabled: false })
    db.upsertThreadMessages(ref.threadId, [message("rename-original", "Keep this content")])
    const before = db.getThreadCore(ref.threadId)!, beforeMetadata = JSON.parse(before.metadata!)
    const result = await f.service.rename!({ conversation: ref, expectedTitle: before.title!, title: "Renamed only" }, apply => apply())
    const after = db.getThreadCore(ref.threadId)!
    expect(result.title).toBe("Renamed only")
    expect(after.status).toBe(before.status)
    expect(after.created_at).toBe(before.created_at)
    expect(JSON.parse(after.metadata!)).toEqual({ ...beforeMetadata, title: "Renamed only" })
    expect(db.getThreadMessagesByIds(ref.threadId, ["rename-original"])[0].content).toBe("Keep this content")
    await expect(f.service.rename!({ conversation: ref, expectedTitle: before.title!, title: "Wrong stale rename" }, apply => apply())).rejects.toThrow("名称已变化")
    expect(db.getThreadCore(ref.threadId)?.title).toBe("Renamed only")
  })

  it("keeps an explicit rename back to the original Fork title visible while a no-op preserves its protection", async () => {
    const f = setup(), title = "Ordinary fork title"
    const ref = create("rename-protected-fork", { title, ...protectedBotHistoryTitle(title), model: "fixed" })
    const rename = (expectedTitle: string, next: string) => f.service.rename!({ conversation: ref,
      expectedTitle, title: next }, apply => apply())
    await rename(title, title)
    expect(botHistoryHidesTitle(ref.threadId, db.getThreadCore(ref.threadId)!)).toBe(true)
    await rename(title, "Explicit temporary name")
    await rename("Explicit temporary name", title)
    expect(botHistoryHidesTitle(ref.threadId, db.getThreadCore(ref.threadId)!)).toBe(false)
    expect((await f.service.list({ query: title })).items.some(item => item.conversation.threadId === ref.threadId)).toBe(true)
    expect(JSON.parse(db.getThreadCore(ref.threadId)!.metadata!).model).toBe("fixed")
  })

  it("rejects a target linked while rename waits and rejects a replay after a later user rename", async () => {
    const f = setup(), ref = create("rename-waiting")
    let release!: () => void, entered!: () => void
    const acquired = new Promise<void>(resolve => { entered = resolve })
    const lock = withThreadRunMutationLock(ref.threadId, () => { entered(); return new Promise<void>(resolve => { release = resolve }) })
    await acquired
    let writes = 0
    const pending = f.service.rename!({ conversation: ref, expectedTitle: "rename-waiting", title: "Renamed" }, apply => { writes++; return apply() })
    f.managed.add(ref.threadId); release(); await lock
    await expect(pending).rejects.toThrow("已变化")
    expect(writes).toBe(0)
    f.managed.delete(ref.threadId)
    const input = { conversation: ref, expectedTitle: "rename-waiting", title: "Renamed" }
    const receipt = await f.service.rename!(input, apply => apply())
    db.updateThread(ref.threadId, { title: "User changed it later" })
    await expect(f.service.rename!(input, () => receipt)).rejects.toThrow("不会覆盖")
    expect(db.getThreadCore(ref.threadId)?.title).toBe("User changed it later")
    await expect(f.service.rename!({ ...input, conversation: { ...ref, incarnation: { ...ref.incarnation, token: "replaced" } } }, apply => apply())).rejects.toThrow("已变化")
  })

  it("reports a partial rename when native metadata saved but the Bot receipt could not persist", async () => {
    const f = setup(), ref = create("rename-partial")
    await expect(f.service.rename!({ conversation: ref, expectedTitle: "rename-partial", title: "Actually saved" }, apply => {
      apply(); throw new Error("receipt disk failed")
    })).rejects.toThrow("名称已写入，但操作回执未确认")
    expect(db.getThreadCore(ref.threadId)?.title).toBe("Actually saved")
  })

  it("uses bounded real summary pages, excludes private/special sessions and permits history without a live directory", async () => {
    const f = setup(), own = create("discover-ordinary"), missing = create("discover-missing-dir", { workspacePath: "/no-longer-present" })
    const privateKinds = [
      { botId: "another" }, { threadType: "internal" }, { heartbeat: true },
      { harnessFeature: {} }, { harnessProjectSession: {} }, { remoteThread: true },
      { imDeliveryContext: {} }, { partnerInputOnly: true }, { scheduledTaskId: "routine" },
      { agentMode: "workflow" }, { agentMode: "coordinator" }, { coordinatorMode: "on" }
    ]
    const privateRefs = privateKinds.map((metadata, index) => create(`discover-private-${index}`, metadata))
    const managed = create("discover-preparing"); f.managed.add(managed.threadId)
    const page = await f.service.list({ query: "discover-" })
    expect(page.items.map(item => item.conversation.threadId).sort()).toEqual([missing.threadId, own.threadId].sort())
    expect(page.scanned).toBeLessThanOrEqual(32)
    expect(page.items.find(item => item.conversation.threadId === own.threadId)?.workspacePath).toBeNull()
    expect((await f.service.list({ query: "discover-", workspacePath: "/no-longer-present" })).items).toHaveLength(1)
    db.upsertThreadMessages(missing.threadId, [message("history", "Readable without touching files")])
    expect((await f.service.read({ conversation: missing })).entries[0].text).toContain("Readable")
    for (const ref of privateRefs.slice(-3)) {
      await expect(f.service.read({ conversation: ref })).rejects.toThrow("不属于普通本机会话")
      await expect(f.service.rename!({ conversation: ref, expectedTitle: ref.threadId, title: "No" },
        apply => apply())).rejects.toThrow("不属于普通本机会话")
    }
    expect(db.getThreadCore(own.threadId)?.metadata).not.toContain("botWorkId")
  })

  it("keeps continuation on empty filtered pages and does not scan the entire directory in one call", async () => {
    const f = setup(), older = create("pagination-old")
    db.updateThread(older.threadId, { title: "Find this exact project" })
    for (let i = 0; i < 68; i++) create(`pagination-private-${i}`, { botId: "private" })
    let cursor: string | undefined, found: string[] = [], pages = 0
    do {
      const page = await f.service.list({ query: "Find this exact project", cursor })
      expect(page.scanned).toBeLessThanOrEqual(32)
      if (pages === 0) { expect(page.items).toEqual([]); expect(page.nextCursor).toBeTruthy() }
      found.push(...page.items.map(item => item.conversation.threadId)); pages++
      cursor = page.nextCursor ?? undefined
      expect(pages).toBeLessThan(20)
    } while (cursor)
    expect(found).toEqual([older.threadId]); expect(pages).toBeGreaterThan(2)
  })

  it("searches visible text and resolves the exact original message, without exposing tool logs or reasoning", async () => {
    const f = setup(), ref = create("read-ordinary")
    db.upsertThreadMessages(ref.threadId, [
      ...Array.from({ length: 50 }, (_, i) => message(`old-${i}`, i === 1 ? "Decision: seven days" : `Comment ${i}`)),
      message("private-tool", "private shell output", "tool"),
      message("answer", "<think>private reasoning</think>Confirmed decision", "assistant")
    ])
    let cursor: string | undefined, hit: Awaited<ReturnType<typeof f.service.read>>["entries"][number] | undefined
    do {
      const page = await f.service.read({ conversation: ref, query: "seven days", cursor })
      expect(page.scanned).toBeLessThanOrEqual(32)
      hit ??= page.entries[0]; cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(hit?.source.messageId).toBe("old-1")
    expect(parseBotThreadHistoryHref(hit!.href)).toEqual(hit!.source)
    expect(await f.service.resolve(hit!.source)).toMatchObject({ threadId: ref.threadId, messageId: "old-1" })
    const recent = await f.service.read({ conversation: ref })
    expect(JSON.stringify(recent)).not.toContain("private shell output")
    expect(JSON.stringify(recent)).not.toContain("private reasoning")
    expect(recent.coverage).toBe("more")
  })

  it("reports an unopened legacy transcript as incomplete until the workbench imports it", async () => {
    const { service } = setup()
    const ref = create("legacy-unopened")
    const query = "original deadline"
    const checkpointPath = createLegacyCheckpoint(ref.threadId, [
      { id: "legacy-user", type: "human", content: "Check the original deadline" }
    ])
    expect(db.getLegacyCheckpointMigrationStatus(ref.threadId)).toBeNull()
    for (const input of [{ conversation: ref }, { conversation: ref, query }]) {
      expect(await service.read(input)).toMatchObject({
        entries: [], coverage: "incomplete", nextCursor: null
      })
    }
    db.upsertThreadMessages(ref.threadId, [message("newer-user", "A newer update")])
    expect(await service.read({ conversation: ref })).toMatchObject({
      entries: [{ text: "A newer update" }], coverage: "incomplete", nextCursor: null
    })
    expect(await service.read({ conversation: ref, query })).toMatchObject({
      entries: [], coverage: "incomplete", nextCursor: null
    })
    expect(db.getLegacyCheckpointMigrationStatus(ref.threadId)).toBeNull()

    bootstrapLegacyCheckpointTranscript(
      checkpointPath, fixture.path, ref.threadId, "", new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    )
    expect(db.getLegacyCheckpointMigrationStatus(ref.threadId)).toBe("complete")
    expect(await service.read({ conversation: ref, query })).toMatchObject({
      entries: [{ source: { messageId: "legacy-user" } }]
    })
    expect(await service.read({ conversation: ref, query: "absent term" })).toMatchObject({
      entries: [], coverage: "exhausted", nextCursor: null
    })
  })

  it("keeps an unopened legacy transcript incomplete after linking the original conversation", async () => {
    const { host, store, owner, bind, close } = setupHistoryNavigation()
    try {
      const conversation = create("linked-legacy-history", { workspacePath: directory })
      const checkpointPath = createLegacyCheckpoint(conversation.threadId, [
        { id: "original-request", type: "human", content: "Check the original deadline" }
      ])
      const requester = host.send({ botId: owner.id, requestId: "find-legacy", message: "Read the original chat" })
      await vi.waitFor(() => expect(store.getTask(requester.id).state).toBe("running"))
      expect((await host.ordinaryThreadHistory(requester.id, { conversation })).coverage).toBe("incomplete")
      const work = bind(conversation)
      await expect(host.ordinaryThreadHistory(requester.id, { conversation })).rejects.toMatchObject({ code: "CONFLICT" })
      for (const input of [{ workId: work.id }, { workId: work.id, query: "original deadline" }]) {
        expect(await host.workHistory(requester.id, input)).toMatchObject({
          entries: [], coverage: "incomplete", nextCursor: null
        })
      }
      expect(db.getLegacyCheckpointMigrationStatus(conversation.threadId)).toBeNull()
      bootstrapLegacyCheckpointTranscript(
        checkpointPath, fixture.path, conversation.threadId, "", new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      )
      expect(await host.workHistory(requester.id, { workId: work.id })).toMatchObject({
        entries: [{ source: { messageId: "original-request" } }], coverage: "exhausted"
      })
    } finally {
      await close()
    }
  })

  it("can exhaust a genuinely empty conversation with or without a legacy checkpoint", async () => {
    const { service } = setup()
    const fresh = create("legacy-no-checkpoint"), empty = create("legacy-empty-checkpoint")
    createLegacyCheckpoint(empty.threadId, [])
    for (const conversation of [fresh, empty]) {
      expect(await service.read({ conversation })).toMatchObject({
        entries: [], coverage: "exhausted", nextCursor: null
      })
    }
  })

  it("rejects stale identity, arbitrary private targets and a scope change during asynchronous read", async () => {
    const f = setup(), ref = create("identity-original")
    db.upsertThreadMessages(ref.threadId, [message("same", "original text")])
    await expect(f.service.read({ conversation: { ...ref, incarnation: { ...ref.incarnation, token: "wrong" } } })).rejects.toThrow("已变化")
    const privateRef = create("identity-private", { botGroupId: "group" })
    await expect(f.service.read({ conversation: privateRef })).rejects.toThrow("已变化")
    fixture.afterRead = () => f.managed.add(ref.threadId)
    await expect(f.service.read({ conversation: ref })).rejects.toThrow("已变化")
  })

  it("binds cursors to target and query and refuses malformed or mixed exact-read requests", async () => {
    const f = setup(), ref = create("cursor-original"), other = create("cursor-other")
    db.upsertThreadMessages(ref.threadId, Array.from({ length: 45 }, (_, i) => message(`cursor-${i}`, "Original")))
    const page = await f.service.read({ conversation: ref, query: "missing" })
    expect(page.nextCursor).toBeTruthy()
    await expect(f.service.read({ conversation: other, query: "missing", cursor: page.nextCursor! })).rejects.toThrow("分页")
    await expect(f.service.read({ conversation: ref, query: "Original", cursor: page.nextCursor! })).rejects.toThrow("分页")
    await expect(f.service.read({ conversation: ref, messageId: "cursor-1", query: "Original" })).rejects.toThrow("混用")
    expect(parseBotThreadHistoryHref("#bot-thread-history/invalid")).toBeNull()
  })

  it("retains accepted Bot input decisions in a detached conversation without modifying the visible original", async () => {
    const f = setup(), ref = create("detached-ordinary")
    db.upsertThreadMessages(ref.threadId, [message("blocked", "HIDDEN SECRET"), message("edited", "HIDDEN SECRET"), message("reply", "Actual result", "assistant")])
    f.projections.set("blocked", null); f.projections.set("edited", "Accepted public input")
    expect((await f.service.read({ conversation: ref })).entries.map(entry => entry.text)).toEqual(["Accepted public input", "Actual result"])
    expect((await f.service.read({ conversation: ref, query: "HIDDEN SECRET" })).entries).toEqual([])
    expect((await f.service.read({ conversation: ref, query: "public input" })).entries[0].source.messageId).toBe("edited")
    await expect(f.service.resolve({ conversation: ref, messageId: "blocked" })).rejects.toThrow()
    expect(db.getThreadMessagesByIds(ref.threadId, ["edited"])[0].content).toBe("HIDDEN SECRET")
    expect(parseBotThreadHistoryHref(botThreadHistoryHref({ conversation: ref, messageId: "edited" }))).toEqual({ conversation: ref, messageId: "edited" })
  })

  it.each([false, true])("opens the original ordinary history source after linking it (another Bot=%s)", async anotherBot => {
    const { host, store, owner, bind, close } = setupHistoryNavigation()
    try {
      const conversation = create(`linked-history-original-${anotherBot}`, { workspacePath: directory })
      const messageId = "original-source-message"
      db.upsertThreadMessages(conversation.threadId, [message(messageId, "Original request")])
      const requester = host.send({ botId: owner.id, requestId: "find-ordinary", message: "Find the previous chat." })
      await vi.waitFor(() => expect(store.getTask(requester.id).state).toBe("running"))
      expect((await host.ordinaryThreads(requester.id, { query: conversation.threadId })).items)
        .toMatchObject([{ conversation }])
      const { entries } = await host.ordinaryThreadHistory(requester.id, { conversation, messageId })
      const source = parseBotThreadHistoryHref(entries[0].href)!
      const target = { threadId: conversation.threadId, messageId, ordinal: entries[0].ordinal }
      expect(source).toEqual({ conversation, messageId })
      expect(await host.resolveOrdinaryThreadSource(owner.id, source)).toEqual(target)

      const linkedOwner = anotherBot
        ? store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null }) : owner
      const work = bind(conversation, linkedOwner.id)
      expect(work.conversation).toMatchObject({ state: "bound", origin: "existing", ref: conversation })
      expect(await host.resolveOrdinaryThreadSource(owner.id, source)).toEqual(target)
      await expect(host.ordinaryThreadHistory(requester.id, { conversation, messageId })).rejects.toMatchObject({ code: "CONFLICT" })
      expect((await host.ordinaryThreads(requester.id, { query: conversation.threadId })).items).toEqual([])

      if (anotherBot) await expect(host.workHistory(requester.id, { workId: work.id, messageId })).rejects.toThrow()
      await expect(host.resolveOrdinaryThreadSource(owner.id, {
        ...source, conversation: { ...conversation, incarnation: { ...conversation.incarnation, token: "stale" } }
      })).rejects.toMatchObject({ code: "CONFLICT" })

      const rejected = store.enqueue({ botId: linkedOwner.id, workId: work.id, requestId: "blocked-input",
        message: "Input removed by submit policy" })
      store.transition(rejected.id, "running")
      store.beginInputPreparation(rejected.id)
      db.upsertThreadMessages(conversation.threadId, [message(rejected.requestId, rejected.message)])
      store.settle(rejected.id, "failed", null, undefined, undefined, false, { outcome: "error", code: "prompt_blocked" })
      expect(db.getThreadMessagesByIds(conversation.threadId, [rejected.requestId])[0]?.content).toBe(rejected.message)
      await expect(host.resolveOrdinaryThreadSource(owner.id, { ...source, messageId: rejected.requestId }))
        .rejects.toMatchObject({ code: "CONFLICT" })
    } finally {
      await close()
    }
  })

  it.each(["detaching", "deleting"] as const)("refuses an ordinary source while its linked work is %s", async state => {
    const { host, store, owner, bind, close } = setupHistoryNavigation()
    try {
      const conversation = create(`linked-history-${state}`, { workspacePath: directory })
      const messageId = `message-${state}`
      db.upsertThreadMessages(conversation.threadId, [message(messageId, "Original request")])
      const source = { conversation, messageId }
      expect(await host.resolveOrdinaryThreadSource(owner.id, source)).toMatchObject({ messageId })
      const work = bind(conversation)
      if (state === "detaching") store.conversations.beginDetach(owner.id, work.id, work.version)
      else store.beginWorkDeletion({
        botId: owner.id, workId: work.id, threadId: conversation.threadId,
        incarnation: conversation.incarnation, version: work.version
      })
      await expect(host.resolveOrdinaryThreadSource(owner.id, source)).rejects.toMatchObject({ code: "CONFLICT" })
    } finally {
      await close()
    }
  })

  it("hides the original creation title from Bot tools after unlink and Bot deletion", async () => {
    const controlDb = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(controlDb)
    const host = new LocalBotHost(store, {
      ordinaryThreads: createBotOrdinaryThreads(() => host),
      onAvailable: () => () => {},
      acquire: (_bot, task) => !task.workId && task.origin.kind === "user" ? {
        release() {},
        execute: signal => new Promise(resolve =>
          signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true }))
      } : null
    })
    setBotHistoryInputSource({
      works: threadId => host.desktopDeliveryWorks(threadId),
      inputs: (botId, threadId, ids, workIds) => store.inputProjections(botId, threadId, ids, workIds)
    })
    try {
      const owner = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
      const reader = store.create({ name: "Reader", instructions: "", color: "#123456", modelRef: null })
      const title = "Removed creation title"
      const { work, task } = store.createWork({ botId: owner.id, operationId: "original", title, goal: title })
      const ref = create(work.threadId, { title, workspacePath: "/original" })
      store.conversations.prepareCreated(owner.id, work.id, ref)
      store.conversations.bound(owner.id, work.id, ref)
      store.transition(task.id, "running")
      store.beginInputPreparation(task.id)
      store.recordPreparedInput(task.id, "Approved body")
      db.upsertThreadMessages(work.threadId, [message(task.requestId, task.message)])
      store.settle(task.id, "completed", null)
      store.conversations.beginDetach(owner.id, work.id, store.getWork(owner.id, work.id).version)
      store.conversations.detached(owner.id, work.id)

      const source = host.send({ botId: reader.id, requestId: "look-up", message: "Find the previous conversation." })
      await vi.waitFor(() => expect(store.getTask(source.id).state).toBe("running"))
      const tools = createBotWorkTools(source, () => host, new AbortController().signal)
      const invoke = (name: string, args: object, id = name) =>
        tools.find(tool => tool.name === name)!.invoke({ type: "tool_call", id, name, args })
      const assertProtected = async () => {
        const search = await invoke("bot_thread_list", { query: title }, "raw-title")
        expect(JSON.parse(search.content).receipt.items).toEqual([])
        const directory = await invoke("bot_thread_list", { query: "原任务" }, "model-title")
        expect(JSON.parse(directory.content).receipt.items).toMatchObject([{ conversation: ref, title: "原任务" }])
        const read = await invoke("bot_thread_read", { conversation: ref })
        expect(JSON.parse(read.content).receipt).toMatchObject({
          thread: { conversation: ref, title: "原任务" }, entries: [{ text: "Approved body" }]
        })
        expect(db.getThreadCore(work.threadId)?.title).toBe(title)
      }
      await assertProtected()
      store.finishDeletion(owner.id, store.beginDeletion(owner.id, owner.version))
      await assertProtected()

      const rename = { conversation: ref, title: "New title" }
      const hidden = await invoke("bot_thread_rename", {
        ...rename, expectedTitle: "原任务", requestKey: "hidden-title"
      }, "hidden-title")
      expect(hidden.status).toBe("error")
      expect(hidden.content).toContain("原工作台")
      expect(db.getThreadCore(work.threadId)?.title).toBe(title)
      const known = await invoke("bot_thread_rename", {
        ...rename, expectedTitle: title, requestKey: "explicit-title"
      }, "explicit-title")
      expect(known.status).not.toBe("error")
      expect(db.getThreadCore(work.threadId)?.title).toBe(rename.title)
    } finally {
      setBotHistoryInputSource(undefined)
      await host.stop()
      controlDb.close()
    }
  })
})
