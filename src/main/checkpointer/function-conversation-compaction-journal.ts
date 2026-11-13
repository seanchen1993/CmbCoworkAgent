import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { SqlJsSaverPreparedCheckpointDescriptor, SqlJsSaverCompactionWritesDescriptor } from "./sqljs-saver"

export type CompactionCommitPhase = "prepared" | "checkpoint-committed" | "ack-persisted" |
  "ready" | "abandoned" | "quarantined"
export interface CompactionJournalBoundary {
  readonly version: 1
  readonly target: string
  readonly sourceCheckpointId: string
  readonly sourceSnapshotDigest: string
  readonly uuid: string
  readonly rowDigest: string
  readonly rowReceiptId: string
  readonly projectionDigest: string
}
/** Persisted native evidence descriptions only. Neither JSON nor its hashes grant authority. */
export interface CompactionCommitRecord {
  readonly version: 1
  readonly intentId: string
  readonly target: string
  readonly expectedUpdateDigest: string
  readonly source: CompactionJournalBoundary
  readonly sourceDescriptor: SqlJsSaverPreparedCheckpointDescriptor
  readonly destination: SqlJsSaverPreparedCheckpointDescriptor
  readonly sourceWrites?: SqlJsSaverCompactionWritesDescriptor
  readonly writerPid: number
  readonly writerBoot: string
  readonly phase: CompactionCommitPhase
  readonly createdAt: number
  readonly updatedAt: number
  readonly quarantineReason?: "source-changed" | "destination-changed" | "unsettled-writer"
}
const table = "function_conversation_compaction_commits"
const phases: readonly CompactionCommitPhase[] = ["prepared", "checkpoint-committed", "ack-persisted",
  "ready", "abandoned", "quarantined"]
const transitions: Readonly<Record<CompactionCommitPhase, readonly CompactionCommitPhase[]>> = {
  prepared: ["checkpoint-committed", "abandoned", "quarantined"],
  "checkpoint-committed": ["ack-persisted", "quarantined"],
  "ack-persisted": ["ready", "quarantined"], ready: [], abandoned: [], quarantined: []
}
function fail(code = "MODS_CONVERSATION_COMPACTION_EVIDENCE_REQUIRED"): never {
  throw new ModFunctionError(code)
}

/** Fixed Main persistence. Callers must supply independently verified native source/write proofs. */
export class FunctionConversationCompactionJournal {
  constructor(private readonly database: NativeSqliteAdapter, private readonly target: string,
    private readonly guard: () => void) {}

