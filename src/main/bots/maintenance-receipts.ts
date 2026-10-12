import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { canonicalJson } from "./validation"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { botComputerCheckpointRestoreResult } from "../../shared/bot-computer-checkpoint"

export const BOT_MAINTENANCE_RECEIPT_BYTES = 8 * 1024 ** 2
const scopeSchema = z.enum(["backup", "browser", "workspace", "computer", "recovery"])
const reasonSchema = z.enum(["manual", "before-restore", "before-reset", "scheduled"])
const idSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase())
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
type Scope = z.infer<typeof scopeSchema>
type Reason = z.infer<typeof reasonSchema>
type Receipt = { reason: Reason; state: "reserved" | "published" | "deleted"; sha256: string }
const states = ["reserved", "published", "deleted"] as const
const operationScope = z.enum([
  "workspace",
  "browser",
  "computer",
  "recovery",
  "computer-delete",
  "windows-setup"
])
const operationStates = ["reserved", "sealed", "completed"] as const
const operationAction = z.enum(["restore", "reset", "delete-recovery", "delete", "setup"])
type OperationScope = z.infer<typeof operationScope>
type OperationReceipt = {
  action: z.infer<typeof operationAction>
  requestSha256: string
  journalSha256: string
  state: (typeof operationStates)[number]
  result: unknown
}
const receiptSql = (name: string) => `CREATE TABLE ${name}(
  scope TEXT NOT NULL CHECK(scope IN ('backup','browser','workspace','computer','recovery')),
  id TEXT NOT NULL CHECK(length(id)=36),
  reason TEXT NOT NULL CHECK(reason IN ('manual','before-restore','before-reset','scheduled')),
  state INTEGER NOT NULL CHECK(state IN (10,11,12)),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64), PRIMARY KEY(scope,id)) WITHOUT ROWID;`
const operationsSql = (name: string) => `CREATE TABLE ${name}(
  scope TEXT NOT NULL CHECK(scope IN ('workspace','browser','computer','recovery','computer-delete','windows-setup')),
  id TEXT NOT NULL CHECK(length(id)=36),
  action TEXT NOT NULL CHECK(action IN ('restore','reset','delete-recovery','delete','setup')),
  state INTEGER NOT NULL CHECK(state IN (32,33,34)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  journal_sha256 TEXT NOT NULL CHECK(length(journal_sha256)=64),
  result TEXT NOT NULL CHECK(length(CAST(result AS BLOB))<=8192),
  PRIMARY KEY(scope,id)) WITHOUT ROWID;`
const unavailable = () => new Error("恢复点操作记录暂时无法保存或读取，请检查本机存储后重试")
const changed = () => new Error("恢复点已变化，请刷新后重新选择")
const deleted = () =>
  new BotDomainError("snapshot_deleted", "该请求创建的恢复点已删除；请发起新的保存操作")

/** Monotonic request identities stay outside restored snapshots. Reuse the
 * deletion ledger's FULL-sync, stable-file and hard-cap convention. Reserved
 * creates remain retryable; a published identity can only become deleted.
 * Tombstones are never evicted: capacity failure precedes destructive work.
 * The caller owns the Host maintenance lock (or its scheduled worker lease).
 */
export class BotMaintenanceReceipts {
  private readonly db: DatabaseSync
  private readonly path: string
  private readonly identity: { dev: bigint; ino: bigint }
  private readonly initialized: boolean
  private readonly version: number
  private closed = false

