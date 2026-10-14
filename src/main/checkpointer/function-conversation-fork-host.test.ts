import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { emptyCheckpoint, copyCheckpoint } from "@langchain/langgraph-checkpoint"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { functionConversationCanonicalStamp } from "./function-conversation-checkpoint-membership"
import { recordFunctionConversationPresentationDisposition,
  readFunctionConversationPresentationDisposition } from "../db/function-conversation-presentation-disposition"
import {
  functionConversationNoteMessage,
  functionConversationState
} from "../agent/mods-conversation"
import { FunctionConversationDeliveryBridge } from "./function-conversation-delivery"
import { SqlJsSaver } from "./sqljs-saver"
import { prepareFunctionConversationForkNativeImport } from "./function-conversation-fork-host"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "../db"

let directory = ""
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-fork-host-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture(options: { inheritedBranch?: boolean;
  presentation?: "persisted" | "blank" | "plumbing"; secondPrompt?: boolean } = {}) {
  const sourceId = randomUUID(),
    workspace = directory
  const source = appDb.createThread(sourceId, { workspacePath: workspace })
  const incarnation = captureThreadIncarnation(source),
    database = appDb.getDb()
  let sourceEffect: (() => void) | undefined
  const guard = () => {
    sourceEffect?.()
    if (
      database !== appDb.getDb() ||
      !matchesThreadIncarnation(appDb.getThreadCore(sourceId), incarnation)
    )
      throw Error("SOURCE_CHANGED")
  }
  const store = new FunctionConversationStore(database)
  const root = store.ensureMain(
    { threadId: sourceId, workspace, incarnation, checkpointNamespace: "" },
    guard
  )
  let target = root
  const append = (text: string) => {
    const uuid = randomUUID(),
      message = { type: "user", role: "user", isMeta: true, content: [{ type: "text", text }] }
    const native = new HumanMessage({
      id: uuid,
      content: message.content,
      additional_kwargs: { isMeta: true }
    })
    const access = createFunctionConversationTranscriptAccess((_ref, row) => ({
      id: row.uuid,
      role: "user",
      content: [{ type: "text", text }],
      created_at: new Date(row.createdAt)
    }))
    return store.commit(
      target,
      {
        uuid,
        inputDigest: `actual:${uuid}`,
        door: "note",
        origin: { kind: "plugin", name: "actual-plugin" },
        message,
        nativePayload: serializeFunctionConversationNativeMessage(native),
        orderAnchor: { kind: "sdk-note" },
        inbox: true,
        sdk: true
      },
      guard,
      access.write,
      access.verify
    )
  }
  const consumed = append("kept at actual checkpoint")
  if (options.inheritedBranch)
    target = store.forkBranch(
      root,
      {
        parentFrontier: consumed.sequence,
        checkpointId: randomUUID()
      },
      guard
    )
  const createPrompt = () => {
    const disposition = options.presentation, uuid = randomUUID()
    if (disposition === undefined) throw Error("ACTUAL_PROMPT_DISPOSITION_REQUIRED")
    const text = "complete native prompt at the actual source checkpoint"
    const native = new HumanMessage({ id: uuid, content: text })
    const access = createFunctionConversationTranscriptAccess((_ref, row) => ({ id: row.uuid,
      role: "user", content: disposition === "persisted" ? text : "",
      recovery_integrity: disposition === "persisted" ? "verified" : "unverified",
      created_at: new Date(row.createdAt) }))
    const selection = (row: Parameters<typeof access.write>[2]) => ({ target, row,
      threadId: sourceId, incarnation, assertCurrent: guard })
    const columns = () => {
      const value = readFunctionConversationRawProjection(database, sourceId, uuid)
      if (!value) throw Error("ACTUAL_PROMPT_COLUMNS_REQUIRED")
      return value
    }
    return store.commit(target, { uuid, inputDigest: uuid, door: "prompt",
      origin: { kind: "composer" }, message: { type: "user", content: [{ type: "text", text }] },
      nativePayload: serializeFunctionConversationNativeMessage(native),
      orderAnchor: { kind: "actual-native-input", presentation: { version: 1, disposition,
        intentDigest: "e".repeat(64) } }, sdk: false, inbox: false }, guard,
    (db, ref, row) => {
      access.write(db, ref, row)
      recordFunctionConversationPresentationDisposition(db, selection(row), columns())
    }, (db, ref, row) => {
      access.verify(db, ref, row)
      readFunctionConversationPresentationDisposition(db, selection(row), columns())
    })
  }
  const prompt = options.presentation === undefined ? undefined : createPrompt()
  const secondPrompt = options.secondPrompt ? createPrompt() : undefined
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.source.sqlite`))
  const checkpoint = emptyCheckpoint()
  const human = prompt ? deserializeFunctionConversationNativeMessage(prompt.nativePayload) :
    new HumanMessage({ id: randomUUID(), content: "native user" })
  if (prompt) human.additional_kwargs = { ...human.additional_kwargs,
    function_row: functionConversationCanonicalStamp(target, prompt) }
  checkpoint.channel_values.messages = [
    human,
    ...(secondPrompt ? [(() => {
      const native = deserializeFunctionConversationNativeMessage(secondPrompt.nativePayload)
      native.additional_kwargs = { ...native.additional_kwargs,
        function_row: functionConversationCanonicalStamp(target, secondPrompt) }
      return native
    })()] : []),
    functionConversationNoteMessage(consumed, target),
    new AIMessage({ id: randomUUID(), content: "native final answer" })
  ]
  checkpoint.channel_values.cmbFunctionConversation = functionConversationState(
    target,
    consumed.sequence
  )
  const bridge = new FunctionConversationDeliveryBridge(store, () => ({
    target,
    checkpointThreadId: sourceId,
    checkpointIncarnation: incarnation,
    signal: new AbortController().signal,
    assertCurrent: guard
  })).wrap(saver)
  await bridge.put({ configurable: { thread_id: sourceId, checkpoint_ns: "" } }, checkpoint, {
    source: "loop",
    step: 1,
    parents: {}
  })
  const pending = append("pending after the original checkpoint")
  cleanup.push(() => saver.close())
  const prepare = (selected = checkpoint) =>
    prepareFunctionConversationForkNativeImport({
      store,
      saver,
      threadId: sourceId,
      workspace,
      originalThread: source,
      checkpoints: [selected],
      selectedCheckpointId: selected.id,
      assertCurrent: guard
    })
  return {
    sourceId,
    source,
    incarnation,
    store,
    target,
    saver,
    checkpoint,
    prompt,
    secondPrompt,
    consumed,
    pending,
    prepare,
    setSourceEffect: (effect?: () => void) => { sourceEffect = effect }
  }
}

function beginActualTarget(
  importer: NonNullable<Awaited<ReturnType<typeof prepareFunctionConversationForkNativeImport>>>,
  copyPages = true
) {
  const targetId = randomUUID(),
    database = appDb.getDb()
  database.run("BEGIN IMMEDIATE")
  const row = appDb.createThreadInTransaction(targetId, { workspacePath: directory })
  const incarnation = captureThreadIncarnation(row)
  let targetEffect: (() => void) | undefined
  const guard = () => {
    targetEffect?.()
    if (
      appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(targetId), incarnation)
    )
      throw Error("TARGET_CHANGED")
  }
  importer.begin(
    { threadId: targetId, workspace: directory, incarnation, checkpointNamespace: "" },
    guard
  )
  database.run("COMMIT")
  while (copyPages && !importer.copyPage().complete) {
    /* Actual bounded native import. */
  }
  return { targetId, database, setTargetEffect: (effect?: () => void) => { targetEffect = effect } }
}

describe("actual fork native source and original transcript adapter", () => {
  it("keeps the genuine native data boundary for empty pages and an already complete retry", async () => {
    const sourceId = randomUUID(), source = appDb.createThread(sourceId, { workspacePath: directory })
    const incarnation = captureThreadIncarnation(source), database = appDb.getDb()
    const guard = () => {
      if (appDb.getDb() !== database ||
        !matchesThreadIncarnation(appDb.getThreadCore(sourceId), incarnation)) throw Error("SOURCE_CHANGED")
    }
    const store = new FunctionConversationStore(database)
    const root = store.ensureMain({ threadId: sourceId, workspace: directory, incarnation,
      checkpointNamespace: "" }, guard)
    const sourceSaver = new SqlJsSaver(join(directory, `${randomUUID()}.empty-source.sqlite`))
    cleanup.push(() => sourceSaver.close())
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values.messages = []
    checkpoint.channel_values.cmbFunctionConversation = functionConversationState(root, 0)
    await new FunctionConversationDeliveryBridge(store, () => ({ target: root,
      checkpointThreadId: sourceId, checkpointIncarnation: incarnation,
      signal: new AbortController().signal, assertCurrent: guard })).wrap(sourceSaver).put(
      { configurable: { thread_id: sourceId, checkpoint_ns: "" } }, checkpoint,
      { source: "loop", step: 1, parents: {} })
    const importer = await prepareFunctionConversationForkNativeImport({ store, saver: sourceSaver,
      threadId: sourceId, workspace: directory, originalThread: source,
      checkpoints: [checkpoint], selectedCheckpointId: checkpoint.id, assertCurrent: guard })
    if (!importer) throw Error("ACTUAL_EMPTY_IMPORT_REQUIRED")
    const { targetId } = beginActualTarget(importer, false)
    expect(importer.copyPage()).toMatchObject({ copied: 0, complete: true })
    expect(importer.copyPage()).toMatchObject({ copied: 0, complete: true })
    const targetCheckpoint = importer.checkpoint(checkpoint)
    const targetSaver = new SqlJsSaver(join(directory, `${randomUUID()}.empty-target.sqlite`))
    cleanup.push(() => targetSaver.close())
    await targetSaver.put({ configurable: { thread_id: targetId, checkpoint_ns: "" } },
      targetCheckpoint, { source: "loop", step: 1, parents: {} })
    await importer.recordCheckpoint(targetSaver, targetCheckpoint)
    await importer.finish(targetSaver)
    await importer.finish(targetSaver)
    expect(importer.view().ready).toBe(true)
    expect(appDb.getThreadMessageCount(targetId)).toBe(0)
    expect(database.exec("SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=?",
      [importer.view().target.conversationId])[0].values).toEqual([[0]])
  })

  it("rolls back a page when a later real row guard damages an earlier copied ledger", async () => {
    const f = await fixture({ presentation: "blank", secondPrompt: true }), importer = await f.prepare()
    const first = f.prompt, last = f.secondPrompt
    if (!importer || !first || !last) throw Error("ACTUAL_TWO_PROMPT_IMPORT_REQUIRED")
    const { targetId, database } = beginActualTarget(importer, false)
    const run = database.run.bind(database), exec = database.exec.bind(database)
    let checkingPage = false, lastReceiptRead = false, changes = 0
    vi.spyOn(database, "run").mockImplementation((sql, args) => {
      const result = run(sql, args)
      if (/^UPDATE function_conversation_fork_imports SET copied_through/.test(sql.trim()))
        checkingPage = true
      return result
    })
    vi.spyOn(database, "exec").mockImplementation((sql, args) => {
      const result = exec(sql, args)
      if (checkingPage && sql.includes("SELECT * FROM function_conversation_projection_receipts") &&
        args?.[0] === targetId && args[2] === last.uuid) lastReceiptRead = true
      return result
    })
    f.setSourceEffect(() => {
      if (!database.inTransaction || !lastReceiptRead || changes) return
      changes++
      database.run(`UPDATE function_conversation_presentation_dispositions SET disposition='plumbing'
        WHERE thread_id=? AND uuid=?`, [targetId, first.uuid])
    })
    expect(() => importer.copyPage()).toThrow()
    expect(changes).toBe(1)
    expect(database.inTransaction).toBe(false)
    expect(appDb.getThreadMessageCount(targetId)).toBe(0)
    expect(database.exec(`SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=?`,
      [importer.view().target.conversationId])[0].values).toEqual([[0]])
    expect(database.exec(`SELECT COUNT(*) FROM function_conversation_presentation_dispositions
      WHERE thread_id=?`, [targetId])[0].values).toEqual([[0]])
    expect(importer.view().ready).toBe(false)
  })

  it("checks the complete page after its last target guard, including ordinary fragments", async () => {
    const f = await fixture({ presentation: "blank" }), importer = await f.prepare(), prompt = f.prompt
    if (!importer || !prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
    const { targetId, database, setTargetEffect } = beginActualTarget(importer)
    const ordinaryId = randomUUID(), provider = randomUUID()
    appDb.upsertThreadMessages(f.sourceId, [{ id: ordinaryId, role: "assistant",
      content: "ordinary base", provider_source_id: provider, provider_occurrence: 2,
      created_at: new Date(1) }])
    expect(appDb.appendThreadMessageTextDelta(f.sourceId, { id: ordinaryId, role: "assistant",
      content: " original fragment", provider_source_id: provider, provider_occurrence: 2,
      created_at: new Date(2) })).toBe(true)
    expect(database.exec(`SELECT content_text FROM thread_message_fragments
      WHERE thread_id=? AND message_id=?`, [f.sourceId, ordinaryId])[0].values)
      .toEqual([[" original fragment"]])
    const exec = database.exec.bind(database)
    let lastReceiptRead = false, changes = 0
    vi.spyOn(database, "exec").mockImplementation((sql, args) => {
      const result = exec(sql, args)
      if (database.inTransaction &&
        sql.includes("SELECT * FROM function_conversation_projection_receipts") &&
        args?.[0] === targetId && args[2] === prompt.uuid) lastReceiptRead = true
      return result
    })
    setTargetEffect(() => {
      if (!database.inTransaction || !lastReceiptRead || changes) return
      changes++
      database.run(`UPDATE thread_message_fragments SET content_text='changed by final target guard'
        WHERE thread_id=? AND message_id=?`, [targetId, ordinaryId])
    })
    expect(() => importer.copyVisiblePage([{ messageId: ordinaryId, role: "assistant",
      providerSourceId: provider, providerOccurrence: 2 },
      { messageId: prompt.uuid, role: "user" }])).toThrow()
    expect(changes).toBe(1)
    expect(database.inTransaction).toBe(false)
    expect(appDb.getThreadMessagesByIds(targetId, [ordinaryId])).toEqual([])
    expect(database.exec(`SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id=? AND message_id=?`,
      [targetId, ordinaryId])[0].values).toEqual([[0]])
    expect(f.store.readReceipt(importer.view().target, prompt.uuid)?.nativePayload).toBe(prompt.nativePayload)
  })

  it.each(["source-members", "journal"] as const)(
    "checks the pure visible-page plan after its final target guard changes %s", async change => {
      const f = await fixture({ presentation: "blank" }), importer = await f.prepare(), prompt = f.prompt
      if (!importer || !prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
      const { targetId, database, setTargetEffect } = beginActualTarget(importer)
      const before = database.exec(`SELECT source_digest FROM function_conversation_fork_imports
        WHERE target_thread_id=?`, [targetId])[0].values
      const members = () => database.exec(`SELECT ordinal,uuid,member_json FROM
        function_conversation_checkpoint_members WHERE receipt_id IN
        (SELECT receipt_id FROM function_conversation_checkpoint_receipts
         WHERE checkpoint_thread_id=? AND checkpoint_id=?) ORDER BY ordinal`,
      [f.sourceId, f.checkpoint.id])[0].values
      const originalMembers = members()
      expect(originalMembers.length).toBe(2)
      const exec = database.exec.bind(database), run = database.run.bind(database)
      let adapterRead = false, finalJournalRead = false, changes = 0, ledgerWrites = 0
      vi.spyOn(database, "exec").mockImplementation((sql, args) => {
        const result = exec(sql, args)
        if (database.inTransaction &&
          sql.includes("SELECT * FROM function_conversation_projection_receipts") &&
          args?.[0] === targetId && args[2] === prompt.uuid) adapterRead = true
        if (database.inTransaction && adapterRead &&
          sql.includes("SELECT * FROM function_conversation_fork_imports WHERE plan_id=?"))
          finalJournalRead = true
        return result
      })
      vi.spyOn(database, "run").mockImplementation((sql, args) => {
        if (/^INSERT INTO function_conversation_presentation_dispositions/.test(sql.trim())) ledgerWrites++
        return run(sql, args)
      })
      setTargetEffect(() => {
        if (!database.inTransaction || !finalJournalRead || changes) return
        changes++
        if (change === "source-members") database.run(`DELETE FROM
          function_conversation_checkpoint_members WHERE receipt_id IN
          (SELECT receipt_id FROM function_conversation_checkpoint_receipts
           WHERE checkpoint_thread_id=? AND checkpoint_id=?)`, [f.sourceId, f.checkpoint.id])
        else database.run(`UPDATE function_conversation_fork_imports SET source_digest=?
          WHERE target_thread_id=?`, ["f".repeat(64), targetId])
      })
      expect(() => importer.copyVisiblePage([{ messageId: prompt.uuid, role: "user" }])).toThrow()
      expect(changes).toBe(1)
      expect(ledgerWrites).toBe(0)
      expect(database.inTransaction).toBe(false)
      expect(members()).toEqual(originalMembers)
      expect(database.exec(`SELECT source_digest FROM function_conversation_fork_imports
        WHERE target_thread_id=?`, [targetId])[0].values).toEqual(before)
      expect(f.store.readReceipt(importer.view().target, prompt.uuid)?.nativePayload).toBe(prompt.nativePayload)
    }
  )

  it.each([false, true])("refuses %s ready retry after a later completed-row guard alters an earlier ledger",
    async alreadyReady => {
      const f = await fixture({ presentation: "blank", secondPrompt: true }), importer = await f.prepare()
      const first = f.prompt, last = f.secondPrompt
      if (!importer || !first || !last) throw Error("ACTUAL_TWO_PROMPT_IMPORT_REQUIRED")
      const { targetId, database, setTargetEffect } = beginActualTarget(importer)
      const checkpoint = importer.checkpoint(f.checkpoint)
      const saver = new SqlJsSaver(join(directory, `${randomUUID()}.batch-tail-target.sqlite`))
      cleanup.push(() => saver.close())
      await saver.put({ configurable: { thread_id: targetId, checkpoint_ns: "" } }, checkpoint,
        { source: "loop", step: 1, parents: {} })
      await importer.recordCheckpoint(saver, checkpoint)
      if (alreadyReady) await importer.finish(saver)
      const run = database.run.bind(database), exec = database.exec.bind(database)
      let insideFinish = alreadyReady, lastReceiptRead = false, changes = 0, ledgerWrites = 0
      vi.spyOn(database, "run").mockImplementation((sql, args) => {
        const result = run(sql, args)
        if (sql === "BEGIN IMMEDIATE") { insideFinish = true; lastReceiptRead = false }
        if (/^INSERT INTO function_conversation_presentation_dispositions/.test(sql.trim())) ledgerWrites++
        return result
      })
      vi.spyOn(database, "exec").mockImplementation((sql, args) => {
        const result = exec(sql, args)
        if (insideFinish && sql.includes("SELECT * FROM function_conversation_projection_receipts") &&
          args?.[0] === targetId && args[2] === last.uuid) lastReceiptRead = true
        return result
      })
      setTargetEffect(() => {
        if (!insideFinish || !lastReceiptRead || changes) return
        changes++
        database.run(`UPDATE function_conversation_presentation_dispositions SET disposition='plumbing'
          WHERE thread_id=? AND uuid=?`, [targetId, first.uuid])
      })
      await expect(importer.finish(saver)).rejects.toThrow()
      expect(changes).toBe(1)
      expect(ledgerWrites).toBe(0)
      expect(database.inTransaction).toBe(false)
      expect(database.exec(`SELECT status FROM function_conversation_fork_imports WHERE target_thread_id=?`,
        [targetId])[0].values).toEqual([[alreadyReady ? "ready" : "preparing"]])
      // Pre-COMMIT damage rolls back. A damaged durable ready row cannot be repaired or ACKed.
      expect(database.exec(`SELECT disposition FROM function_conversation_presentation_dispositions
        WHERE thread_id=? AND uuid=?`, [targetId, first.uuid])[0].values)
        .toEqual([[alreadyReady ? "plumbing" : "blank"]])
    }
  )

  it("checks original source checkpoint indexes after the last actual source guard", async () => {
    const f = await fixture(), importer = await f.prepare()
    if (!importer) throw Error("ACTUAL_IMPORT_REQUIRED")
    const { targetId, database } = beginActualTarget(importer, false)
    const run = database.run.bind(database)
    let copied = false, changes = 0
    vi.spyOn(database, "run").mockImplementation((sql, args) => {
      const result = run(sql, args)
      if (/^UPDATE function_conversation_fork_imports SET copied_through/.test(sql.trim())) copied = true
      return result
    })
    f.setSourceEffect(() => {
      if (!database.inTransaction || !copied || changes) return
      changes++
      database.run(`DELETE FROM function_conversation_checkpoint_members WHERE receipt_id IN
        (SELECT receipt_id FROM function_conversation_checkpoint_receipts WHERE checkpoint_thread_id=?
         AND checkpoint_id=?)`, [f.sourceId, f.checkpoint.id])
    })
    expect(() => importer.copyPage()).toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    expect(changes).toBe(1)
    expect(database.inTransaction).toBe(false)
    expect(appDb.getThreadMessageCount(targetId)).toBe(0)
    expect(database.exec(`SELECT COUNT(*) FROM function_conversation_checkpoint_members WHERE receipt_id IN
      (SELECT receipt_id FROM function_conversation_checkpoint_receipts WHERE checkpoint_thread_id=?
       AND checkpoint_id=?)`, [f.sourceId, f.checkpoint.id])[0].values).toEqual([[1]])
  })

  it("rejects a ready retry when its last target guard changes the fresh journal to preparing", async () => {
    const f = await fixture({ presentation: "blank" }), importer = await f.prepare()
    if (!importer || !f.prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
    const { targetId, database, setTargetEffect } = beginActualTarget(importer)
    const checkpoint = importer.checkpoint(f.checkpoint)
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.ready-status-target.sqlite`))
    cleanup.push(() => saver.close())
    await saver.put({ configurable: { thread_id: targetId, checkpoint_ns: "" } }, checkpoint,
      { source: "loop", step: 1, parents: {} })
    await importer.recordCheckpoint(saver, checkpoint)
    await importer.finish(saver)
    expect(importer.view().ready).toBe(true)
    const targetReceipt = database.exec(`SELECT receipt_id FROM function_conversation_checkpoint_receipts
      WHERE checkpoint_thread_id=? AND checkpoint_id=?`, [targetId, checkpoint.id])[0].values[0][0]
    const exec = database.exec.bind(database), run = database.run.bind(database)
    let pinnedTarget = false, journalRead = false, changes = 0, ledgerWrites = 0
    vi.spyOn(database, "exec").mockImplementation((sql, args) => {
      const result = exec(sql, args)
      if (sql === "SELECT * FROM function_conversation_checkpoint_members WHERE receipt_id=? ORDER BY ordinal" &&
        args?.[0] === targetReceipt) pinnedTarget = true
      if (pinnedTarget && sql.includes("SELECT * FROM function_conversation_fork_imports WHERE plan_id=?"))
        journalRead = true
      return result
    })
    vi.spyOn(database, "run").mockImplementation((sql, args) => {
      if (/^INSERT INTO function_conversation_presentation_dispositions/.test(sql.trim())) ledgerWrites++
      return run(sql, args)
    })
    setTargetEffect(() => {
      if (!journalRead || changes) return
      changes++
      database.run(`UPDATE function_conversation_fork_imports SET status='preparing'
        WHERE target_thread_id=? AND status='ready'`, [targetId])
      expect(database.getRowsModified()).toBe(1)
    })
    await expect(importer.finish(saver)).rejects.toThrow()
    expect(changes).toBe(1)
    expect(ledgerWrites).toBe(0)
    expect(database.inTransaction).toBe(false)
    expect(database.exec(`SELECT status FROM function_conversation_fork_imports WHERE target_thread_id=?`,
      [targetId])[0].values).toEqual([["preparing"]])
    expect(f.store.readReceipt(importer.view().target, f.prompt.uuid)?.nativePayload).toBe(f.prompt.nativePayload)
  })

  it.each(["persisted", "blank", "plumbing"] as const)(
    "finishes a real Saver/native fork with a recalculated %s target ledger", async presentation => {
      const f = await fixture({ presentation }), importer = await f.prepare()
      const prompt = f.prompt
      if (!importer || !prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
      const { targetId, database } = beginActualTarget(importer)
      const row = f.store.readReceipt(importer.view().target, prompt.uuid)
      const actual = appDb.getThreadCore(targetId)
      const columns = readFunctionConversationRawProjection(database, targetId, prompt.uuid)
      if (!row || !actual || !columns) throw Error("ACTUAL_TARGET_PROMPT_REQUIRED")
      const target = importer.view().target
      expect(readFunctionConversationPresentationDisposition(database, { target, row,
        threadId: targetId, incarnation: captureThreadIncarnation(actual),
        assertCurrent: () => f.store.assertCurrent(target) }, columns).kind)
        .toBe(presentation === "persisted" ? "visible" : presentation)
      expect(row.nativePayload).toBe(prompt.nativePayload)
      expect(row.orderAnchor).toEqual(prompt.orderAnchor)
      expect(row.receiptId).not.toBe(prompt.receiptId)
      const cp = importer.checkpoint(f.checkpoint)
      const saver = new SqlJsSaver(join(directory, `${randomUUID()}.ledger-target.sqlite`))
      cleanup.push(() => saver.close())
      await saver.put({ configurable: { thread_id: targetId, checkpoint_ns: "" } }, cp,
        { source: "loop", step: 1, parents: {} })
      await importer.recordCheckpoint(saver, cp)
      await importer.finish(saver)
      expect(importer.view().ready).toBe(true)
      expect(database.exec(`SELECT target_json,canonical_receipt_id FROM
        function_conversation_presentation_dispositions WHERE thread_id=? AND uuid=?`,
      [targetId, row.uuid])[0].values).toEqual(database.exec(`SELECT target_json,canonical_receipt_id
        FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?`,
      [targetId, row.uuid])[0].values)
      expect(f.store.readReceipt(f.target, prompt.uuid)?.nativePayload).toBe(prompt.nativePayload)
      expect(f.store.readReceipt(target, f.pending.uuid)).toBeUndefined()
    }
  )

  it("accepts only the complete committed target ledger when an actual page COMMIT loses its ACK", async () => {
    const f = await fixture({ presentation: "blank" }), importer = await f.prepare()
    const prompt = f.prompt
    if (!importer || !prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
    const { targetId, database } = beginActualTarget(importer, false)
    const run = database.run.bind(database)
    let commits = 0, ledgerWrites = 0
    vi.spyOn(database, "run").mockImplementation((sql, args) => {
      if (/^INSERT INTO function_conversation_presentation_dispositions/.test(sql.trim())) ledgerWrites++
      const result = run(sql, args)
      if (sql === "COMMIT" && ++commits === 1) throw Error("ACTUAL_PAGE_COMMIT_ACK_LOST")
      return result
    })
    expect(() => importer.copyPage()).not.toThrow()
    expect(database.inTransaction).toBe(false)
    expect(commits).toBe(1)
    expect(ledgerWrites).toBe(1)
    expect(() => importer.copyPage()).not.toThrow()
    expect(ledgerWrites).toBe(1)
    database.run(`DELETE FROM function_conversation_presentation_dispositions
      WHERE thread_id=? AND uuid=?`, [targetId, prompt.uuid])
    expect(() => importer.copyVisiblePage([{ messageId: prompt.uuid, role: "user" }]))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(ledgerWrites).toBe(1)
  })

  it("refuses ready publication when the actual target ledger is removed after checkpoint import", async () => {
    const f = await fixture({ presentation: "plumbing" }), importer = await f.prepare()
    const prompt = f.prompt
    if (!importer || !prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
    const { targetId, database } = beginActualTarget(importer)
    const checkpoint = importer.checkpoint(f.checkpoint)
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.denied-target.sqlite`))
    cleanup.push(() => saver.close())
    await saver.put({ configurable: { thread_id: targetId, checkpoint_ns: "" } }, checkpoint,
      { source: "loop", step: 1, parents: {} })
    await importer.recordCheckpoint(saver, checkpoint)
    database.run(`DELETE FROM function_conversation_presentation_dispositions
      WHERE thread_id=? AND uuid=?`, [targetId, prompt.uuid])
    await expect(importer.finish(saver)).rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(importer.view().ready).toBe(false)
    expect(database.exec(`SELECT COUNT(*) FROM function_conversation_presentation_dispositions
      WHERE thread_id=?`, [targetId])[0].values).toEqual([[0]])
  })

  it("preflights a missing source ledger before creating any target", async () => {
    const f = await fixture({ presentation: "blank" }), importer = await f.prepare()
    const prompt = f.prompt
    if (!importer || !prompt) throw Error("ACTUAL_PROMPT_IMPORT_REQUIRED")
    const database = appDb.getDb(), before = database.exec("SELECT COUNT(*) FROM threads")
    database.run(`DELETE FROM function_conversation_presentation_dispositions
      WHERE thread_id=? AND uuid=?`, [f.sourceId, prompt.uuid])
    expect(() => importer.preflightVisible([{ messageId: prompt.uuid, role: "user" }]))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(database.exec("SELECT COUNT(*) FROM threads")).toEqual(before)
  })

  it("preflights missing and damaged canonical sources before creating any target", async () => {
    const f = await fixture(),
      importer = await f.prepare()
    if (!importer) throw Error("ACTUAL_NATIVE_IMPORT_REQUIRED")
    const database = appDb.getDb()
    const before = database.exec("SELECT COUNT(*) FROM threads")
    expect(() =>
      importer.preflightVisible([{ messageId: randomUUID(), role: "assistant" }])
    ).toThrow("MIGRATION_REQUIRED")
    database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?", [
      JSON.stringify("damaged sealed source"),
      f.sourceId,
      f.consumed.uuid
    ])
    expect(() => importer.preflightVisible([{ messageId: f.consumed.uuid, role: "user" }])).toThrow(
      "PROJECTION_CONFLICT"
    )
    expect(database.exec("SELECT COUNT(*) FROM threads")).toEqual(before)
  })

  it("copies exact ordinary rows, fragments and flags alongside the full canonical receipt", async () => {
    const f = await fixture(),
      ordinaryId = randomUUID(),
      provider = randomUUID()
    appDb.upsertThreadMessages(f.sourceId, [
      {
        id: ordinaryId,
        role: "assistant",
        content: "actual ordinary base",
        provider_source_id: provider,
        provider_occurrence: 2,
        created_at: new Date(100),
        is_error: true
      }
    ])
    expect(
      appDb.appendThreadMessageTextDelta(f.sourceId, {
        id: ordinaryId,
        role: "assistant",
        content: " actual delta",
        provider_source_id: provider,
        provider_occurrence: 2,
        created_at: new Date(101)
      })
    ).toBe(true)
    const importer = await f.prepare()
    if (!importer) throw Error("ACTUAL_NATIVE_IMPORT_REQUIRED")
    const selectors = [
      { messageId: f.consumed.uuid, role: "user" as const },
      {
        messageId: ordinaryId,
        role: "assistant" as const,
        providerSourceId: provider,
        providerOccurrence: 2
      }
    ]
    importer.preflightVisible(selectors)
    const { targetId, database } = beginActualTarget(importer)
    importer.copyVisiblePage(selectors)
    expect(readFunctionConversationRawProjection(database, targetId, ordinaryId)).toEqual({
      ...readFunctionConversationRawProjection(database, f.sourceId, ordinaryId),
      thread_id: targetId
    })
    expect(
      appDb.getThreadMessages(targetId).find((message) => message.id === ordinaryId)?.content
    ).toBe("actual ordinary base actual delta")
    expect(appDb.getThreadMessageCount(targetId)).toBe(2)
    importer.copyVisiblePage(selectors)
    expect(appDb.getThreadMessageCount(targetId)).toBe(2)
  })

  it("adopts an uncertain actual COMMIT by a readonly exact copy verification without replay", async () => {
    const f = await fixture(),
      ordinaryId = randomUUID()
    appDb.upsertThreadMessages(f.sourceId, [
      { id: ordinaryId, role: "assistant", content: "once actual copy", created_at: new Date(100) }
    ])
    const importer = await f.prepare()
    if (!importer) throw Error("ACTUAL_NATIVE_IMPORT_REQUIRED")
    const { targetId, database } = beginActualTarget(importer)
    const originalRun = database.run.bind(database)
    let commits = 0,
      inserts = 0
    vi.spyOn(database, "run").mockImplementation((sql, args) => {
      if (/^INSERT\s+INTO\s+thread_messages/i.test(sql.trim())) inserts++
      const result = originalRun(sql, args)
      if (sql === "COMMIT" && ++commits === 1) throw Error("ACTUAL_COMMIT_ACK_LOST")
      return result
    })
    expect(() =>
      importer.copyVisiblePage([{ messageId: ordinaryId, role: "assistant" }])
    ).not.toThrow()
    expect(commits).toBe(1)
    expect(inserts).toBe(1)
    expect(database.inTransaction).toBe(false)
    expect(appDb.getThreadMessageCount(targetId)).toBe(2)
  })

  it("verifies inherited canonical rows against their own copied ancestor branch", async () => {
    const f = await fixture({ inheritedBranch: true }),
      importer = await f.prepare()
    if (!importer) throw Error("ACTUAL_NATIVE_IMPORT_REQUIRED")
    const selectors = [{ messageId: f.consumed.uuid, role: "user" as const }]
    importer.preflightVisible(selectors)
    const { targetId } = beginActualTarget(importer)
    const view = importer.view()
    expect(view.entries[view.selectedSourceIndex].target.branchId).not.toBe(
      view.branchMap[f.consumed.branchId]
    )
    expect(() => importer.copyVisiblePage(selectors)).not.toThrow()
    expect(appDb.getThreadMessages(targetId).map((message) => message.id)).toEqual([
      f.consumed.uuid
    ])
  })

  it("uses newly persisted target membership and leaves source pending notes untouched", async () => {
    const f = await fixture(),
      importer = await f.prepare()
    if (!importer) throw Error("ACTUAL_NATIVE_IMPORT_REQUIRED")
    const targetId = randomUUID(),
      database = appDb.getDb()
    database.run("BEGIN IMMEDIATE")
    const row = appDb.createThreadInTransaction(targetId, { workspacePath: directory })
    const incarnation = captureThreadIncarnation(row)
    const guard = () => {
      if (
        appDb.getDb() !== database ||
        !matchesThreadIncarnation(appDb.getThreadCore(targetId), incarnation)
      )
        throw Error("TARGET_CHANGED")
    }
    importer.begin(
      { threadId: targetId, workspace: directory, incarnation, checkpointNamespace: "" },
      guard
    )
    database.run("COMMIT")
    const sourcePending = database.exec(
      "SELECT uuid FROM function_conversation_inbox WHERE conversation_id = ?",
      [f.target.conversationId]
    )[0].values
    expect(() =>
      f.store.findMain(
        { threadId: targetId, workspace: directory, incarnation, checkpointNamespace: "" },
        guard
      )
    ).toThrow("FORK_PREPARING")
    while (!importer.copyPage().complete) {
      /* Actual bounded import, with no Hook/model replay. */
    }
    const checkpoint = importer.checkpoint(f.checkpoint)
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.target.sqlite`))
    cleanup.push(() => saver.close())
    await saver.put({ configurable: { thread_id: targetId, checkpoint_ns: "" } }, checkpoint, {
      source: "loop",
      step: 1,
      parents: {}
    })
    await importer.recordCheckpoint(saver, checkpoint)
    await importer.finish(saver)
    const view = importer.view()
    expect(view.ready).toBe(true)
    expect(view.target.conversationId).not.toBe(f.target.conversationId)
    expect(f.store.readReceipt(view.target, f.consumed.uuid)?.receiptId).not.toBe(
      f.consumed.receiptId
    )
    expect(f.store.readReceipt(view.target, f.pending.uuid)).toBeUndefined()
    expect(
      database.exec("SELECT uuid FROM function_conversation_inbox WHERE conversation_id = ?", [
        f.target.conversationId
      ])[0].values
    ).toEqual(sourcePending)
    expect(appDb.getThreadMessages(targetId).map((message) => message.id)).toEqual([
      f.consumed.uuid
    ])
    expect(
      await saver.getTuple({ configurable: { thread_id: targetId, checkpoint_id: checkpoint.id } })
    ).toHaveProperty(
      "checkpoint.channel_values.cmbFunctionConversation.conversationId",
      view.target.conversationId
    )
  })

  it.each(["frontier", "members", "metadata"] as const)(
    "rejects a same-ID source %s change against its original persisted consumption facts",
    async (change) => {
      const f = await fixture(),
        changed = copyCheckpoint(f.checkpoint)
      if (change === "frontier")
        changed.channel_values.cmbFunctionConversation = functionConversationState(
          f.target,
          f.pending.sequence
        )
      if (change === "members") changed.channel_values.messages = []
      if (change === "metadata") {
        const messages = changed.channel_values.messages as HumanMessage[]
        messages[0] = new HumanMessage({
          id: messages[0].id,
          content: messages[0].content,
          response_metadata: { provider: "changed after the original commit" }
        })
      }
      await f.saver.put({ configurable: { thread_id: f.sourceId, checkpoint_ns: "" } }, changed, {
        source: "loop",
        step: 1,
        parents: {}
      })
      const before = appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_fork_imports")
      await expect(f.prepare(changed)).rejects.toThrow("MEMBERSHIP")
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_fork_imports")).toEqual(
        before
      )
    }
  )

  it("rejects a shortened message prefix instead of borrowing the original later frontier", async () => {
    const f = await fixture(),
      prefix = copyCheckpoint(f.checkpoint)
    prefix.channel_values.messages = [
      new HumanMessage({ id: randomUUID(), content: "old boundary" })
    ]
    await expect(f.prepare(prefix)).rejects.toThrow("FORK_CHECKPOINT_CONFLICT")
  })
})