  private exists(): boolean {
    this.guard()
    return Boolean(this.database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
      [table])[0]?.values.length)
  }
  private decode(row: unknown[]): CompactionCommitRecord {
    if (typeof row[0] !== "string" || row[0].length > 256 * 1024) fail()
    let value: CompactionCommitRecord
    try { value = JSON.parse(row[0]) as CompactionCommitRecord } catch { return fail() }
    if (!value || value.version !== 1 || value.target !== this.target ||
      value.intentId !== row[1] || value.phase !== row[2] || !phases.includes(value.phase) ||
      !value.source || value.source.version !== 1 || value.source.target !== this.target ||
      !value.destination || !value.sourceDescriptor ||
      typeof value.expectedUpdateDigest !== "string" ||
      !Number.isSafeInteger(value.writerPid) || value.writerPid <= 0 ||
      typeof value.writerBoot !== "string" || !value.writerBoot) fail()
    this.guard()
    return value
  }
  read(intentId: string): CompactionCommitRecord | undefined {
    if (!this.exists()) return undefined
    const row = this.database.exec(`SELECT record_json,intent_id,phase FROM ${table}
      WHERE intent_id=? AND target=? LIMIT 1`, [intentId, this.target])[0]?.values[0]
    return row ? this.decode(row) : undefined
  }
  readActive(): CompactionCommitRecord | undefined {
    if (!this.exists()) return undefined
    const rows = this.database.exec(`SELECT record_json,intent_id,phase FROM ${table}
      WHERE target=? AND phase NOT IN ('ready','abandoned') LIMIT 2`, [this.target])[0]?.values ?? []
    if (rows.length > 1) fail()
    return rows.length ? this.decode(rows[0]) : undefined
  }
  private transaction<T>(run: () => T): T {
    this.guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NESTED_TRANSACTION")
    this.database.run("BEGIN IMMEDIATE")
    try {
      this.guard()
      const result = run()
      this.guard()
      this.database.run("COMMIT")
      return result
    } catch (error) {
      try { this.database.run("ROLLBACK") } catch { /* Preserve COMMIT uncertainty. */ }
      throw error
    }
  }
  prepare(record: CompactionCommitRecord): void {
    this.guard()
    if (JSON.stringify(record).length > 256 * 1024) fail()
    this.database.run(`CREATE TABLE IF NOT EXISTS ${table} (
      intent_id TEXT PRIMARY KEY,target TEXT NOT NULL,phase TEXT NOT NULL,
      record_json TEXT NOT NULL,updated_at INTEGER NOT NULL)`)
    this.database.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_function_compaction_active
      ON ${table}(target) WHERE phase NOT IN ('ready','abandoned')`)
    this.database.run(`CREATE INDEX IF NOT EXISTS idx_function_compaction_target_history
      ON ${table}(target,updated_at DESC,intent_id DESC)`)
    this.database.run(`CREATE INDEX IF NOT EXISTS idx_function_compaction_owner
      ON ${table}(json_extract(target,'$.conversationId')) WHERE json_valid(target)`)
    this.transaction(() => {
      if (this.read(record.intentId) || this.readActive()) fail("MODS_CONVERSATION_COMPACTION_BUSY")
      if (record.phase !== "prepared" || record.target !== this.target) fail()
      this.database.run(`INSERT INTO ${table} VALUES(?,?,?,?,?)`,
        [record.intentId, this.target, record.phase, JSON.stringify(record), record.updatedAt])
    })
    if (JSON.stringify(this.read(record.intentId)) !== JSON.stringify(record)) fail()
  }
  /** ACK invokes this inside the original membership/delivery transaction, never a nested BEGIN. */
  advanceInsideTransaction(previous: CompactionCommitRecord, phase: CompactionCommitPhase,
    quarantineReason?: CompactionCommitRecord["quarantineReason"]): CompactionCommitRecord {
    this.guard()
    if (!this.database.inTransaction || previous.target !== this.target ||
      !transitions[previous.phase].includes(phase)) fail()
    const next: CompactionCommitRecord = { ...previous, phase, updatedAt: Date.now(),
      ...(quarantineReason ? { quarantineReason } : {}) }
    this.database.run(`UPDATE ${table} SET phase=?,record_json=?,updated_at=?
      WHERE intent_id=? AND target=? AND phase=? AND record_json=?`,
    [phase, JSON.stringify(next), next.updatedAt, previous.intentId, this.target, previous.phase,
      JSON.stringify(previous)])
    if (this.database.getRowsModified() !== 1) fail()
    this.guard()
    return next
  }
  advance(previous: CompactionCommitRecord, phase: CompactionCommitPhase,
    reason?: CompactionCommitRecord["quarantineReason"]): CompactionCommitRecord {
    const next = this.transaction(() => this.advanceInsideTransaction(previous, phase, reason))
    if (JSON.stringify(this.read(previous.intentId)) !== JSON.stringify(next)) fail()
    return next
  }
  retainReady(keepDestinationId: string): void {
    this.transaction(() => {
      this.database.run(`DELETE FROM ${table} WHERE intent_id IN (
        SELECT intent_id FROM ${table} WHERE target=? AND phase IN ('ready','abandoned')
        ORDER BY updated_at DESC,intent_id DESC LIMIT -1 OFFSET 16
      ) AND json_extract(record_json,'$.destination.checkpointId') != ?`, [this.target, keepDestinationId])
    })
  }
}
