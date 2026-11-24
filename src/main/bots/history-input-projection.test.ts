import assert from "node:assert/strict"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { BOT_FORK_DELIVERY_BOUNDARY, botHistoryHidesTitle, botHistoryInputProjection, botHistoricalMessageReader,
  botLegacyHistoryRequests, decorateBotHistoryPage, deleteBotThreadHistory, protectedBotHistoryTitle,
  setBotHistoryInputSource } from "./history-input-projection"
import { formatBotMessageReply } from "../../shared/bots/message-reply"
import type { BotMessageReply } from "../../shared/bots/contracts"
import { parseBotHistoryFileDelivery } from "../../shared/bots/file-delivery"
import { canonicalBotMessageInput } from "../../shared/bots/message-mentions"

afterEach(() => setBotHistoryInputSource(undefined))

it("offers retained delivery controls only for their exact native history, including detached and archived owners", async () => {
  const row = { created_at: 1, metadata: '{"cmb_thread_incarnation":"delivery"}' }
  const owner = { id: "work", botId: "bot", threadId: "native", audienceKey: "desktop", conversation: {
    state: "detached" as const, origin: "existing" as const,
    ref: { kind: "local_thread" as const, threadId: "native", incarnation: captureThreadIncarnation(row) }
  } }
  const message = { id: "delivered", role: "assistant" as const, content: "", created_at: new Date(),
    tool_calls: [{ id: "deliver", name: "bot_deliver_files", args: {} }] }
  const page: { messages: import("../types").Message[] } = { messages: [message] }
  setBotHistoryInputSource({ works: id => id === "native" ? [owner] : [], inputs: () => new Map() })
  const decorated = await decorateBotHistoryPage("native", page, () => row)
  const scope = decorated.messages[0].botHistoryDeliveryScope!
  const receipt = JSON.stringify({ kind: "bot-file-delivery", receiptThread: scope.receiptThread, receiptWorkId: "work",
    files: [{ filePath: "/project/report.md", name: "report.md", size: 2, attachmentPath: "/retained/report.md" }] })
  expect(parseBotHistoryFileDelivery(receipt, scope)).toHaveLength(1)
  const fork = await decorateBotHistoryPage("fork", page, () => ({ ...row, created_at: 2 }))
  expect(fork).toBe(page)
  expect(parseBotHistoryFileDelivery(receipt, fork.messages[0].botHistoryDeliveryScope)).toBeNull()
  expect(parseBotHistoryFileDelivery(receipt, { ...scope, workIds: ["new-owner"] })).toBeNull()
  expect(parseBotHistoryFileDelivery(receipt, { ...scope, receiptThread: "recreated-thread" })).toBeNull()
  expect(await decorateBotHistoryPage("native", page, () => ({ ...row, metadata: "{}" }))).toBe(page)
})

it("protects only initialized exact native work titles and preserves failed-rename protection", () => {
  const metadata = { botId: "bot", botWorkId: "work", botHostId: "local", botAudienceKey: "desktop", workspacePath: "/project" }
  const row = { created_at: 1, metadata: JSON.stringify(metadata), title: "Original derived title" }
  const owner = { id: "work", botId: "bot", threadId: "native", audienceKey: "desktop", workspace: { path: "/project" },
    omitResultTitle: true as const, threadInitialized: true as const, title: row.title }
  const install = (value = owner) => setBotHistoryInputSource({ works: () => [value], inputs: () => new Map() })
  install()
  expect(botHistoryHidesTitle("native", row)).toBe(true)
  expect(botHistoryHidesTitle("other", row)).toBe(false)
  expect(botHistoryHidesTitle("native", { ...row, metadata: JSON.stringify({ ...metadata, botWorkId: "other" }) })).toBe(false)
  setBotHistoryInputSource({ works: () => [{ ...owner, threadInitialized: undefined }], inputs: () => new Map() })
  expect(botHistoryHidesTitle("native", row)).toBe(false)
  setBotHistoryInputSource({ works: () => [{ ...owner, title: "Explicit new title", titleExplicitlyRenamed: true }], inputs: () => new Map() })
  expect(botHistoryHidesTitle("native", row)).toBe(true) // Bot commit alone does not prove native rename succeeded.
  expect(botHistoryHidesTitle("native", { ...row, title: "Explicit new title" })).toBe(false)
  const renamed = { ...row, title: "Later ordinary name", metadata: JSON.stringify({ ...metadata, ...protectedBotHistoryTitle(null) }) }
  expect(botHistoryHidesTitle("native", renamed)).toBe(false)
  const detached = { ...row, metadata: JSON.stringify(protectedBotHistoryTitle(row.title)) }
  expect(botHistoryHidesTitle("native", detached)).toBe(true)
  expect(botHistoryHidesTitle("native", { ...detached, title: "Ordinary sidebar name" })).toBe(false)
})

it("preserves legacy workspace snapshots for exact original owners and rejects copied Fork receipts", async () => {
  const row = { created_at: 1, metadata: '{"cmb_thread_incarnation":"legacy","workspacePath":"/workspace"}' }
  const owners = ["first", "next"].map(id => ({ id, botId: id, threadId: "original", audienceKey: "desktop", conversation: {
    state: "detached" as const, origin: "existing" as const,
    ref: { kind: "local_thread" as const, threadId: "original", incarnation: captureThreadIncarnation(row) }
  } }))
  setBotHistoryInputSource({ works: () => owners, inputs: () => new Map() })
  const receipt = JSON.stringify({ kind: "bot-file-delivery", files: [{ filePath: "/workspace/report.md",
    name: "report.md", size: 2, attachmentPath: `/workspace/.bot-deliveries/${"a".repeat(64)}/report.md` }] })
  const page: { messages: import("../types").Message[] } = { messages: [{ id: "sent", ordinal: 3, role: "assistant", content: "",
    created_at: new Date(1), tool_calls: [{ id: "deliver", name: "bot_deliver_files", args: {} }] }] }
  const original = (await decorateBotHistoryPage("original", page, () => row)).messages[0].botHistoryDeliveryScope
  expect(parseBotHistoryFileDelivery(receipt, original)).toHaveLength(1)
  const fork = { ...row, created_at: 2, metadata: JSON.stringify({ cmb_thread_incarnation: "fork", workspacePath: "/workspace",
    forkedFromThreadId: "original", [BOT_FORK_DELIVERY_BOUNDARY]: 5 }) }
  setBotHistoryInputSource({ works: id => id === "fork" ? [{ ...owners[0], id: "fork-work", threadId: id,
    conversation: { ...owners[0].conversation, ref: { ...owners[0].conversation.ref, threadId: id,
      incarnation: captureThreadIncarnation(fork) } } }] : owners, inputs: () => new Map() })
  const read = async (nativeRow = fork, ordinal = 3) => (await decorateBotHistoryPage("fork", {
    messages: [{ ...page.messages[0], ordinal }]
  }, () => nativeRow)).messages[0].botHistoryDeliveryScope
  expect((await read())?.workIds).toEqual(["fork-work"])
  expect(parseBotHistoryFileDelivery(receipt, await read())).toBeNull()
  expect(parseBotHistoryFileDelivery(receipt, await read(fork, 5))).toHaveLength(1)
  const modernSource = JSON.stringify({ ...JSON.parse(receipt), receiptThread: `thread-${"c".repeat(64)}`,
    receiptWorkId: "source-work" })
  expect(parseBotHistoryFileDelivery(modernSource, await read())).toBeNull()
  const unassociated = await decorateBotHistoryPage("another-fork", page, () => fork)
  expect(parseBotHistoryFileDelivery(receipt, unassociated.messages[0].botHistoryDeliveryScope)).toBeNull()
  expect(parseBotHistoryFileDelivery(receipt, await read({ ...row, metadata: "broken" }))).toBeNull()
})

