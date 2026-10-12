import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  botShellJobRead,
  botShellJobStop,
  botShellJobStatus,
  type BotShellJobView
} from "../../shared/bot-shell-jobs"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import type { BotShellProgress, BotShellResult } from "./shell-contract"

const OUTPUT_LIMIT = 262144
const active = "('queued','running','cancelling')"
const columns =
  "id,run_id,invocation,effect_id,command,status,fence,revision,substr(output,1,?) AS output,truncated,exit_code,created_at,updated_at"
const rowSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  invocation: z.string(),
  effect_id: z.string(),
  command: z.string(),
  status: botShellJobStatus,
  fence: z.number(),
  revision: z.number(),
  output: z.string(),
  truncated: z.number(),
  exit_code: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number()
})

/** SQLite owns job identity and bounded output. A lost executor is never relaunched. */
export class BotShellJobsStore {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, input: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  private rows(sql: string, args: (string | number)[]) {
    const result = this.store.db.exec(sql, args)[0]
    return (result?.values ?? []).map((row) =>
      rowSchema.parse(Object.fromEntries(result.columns.map((column, i) => [column, row[i]])))
    )
  }

  get(runId: string, id: string, outputLimit = OUTPUT_LIMIT) {
    const value = this.rows(`SELECT ${columns} FROM bot_shell_jobs WHERE run_id=? AND id=?`, [
      outputLimit,
      runId,
      id
    ])[0]
    if (!value) throw new BotDomainError("shell_job_scope", "后台命令不属于当前任务")
    return value
  }

  list(runId: string, outputLimit = 12001) {
    return this.rows(
      `SELECT ${columns} FROM bot_shell_jobs WHERE run_id=? ORDER BY created_at,id LIMIT 16`,
      [outputLimit, runId]
    )
  }

  find(runId: string, invocation: string) {
    return this.rows(`SELECT ${columns} FROM bot_shell_jobs WHERE run_id=? AND invocation=?`, [
      0,
      runId,
      invocation
    ])[0]
  }

  /** Called inside toolOnce, atomically with beginEffect and its approval consumption. */
  reserve(lease: BotRunLease, invocation: string, effectId: string, command: string): string {
    this.store.assertDispatch(lease)
    const count = Number(
      this.store.db.exec(`SELECT COUNT(*) FROM bot_shell_jobs WHERE status IN ${active}`)[0]
        ?.values[0]?.[0] ?? 0
    )
    const entries = this.list(lease.runId, 0)
    if (
      entries.length >= 16 ||
      entries.filter((row) => ["queued", "running", "cancelling"].includes(row.status)).length >=
        4 ||
      count >= 8
    )
      throw new Error("后台命令达到并发或当前任务保存上限，请先等待已有命令结束")
    const id = randomUUID(),
      now = this.store.now()
    this.store.db.run(
      `INSERT INTO bot_shell_jobs(id,run_id,invocation,effect_id,command,status,fence,revision,output,truncated,exit_code,created_at,updated_at)
      VALUES(?,?,?,?,?,'queued',?,1,'',0,NULL,?,?)`,
      [id, lease.runId, invocation, effectId, command, lease.fence, now, now]
    )
    this.event("shell.queued", lease.runId, { jobId: id })
    return id
  }

  private owned(lease: BotRunLease, id: string) {
    this.store.assertLease(lease, true, true)
    const row = this.get(lease.runId, id, 0)
    if (row.fence !== lease.fence || !["queued", "running", "cancelling"].includes(row.status))
      throw new BotDomainError("stale_shell_job", "后台命令执行权已失效")
    return row
  }

  start(lease: BotRunLease, id: string): boolean {
    return this.store.transaction(() => {
      this.store.assertDispatch(lease, true)
      const row = this.owned(lease, id)
      if (row.status === "cancelling") return false
      if (row.status !== "queued")
        throw new BotDomainError("shell_job_started", "后台命令已有启动记录，禁止重复执行")
      this.store.db.run(
        "UPDATE bot_shell_jobs SET status='running',revision=revision+1,updated_at=? WHERE id=?",
        [this.store.now(), id]
      )
      this.event("shell.started", lease.runId, { jobId: id })
      return true
    })
  }

  progress(lease: BotRunLease, id: string, value: BotShellProgress): void {
    this.store.transaction(() => {
      this.owned(lease, id)
      this.store.db.run("UPDATE bot_shell_jobs SET output=?,truncated=?,updated_at=? WHERE id=?", [
        value.output.slice(0, OUTPUT_LIMIT),
        value.truncated || value.output.length > OUTPUT_LIMIT ? 1 : 0,
        this.store.now(),
        id
      ])
    })
  }

