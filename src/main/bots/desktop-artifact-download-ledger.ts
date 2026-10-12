import { DatabaseSync, type StatementSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, lstatSync, realpathSync } from "node:fs"
import { dirname, resolve, isAbsolute, join } from "node:path"
import { z } from "zod"
import {
  BOT_ARTIFACT_DOWNLOAD_HISTORY,
  BOT_ARTIFACT_DOWNLOAD_PENDING,
  BOT_ARTIFACT_DOWNLOAD_RECEIPTS,
  BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES,
  botArtifactDownloadJobSchema,
  botArtifactDownloadStateSchema,
  botArtifactDownloadNonceSchema,
  type BotArtifactDownloadJob,
  type BotArtifactDownloadSource
} from "../../shared/bot-artifact-downloads"
import { BotDomainError } from "../../shared/bot-types"

export const downloadIdentitySchema = z
  .object({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    size: z.string().regex(/^\d+$/),
    modified: z.string().regex(/^\d+$/),
    changed: z.string().regex(/^\d+$/)
  })
  .strict()
export type DownloadIdentity = z.infer<typeof downloadIdentitySchema>
export const downloadTargetSchema = z
  .object({
    path: z.string().min(1).max(4096),
    parent: z.string().min(1).max(4096),
    parentDevice: z.string().regex(/^\d+$/),
    parentInode: z.string().regex(/^\d+$/)
  })
  .strict()
export const downloadRecordSchema = z
  .object({
    job: botArtifactDownloadJobSchema,
    target: downloadTargetSchema.optional(),
    stage: z
      .object({
        path: z.string().min(1).max(4096),
        identity: downloadIdentitySchema
      })
      .strict()
      .optional(),
    prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z
      .object({
        identity: downloadIdentitySchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .optional(),
    published: downloadIdentitySchema.optional()
  })
  .strict()
  .refine((record) => {
    if (
      record.target &&
      (!isAbsolute(record.target.path) ||
        !isAbsolute(record.target.parent) ||
        record.target.path !== resolve(record.target.path) ||
        record.target.parent !== dirname(record.target.path))
    )
      return false
    if (
      record.stage &&
      (!record.target ||
        record.stage.path !== join(record.target.parent, `.CMBDevClaw-save-${record.job.id}.part`))
    )
      return false
    if (
      record.intent &&
      (!record.stage ||
        record.intent.sha256 !== record.job.source.sha256 ||
        record.intent.identity.device !== record.stage.identity.device ||
        record.intent.identity.inode !== record.stage.identity.inode)
    )
      return false
    return !record.published || (record.target !== undefined && record.job.state === "completed")
  }, "Invalid private save ownership")
export type DownloadRecord = z.infer<typeof downloadRecordSchema>

const receiptSchema = z
  .object({
    id: botArtifactDownloadNonceSchema,
    source_key: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.union([botArtifactDownloadStateSchema, z.literal("archived")]),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    created_at: z.number().int().nonnegative()
  })
  .strict()
const jobSelect = `SELECT j.id,j.revision,j.state,j.created_at,j.conversation,j.record,
  r.id AS receipt_id,r.source_key AS receipt_source_key,r.state AS receipt_state,
  r.revision AS receipt_revision,r.created_at AS receipt_created_at
  FROM download_jobs j LEFT JOIN download_receipts r ON r.id=j.id`
const terminal = (state: BotArtifactDownloadJob["state"]) =>
  ["completed", "cancelled", "failed"].includes(state)
export const artifactDownloadSourceKey = (source: BotArtifactDownloadSource) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        source.artifactId,
        source.conversationId,
        source.sha256,
        source.size,
        source.dataEpoch
      ])
    )
    .digest("hex")

