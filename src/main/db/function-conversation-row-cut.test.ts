import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import {
  FunctionConversationStore,
  type FunctionConversationCommit,
  type FunctionConversationRef,
  type FunctionConversationRow,
  type FunctionConversationRowReadCut,
  type FunctionConversationTranscriptVerifier,
  type FunctionConversationTranscriptWriter
} from "./function-conversation-store"

const cleanups: Array<() => void> = []
const live = () => undefined

afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) close()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-function-row-cut-"))
  const path = join(directory, "app.sqlite")
  let db = openNativeSqliteDatabase(path).database
  db.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
  db.run(`CREATE TABLE projection (conversation_id TEXT, uuid TEXT, payload TEXT NOT NULL,
    PRIMARY KEY(conversation_id, uuid))`)
  const token = randomUUID()
  db.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: token })])
  let store = new FunctionConversationStore(db)
  cleanups.push(() => {
    if (db.inTransaction) db.run("ROLLBACK")
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = { threadId: "thread", workspace: "C:/workspace",
    incarnation: { token, legacyCreatedAt: 1000 }, checkpointNamespace: "" }
  const ref = store.ensureMain(input, live)
  const writer: FunctionConversationTranscriptWriter = (database, target, row) => {
    expect(database.inTransaction).toBe(true)
    database.run("INSERT INTO projection VALUES (?, ?, ?)", [
      target.conversationId, row.uuid, JSON.stringify(row)
    ])
  }
  const verify: FunctionConversationTranscriptVerifier = (database, target, row) => {
    expect(database).toBe(db)
    const result = database.exec(`SELECT payload FROM projection
      WHERE conversation_id = ? AND uuid = ?`, [target.conversationId, row.uuid])[0]
    if (result?.values.length !== 1 || result.values[0][0] !== JSON.stringify(row))
      throw Error("CANONICAL_TRANSCRIPT_NOT_COMMITTED")
  }
  return { get db() { return db }, get store() { return store }, ref, input, writer, verify,
    reopen() {
      db.close()
      db = openNativeSqliteDatabase(path).database
      store = new FunctionConversationStore(db)
    } }
}

function note(uuid = randomUUID(), text = "actual note"): FunctionConversationCommit {
  return { uuid, inputDigest: `digest:${uuid}`, door: "note",
    origin: { kind: "plugin", name: "P" },
    message: { type: "user", role: "user", isMeta: true, content: [{ type: "text", text }] },
    nativePayload: JSON.stringify({ type: "human", content: text,
      additional_kwargs: { actual: true } }),
    orderAnchor: { request: "actual-request", batch: "actual-batch" }, inbox: true, sdk: true }
}

function commit(f: ReturnType<typeof fixture>, input = note(), target = f.ref) {
  return f.store.commit(target, input, live, f.writer, f.verify)
}

function read(f: ReturnType<typeof fixture>, target: FunctionConversationRef,
  row: FunctionConversationRow, cut: FunctionConversationRowReadCut
) {
  return f.store.readRowAtCut(target, row.uuid, cut, live)
}

describe("FunctionConversationStore exact canonical row at a fixed host cut", () => {
  it("returns the full native original, without the SDK or display content boundary", () => {
    const f = fixture()
    const text = "中".repeat(400_000)
    const input: FunctionConversationCommit = { ...note(), door: "response", sdk: false,
      inbox: false, message: { type: "assistant", role: "assistant", content: [
        { type: "text", text }, { type: "thinking", thinking: "original reasoning" },
        { type: "tool_use", id: "tool-actual", name: "read_file", input: { path: "actual" } }
      ] }, nativePayload: JSON.stringify({ type: "ai", content: text,
        usage_metadata: { total_tokens: 7 }, artifact: { bytes: [1, 2] },
        response_metadata: { original: true } }) }
    const row = commit(f, input)
    expect(Buffer.byteLength(row.nativePayload)).toBeGreaterThan(1024 * 1024)
    expect(read(f, f.ref, row, { frontier: row.sequence })).toEqual(row)
    expect(read(f, f.ref, row, { frontier: row.sequence }).message).toEqual(input.message)
    expect(read(f, f.ref, row, { frontier: row.sequence }).nativePayload).toBe(input.nativePayload)
    expect(f.store.captureInbox(f.ref, 0).rows).toEqual([])
    expect(f.db.exec("SELECT * FROM function_conversation_deliveries")[0].values).toEqual([])
  })

  it("reads an exact old UUID outside the real 4096-row API tail, without using that API", () => {
    const f = fixture()
    const first = commit(f, { ...note(), inbox: false, sdk: false })
    // Seed committed history using an actual SQLite transaction, not 4096 SDK dispatches.
    f.db.run("BEGIN IMMEDIATE")
    try {
      f.db.run(`WITH RECURSIVE history(n) AS (
        SELECT 2 UNION ALL SELECT n + 1 FROM history WHERE n < 4097
      ) INSERT INTO function_conversation_rows
        SELECT r.conversation_id, 'history-' || h.n, r.branch_id, h.n,
          'history-receipt-' || h.n, r.input_digest, r.payload_digest, r.payload_json,
          r.door, r.created_at, r.bytes
        FROM history h CROSS JOIN function_conversation_rows r
        WHERE r.conversation_id = ? AND r.uuid = ?`, [f.ref.conversationId, first.uuid])
      f.db.run("UPDATE function_conversations SET next_sequence = 4098 WHERE conversation_id = ?",
        [f.ref.conversationId])
      f.db.run("COMMIT")
    } catch (error) {
      f.db.run("ROLLBACK")
      throw error
    }
    const tail = f.store.readRows(f.ref)
    expect(tail).toHaveLength(4096)
    expect(tail.some((row) => row.uuid === first.uuid)).toBe(false)
    const tailSpy = vi.spyOn(f.store, "readRows").mockImplementation(() => {
      throw Error("API_TAIL_IS_NOT_CANONICAL_LOOKUP")
    })
    const receiptSpy = vi.spyOn(f.store, "readReceipt").mockImplementation(() => {
      throw Error("RECEIPT_WITHOUT_BRANCH_CUT_IS_NOT_RECOVERY")
    })
    expect(read(f, f.ref, first, { frontier: 4097 })).toEqual(first)
    expect(tailSpy).not.toHaveBeenCalled()
    expect(receiptSpy).not.toHaveBeenCalled()
  })

  it("inherits only each real ancestor cut and excludes future parents and sibling rows", () => {
    const f = fixture(), root = commit(f)
    const branch = f.store.forkBranch(f.ref,
      { parentFrontier: root.sequence, checkpointId: "cp-root" }, live)
    const futureRoot = commit(f), inherited = commit(f, note(), branch)
    const grandchild = f.store.forkBranch(branch,
      { parentFrontier: inherited.sequence, checkpointId: "cp-branch" }, live)
    const futureParent = commit(f, note(), branch), own = commit(f, note(), grandchild)
    const sibling = f.store.forkBranch(f.ref,
      { parentFrontier: root.sequence, checkpointId: "cp-sibling" }, live)
    const foreign = commit(f, note(), sibling)
    for (const row of [root, inherited, own])
      expect(read(f, grandchild, row, { frontier: foreign.sequence })).toEqual(row)
    for (const row of [futureRoot, futureParent, foreign])
      expect(() => read(f, grandchild, row, { frontier: foreign.sequence }))
        .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    expect(() => read(f, grandchild, own, { frontier: futureParent.sequence }))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    expect(() => read(f, f.ref, inherited, { frontier: foreign.sequence }))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
  })

  it("keeps a restored exact branch and its original cut after reopening actual SQLite", () => {
    const f = fixture(), first = commit(f)
    const branch = f.store.forkBranch(f.ref,
      { parentFrontier: first.sequence, checkpointId: "cp-exact" }, live)
    const own = commit(f, note(), branch)
    const future = commit(f)
    f.reopen()
    const main = f.store.ensureMain(f.input, live)
    const restored = f.store.selectBranch(main, branch.branchId, live)
    expect(read(f, restored, first, { frontier: own.sequence })).toEqual(first)
    expect(read(f, restored, own, { frontier: own.sequence })).toEqual(own)
    expect(() => read(f, restored, future, { frontier: own.sequence }))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
  })

  it("does not borrow the same UUID or label from another real child conversation", () => {
    const f = fixture(), uuid = randomUUID()
    const main = commit(f, note(uuid, "main original"))
    const firstChild = f.store.createChild(f.ref,
      { invocationId: randomUUID(), checkpointNamespace: "same-visible-label" }, live)
    const secondChild = f.store.createChild(f.ref,
      { invocationId: randomUUID(), checkpointNamespace: "same-visible-label" }, live)
    const first = commit(f, note(uuid, "first child original"), firstChild)
    const second = commit(f, note(uuid, "second child original"), secondChild)
    const firstOnly = commit(f, note(), firstChild)
    expect(read(f, f.ref, main, { frontier: main.sequence })).toEqual(main)
    expect(read(f, firstChild, first, { frontier: firstOnly.sequence })).toEqual(first)
    expect(read(f, secondChild, second, { frontier: second.sequence })).toEqual(second)
    expect(() => read(f, secondChild, firstOnly, { frontier: second.sequence }))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    expect(firstChild.conversationId).not.toBe(secondChild.conversationId)
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2])(
    "rejects invalid or unavailable fixed frontier %s rather than borrowing latest",
    (frontier) => {
      const f = fixture(), row = commit(f)
      expect(() => read(f, f.ref, row, { frontier }))
        .toThrow("MODS_CONVERSATION_READ_CUT_INVALID")
    }
  )

  it("rejects a zero frontier and unknown exact UUID with the same outside-cut outcome", () => {
    const f = fixture(), row = commit(f)
    expect(() => read(f, f.ref, row, { frontier: 0 }))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    for (const uuid of ["", " ", randomUUID(), `${row.uuid}-wrong`])
      expect(() => f.store.readRowAtCut(f.ref, uuid, { frontier: row.sequence }, live))
        .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
  })

  it("uses exact creation time including the boundary and rejects invalid time cuts", () => {
    const f = fixture()
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000)
    const first = commit(f)
    now.mockReturnValue(20_000)
    const second = commit(f)
    expect(read(f, f.ref, first, { frontier: second.sequence,
      notAfterCreatedAt: first.createdAt })).toEqual(first)
    expect(() => read(f, f.ref, first, { frontier: second.sequence,
      notAfterCreatedAt: first.createdAt - 1 })).toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    expect(() => read(f, f.ref, second, { frontier: second.sequence,
      notAfterCreatedAt: first.createdAt })).toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    expect(read(f, f.ref, second, { frontier: second.sequence,
      notAfterCreatedAt: undefined })).toEqual(second)
    for (const notAfterCreatedAt of [-1, 0.5, NaN, Infinity])
      expect(() => read(f, f.ref, first, { frontier: second.sequence, notAfterCreatedAt }))
        .toThrow("MODS_CONVERSATION_READ_CUT_INVALID")
  })

  it("copies the fixed cut and actual target before a guard can mutate caller data", () => {
    const f = fixture()
    const now = vi.spyOn(Date, "now").mockReturnValue(100)
    const first = commit(f)
    now.mockReturnValue(200)
    const future = commit(f)
    const branch = f.store.forkBranch(f.ref,
      { parentFrontier: 0, checkpointId: "cp-empty" }, live)
    const cut = { frontier: first.sequence, notAfterCreatedAt: first.createdAt }
    const target = { ...f.ref }
    const guard = vi.fn(() => {
      cut.frontier = future.sequence
      cut.notAfterCreatedAt = future.createdAt
      target.branchId = branch.branchId
    })
    expect(f.store.readRowAtCut(target, first.uuid, cut, guard)).toEqual(first)
    expect(guard).toHaveBeenCalledTimes(2)
    expect(() => f.store.readRowAtCut(f.ref, future.uuid,
      { frontier: first.sequence, notAfterCreatedAt: first.createdAt }, guard))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
  })

  it("rejects an accessor cut without evaluating its getter", () => {
    const f = fixture(), row = commit(f), getter = vi.fn(() => row.sequence)
    const cut: FunctionConversationRowReadCut = { frontier: row.sequence }
    Object.defineProperty(cut, "frontier", { get: getter })
    expect(() => read(f, f.ref, row, cut)).toThrow("MODS_CONVERSATION_READ_CUT_INVALID")
    expect(getter).not.toHaveBeenCalled()
  })

  it("refuses both committed and same-connection uncommitted rows while in a transaction", () => {
    const f = fixture(), row = commit(f), input = note()
    const original = f.db.run.bind(f.db)
    const rejected = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw Error("uncertain native commit")
      return original(sql, args)
    })
    try {
      expect(() => commit(f, input)).toThrow("uncertain native commit")
      expect(f.db.inTransaction).toBe(true)
      expect(f.store.readReceipt(f.ref, input.uuid)).toBeDefined()
      for (const uuid of [row.uuid, input.uuid])
        expect(() => f.store.readRowAtCut(f.ref, uuid, { frontier: 2 }, live))
          .toThrow("MODS_CONVERSATION_NOT_COMMITTED")
    } finally {
      rejected.mockRestore()
      original("ROLLBACK")
    }
    expect(read(f, f.ref, row, { frontier: row.sequence })).toEqual(row)
    expect(() => f.store.readRowAtCut(f.ref, input.uuid, { frontier: row.sequence }, live))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
  })

  it("preserves the actual source guard exception at entry and before returning", () => {
    const f = fixture(), row = commit(f), expired = Error("actual source expired")
    for (const expireAt of [1, 2]) {
      let calls = 0, caught: unknown
      try {
        f.store.readRowAtCut(f.ref, row.uuid, { frontier: row.sequence }, () => {
          if (++calls === expireAt) throw expired
        })
      } catch (error) { caught = error }
      expect(caught).toBe(expired)
      expect(calls).toBe(expireAt)
    }
  })

  it("rechecks committed state and thread incarnation after the final actual guard", () => {
    const f = fixture(), row = commit(f)
    let calls = 0
    try {
      expect(() => f.store.readRowAtCut(f.ref, row.uuid, { frontier: row.sequence }, () => {
        if (++calls === 2) f.db.run("BEGIN")
      })).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
    } finally { if (f.db.inTransaction) f.db.run("ROLLBACK") }
    calls = 0
    expect(() => f.store.readRowAtCut(f.ref, row.uuid, { frontier: row.sequence }, () => {
      if (++calls === 2) f.db.run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [
        JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.ref.threadId
      ])
    })).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
  })

  it("rejects deleted or rebound targets, even when the thread ID and timestamp are reused", () => {
    const f = fixture(), row = commit(f)
    f.db.run("DELETE FROM threads WHERE thread_id = ?", [f.ref.threadId])
    expect(() => read(f, f.ref, row, { frontier: row.sequence }))
      .toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    const token = randomUUID()
    f.db.run("INSERT INTO threads VALUES (?, ?, ?)", [f.ref.threadId, 1000,
      JSON.stringify({ cmb_thread_incarnation: token })])
    const rebound = f.store.ensureMain({ ...f.input,
      incarnation: { token, legacyCreatedAt: 1000 } }, live)
    expect(rebound.conversationId).not.toBe(f.ref.conversationId)
    expect(() => read(f, f.ref, row, { frontier: row.sequence }))
      .toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(() => read(f, rebound, row, { frontier: 0 }))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
  })

  it.each(["payload_json", "payload_digest", "bytes"])(
    "rejects a damaged full payload %s without a display or latest fallback",
    (column) => {
      const f = fixture(), row = commit(f)
      const value = column === "bytes" ? row.bytes + 1 : "damaged payload"
      f.db.run(`UPDATE function_conversation_rows SET ${column} = ?
        WHERE conversation_id = ? AND uuid = ?`, [value, f.ref.conversationId, row.uuid])
      expect(() => read(f, f.ref, row, { frontier: row.sequence }))
        .toThrow("MODS_CONVERSATION_STORE_CORRUPT")
    }
  )

  it("rejects a corrupted private lineage instead of guessing a parent or latest branch", () => {
    const f = fixture(), row = commit(f)
    f.db.run(`UPDATE function_conversation_branches SET parent_branch_id = branch_id
      WHERE branch_id = ?`, [f.ref.branchId])
    expect(() => read(f, f.ref, row, { frontier: row.sequence }))
      .toThrow("MODS_CONVERSATION_BRANCH_INVALID")
  })
})