  finish(
    lease: BotRunLease,
    id: string,
    result: BotShellResult,
    neverStarted: boolean | "failed" = false
  ): void {
    const row = this.owned(lease, id)
    this.progress(lease, id, result)
    const uncertain =
      !neverStarted &&
      (result.exitCode === null || result.exitCode === 124 || result.exitCode === 130)
    const status = uncertain
      ? "needs_review"
      : neverStarted === "failed"
        ? "failed"
        : neverStarted
          ? "cancelled"
          : result.exitCode === 0
            ? "succeeded"
            : "failed"
    this.store.settleEffect(
      lease,
      row.effect_id,
      uncertain ? "unknown" : neverStarted === "failed" ? "failed" : "succeeded",
      JSON.stringify({ jobId: id, status, exitCode: result.exitCode })
    )
  }

  /** Called only by settleEffect inside its own transaction, after checking the exact fence. */
  settled(effectId: string, receipt: string): void {
    const row = this.rows("SELECT * FROM bot_shell_jobs WHERE effect_id=?", [effectId])[0]
    if (!row) return
    const result = z
      .object({
        jobId: z.literal(row.id),
        status: botShellJobStatus,
        exitCode: z.number().nullable()
      })
      .parse(JSON.parse(receipt))
    if (["queued", "running", "cancelling"].includes(result.status))
      throw new Error("后台命令收据不是终态")
    this.store.db.run(
      "UPDATE bot_shell_jobs SET status=?,exit_code=?,revision=revision+1,updated_at=? WHERE id=?",
      [result.status, result.exitCode, this.store.now(), row.id]
    )
    this.event("shell.settled", row.run_id, { jobId: row.id, status: result.status })
  }

  wasReviewed(effectId: string): boolean {
    return Boolean(
      this.store.db.exec(
        "SELECT 1 FROM bot_effects WHERE id=? AND status IN ('succeeded','failed')",
        [effectId]
      )[0]?.values.length
    )
  }

  read(raw: unknown): BotShellJobView {
    const parsed = botShellJobRead.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "后台命令查询参数无效")
    const input = parsed.data
    const run = this.store.assertRunAddress(input)
    this.store.getBot(run.botId)
    if (!this.store.getConversation(run.conversationId).members.includes(run.botId))
      throw new BotDomainError("shell_job_scope", "Bot 已不在此对话中")
    const row = this.get(run.id, input.jobId),
      offset = input.offset ?? 0
    return {
      dataEpoch: this.store.dataEpoch(),
      id: row.id,
      address: {
        runId: run.id,
        conversationId: run.conversationId,
        ...(run.threadRootId ? { threadRootId: run.threadRootId } : {})
      },
      command: row.command,
      ...(this.store.shellServices.isService(row.id) ? { keepAlive: true } : {}),
      ...(row.status === "needs_review" && this.wasReviewed(row.effect_id)
        ? { reviewed: true }
        : {}),
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      exitCode: row.exit_code,
      output: row.output.slice(offset, offset + 16000),
      truncated: Boolean(row.truncated),
      nextOffset: offset + 16000 < row.output.length ? offset + 16000 : null
    }
  }

  stop(raw: unknown): BotShellJobView {
    const parsed = botShellJobStop.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "后台命令停止参数无效")
    const input = parsed.data
    return this.store.transaction(() => {
      if (input.dataEpoch !== this.store.backupSchedule.epoch())
        throw new BotDomainError("data_epoch", "数据已恢复，请重新打开命令记录")
      this.read({
        conversationId: input.conversationId,
        runId: input.runId,
        threadRootId: input.threadRootId,
        jobId: input.jobId
      })
      return this.receipt(input.nonce, { method: "stopShellJob", ...input }, () => {
        const current = this.read({
          conversationId: input.conversationId,
          runId: input.runId,
          threadRootId: input.threadRootId,
          jobId: input.jobId
        })
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "命令状态已变化，请刷新后重试")
        if (["queued", "running"].includes(current.status)) {
          this.requestStopInTransaction(input.runId, input.jobId)
        }
        return this.read({
          conversationId: input.conversationId,
          runId: input.runId,
          threadRootId: input.threadRootId,
          jobId: input.jobId
        })
      })
    })
  }

  /** Host-owned revocation inside the caller's domain transaction/receipt.
   * Keep the effect untouched until the supervisor collects the process result. */
  requestStopInTransaction(runId: string, jobId: string): void {
    this.get(runId, jobId, 0)
    this.store.db.run(
      "UPDATE bot_shell_jobs SET status='cancelling',revision=revision+1,updated_at=? WHERE id=? AND run_id=? AND status IN ('queued','running')",
      [this.store.now(), jobId, runId]
    )
    if (this.store.db.getRowsModified()) this.event("shell.stop_requested", runId, { jobId })
  }

  interrupt(runId: string): void {
    this.store.db.run(
      `UPDATE bot_shell_jobs SET status='needs_review',revision=revision+1,updated_at=? WHERE run_id=? AND status IN ${active}`,
      [this.store.now(), runId]
    )
  }
}