it("reads exact verified reply origins before a native task is first opened", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    const reply = { id: "reference", ordinal: 0, role: "assistant" as const, text: "Old reference" }
    const store = new BotStore(db, Date.now, undefined, () => reply)
    const bot = store.create({ name: "Reader", instructions: "", color: "#123456", modelRef: null })
    const { work, task } = store.createWork({ botId: bot.id, operationId: "native-reply", title: "Review",
      goal: formatBotMessageReply("Current request", reply), explicitSkill: { name: "Review", path: "/skills/review/SKILL.md" } })
    store.initializeWorkThread(bot.id, work.id)
    store.transition(task.id, "running")
    store.recordPreparedInput(task.id, task.message)
    store.settle(task.id, "completed", null)
    const row = { created_at: 1, metadata: JSON.stringify({ cmb_thread_incarnation: "native-reply", botId: bot.id,
      botWorkId: work.id, botHostId: "local", botAudienceKey: "desktop", workspacePath: "/isolated/native-work" }) }
    setBotHistoryInputSource({ works: id => store.desktopDeliveryWorks(id), inputs: () => new Map(),
      origins: (id, incarnation, ids, nativeRow) => store.historicalMessageOrigins(id, incarnation, ids, true, nativeRow) })
    expect(store.getWork(bot.id, work.id).conversation).toBeUndefined()
    expect(task.origin).toMatchObject({ kind: "user", replyTo: { id: reply.id, sourceThreadId: bot.threadId } })
    const reader = botHistoricalMessageReader(work.threadId, () => row)!
    expect(reader([task.requestId, "unrelated"]).get(task.requestId)?.replyTo?.id).toBe(reply.id)
    expect(reader([task.requestId, "unrelated"]).has("unrelated")).toBe(false)
    expect(botHistoricalMessageReader(work.threadId, () => ({ ...row, metadata: "{}" }))).toBeUndefined()
    expect(store.historicalMessageOrigins(work.threadId, captureThreadIncarnation(row), [task.requestId], true)).toEqual([])
    expect(store.historicalMessageOrigins(work.threadId, captureThreadIncarnation(row), [task.requestId], true,
      { ...row, metadata: row.metadata.replace(work.id, "different-work") })).toEqual([])
  } finally { db.close() }
})

it("does not treat pre-association ordinary inputs as legacy Bot requests", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    let now = Date.now()
    const store = new BotStore(db, () => now)
    const bot = store.create({ name: "Reader", instructions: "", color: "#123456", modelRef: null })
    const row = { created_at: 1, metadata: '{"cmb_thread_incarnation":"original"}' }
    const ref = { kind: "local_thread" as const, threadId: "ordinary", incarnation: captureThreadIncarnation(row) }
    const work = store.conversations.prepare({ botId: bot.id, operationId: "link", conversation: ref,
      title: "Existing conversation", goal: "Continue" })
    store.conversations.bound(bot.id, work.id, ref)
    const task = store.enqueue({ botId: bot.id, workId: work.id, requestId: "bot-input", message: "Review" })
    store.transition(task.id, "running")
    store.settle(task.id, "completed", null)
    setBotHistoryInputSource({ works: id => store.desktopDeliveryWorks(id), inputs: () => new Map(),
      legacyRequests: (...args) => store.legacyHistoryRequests(...args) })
    expect(botLegacyHistoryRequests(ref.threadId, row, ["ordinary-input", task.requestId])).toEqual(new Set([task.requestId]))
    expect(botLegacyHistoryRequests(ref.threadId, { ...row, metadata: '{"cmb_thread_incarnation":"replacement"}' },
      [task.requestId])).toEqual(new Set())
    const warm = store.enqueue({ botId: bot.id, workId: work.id, requestId: "warm-input", message: "Still retained" })
    store.transition(warm.id, "running")
    store.settle(warm.id, "completed", null)
    store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
    store.conversations.detached(bot.id, work.id)

    // Exercise the existing 90-day receipt boundary without filling the whole recent tail.
    db.run(`INSERT INTO bot_task_receipts (request_id,bot_id,message_hash,finished_at,work_id)
      VALUES (?,?,?,?,?)`, ["receipt-input", bot.id, "opaque-hash", now, work.id])
    db.run(`INSERT INTO bot_task_receipts (request_id,bot_id,message_hash,finished_at,work_id)
      VALUES (?,?,?,?,?)`, ["pending-expiry", bot.id, "opaque-hash", now + 2 * 24 * 60 * 60 * 1000, work.id])
    now += 91 * 24 * 60 * 60 * 1000
    store.pruneTaskHistory()
    expect(botLegacyHistoryRequests(ref.threadId, row, ["ordinary-input", "receipt-input"])).toEqual(new Set(["receipt-input"]))
    const deletedThreads = store.beginDeletion(bot.id, bot.version)
    expect(deletedThreads).not.toContain(ref.threadId)
    store.finishDeletion(bot.id, deletedThreads)
    const ids = ["ordinary-input", "receipt-input", "pending-expiry", task.requestId, warm.requestId]
    expect(botLegacyHistoryRequests(ref.threadId, row, ids)).toEqual(new Set(ids.slice(1)))
    const archived = db.prepare("SELECT * FROM bot_legacy_work_requests WHERE request_id='receipt-input'")
    expect(archived.step()).toBe(true)
    expect(archived.getAsObject()).toEqual({
      work_id: work.id, request_id: "receipt-input"
    })
    archived.free()
    expect(deleteBotThreadHistory(db, [ref.threadId])).toBe(true)
    expect(db.exec("SELECT * FROM bot_legacy_work_requests")[0].values).toEqual([])
    expect(botLegacyHistoryRequests(ref.threadId, row, ids)).toEqual(new Set())
  } finally { db.close() }
})