  static readOnly(directory: string): BotMaintenanceReceipts | undefined {
    try {
      lstatSync(join(directory, "maintenance-receipts.sqlite"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw unavailable()
    }
    return new BotMaintenanceReceipts(directory, true)
  }

  constructor(
    directory: string,
    private readonly readOnly = false
  ) {
    let db: DatabaseSync | undefined
    try {
      const root = realpathSync(directory)
      this.path = join(root, "maintenance-receipts.sqlite")
      if (!readOnly) {
        try {
          const fd = openSync(this.path, "wx", 0o600)
          closeSync(fd)
          if (process.platform !== "win32") {
            const parent = openSync(root, "r")
            try {
              fsyncSync(parent)
            } finally {
              closeSync(parent)
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      }
      const info = lstatSync(this.path, { bigint: true })
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(BOT_MAINTENANCE_RECEIPT_BYTES))
        throw unavailable()
      this.identity = info
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        try {
          const sidecar = lstatSync(this.path + suffix)
          if (!sidecar.isFile() || sidecar.nlink !== 1) throw unavailable()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      db = new DatabaseSync(this.path, { readOnly })
      db.exec("PRAGMA busy_timeout=5000")
      const version = db.prepare("PRAGMA user_version").get()?.user_version,
        tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (
        (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4) ||
        (version === 0 && tables.length !== 0) ||
        (version === 1 && (tables.length !== 1 || tables[0].name !== "receipts")) ||
        ((version === 2 || version === 3 || version === 4) &&
          (tables.length !== 2 ||
            !tables.some((t) => t.name === "receipts") ||
            !tables.some((t) => t.name === "operations"))) ||
        db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok"
      )
        throw unavailable()
      if (!readOnly) {
        const pages = Math.floor(
          BOT_MAINTENANCE_RECEIPT_BYTES / Number(db.prepare("PRAGMA page_size").get()?.page_size)
        )
        if (Number(db.prepare("PRAGMA page_count").get()?.page_count) > pages) throw unavailable()
        db.exec(
          `PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=${pages};`
        )
        // The CHECK constraint requires a real table migration. All writes,
        // copying and schema publication share one FULL-sync transaction.
        // At the 8 MiB cap, SQLite rolls back without dropping old receipts.
        if (version !== 4) {
          db.exec("BEGIN IMMEDIATE")
          try {
            if (version === 1) {
              db.exec(receiptSql("receipts_v2"))
              db.exec(`INSERT INTO receipts_v2 SELECT * FROM receipts;
                DROP TABLE receipts; ALTER TABLE receipts_v2 RENAME TO receipts;`)
            } else if (version === 0) db.exec(receiptSql("receipts"))
            if (version === 2 || version === 3) {
              db.exec(operationsSql("operations_v4"))
              db.exec(`INSERT INTO operations_v4 SELECT * FROM operations;
                DROP TABLE operations; ALTER TABLE operations_v4 RENAME TO operations;`)
            } else db.exec(operationsSql("operations"))
            db.exec("PRAGMA user_version=4; COMMIT")
          } catch (error) {
            if (db.isTransaction) db.exec("ROLLBACK")
            throw error
          }
        }
      }
      // An interruption between creating the file and initializing SQLite has
      // no request identities to recover. A reader must not prevent its owner
      // from finishing initialization on the next maintenance operation.
      this.initialized =
        version === 1 || version === 2 || version === 3 || version === 4 || !readOnly
      this.version = readOnly ? Number(version) : 4
      this.db = db
      this.assertIdentity()
    } catch {
      db?.close()
      throw unavailable()
    }
  }

  private assertIdentity(): void {
    if (this.closed) throw unavailable()
    try {
      const info = lstatSync(this.path, { bigint: true })
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.dev !== this.identity.dev ||
        info.ino !== this.identity.ino
      )
        throw unavailable()
    } catch {
      throw unavailable()
    }
  }

  get(scope: Scope, id: string): Receipt | undefined {
    this.assertIdentity()
    if (!this.initialized) return undefined
    try {
      const row = this.db
        .prepare("SELECT reason,state,sha256 FROM receipts WHERE scope=? AND id=?")
        .get(scopeSchema.parse(scope), idSchema.parse(id))
      if (!row) return undefined
      const state = z.number().int().min(10).max(12).parse(row.state)
      return {
        reason: reasonSchema.parse(row.reason),
        state: states[state - 10],
        sha256: hashSchema.parse(row.sha256)
      }
    } catch {
      throw unavailable()
    }
  }

  private write(operation: () => void): void {
    if (this.readOnly) throw unavailable()
    this.assertIdentity()
    try {
      this.db.exec("BEGIN IMMEDIATE")
      try {
        operation()
        this.assertIdentity()
        this.db.exec("COMMIT")
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      }
    } catch {
      throw unavailable()
    }
  }

  assertActive(scope: Scope, id: string, sha256?: string): void {
    const previous = this.get(scope, id)
    if (previous?.state === "deleted") throw deleted()
    if (previous?.state === "published" && sha256 && previous.sha256 !== sha256) throw changed()
  }

  reserve(scope: Scope, id: string, reason: Reason): void {
    scopeSchema.parse(scope)
    reasonSchema.parse(reason)
    const key = idSchema.parse(id),
      previous = this.get(scope, key)
    if ((scope === "workspace" || scope === "browser") && this.getOperation(scope, key))
      throw new Error("恢复点标识已用于其他操作")
    if (previous?.state === "deleted") throw deleted()
    if (previous && previous.reason !== reason) throw new Error("恢复点标识已用于其他操作")
    if (previous) return
    // Allocate the full future digest and state width before publishing bytes.
    // All three state values use the same SQLite integer representation.
    this.write(() => {
      this.db
        .prepare("INSERT INTO receipts VALUES(?,?,?,10,?)")
        .run(scope, key, reason, "0".repeat(64))
    })
  }

  publish(scope: Scope, id: string, reason: Reason, sha256: string): void {
    hashSchema.parse(sha256)
    this.reserve(scope, id, reason)
    const previous = this.get(scope, id)!
    if (previous.state === "published") {
      if (previous.sha256 !== sha256) throw changed()
      return
    }
    this.write(() => {
      this.db
        .prepare("UPDATE receipts SET state=11,sha256=? WHERE scope=? AND id=? AND state=10")
        .run(sha256, scope, idSchema.parse(id))
    })
  }

  releaseReservation(scope: Scope, id: string): void {
    if (this.get(scope, id)?.state !== "reserved") return
    this.write(() => {
      this.db
        .prepare("DELETE FROM receipts WHERE scope=? AND id=? AND state=10")
        .run(scope, idSchema.parse(id))
    })
  }

  retire(scope: Scope, id: string, sha256: string, reason?: Reason): void {
    hashSchema.parse(sha256)
    const key = idSchema.parse(id),
      previous = this.get(scope, key)
    if ((scope === "workspace" || scope === "browser") && this.getOperation(scope, key))
      throw new Error("恢复点标识已用于其他操作")
    if (previous && previous.state !== "reserved" && previous.sha256 !== sha256) throw changed()
    if (previous && reason && previous.reason !== reason)
      throw new Error("恢复点标识已用于其他操作")
    if (previous?.state === "deleted") return
    const savedReason = reasonSchema.parse(reason ?? previous?.reason ?? "manual")
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO receipts VALUES(?,?,?,12,?)
          ON CONFLICT(scope,id) DO UPDATE SET state=12,sha256=excluded.sha256`
        )
        .run(scope, key, savedReason, sha256)
    })
  }

  static requestHash(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex")
  }

  getOperation(scope: OperationScope, id: string): OperationReceipt | undefined {
    this.assertIdentity()
    if (this.version < 2) return undefined
    const row = this.db
      .prepare(
        `SELECT action,state,request_sha256,journal_sha256,result
      FROM operations WHERE scope=? AND id=?`
      )
      .get(operationScope.parse(scope), idSchema.parse(id))
    if (!row) return undefined
    const bytes = String(row.result)
    if (Buffer.byteLength(bytes) > 8192) throw unavailable()
    return {
      action: operationAction.parse(row.action),
      state: operationStates[z.number().int().min(32).max(34).parse(row.state) - 32],
      requestSha256: hashSchema.parse(row.request_sha256),
      journalSha256: hashSchema.parse(row.journal_sha256),
      result: JSON.parse(bytes) as unknown
    }
  }

  /** A bounded witness, never a reconstruction of the latest restore nonce.
   * Startup may use this only when the control DB has no durable generation. */
  hasVerifiedCompletedComputerRestore(): boolean {
    this.assertIdentity()
    if (this.version < 2) {
      this.assertIdentity()
      return false
    }
    try {
      const row = this.db
        .prepare(
          "SELECT id FROM operations WHERE scope='computer' AND action='restore' AND state=34 LIMIT 1"
        )
        .get()
      if (!row) {
        this.assertIdentity()
        return false
      }
      const id = idSchema.parse(row.id),
        operation = this.getOperation("computer", id),
        result = botComputerCheckpointRestoreResult.parse(operation?.result)
      if (
        operation?.action !== "restore" ||
        operation.state !== "completed" ||
        operation.journalSha256 === "0".repeat(64) ||
        result.recoveryCopy !== id ||
        operation.requestSha256 !==
          BotMaintenanceReceipts.requestHash({
            action: "restore",
            nonce: id,
            checkpoint: result.checkpoint
          })
      )
        throw unavailable()
      this.assertIdentity()
      return true
    } catch {
      throw unavailable()
    }
  }

  reserveOperation(
    scope: OperationScope,
    id: string,
    action: OperationReceipt["action"],
    requestSha256: string,
    result: unknown
  ): void {
    operationScope.parse(scope)
    operationAction.parse(action)
    hashSchema.parse(requestSha256)
    const key = idSchema.parse(id),
      serialized = canonicalJson(result),
      previous = this.getOperation(scope, key)
    if ((scope === "workspace" || scope === "browser") && this.get(scope, key))
      throw new Error("操作标识已用于保存恢复点")
    if (Buffer.byteLength(serialized) > 8192) throw unavailable()
    if (previous) {
      if (
        previous.action !== action ||
        previous.requestSha256 !== requestSha256 ||
        canonicalJson(previous.result) !== serialized
      )
        throw new Error("操作标识已用于其他恢复请求")
      return
    }
    // Allocate all future state/digest/result bytes before journal publication.
    // A later completed update requires no larger row even at a full ledger.
    this.write(() => {
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,32,?,?,?)")
        .run(scope, key, action, requestSha256, "0".repeat(64), serialized)
    })
  }

  sealOperation(scope: OperationScope, id: string, journalSha256: string): void {
    hashSchema.parse(journalSha256)
    const previous = this.getOperation(scope, id)
    if (!previous) throw unavailable()
    if (previous.state !== "reserved") {
      if (previous.journalSha256 !== journalSha256) throw changed()
      return
    }
    this.write(() => {
      this.db
        .prepare(
          "UPDATE operations SET state=33,journal_sha256=? WHERE scope=? AND id=? AND state=32"
        )
        .run(journalSha256, scope, idSchema.parse(id))
    })
  }

  completeOperation(
    scope: OperationScope,
    id: string,
    journalSha256: string,
    result?: unknown
  ): void {
    const previous = this.getOperation(scope, id)
    if (
      !previous ||
      previous.state === "reserved" ||
      previous.journalSha256 !== hashSchema.parse(journalSha256)
    )
      throw unavailable()
    const serialized = result === undefined ? undefined : canonicalJson(result)
    if (
      serialized !== undefined &&
      (Buffer.byteLength(serialized) > 8192 ||
        Buffer.byteLength(serialized) > Buffer.byteLength(canonicalJson(previous.result)))
    )
      throw unavailable()
    if (previous.state === "completed") {
      if (serialized !== undefined && serialized !== canonicalJson(previous.result)) throw changed()
      return
    }
    this.write(() => {
      this.db
        .prepare(
          serialized === undefined
            ? "UPDATE operations SET state=34 WHERE scope=? AND id=? AND state=33"
            : "UPDATE operations SET state=34,result=? WHERE scope=? AND id=? AND state=33"
        )
        .run(
          ...(serialized === undefined
            ? [scope, idSchema.parse(id)]
            : [serialized, scope, idSchema.parse(id)])
        )
    })
  }

  releaseOperation(scope: OperationScope, id: string): void {
    if (this.getOperation(scope, id)?.state !== "reserved") return
    this.write(() => {
      this.db
        .prepare("DELETE FROM operations WHERE scope=? AND id=? AND state=32")
        .run(scope, idSchema.parse(id))
    })
  }

  /** Migration runs while the existing maintenance lock is held. Caller parses
   * legacy schemas and proves journal/checkpoint identity before each row. An
   * imported completed nonce never replays even after its old JSON is removed. */
  importCompletedOperation(
    scope: OperationScope,
    id: string,
    action: OperationReceipt["action"],
    request: unknown,
    result: unknown,
    journalSha256: string
  ): void {
    this.reserveOperation(scope, id, action, BotMaintenanceReceipts.requestHash(request), result)
    this.sealOperation(scope, id, journalSha256)
    this.completeOperation(scope, id, journalSha256)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
