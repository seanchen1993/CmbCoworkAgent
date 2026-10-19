import type { ProjectCheckpointResult } from "./project-checkpoint"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"
import {
  canonicalStageCheckJson,
  parseStageCheckContracts,
  parseStageCheckReceipt,
  stageCheckArtifactAllowed,
  type StageCheckContract,
  type StageCheckReceipt
} from "../../../shared/project-runtime/stage-check-receipt"
import { compositionDigest, compositionText } from "../../../shared/project-runtime/composition"
import { runtimeDigest } from "./safe-files"
import { readRuntimeScopedFileAsync } from "./safe-files-async"
import {
  parseSourceHandoffBaseline,
  type SourceHandoffBaseline
} from "./composition-source-handoff"

export interface StoredStageCheck {
  runId: string
  unitId: string
  engineRunId: string
  packageDigest: string
  threadId: string
  incarnationKey: string
  hookId: string
  receipt: StageCheckReceipt
}
/** Main-only receipts; independent of original engine/journal schemas. */
export class CompositionStageCheckStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS contracts (run TEXT NOT NULL, unit TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run,unit));
      CREATE TABLE IF NOT EXISTS transitions (id TEXT PRIMARY KEY, run TEXT NOT NULL, unit TEXT NOT NULL, status TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY, run TEXT NOT NULL, unit TEXT NOT NULL, data TEXT NOT NULL);`)
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS source_baselines (run TEXT NOT NULL, unit TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run,unit))"
    )
  }
  freezeSourceBaseline(runId: string, unitId: string, baseline: SourceHandoffBaseline): void {
    compositionText(runId)
    compositionText(unitId)
    const data = canonicalStageCheckJson(parseSourceHandoffBaseline(baseline))
    if (Buffer.byteLength(data) > 256 * 1024) throw Error("SOURCE_HANDOFF_BASELINE_LIMIT")
    const old = this.db
      .prepare("SELECT data FROM source_baselines WHERE run=? AND unit=?")
      .get(runId, unitId) as { data: string } | undefined
    if (old && old.data !== data) throw Error("SOURCE_HANDOFF_BASELINE_CHANGED")
    if (!old) this.db.prepare("INSERT INTO source_baselines VALUES(?,?,?)").run(runId, unitId, data)
  }
  sourceBaseline(runId: string, unitId: string): SourceHandoffBaseline | undefined {
    const row = this.db
      .prepare("SELECT data FROM source_baselines WHERE run=? AND unit=?")
      .get(runId, unitId) as { data: string } | undefined
    if (!row) return undefined
    if (Buffer.byteLength(row.data) > 256 * 1024) throw Error("SOURCE_HANDOFF_BASELINE_LIMIT")
    return parseSourceHandoffBaseline(JSON.parse(row.data))
  }
  freezeContracts(runId: string, unitId: string, value: StageCheckContract[]): void {
    compositionText(runId)
    compositionText(unitId)
    const data = canonicalStageCheckJson(parseStageCheckContracts(value))
    if (Buffer.byteLength(data) > 256 * 1024) throw Error("STAGE_CHECK_CONTRACT_LIMIT")
    const old = this.db
      .prepare("SELECT data FROM contracts WHERE run=? AND unit=?")
      .get(runId, unitId) as { data: string } | undefined
    if (old && old.data !== data) throw Error("STAGE_CHECK_CONTRACT_CHANGED")
    if (!old) this.db.prepare("INSERT INTO contracts VALUES(?,?,?)").run(runId, unitId, data)
  }
  contracts(runId: string, unitId: string): StageCheckContract[] | undefined {
    const row = this.db
      .prepare("SELECT data FROM contracts WHERE run=? AND unit=?")
      .get(runId, unitId) as { data: string } | undefined
    return row ? parseStageCheckContracts(JSON.parse(row.data)) : undefined
  }
  async validateReceipts(
    workspace: string,
    runId: string,
    unitId: string,
    receipts: StageCheckReceipt[],
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    if (!receipts.length || receipts.length > 32) throw Error("STAGE_CHECK_RECEIPT_LIMIT")
    const contracts = this.contracts(runId, unitId)
    if (!contracts) throw Error("STAGE_CHECK_CONTRACT_REQUIRED")
    const files = new Map<string, string>()
    let totalBytes = 0
    for (const value of receipts) {
      const receipt = parseStageCheckReceipt(value)
      if (Buffer.byteLength(JSON.stringify(receipt)) > 65536)
        throw Error("STAGE_CHECK_RECEIPT_LIMIT")
      const contract = contracts.find(
        (item) =>
          item.nodeId === receipt.nodeId &&
          item.checkId === receipt.checkId &&
          item.contractDigest === receipt.contractDigest
      )
      if (
        !contract ||
        (!receipt.artifacts.length && !contract.checkOnly) ||
        receipt.artifacts.some((artifact) => !stageCheckArtifactAllowed(contract, artifact))
      )
        throw Error("STAGE_CHECK_CONTRACT_MISMATCH")
      for (const artifact of receipt.artifacts) {
        signal?.throwIfAborted()
        let digest = files.get(artifact.path)
        if (!digest) {
          if (files.size >= 128) throw Error("STAGE_CHECK_ARTIFACT_LIMIT")
          const file = await readRuntimeScopedFileAsync(
            workspace,
            artifact.path,
            Math.min(4 * 1024 * 1024, 16 * 1024 * 1024 - totalBytes),
            signal
          )
          if (!file.bytes) throw Error("STAGE_CHECK_ARTIFACT_CHANGED")
          totalBytes += file.bytes.length
          if (totalBytes > 16 * 1024 * 1024) throw Error("STAGE_CHECK_ARTIFACT_LIMIT")
          digest = runtimeDigest(file.bytes)
          files.set(artifact.path, digest)
        }
        if (digest !== artifact.digest) throw Error("STAGE_CHECK_ARTIFACT_CHANGED")
      }
    }
    signal?.throwIfAborted()
    const rows = this.db
      .prepare("SELECT data FROM receipts WHERE run=? AND unit=?")
      .all(runId, unitId) as { data: string }[]
    if (
      rows.length + receipts.length > 256 ||
      rows.reduce((sum, row) => sum + Buffer.byteLength(row.data), 0) +
        Buffer.byteLength(JSON.stringify(receipts)) +
        receipts.length * 4096 >
        4 * 1024 * 1024
    )
      throw Error("STAGE_CHECK_RECEIPT_LIMIT")
  }
  async append(
    workspace: string,
    identity: Omit<StoredStageCheck, "receipt">,
    receipts: StageCheckReceipt[],
    options: { signal?: AbortSignal; assertCurrent?(): void } = {}
  ): Promise<void> {
    for (const key of [
      "runId",
      "unitId",
      "engineRunId",
      "threadId",
      "incarnationKey",
      "hookId"
    ] as const)
      compositionText(identity[key])
    compositionDigest(identity.packageDigest)
    await this.validateReceipts(
      workspace,
      identity.runId,
      identity.unitId,
      receipts,
      options.signal
    )
    const values = receipts.map((receipt) => {
      const data = JSON.stringify({ ...identity, receipt: parseStageCheckReceipt(receipt) })
      if (Buffer.byteLength(data) > 65536) throw Error("STAGE_CHECK_RECEIPT_LIMIT")
      return data
    })
    options.signal?.throwIfAborted()
    options.assertCurrent?.()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const rows = this.db
        .prepare("SELECT data FROM receipts WHERE run=? AND unit=?")
        .all(identity.runId, identity.unitId) as { data: string }[]
      if (
        rows.length + values.length > 256 ||
        [...rows.map((row) => row.data), ...values].reduce(
          (sum, value) => sum + Buffer.byteLength(value),
          0
        ) >
          4 * 1024 * 1024
      )
        throw Error("STAGE_CHECK_RECEIPT_LIMIT")
      for (const data of values)
        this.db
          .prepare("INSERT INTO receipts(run,unit,data) VALUES(?,?,?)")
          .run(identity.runId, identity.unitId, data)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  read(runId: string, unitId: string): StoredStageCheck[] {
    return (
      this.db
        .prepare("SELECT data FROM receipts WHERE run=? AND unit=? ORDER BY seq")
        .all(runId, unitId) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as StoredStageCheck)
  }
  beginTransition(
    runId: string,
    unitId: string,
    checkpoint: string,
    expectedStateDigest: string
  ): { id: string; prior?: ProjectCheckpointResult } {
    const id = runtimeDigest(JSON.stringify([runId, unitId, checkpoint, expectedStateDigest]))
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const old = this.db.prepare("SELECT status,data FROM transitions WHERE id=?").get(id) as
        | { status: string; data: string | null }
        | undefined
      if (old) {
        this.db.exec("COMMIT")
        return {
          id,
          prior: old.data
            ? (JSON.parse(old.data) as ProjectCheckpointResult)
            : {
                status: "unknown",
                receipts: [],
                message: "Original transition intent already exists; no replay is permitted"
              }
        }
      }
      const pending = this.db
        .prepare(
          "SELECT id FROM transitions WHERE run=? AND unit=? AND status IN ('pending','unknown')"
        )
        .get(runId, unitId)
      if (pending) throw Error("PROJECT_CHECKPOINT_UNRESOLVED")
      this.db.prepare("INSERT INTO transitions VALUES(?,?,?,'pending',NULL)").run(id, runId, unitId)
      this.db.exec("COMMIT")
      return { id }
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  settleTransition(id: string, result: ProjectCheckpointResult): void {
    const data = JSON.stringify(result)
    if (Buffer.byteLength(data) > 256 * 1024) throw Error("STAGE_CHECK_RECEIPT_LIMIT")
    this.db
      .prepare("UPDATE transitions SET status=?,data=? WHERE id=? AND status='pending'")
      .run(result.status, data, id)
  }
  close(): void {
    this.db.close()
  }
}