it("keeps unconsumed input hidden when deleting its Bot preserves an existing conversation", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    const store = new BotStore(db)
    const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
    const ref = { kind: "local_thread" as const, threadId: "preserved-conversation",
      incarnation: { token: "preserved", legacyCreatedAt: 1 } }
    const work = store.conversations.prepare({ botId: bot.id, operationId: "link", conversation: ref,
      title: "Original task", goal: "Continue" })
    store.conversations.bound(bot.id, work.id, ref)
    const accepted = store.enqueue({ botId: bot.id, workId: work.id, requestId: "accepted", message: "Original instruction" })
    store.transition(accepted.id, "running")
    store.recordPreparedInput(accepted.id, "Actually accepted instruction")
    store.settle(accepted.id, "cancelled", null)
    const pending = store.enqueue({ botId: bot.id, workId: work.id, requestId: "pending", message: "Unconsumed instruction" })
    store.beginInputPreparation(pending.id)
    store.recordPreparedInput(pending.id, "Prepared but never consumed")
    const deletedThreads = store.beginDeletion(bot.id, bot.version)
    expect(deletedThreads).not.toContain(ref.threadId)
    // The production removal callback unlinks original conversations before final cleanup.
    store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
    store.conversations.detached(bot.id, work.id)
    store.finishDeletion(bot.id, deletedThreads)
    expect(new BotStore(db).inputProjections(bot.id, ref.threadId, [accepted.requestId, pending.requestId], [work.id]))
      .toEqual(new Map([[accepted.requestId, "Actually accepted instruction"], [pending.requestId, null]]))
  } finally { db.close() }
})

it("adds display metadata only for exact Bot-owned native pages, leaving ordinary history and input text unchanged", async () => {
  const row = { created_at: 1, metadata: '{"cmb_thread_incarnation":"same"}' }
  const owner = { id: "work", botId: "bot", threadId: "native", audienceKey: "desktop", conversation: {
    state: "bound" as const, origin: "existing" as const,
    ref: { kind: "local_thread" as const, threadId: "native", incarnation: captureThreadIncarnation(row) }
  } }
  const origin = { kind: "user" as const, explicitSkill: { name: "Review", path: "/skills/review/SKILL.md" },
    replyTo: { id: "old", ordinal: 1, role: "assistant" as const, sourceThreadId: "prior-bot" } }
  const origins = vi.fn(() => [{ id: "task", requestId: "input", state: "completed" as const, origin }])
  setBotHistoryInputSource({ works: id => id === "native" ? [owner] : [], inputs: () => new Map(), origins })
  const content = formatBotMessageReply("New instruction", { ...origin.replyTo, text: "Old context" })
  const message = { id: "input", role: "user" as const, content, created_at: new Date(1) }
  const page = { messages: [message, { ...message, id: "assistant", role: "assistant" as const }] }
  const readRow = vi.fn(() => row)
  expect(await decorateBotHistoryPage("ordinary", page, readRow)).toBe(page)
  expect(origins).not.toHaveBeenCalled()
  expect(readRow).not.toHaveBeenCalled()
  const display = await decorateBotHistoryPage("native", page, readRow)
  expect(display.messages[0]).toEqual({ ...message, botHistoryInputOrigin: {
    explicitSkill: origin.explicitSkill, replyTo: { id: "old", ordinal: 1, role: "assistant" }
  } })
  expect(page.messages[0]).toBe(message)
  expect(display.messages[0].content).toBe(content)
  expect(display.messages[1]).toBe(page.messages[1])
  expect(botHistoricalMessageReader("native", () => ({ ...row, metadata: '{"cmb_thread_incarnation":"other"}' }))).toBeUndefined()
  setBotHistoryInputSource(undefined)
  expect(await decorateBotHistoryPage("native", page, readRow)).toBe(page)
})

it.each(["completed", "failed", "cancelled", "interrupted", "superseded", "outcome_unknown"] as const)("clears deleted %s native input before warm history can archive it, preserving receipts and unrelated work", terminal => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  let now = 1000
  const store = new BotStore(db, () => ++now)
  try {
    const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const items = ["deleted", "retained", "bound"].map(threadId => {
      const ref = { kind: "local_thread" as const, threadId, incarnation: { token: threadId, legacyCreatedAt: 1 } }
      const work = store.conversations.prepare({ botId: bot.id, operationId: threadId, conversation: ref, title: threadId, goal: "Check" })
      store.conversations.bound(bot.id, work.id, ref)
      const skill = { name: "Review", path: "/skills/review/SKILL.md" }
      const task = store.enqueue({ botId: bot.id, workId: work.id, requestId: threadId,
        message: "original input", explicitSkill: skill })
      store.transition(task.id, "running")
      store.recordPreparedInput(task.id, "admitted input")
      store.transition(task.id, terminal)
      if (threadId !== "bound") {
        store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
        store.conversations.detached(bot.id, work.id)
      }
      return { ref, work, task, skill }
    })
    const [deleted, retained, bound] = items
    expect(store.historicalMessageOrigins(deleted.ref.threadId, deleted.ref.incarnation, [deleted.task.requestId])[0]?.origin)
      .toEqual({ kind: "user", explicitSkill: deleted.skill })
    expect(store.historicalMessageOrigins(deleted.ref.threadId, { ...deleted.ref.incarnation, token: "recreated" }, [deleted.task.requestId])).toEqual([])
    expect(store.historicalMessageOrigins(bound.ref.threadId, bound.ref.incarnation, [bound.task.requestId])).toEqual([])
    expect(store.historicalMessageOrigins(deleted.ref.threadId, deleted.ref.incarnation, [retained.task.requestId])).toEqual([])
    const hash = createHash("sha256").update(canonicalBotMessageInput(deleted.task.message, undefined, undefined, deleted.skill)).digest("hex")
    store.removeMessageReactionsForThreads([deleted.ref.threadId, bound.ref.threadId])
    expect(db.exec("SELECT message,prepared_input,origin_json FROM bot_tasks WHERE id=?", [deleted.task.id])[0].values)
      .toEqual([["", null, '{"kind":"user"}']])
    expect(db.exec("SELECT message_hash FROM bot_task_receipts WHERE request_id=?", [deleted.task.requestId])[0].values).toEqual([[hash]])
    for (const keep of [retained, bound]) {
      expect(store.getTask(keep.task.id).message).toBe("original input")
      expect(store.getTask(keep.task.id).origin).toMatchObject({ kind: "user", explicitSkill: keep.skill })
      expect(store.getWork(bot.id, keep.work.id).id).toBe(keep.work.id)
    }
    now += 32 * 86400000
    for (let i = 0; i < 101; i++) {
      const later = store.enqueue({ botId: bot.id, requestId: `later-${i}`, message: "Later" })
      store.transition(later.id, "running")
      store.transition(later.id, "completed")
    }
    expect(store.pruneTaskHistory()).toBeGreaterThan(0)
    expect(db.exec("SELECT id FROM bot_exchange_archive WHERE request_id=?", [deleted.task.requestId])[0]?.values ?? []).toEqual([])
    expect(db.exec("SELECT message_hash FROM bot_task_receipts WHERE request_id=?", [deleted.task.requestId])[0].values).toEqual([[hash]])
    expect(store.historicalMessageOrigins(retained.ref.threadId, retained.ref.incarnation, [retained.task.requestId])[0]?.origin)
      .toEqual({ kind: "user", explicitSkill: retained.skill })
  } finally { db.close() }
})

