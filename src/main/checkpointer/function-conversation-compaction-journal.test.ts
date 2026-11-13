import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { FunctionConversationCompactionJournal, type CompactionCommitRecord } from
  "./function-conversation-compaction-journal"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "actual-compaction-journal-"))
  const database = openNativeSqliteDatabase(join(directory, "original.sqlite")).database
  cleanup.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return database
}
function record(id = "intent", target = "original-target"): CompactionCommitRecord {
  const descriptor = { threadId: "original-thread", namespace: "", checkpointId: "source",
    parentCheckpointId: null, checkpointType: "json", checkpointBytesDigest: "source-raw",
    metadataType: "json", metadataBytesDigest: "source-metadata", channels: { messages: "original" } }
  return { version: 1, intentId: id, target, expectedUpdateDigest: "actual-delta",
    source: { version: 1, target, sourceCheckpointId: "source", sourceSnapshotDigest: "source-members",
      uuid: "last-source-message", rowDigest: "row", rowReceiptId: "receipt", projectionDigest: "projection" },
    sourceDescriptor: descriptor, destination: { ...descriptor, checkpointId: `destination-${id}`,
      parentCheckpointId: "source", checkpointBytesDigest: "destination-raw" },
    writerPid: process.pid, writerBoot: "test-only-boot", phase: "prepared", createdAt: 1, updatedAt: 1 }
}
function ready(journal: FunctionConversationCompactionJournal, value: CompactionCommitRecord) {
  journal.prepare(value)
  const written = journal.advance(value, "checkpoint-committed")
  const acknowledged = journal.advance(written, "ack-persisted")
  return journal.advance(acknowledged, "ready")
}

it("keeps a missing journal read-only and enforces one active intent per exact target", () => {
  const database = fixture(), journal = new FunctionConversationCompactionJournal(database,
    "original-target", () => {})
  expect(journal.read("missing")).toBeUndefined()
  expect(journal.readActive()).toBeUndefined()
  expect(database.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? [])
    .toHaveLength(0)
  journal.prepare(record())
  expect(journal.readActive()).toEqual(record())
  expect(() => journal.prepare(record("other"))).toThrow("COMPACTION_BUSY")
  const foreign = new FunctionConversationCompactionJournal(database, "foreign-target", () => {})
  foreign.prepare(record("foreign", "foreign-target"))
  expect(journal.read("foreign")).toBeUndefined()
  expect(foreign.readActive()?.intentId).toBe("foreign")
})

it("updates the journal phase in the same real ACK transaction and rolls it back with ACK", () => {
  const database = fixture(), journal = new FunctionConversationCompactionJournal(database,
    "original-target", () => {})
  const original = record()
  journal.prepare(original)
  const committed = journal.advance(original, "checkpoint-committed")
  database.run("BEGIN IMMEDIATE")
  journal.advanceInsideTransaction(committed, "ack-persisted")
  expect(journal.readActive()?.phase).toBe("ack-persisted")
  database.run("ROLLBACK")
  expect(journal.readActive()).toEqual(committed)
  expect(() => journal.advanceInsideTransaction(committed, "ack-persisted")).toThrow()
  expect(() => journal.advance(committed, "ready")).toThrow()
  expect(journal.readActive()).toEqual(committed)
})

it("never turns an uncertain native COMMIT into a success or automatically repeats it", () => {
  const database = fixture(), journal = new FunctionConversationCompactionJournal(database,
    "original-target", () => {})
  journal.prepare(record())
  const originalRun = database.run.bind(database), uncertain = Error("actual COMMIT result unavailable")
  let commits = 0
  database.run = (...args) => {
    const result = originalRun(...args)
    if (args[0] === "COMMIT") { commits++; throw uncertain }
    return result
  }
  expect(() => journal.advance(record(), "checkpoint-committed")).toThrow(uncertain)
  database.run = originalRun
  expect(commits).toBe(1)
  expect(journal.readActive()?.phase).toBe("checkpoint-committed")
})

it("retains the sixteen recent settled records and the selected ledger while preserving unknown evidence", () => {
  const database = fixture(), journal = new FunctionConversationCompactionJournal(database,
    "original-target", () => {})
  const keep = ready(journal, record("00"))
  for (let index = 1; index < 20; index++) ready(journal, record(String(index).padStart(2, "0")))
  journal.prepare(record("unknown"))
  const foreignTarget = JSON.stringify({ conversationId: "foreign-conversation", threadId: "foreign-thread" })
  database.run(`WITH RECURSIVE ids(value) AS (SELECT 1 UNION ALL
    SELECT value+1 FROM ids WHERE value<10000)
    INSERT INTO function_conversation_compaction_commits
    SELECT 'foreign-'||value,?,'ready',
      json_set(?,'$.intentId','foreign-'||value,'$.phase','ready'),value FROM ids`,
  [foreignTarget, JSON.stringify(record("foreign", foreignTarget))])
  const plan = database.exec(`EXPLAIN QUERY PLAN SELECT intent_id FROM
    function_conversation_compaction_commits WHERE target=? AND phase IN ('ready','abandoned')
    ORDER BY updated_at DESC,intent_id DESC LIMIT -1 OFFSET 16`, ["original-target"])
  expect(JSON.stringify(plan)).toContain("idx_function_compaction_target_history")
  expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE")
  const cleanupPlan = database.exec(`EXPLAIN QUERY PLAN SELECT intent_id,target,record_json
    FROM function_conversation_compaction_commits WHERE json_valid(target)
      AND json_extract(target,'$.conversationId')=?`, ["selected-conversation"])
  expect(JSON.stringify(cleanupPlan)).toContain("idx_function_compaction_owner")
  expect(JSON.stringify(cleanupPlan)).not.toContain("SCAN function_conversation_compaction_commits")
  journal.retainReady(keep.destination.checkpointId)
  expect(journal.read("00")?.phase).toBe("ready")
  expect(journal.read("unknown")?.phase).toBe("prepared")
  expect(Number(database.exec(`SELECT COUNT(*) FROM function_conversation_compaction_commits
    WHERE target=? AND phase='ready'`, ["original-target"])[0]?.values[0]?.[0])).toBe(17)
  expect(Number(database.exec(`SELECT COUNT(*) FROM function_conversation_compaction_commits
    WHERE target=?`, [foreignTarget])[0]?.values[0]?.[0])).toBe(10000)
})

it("rejects unknown journal versions without changing the only persisted evidence", () => {
  const database = fixture(), journal = new FunctionConversationCompactionJournal(database,
    "original-target", () => {})
  journal.prepare(record())
  database.run(`UPDATE function_conversation_compaction_commits SET record_json=
    json_set(record_json,'$.version',999) WHERE intent_id='intent'`)
  const before = database.exec("SELECT record_json FROM function_conversation_compaction_commits")[0]
  expect(() => journal.readActive()).toThrow("EVIDENCE_REQUIRED")
  expect(database.exec("SELECT record_json FROM function_conversation_compaction_commits")[0]).toEqual(before)
})
