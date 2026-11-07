import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureCanonicalCheckpointMembershipEvidence } from "./canonical-checkpoint-membership-evidence"

const databases: NativeSqliteAdapter[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })

function fixture(count: number) {
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(database)
  database.run(`CREATE TABLE function_conversation_checkpoint_receipts (
    receipt_id TEXT PRIMARY KEY, target_json TEXT, snapshot_digest TEXT, snapshot_json TEXT,
    conversation_id TEXT, branch_id TEXT, checkpoint_thread_id TEXT,
    checkpoint_incarnation TEXT, checkpoint_namespace TEXT, checkpoint_id TEXT)`)
  database.run(`CREATE TABLE function_conversation_checkpoint_members (
    receipt_id TEXT, ordinal INTEGER, uuid TEXT, member_json TEXT)`)
  const members = Array.from({ length: count }, (_, ordinal) => ({ ordinal,
    uuid: `message-${ordinal}`, rowReceiptId: `row-receipt-${ordinal}`,
    rowDigest: "a".repeat(64), nativeDigest: "b".repeat(64) }))
  const snapshotJson = JSON.stringify({ members })
  database.run("INSERT INTO function_conversation_checkpoint_receipts VALUES (?,?,?,?,?,?,?,?,?,?)", [
    "receipt", '{"conversationId":"conversation","branchId":"branch"}', "digest", snapshotJson,
    "conversation", "branch", "thread", "incarnation", "", "checkpoint"
  ])
  database.run("BEGIN")
  for (const member of members) database.run(
    "INSERT INTO function_conversation_checkpoint_members VALUES (?,?,?,?)",
    ["receipt", member.ordinal, member.uuid, JSON.stringify(member)])
  database.run("COMMIT")
  const read = () => captureCanonicalCheckpointMembershipEvidence(database, {
    conversationId: "conversation", branchId: "branch"
  }, { checkpointThreadId: "thread", checkpointIncarnation: "incarnation",
    namespace: "", checkpointId: "checkpoint" })
  return { database, read, members, snapshotJson }
}

describe("complete canonical membership evidence without repeated receipt JSON", () => {
  it("keeps complete receipt and ordered member bytes, including an empty checkpoint", () => {
    for (const count of [0, 3]) {
      const f = fixture(count), evidence = JSON.parse(f.read())
      expect(evidence.receipt.values).toEqual([["receipt",
        '{"conversationId":"conversation","branchId":"branch"}', "digest", f.snapshotJson]])
      expect(evidence.members?.values ?? []).toEqual(f.members.map(member => [
        member.ordinal, member.uuid, JSON.stringify(member)
      ]))
    }
  })

  it.each(["target_json", "snapshot_digest", "snapshot_json"] as const)(
    "detects a change to receipt %s in the final evidence comparison", column => {
      const f = fixture(3), before = f.read()
      f.database.run(`UPDATE function_conversation_checkpoint_receipts SET ${column}=?`, ["changed"])
      expect(f.read()).not.toBe(before)
    })

  it.each(["ordinal", "uuid", "member_json", "delete"] as const)(
    "detects a changed member %s without losing any member evidence", column => {
      const f = fixture(3), before = f.read()
      if (column === "delete") f.database.run(
        "DELETE FROM function_conversation_checkpoint_members WHERE ordinal=0")
      else f.database.run(`UPDATE function_conversation_checkpoint_members SET ${column}=? WHERE ordinal=0`,
        [column === "ordinal" ? 99 : "changed"])
      expect(f.read()).not.toBe(before)
    })

  it("refuses missing or duplicate receipts instead of treating them as empty membership", () => {
    const f = fixture(0)
    f.database.run(`INSERT INTO function_conversation_checkpoint_receipts
      SELECT 'duplicate',target_json,snapshot_digest,snapshot_json,conversation_id,branch_id,
        checkpoint_thread_id,checkpoint_incarnation,checkpoint_namespace,checkpoint_id
      FROM function_conversation_checkpoint_receipts`)
    expect(f.read).toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    f.database.run("DELETE FROM function_conversation_checkpoint_receipts")
    expect(f.read).toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  })

  it("keeps real SQLite evidence size linear through 1000 members", () => {
    const measured = [100, 500, 1000].map(count => {
      const f = fixture(count), start = performance.now(), evidence = f.read()
      const result = { count, bytes: Buffer.byteLength(evidence),
        receiptBytes: Buffer.byteLength(f.snapshotJson),
        elapsedMs: Math.round((performance.now() - start) * 100) / 100 }
      // One full receipt plus one ordered row per member; no receipt text per row.
      expect(result.bytes).toBeLessThan(result.receiptBytes * 3)
      expect(JSON.parse(evidence).members.values).toHaveLength(count)
      return result
    })
    expect(measured[2].bytes / measured[0].bytes).toBeLessThan(11)
    console.log("[CanonicalMembershipEvidencePerformance]", measured)
  })
})