it.each([
  { token: "native", same: true }, { token: "native", same: false },
  { token: null, same: true }, { token: null, same: false }
])("recovers only matching native skill origins across Bot rebind (token=$token, same=$same)", ({ token, same }) => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  try {
    const a = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const b = store.create({ name: "B", instructions: "", color: "#654321", modelRef: null })
    const ref = { kind: "local_thread" as const, threadId: "original", incarnation: { token, legacyCreatedAt: 1 } }
    const first = store.conversations.prepare({ botId: a.id, operationId: "original", conversation: ref, title: "Original", goal: "Review" })
    store.conversations.bound(a.id, first.id, ref)
    const explicitSkill = { name: "Review", path: "/skills/review/SKILL.md" }
    const input = store.enqueue({ botId: a.id, workId: first.id, requestId: "skill", message: "Review", explicitSkill })
    store.transition(input.id, "running")
    store.recordPreparedInput(input.id, input.message)
    store.transition(input.id, "completed")
    store.conversations.beginDetach(a.id, first.id, store.getWork(a.id, first.id).version)
    store.conversations.detached(a.id, first.id)
    const nextRef = { ...ref, incarnation: { token: !same && token ? "recreated" : token, legacyCreatedAt: same ? 1 : 2 } }
    const next = store.conversations.prepare({ botId: b.id, operationId: "new-owner", conversation: nextRef, title: "Original", goal: "Continue" })
    store.conversations.bound(b.id, next.id, nextRef)
    const read = () => store.messageOrigins(b.id, [input.requestId], undefined, next.id)
    if (same) expect(read()[0]?.origin).toEqual({ kind: "user", explicitSkill })
    else expect(read()).toEqual([])
    expect(store.messageOrigins(b.id, [input.requestId])).toEqual([])
    expect(store.messageOrigins(b.id, [input.requestId], undefined, next.id, false)).toEqual([])
    store.conversations.beginDetach(b.id, next.id, store.getWork(b.id, next.id).version)
    store.conversations.detached(b.id, next.id)
    expect(read()).toEqual([])
  } finally { db.close() }
})

it.each([
  { archived: false, rewritten: false }, { archived: false, rewritten: true },
  { archived: true, rewritten: false }, { archived: true, rewritten: true }
])("keeps exact skill editing metadata when the previous owner is deleted (archived=$archived, rewritten=$rewritten)", ({ archived, rewritten }) => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  let now = 1000
  const store = new BotStore(db, () => now)
  try {
    const a = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const b = store.create({ name: "B", instructions: "", color: "#654321", modelRef: null })
    const ref = { kind: "local_thread" as const, threadId: "original", incarnation: { token: "original", legacyCreatedAt: 1 } }
    const first = store.conversations.prepare({ botId: a.id, operationId: "original", conversation: ref, title: "Original", goal: "Review" })
    store.conversations.bound(a.id, first.id, ref)
    const explicitSkill = { name: "Review", path: "/skills/review/SKILL.md" }
    const input = store.enqueue({ botId: a.id, workId: first.id, requestId: "skill", message: "Review", explicitSkill })
    store.transition(input.id, "running")
    store.recordPreparedInput(input.id, rewritten ? "Allowed review" : input.message)
    store.transition(input.id, "completed")
    if (archived) {
      for (let i = 0; i < 101; i++) {
        now++
        const later = store.enqueue({ botId: a.id, workId: first.id, requestId: `later-${i}`, message: "Later" })
        store.transition(later.id, "running")
        store.transition(later.id, "completed")
      }
      now += 32 * 86400000
      expect(store.pruneTaskHistory()).toBeGreaterThan(0)
    }
    store.conversations.beginDetach(a.id, first.id, store.getWork(a.id, first.id).version)
    store.conversations.detached(a.id, first.id)
    const next = store.conversations.prepare({ botId: b.id, operationId: "new-owner", conversation: ref, title: "Original", goal: "Continue" })
    store.conversations.bound(b.id, next.id, ref)
    const verify = () => expect(store.messageOrigins(b.id, [input.requestId], undefined, next.id)[0]?.origin)
      .toEqual({ kind: "user", explicitSkill })
    verify()
    store.finishDeletion(a.id, store.beginDeletion(a.id, store.getBot(a.id).version))
    verify()
    expect(store.inputProjections(a.id, ref.threadId, [input.requestId], [first.id]).get(input.requestId))
      .toBe(rewritten ? "Allowed review" : undefined)
    store.removeMessageReactionsForThreads([ref.threadId])
    expect(store.messageOrigins(b.id, [input.requestId], undefined, next.id)).toEqual([])
  } finally { db.close() }
})