/** Single Main-owned DB; one bounded row per checkpoint, never the Host DB or a 10k receipt rewrite. */
export class DesktopArtifactDownloadLedger {
  private readonly db: DatabaseSync
  private closed = false
  private readonly statements = new Map<string, StatementSync>()
  private readonly rootIdentity: { device: bigint; inode: bigint }
  private readonly dbIdentity: { device: bigint; inode: bigint }
  private readonly sidecarIdentities = new Map<string, { device: bigint; inode: bigint }>()
  constructor(private readonly path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    } catch {
      throw new BotDomainError("download_request_rejected", "无法打开保存记录目录")
    }
    const parent = lstatSync(dirname(path), { bigint: true })
    if (!parent.isDirectory() || realpathSync(dirname(path)) !== resolve(dirname(path)))
      throw new BotDomainError("download_request_rejected", "保存记录目录无效")
    this.rootIdentity = { device: parent.dev, inode: parent.ino }
    try {
      const before = lstatSync(path, { bigint: true })
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size > BigInt(BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES)
      )
        throw new BotDomainError("download_request_rejected", "保存记录文件无效或超过限制")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof BotDomainError) throw error
        throw new BotDomainError("download_request_rejected", "无法打开保存记录文件")
      }
    }
    this.assertSidecars()
    try {
      this.db = new DatabaseSync(path)
    } catch {
      throw new BotDomainError("download_request_rejected", "无法打开保存记录文件")
    }
    try {
      const info = lstatSync(path, { bigint: true })
      if (!info.isFile() || info.nlink !== 1n || realpathSync(path) !== resolve(path))
        throw new BotDomainError("download_request_rejected", "保存记录文件无效")
      this.dbIdentity = { device: info.dev, inode: info.ino }
      this.db.exec("PRAGMA busy_timeout=0")
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version)
      const tables = this.db
        .prepare(
          "SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'"
        )
        .all()
      const fresh = version === 0 && tables.length === 0
      if (
        !fresh &&
        (version !== 1 ||
          tables.length !== 2 ||
          tables.some(
            (row) =>
              row.type !== "table" ||
              !["download_jobs", "download_receipts"].includes(String(row.name))
          ))
      )
        throw new BotDomainError("download_request_rejected", "保存记录版本或结构不兼容")
      const size = Number(this.db.prepare("PRAGMA page_size").get()!.page_size)
      const pages = Number(this.db.prepare("PRAGMA page_count").get()!.page_count)
      if (
        !Number.isSafeInteger(size) ||
        size < 512 ||
        size > 65536 ||
        (size & (size - 1)) !== 0 ||
        !Number.isSafeInteger(pages) ||
        pages < 0 ||
        pages * size > BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES
      )
        throw new BotDomainError("download_capacity", "保存记录超过限制")
      const check = this.db.prepare("PRAGMA quick_check(1)").get()
      if (!check || Object.values(check)[0] !== "ok")
        throw new BotDomainError("download_request_rejected", "保存记录完整性校验失败")
      if (
        !fresh &&
        String(this.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !==
          "delete"
      )
        throw new BotDomainError("download_request_rejected", "保存记录日志模式不兼容")
      // No long readers. DELETE journal avoids unbounded WAL growth and keeps FULL durability.
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        PRAGMA max_page_count=${Math.floor(BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES / size)};`)
      if (fresh)
        this.db.exec(`CREATE TABLE download_jobs(id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, conversation TEXT NOT NULL, record TEXT NOT NULL);
        CREATE INDEX download_jobs_page ON download_jobs(created_at DESC,id DESC);
        CREATE TABLE download_receipts(id TEXT PRIMARY KEY, source_key TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL); PRAGMA user_version=1;`)
      this.assertTableSchema("download_jobs", [
        "id:TEXT:0:1",
        "revision:INTEGER:1:0",
        "state:TEXT:1:0",
        "created_at:INTEGER:1:0",
        "conversation:TEXT:1:0",
        "record:TEXT:1:0"
      ])
      this.assertTableSchema("download_receipts", [
        "id:TEXT:0:1",
        "source_key:TEXT:1:0",
        "state:TEXT:1:0",
        "revision:INTEGER:1:0",
        "created_at:INTEGER:1:0"
      ])
      const receipts = Number(
        this.db.prepare("SELECT count(*) AS n FROM download_receipts").get()!.n
      )
      const jobs = Number(this.db.prepare("SELECT count(*) AS n FROM download_jobs").get()!.n)
      if (
        receipts > BOT_ARTIFACT_DOWNLOAD_RECEIPTS ||
        jobs > BOT_ARTIFACT_DOWNLOAD_HISTORY + BOT_ARTIFACT_DOWNLOAD_PENDING
      )
        throw new BotDomainError("download_capacity", "保存记录超过限制")
      this.sidecarIdentities.clear()
      this.assertCurrent()
    } catch (error) {
      this.closed = true
      this.db.close()
      if (error instanceof BotDomainError) throw error
      throw new BotDomainError("download_request_rejected", "保存记录校验失败")
    }
  }
  private assertTableSchema(
    name: "download_jobs" | "download_receipts",
    expected: readonly string[]
  ): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((row) => `${row.name}:${String(row.type).toUpperCase()}:${row.notnull}:${row.pk}`)
    if (JSON.stringify(columns) !== JSON.stringify(expected))
      throw new BotDomainError("download_request_rejected", "保存记录结构不兼容")
  }
  private assertSidecars(): void {
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const path = this.path + suffix
      try {
        const info = lstatSync(path, { bigint: true }),
          previous = this.sidecarIdentities.get(suffix)
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1n ||
          info.size > BigInt(BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES + 65536) ||
          realpathSync(path) !== resolve(path) ||
          (previous && (previous.device !== info.dev || previous.inode !== info.ino))
        )
          throw new BotDomainError("download_ledger_unavailable", "保存记录日志无效或超过限制")
        this.sidecarIdentities.set(suffix, {
          device: info.dev,
          inode: info.ino
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (error instanceof BotDomainError) throw error
          throw new BotDomainError("download_ledger_unavailable", "保存记录日志无法打开")
        }
        this.sidecarIdentities.delete(suffix)
      }
    }
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }
  private assertCurrent(): void {
    if (this.closed) throw new BotDomainError("download_ledger_unavailable", "保存服务已关闭")
    try {
      this.assertSidecars()
      const root = lstatSync(dirname(this.path), { bigint: true }),
        file = lstatSync(this.path, { bigint: true })
      if (
        !root.isDirectory() ||
        root.dev !== this.rootIdentity.device ||
        root.ino !== this.rootIdentity.inode ||
        !file.isFile() ||
        file.size > BigInt(BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES) ||
        file.nlink !== 1n ||
        file.dev !== this.dbIdentity.device ||
        file.ino !== this.dbIdentity.inode ||
        realpathSync(dirname(this.path)) !== resolve(dirname(this.path)) ||
        realpathSync(this.path) !== resolve(this.path)
      )
        throw new BotDomainError("download_ledger_unavailable", "保存记录目录发生变化")
    } catch (error) {
      if (error instanceof BotDomainError) throw error
      throw new BotDomainError("download_ledger_unavailable", "保存记录目录发生变化")
    }
  }
  receipt(id: string): { sourceKey: string; state: string; revision: number } | undefined {
    this.assertCurrent()
    const row = this.statement(
      "SELECT id,source_key,state,revision,created_at FROM download_receipts WHERE id=?"
    ).get(id)
    if (!row) return undefined
    const parsed = receiptSchema.safeParse(row)
    if (!parsed.success || parsed.data.id !== id)
      throw new BotDomainError("download_ledger_unavailable", "保存回执无效")
    return {
      sourceKey: parsed.data.source_key,
      state: parsed.data.state,
      revision: parsed.data.revision
    }
  }
  private decode(row: Record<string, unknown>): DownloadRecord {
    if (typeof row.record !== "string" || Buffer.byteLength(row.record) > 24 * 1024)
      throw new BotDomainError("download_ledger_unavailable", "保存记录无效或超过限制")
    let value: unknown
    try {
      value = JSON.parse(row.record)
    } catch {
      throw new BotDomainError("download_ledger_unavailable", "保存记录无效")
    }
    const parsed = downloadRecordSchema.safeParse(value)
    if (!parsed.success) throw new BotDomainError("download_ledger_unavailable", "保存记录无效")
    const record = parsed.data,
      job = record.job
    const receiptResult = receiptSchema.safeParse({
      id: row.receipt_id,
      source_key: row.receipt_source_key,
      state: row.receipt_state,
      revision: row.receipt_revision,
      created_at: row.receipt_created_at
    })
    const receipt = receiptResult.success ? receiptResult.data : undefined
    if (
      row.id !== job.id ||
      row.revision !== job.revision ||
      row.state !== job.state ||
      row.created_at !== job.createdAt ||
      row.conversation !== job.source.conversationId ||
      !receipt ||
      receipt.source_key !== artifactDownloadSourceKey(job.source) ||
      receipt.state !== job.state ||
      receipt.revision !== job.revision ||
      receipt.created_at !== job.createdAt
    )
      throw new BotDomainError("download_ledger_unavailable", "保存记录与回执不一致")
    return record
  }
  get(id: string): DownloadRecord | undefined {
    this.assertCurrent()
    const row = this.statement(`${jobSelect} WHERE j.id=?`).get(id)
    return row ? this.decode(row) : undefined
  }
  list(): DownloadRecord[] {
    this.assertCurrent()
    const rows = this.statement(`${jobSelect} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).all(
      BOT_ARTIFACT_DOWNLOAD_HISTORY + BOT_ARTIFACT_DOWNLOAD_PENDING + 1
    )
    if (rows.length > BOT_ARTIFACT_DOWNLOAD_HISTORY + BOT_ARTIFACT_DOWNLOAD_PENDING)
      throw new BotDomainError("download_capacity", "保存记录超过限制")
    return rows.map((row) => this.decode(row))
  }
  private transaction<T>(operation: () => T): T {
    this.assertCurrent()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const value = operation()
      this.assertCurrent()
      this.db.exec("COMMIT")
      this.assertSidecars()
      return value
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
        this.sidecarIdentities.clear()
      } catch {
        /* keep the original failure */
      }
      throw error
    }
  }
  admit(record: DownloadRecord): void {
    record = downloadRecordSchema.parse(record)
    this.transaction(() => {
      const count = Number(this.statement("SELECT count(*) AS n FROM download_receipts").get()!.n)
      if (count >= BOT_ARTIFACT_DOWNLOAD_RECEIPTS)
        throw new BotDomainError("download_capacity", "保存回执已满，请维护保存记录")
      this.statement("INSERT INTO download_receipts VALUES(?,?,?,?,?)").run(
        record.job.id,
        artifactDownloadSourceKey(record.job.source),
        record.job.state,
        record.job.revision,
        record.job.createdAt
      )
      this.statement("INSERT INTO download_jobs VALUES(?,?,?,?,?,?)").run(
        record.job.id,
        record.job.revision,
        record.job.state,
        record.job.createdAt,
        record.job.source.conversationId,
        JSON.stringify(record)
      )
    })
  }
  /** Progress keeps control revision; state/control transitions increment it. */
  put(record: DownloadRecord, expectedRevision: number): void {
    record = downloadRecordSchema.parse(record)
    const bytes = JSON.stringify(record)
    if (Buffer.byteLength(bytes) > 24 * 1024)
      throw new BotDomainError("download_capacity", "保存记录超过限制")
    this.transaction(() => {
      const current = this.get(record.job.id)
      if (!current || current.job.revision !== expectedRevision)
        throw new BotDomainError("download_revision_conflict", "保存任务已变化，请刷新后操作")
      if (
        artifactDownloadSourceKey(current.job.source) !==
          artifactDownloadSourceKey(record.job.source) ||
        current.job.createdAt !== record.job.createdAt ||
        (current.target !== undefined &&
          JSON.stringify(current.target) !== JSON.stringify(record.target)) ||
        (current.stage !== undefined &&
          record.stage !== undefined &&
          (current.stage.path !== record.stage.path ||
            current.stage.identity.device !== record.stage.identity.device ||
            current.stage.identity.inode !== record.stage.identity.inode)) ||
        record.job.revision < expectedRevision ||
        record.job.revision > expectedRevision + 1
      )
        throw new BotDomainError("download_ledger_unavailable", "保存记录身份不能替换")
      const result = this.statement(
        "UPDATE download_jobs SET revision=?,state=?,record=? WHERE id=? AND revision=?"
      ).run(record.job.revision, record.job.state, bytes, record.job.id, expectedRevision)
      if (Number(result.changes) !== 1)
        throw new BotDomainError("download_revision_conflict", "保存任务已变化，请刷新后操作")
      this.statement("UPDATE download_receipts SET state=?,revision=? WHERE id=?").run(
        record.job.state,
        record.job.revision,
        record.job.id
      )
      if (terminal(record.job.state)) {
        const stale = this.statement(
          "SELECT id FROM download_jobs WHERE state IN ('completed','cancelled','failed') ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?"
        ).all(BOT_ARTIFACT_DOWNLOAD_HISTORY)
        for (const row of stale) {
          const saved = this.get(String(row.id))
          if (saved?.stage) continue // never drop the only owned-part receipt
          this.statement("DELETE FROM download_jobs WHERE id=?").run(String(row.id))
          this.statement("UPDATE download_receipts SET state='archived' WHERE id=?").run(
            String(row.id)
          )
        }
      }
    })
  }
  forget(id: string, revision: number): void {
    this.transaction(() => {
      const record = this.get(id)
      if (!record || record.job.revision !== revision)
        throw new BotDomainError("download_revision_conflict", "保存任务已变化，请刷新后操作")
      if (!terminal(record.job.state) || record.stage)
        throw new BotDomainError("download_cleanup_required", "请先取消并清理未完成的保存")
      this.statement("DELETE FROM download_jobs WHERE id=?").run(id)
      this.statement("UPDATE download_receipts SET state='archived' WHERE id=?").run(id)
    })
  }
  close(): void {
    if (!this.closed) {
      this.closed = true
      this.db.close()
      this.statements.clear()
    }
  }
}