it("cleans skill-only origins when their detached native conversation is deleted", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  let now = 1000
  const store = new BotStore(db, () => now)
  try {
    const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const ref = { kind: "local_thread" as const, threadId: "skill-thread", incarnation: captureThreadIncarnation({
      created_at: 1, metadata: '{"cmb_thread_incarnation":"skill-thread"}' }) }
    const work = store.conversations.prepare({ botId: bot.id, operationId: "link-skill", conversation: ref, title: "Original", goal: "Check" })
    store.conversations.bound(bot.id, work.id, ref)
    const skillTask = store.enqueue({ botId: bot.id, workId: work.id, requestId: "skill-only", message: "Check",
      explicitSkill: { name: "Review", path: "/skills/review/SKILL.md" } })
    store.transition(skillTask.id, "running")
    store.beginInputPreparation(skillTask.id)
    store.recordPreparedInput(skillTask.id, "Check")
    store.transition(skillTask.id, "completed")
    for (let i = 0; i < 101; i++) {
      now++
      const task = store.enqueue({ botId: bot.id, workId: work.id, requestId: `later-${i}`, message: "Later" })
      store.transition(task.id, "running")
      store.transition(task.id, "completed")
    }
    now += 32 * 86400000
    expect(store.pruneTaskHistory()).toBeGreaterThan(0)
    expect(db.exec("SELECT id FROM bot_exchange_archive WHERE id=?", [skillTask.id])[0]?.values ?? []).toHaveLength(1)
    store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
    store.conversations.detached(bot.id, work.id)
    store.removeMessageReactionsForThreads(["unrelated"])
    expect(db.exec("SELECT id FROM bot_exchange_archive WHERE id=?", [skillTask.id])[0]?.values ?? []).toHaveLength(1)
    store.removeMessageReactionsForThreads([ref.threadId])
    expect(db.exec("SELECT id FROM bot_exchange_archive WHERE id=?", [skillTask.id])[0]?.values ?? []).toHaveLength(0)
  } finally { db.close() }
})

it.each([{ size: 12, rewritten: false }, { size: 7900, rewritten: false },
  { size: 12, rewritten: true }, { size: 7900, rewritten: true }])("preserves the selected admitted reply body after unlink and owner deletion ($size quoted, rewritten=$rewritten)", ({ size, rewritten }) => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const parent: BotMessageReply = { id: "answer", ordinal: 1, role: "assistant", text: "A".repeat(size) }
  const messages = new Map([[parent.id, parent]])
  let now = 1000
  const row = { created_at: 1, metadata: '{"cmb_thread_incarnation":"reply-thread"}' }
  const store = new BotStore(db, () => now,
    (_thread, ids) => new Map(ids.flatMap(id => messages.has(id) ? [[id, messages.get(id)!.text]] : [])),
    (thread, id) => {
      const message = messages.get(id)
      if (!message || message.role !== "user") return message ?? null
      const body = botHistoryInputProjection(thread, row)?.([id], "reply").get(id)
      return body === null ? null : { ...message, text: body ?? message.text }
    })
  try {
    const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const ref = { kind: "local_thread" as const, threadId: "reply-thread", incarnation: captureThreadIncarnation(row) }
    const work = store.conversations.prepare({ botId: bot.id, operationId: "link", conversation: ref, title: "Original", goal: "Continue" })
    store.conversations.bound(bot.id, work.id, ref)
    const body = "Please independently verify this."
    const accepted = formatBotMessageReply(body, parent)
    for (const id of ["archived", "live"]) {
      const task = store.enqueue({ botId: bot.id, workId: work.id, requestId: id,
        message: formatBotMessageReply(rewritten ? "Old terminology" : body, parent), replyToId: parent.id })
      store.transition(task.id, "running")
      store.beginInputPreparation(task.id)
      store.recordPreparedInput(task.id, accepted)
      store.settle(task.id, "completed", null)
      messages.set(id, { id, ordinal: 2, role: "user", text: task.message })
      if (id === "archived") {
        for (let i = 0; i < 101; i++) {
          const later = store.enqueue({ botId: bot.id, requestId: `later-${i}`, message: "Later" })
          store.transition(later.id, "running")
          store.settle(later.id, "completed", null)
        }
        now += 32 * 86400000
        expect(store.pruneTaskHistory()).toBeGreaterThan(0)
      }
    }
    store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
    store.conversations.detached(bot.id, work.id)
    setBotHistoryInputSource({ works: id => store.desktopDeliveryWorks(id),
      inputs: (botId, id, ids, workIds, purpose) => store.inputProjections(botId, id, ids, workIds, purpose) })
    const next = store.create({ name: "B", instructions: "", color: "#234567", modelRef: null })
    const rebound = store.conversations.prepare({ botId: next.id, operationId: "relink", conversation: ref, title: "Original", goal: "Continue" })
    store.conversations.bound(next.id, rebound.id, ref)
    const verify = () => {
      const projection = botHistoryInputProjection(ref.threadId, row)!
      if (rewritten)
        expect(projection(["live", "archived"])).toEqual(new Map([["archived", accepted], ["live", accepted]]))
      else expect(projection(["live", "archived"])).toEqual(new Map())
      expect(projection(["live", "archived"], "reply")).toEqual(new Map([["archived", body], ["live", body]]))
      expect(store.messageReply(next.id, "live", rebound.id).text).toBe(body)
      expect(store.messageReply(next.id, "archived", rebound.id).text).toBe(body)
      for (const id of ["live", "archived"]) {
        expect(store.messageOrigins(next.id, [id], undefined, rebound.id)[0]?.origin).toEqual({
          kind: "user", replyTo: { id: parent.id, ordinal: parent.ordinal, role: parent.role }
        })
      }
    }
    verify()
    const deleted = store.beginDeletion(bot.id, bot.version)
    store.finishDeletion(bot.id, deleted)
    verify()
    store.removeMessageReactionsForThreads([ref.threadId])
    expect(store.inputProjections(bot.id, ref.threadId, ["live", "archived"], [work.id], "reply")).toEqual(new Map())
  } finally { db.close() }
})

it("peels only the trusted reply envelope, retaining literal nested text and mismatched identities", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const parent: BotMessageReply = { id: "answer", ordinal: 1, role: "assistant", text: "Earlier answer" }
  const messages = new Map([[parent.id, parent]])
  const store = new BotStore(db, Date.now, undefined, (_thread, id) => messages.get(id) ?? null)
  try {
    const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const nested = formatBotMessageReply("Literal example", parent)
    for (const [id, accepted, expected] of [
      ["nested", formatBotMessageReply(nested, parent), nested],
      ["id", formatBotMessageReply("Other", { ...parent, id: "other" }), undefined],
      ["ordinal", formatBotMessageReply("Other", { ...parent, ordinal: 9 }), undefined],
      ["role", formatBotMessageReply("Other", { ...parent, role: "user" }), undefined],
      ["denied", null, null]
    ] as const) {
      const task = store.enqueue({ botId: bot.id, requestId: id, message: formatBotMessageReply("Follow up", parent), replyToId: parent.id })
      store.transition(task.id, "running")
      store.beginInputPreparation(task.id)
      if (accepted !== null) store.recordPreparedInput(task.id, accepted)
      store.settle(task.id, accepted === null ? "failed" : "completed", null)
      expect(store.inputProjections(bot.id, bot.threadId, [id]).get(id)).toBe(accepted)
      expect(store.inputProjections(bot.id, bot.threadId, [id], undefined, "reply").get(id)).toBe(expected === undefined ? accepted : expected)
    }
  } finally { db.close() }
})

it("retains admitted input across unlink and mode changes, without touching another thread incarnation", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    const store = new BotStore(db)
    const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const row = { created_at: 10, metadata: JSON.stringify({ cmb_thread_incarnation: "original" }) }
    const ref = { kind: "local_thread" as const, threadId: "original", incarnation: captureThreadIncarnation(row) }
    const work = store.conversations.prepare({ botId: bot.id, operationId: "link", conversation: ref,
      title: "Original", goal: "Continue" })
    store.conversations.bound(bot.id, work.id, ref)
    for (const [id, admitted] of [["blocked", null], ["rewritten", "APPROVED"]] as const) {
      const task = store.enqueue({ botId: bot.id, workId: work.id, requestId: id, message: "REMOVED" })
      store.transition(task.id, "running")
      store.beginInputPreparation(task.id)
      if (admitted !== null) store.recordPreparedInput(task.id, admitted)
      store.settle(task.id, admitted === null ? "failed" : "completed", null)
    }
    store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
    store.conversations.detached(bot.id, work.id)
    setBotHistoryInputSource({ works: id => store.desktopDeliveryWorks(id), inputs: (botId, id, ids, workIds) => store.inputProjections(botId, id, ids, workIds) })
    const restored = botHistoryInputProjection("original", row)
    expect(restored?.(["blocked", "rewritten", "unrelated"])).toEqual(new Map([["blocked", null], ["rewritten", "APPROVED"]]))
    expect(botHistoryInputProjection("original", { ...row, metadata: JSON.stringify({ cmb_thread_incarnation: "original", agentMode: "workflow" }) })?.(["rewritten"])).toEqual(new Map([["rewritten", "APPROVED"]]))
    expect(botHistoryInputProjection("other", row)).toBeUndefined()
    expect(botHistoryInputProjection("original", { ...row, metadata: JSON.stringify({ cmb_thread_incarnation: "replacement" }) })).toBeUndefined()
    const next = store.create({ name: "B", instructions: "", color: "#234567", modelRef: null })
    const rebound = store.conversations.prepare({ botId: next.id, operationId: "relink", conversation: ref,
      title: "Original", goal: "Continue" })
    store.conversations.bound(next.id, rebound.id, ref)
    const ids = ["blocked", "rewritten"]
    const decisions = new Map([["blocked", null], ["rewritten", "APPROVED"]])
    expect(botHistoryInputProjection("original", row, { botId: next.id, workId: rebound.id })?.(ids)).toEqual(decisions)
    const deletedThreads = store.beginDeletion(bot.id, bot.version)
    expect(deletedThreads).not.toContain(ref.threadId)
    store.finishDeletion(bot.id, deletedThreads)
    expect(() => store.getBot(bot.id)).toThrow()
    expect(() => store.getWork(bot.id, work.id)).toThrow()
    expect(store.conversations.forThread(ref.threadId)?.id).toBe(rebound.id)
    expect(botHistoryInputProjection("original", row, { botId: next.id, workId: rebound.id })?.(ids)).toEqual(decisions)
    expect(botHistoryInputProjection("original", row)?.(ids)).toEqual(decisions)
    store.conversations.beginDetach(next.id, rebound.id, store.getWork(next.id, rebound.id).version)
    store.conversations.detached(next.id, rebound.id)
    store.removeMessageReactionsForThreads(["original"])
    expect(store.archivedDeliveryWork(bot.id, work.id)).toBeUndefined()
    expect(store.inputProjections(bot.id, "original", ids, [work.id])).toEqual(new Map())
    expect(() => store.getWork(next.id, rebound.id)).toThrow()
    expect(botHistoryInputProjection("original", row)).toBeUndefined()
    setBotHistoryInputSource(undefined)
    expect(botHistoryInputProjection("original", row)).toBeUndefined()
  } finally { db.close() }
})

it("cleans cold attachment and mention identities without discarding idempotency receipts", () => {
const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
let now = 10_000
try {
  const store = new BotStore(db, () => ++now)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const peer = store.create({ name: "Peer", instructions: "", color: "#654321", modelRef: null })
  const ref = {
    kind: "local_thread" as const,
    threadId: "cold-input-thread",
    incarnation: { token: "cold-input-thread", legacyCreatedAt: 1 }
  }
  const work = store.conversations.prepare({
    botId: bot.id,
    operationId: "link",
    conversation: ref,
    title: "Original",
    goal: "Check"
  })
  store.conversations.bound(bot.id, work.id, ref)
  const attachment = store.retainInputFile(
    bot.id,
    { filename: "sample.txt", filePath: "/editable/sample.txt", content: "selected bytes",
      size: 14, mimeType: "text/plain", truncated: false },
    "/fixture/.bot-deliveries/" + "a".repeat(64) + "/sample.txt",
    work.id
  )
  assert.ok(attachment.botInputId)
  const cases = [
    {
      requestId: "file-only-cancelled",
      message: "Please check" + buildAttachmentMessageParts([attachment]).attachmentModelBlocks,
      inputFileIds: [attachment.botInputId],
      originKey: "inputFileIds"
    },
    {
      requestId: "mention-only-cancelled",
      message: "@Peer please check",
      mentions: [{ botId: peer.id, start: 0, end: 5, label: "Peer" }],
      originKey: "mentions"
    }
  ]
  for (const { originKey, ...input } of cases) {
    const task = store.enqueue({ ...input, botId: bot.id, workId: work.id })
    store.transition(task.id, "cancelled")
  }
  now += 32 * 86_400_000
  for (let i = 0; i < 101; i++) {
    const next = store.enqueue({ botId: bot.id, requestId: "later-" + i, message: "Later" })
    store.transition(next.id, "cancelled")
  }
  assert.ok(store.pruneTaskHistory() > 0)

  const archive = (requestId: string) => db.exec(
    "SELECT message, origin_json, input_projection FROM bot_exchange_archive WHERE request_id=?",
    [requestId]
  )[0]?.values ?? []
  const receipt = (requestId: string) => db.exec(
    "SELECT message_hash FROM bot_task_receipts WHERE request_id=?", [requestId]
  )[0].values[0][0]
  for (const { requestId, message, mentions, inputFileIds, originKey } of cases) {
    const [[body, origin, projection]] = archive(requestId)
    assert.equal(body, null)
    assert.equal(projection, "null", "An input cancelled before dispatch retains an explicit denied projection")
    assert.ok(JSON.parse(String(origin))[originKey]?.length)
    assert.equal(receipt(requestId), createHash("sha256")
      .update(canonicalBotMessageInput(message, mentions, inputFileIds)).digest("hex"))
  }
  const receiptHashes = cases.map(({ requestId }) => receipt(requestId))
  store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
  store.conversations.detached(bot.id, work.id)
  store.removeMessageReactionsForThreads([ref.threadId])
  assert.equal(db.exec("SELECT COUNT(*) FROM bot_input_files WHERE id=?", [attachment.botInputId])[0].values[0][0], 0)
  assert.deepEqual(cases.map(({ requestId }) => receipt(requestId)), receiptHashes)
  const surviving = cases.flatMap(({ requestId, originKey }) => archive(requestId)
    .filter(([, origin]) => JSON.parse(String(origin))[originKey]?.length)
    .map(([, origin]) => ({ requestId, originKey, origin: JSON.parse(String(origin)) })))
  assert.deepEqual(surviving, [], "Native deletion must erase cold input identities")
} finally {
  db.close()
}

})

it("clears deleted queued work previews and both receipt shapes without erasing newer work or activity clocks", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null })
  try {
    const source = store.enqueue({ botId: bot.id, requestId: "main", message: "Keep the original main request" })
    store.transition(source.id, "running")
    store.recordPreparedInput(source.id, source.message)
    const aInput = { botId: bot.id, operationId: "a", title: "A", goal: "Private first work input" }
    const a = await host.createWork(aInput)
    const renameCommand = { taskId: source.id, callId: "rename", key: "rename" }
    store.renameWork(renameCommand, a.work.id, a.work.version, "Renamed A")
    const bInput = { botId: bot.id, operationId: "b", title: "B", goal: "Private second work input" }
    const b = await host.createWork(bInput)
    const activity = (kind: string, id: string) => db.exec(
      "SELECT version,attention_version,seen_version,updated_at,preview FROM bot_activity WHERE kind=? AND id=?", [kind, id])[0].values[0]
    const aClock = activity("work", a.work.id)
    const bClock = activity("work", b.work.id)
    const aggregate = activity("work-bot", bot.id)
    const remove = async (workId: string) => {
      const work = store.getWork(bot.id, workId)
      expect(await host.removeWork({ botId: bot.id, workId, threadId: work.threadId,
        version: work.version, incarnation: null }, async (_read, ready) => { ready(); return undefined }, () => {}))
        .toMatchObject({ state: "deleted" })
    }
    await remove(a.work.id)
    expect(activity("work", a.work.id)).toEqual([...aClock.slice(0, 4), ""])
    expect(activity("work-bot", bot.id)).toEqual(aggregate)
    expect(activity("work", b.work.id)).toEqual(bClock)
    expect(store.getWork(bot.id, a.work.id).activity?.preview).toBe("")
    expect(store.workCreationReceipt(aInput)?.work).toMatchObject({ goal: "", activity: { preview: "" } })
    const renamed = JSON.parse(String(db.exec("SELECT receipt FROM bot_work_commands WHERE command_id=?",
      [`tool:${source.id}:rename`])[0].values[0][0]))
    expect(renamed).toMatchObject({ id: a.work.id, title: "Renamed A", goal: "", activity: { preview: "" } })
    await remove(b.work.id)
    expect(activity("work", b.work.id)).toEqual([...bClock.slice(0, 4), ""])
    expect(activity("work-bot", bot.id)).toEqual([...aggregate.slice(0, 4), ""])
    expect(store.workCreationReceipt(bInput)?.work.activity?.preview).toBe("")
    expect(store.getTask(source.id).message).toBe(source.message)
  } finally { await host.stop(); db.close() }
})

it.each(["uninitialized", "created", "existing"] as const)("clears exact inputs after a fenced %s work deletion, retaining the retry receipt", kind => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  let now = 1000
  const store = new BotStore(db, () => ++now)
  try {
    const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
    const skill = { name: "Review", path: "/skills/review/SKILL.md" }
    const input = { botId: bot.id, operationId: "create", title: "Task", goal: "Private first input", explicitSkill: skill }
    const created = kind === "existing" ? undefined : store.createWork(input)
    const ref = { kind: "local_thread" as const, threadId: created?.work.threadId ?? "existing",
      incarnation: { token: "original", legacyCreatedAt: 1 } }
    const work = created?.work ?? store.conversations.prepare({ botId: bot.id, operationId: "link",
      title: "Task", goal: input.goal, conversation: ref })
    if (kind === "created") store.conversations.prepareCreated(bot.id, work.id, ref)
    if (kind !== "uninitialized") store.conversations.bound(bot.id, work.id, ref)
    const cold = created?.task ?? store.enqueue({ botId: bot.id, workId: work.id, requestId: "first",
      message: input.goal, explicitSkill: skill })
    store.transition(cold.id, "running")
    store.recordPreparedInput(cold.id, "Approved first input")
    store.transition(cold.id, "cancelled")
    now += 32 * 86400000
    for (let i = 0; i < 101; i++) {
      const tail = store.enqueue({ botId: bot.id, requestId: `tail-${i}`, message: "Unrelated main input" })
      store.transition(tail.id, "cancelled")
    }
    store.pruneTaskHistory()
    expect(db.exec("SELECT input_projection FROM bot_exchange_archive WHERE id=?", [cold.id])[0].values)
      .toEqual([[JSON.stringify("Approved first input")]])
    const warm = store.enqueue({ botId: bot.id, workId: work.id, requestId: "second", message: "Private second input", explicitSkill: skill })
    store.transition(warm.id, "running")
    store.recordPreparedInput(warm.id, "Approved second input")
    store.transition(warm.id, "cancelled")
    const fingerprint = createHash("sha256").update(canonicalBotMessageInput(warm.message, undefined, undefined, skill)).digest("hex")
    const stopping = store.beginWorkDeletion({ botId: bot.id, workId: work.id, threadId: work.threadId,
      version: store.getWork(bot.id, work.id).version, incarnation: kind === "uninitialized" ? null : ref.incarnation })
    if (kind === "existing") {
      store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
      store.conversations.detached(bot.id, work.id)
    }
    const ready = store.advanceWorkDeletion(stopping, "ready")
    expect(store.getTask(warm.id).message).toBe(warm.message)
    // The normal native post-commit callback deliberately retains the deletion fence.
    if (kind !== "uninitialized") store.removeMessageReactionsForThreads([work.threadId])
    expect(store.getWork(bot.id, work.id).id).toBe(work.id)
    const restarted = new BotStore(db, () => ++now)
    restarted.advanceWorkDeletion(ready, "deleted")
    expect(restarted.getWork(bot.id, work.id)).toMatchObject({ deletionCommitted: true, goal: "" })
    expect(restarted.getTask(warm.id)).toMatchObject({ message: "", origin: { kind: "user" } })
    expect(db.exec("SELECT prepared_input,input_preparation_required FROM bot_tasks WHERE id=?", [warm.id])[0].values).toEqual([[null, 0]])
    expect(restarted.messageOrigins(bot.id, [cold.requestId, warm.requestId], undefined, work.id)).toEqual([])
    expect(db.exec("SELECT id FROM bot_exchange_archive WHERE id=?", [cold.id])[0]?.values ?? []).toEqual([])
    expect(db.exec("SELECT message_hash FROM bot_task_receipts WHERE request_id=?", [warm.requestId])[0].values).toEqual([[fingerprint]])
    expect(restarted.recentTasks(true).filter(task => task.requestId.startsWith("tail-")).every(task => task.message === "Unrelated main input")).toBe(true)
    if (created) {
      const retry = restarted.workCreationReceipt(input)!
      expect(retry.work.goal).toBe("")
      expect(retry.task).toMatchObject({ id: cold.id, message: "", origin: { kind: "user" } })
      expect(retry.task.origin).not.toHaveProperty("explicitSkill")
      expect(restarted.createWork(input).task.id).toBe(cold.id)
    }
  } finally { db.close() }
})


it("erases only personal-IM input forwarded into a deleted desktop work, preserving the original IM scope", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
  const ref = { kind: "local_thread" as const, threadId: "native-im", incarnation: { token: "native", legacyCreatedAt: 1 } }
  const work = store.conversations.prepare({ botId: bot.id, operationId: "link", conversation: ref, title: "Task", goal: "Check" })
  store.conversations.bound(bot.id, work.id, ref)
  let forwarded: ReturnType<typeof store.getTask> | undefined
  let source: ReturnType<typeof store.getTask> | undefined
  const errors: unknown[] = []
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({ release() {}, async execute() {
      if (task.mockSource) host.mockExecution(task)
      if (!task.workId && task.origin.kind === "mock") {
        source = task
        host.sendWork({ taskId: task.id, callId: "send", key: "send" }, work.id, "Private forwarded input")
      } else if (task.workId === work.id && task.origin.kind === "work") {
        forwarded = task
        host.beginInputPreparation(task.id, task.id)
        host.recordPreparedInput(task.id, task.id, "Approved forwarded input")
      }
      return { state: "completed", result: "done" }
    } })
  }, 2, error => errors.push(error))
  try {
    const now = Date.now()
    const binding = { id: "personal", botId: bot.id, kind: "dm" as const, label: "Owner", version: 1,
      state: "active" as const, conversationKey: "personal-conversation", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 90000).toISOString() }
    const scope = host.registerImBinding("realm", "owner", binding)
    host.imChannel.importImBinding({ id: scope.id, botId: bot.id, kind: binding.kind, label: binding.label,
      channelKey: "gateway-conversation", version: binding.version })
    host.setImOnline(bot.id, scope.id, true)
    const wire = { route: { bindingId: binding.id, botId: bot.id, kind: "dm" as const, label: "Owner", version: 1, senderId: "owner" },
      event: { schemaVersion: 1 as const, eventId: "event", platformMessageId: "msg", principalId: "owner",
        conversationKey: binding.conversationKey, conversationSeq: 1, message: { type: "text" as const, text: "Revise the native work" },
        occurredAt: new Date(now).toISOString(), redelivered: false,
        lease: { id: "lease", expiresAt: new Date(now + 90000).toISOString() } } }
    const event = host.imGateway.receive("realm", "owner", wire)
    host.imGateway.settle(event.id, "active", undefined, now + 90000)
    const accepted = host.acceptImEvent({ bindingId: event.bindingId, eventId: event.id, messageId: "msg",
      senderId: "owner", text: wire.event.message.text, mentionsBotIds: [bot.id] })
    host.imGateway.settle(event.id, "active", accepted.taskId!)
    await vi.waitFor(() => expect(forwarded && store.getTask(forwarded.id).state).toBe("completed"))
    expect(errors).toEqual([])
    assert.ok(forwarded && source)
    const command = { taskId: source.id, callId: "send", key: "send" }
    expect(forwarded.mockSource?.personal).toBe(true)
    store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
    store.conversations.detached(bot.id, work.id)
    store.removeMessageReactionsForThreads([ref.threadId])
    expect(store.getTask(forwarded.id).message).toBe("")
    expect(db.exec("SELECT prepared_input,input_preparation_required FROM bot_tasks WHERE id=?", [forwarded.id])[0].values).toEqual([[null, 0]])
    const receipt = db.exec("SELECT message_hash,mock_source_json FROM bot_task_receipts WHERE request_id=?", [forwarded.requestId])[0].values[0]
    expect(receipt[0]).toBe(createHash("sha256").update(canonicalBotMessageInput(forwarded.message)).digest("hex"))
    expect(JSON.parse(String(receipt[1]))).toEqual(forwarded.mockSource)
    expect(JSON.parse(String(db.exec("SELECT receipt FROM bot_work_commands WHERE command_id=?", [`tool:${command.taskId}:${command.callId}`])[0].values[0][0])).message).toBe("")
    expect(store.getTask(source.id).message).toBe(source.message)
    expect(host.imGateway.receive("realm", "owner", wire).id).toBe(event.id)
  } finally { await host.stop(); db.close() }
})
