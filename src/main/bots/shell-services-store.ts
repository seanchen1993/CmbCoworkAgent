import { randomUUID } from "node:crypto"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import type { BotShellProgress, BotShellResult } from "./shell-contract"

export interface BotShellServiceLease {
  jobId: string
  runId: string
  owner: string
  token: string
}
const live = "('queued','running','cancelling')"

/** A service retains the approved effect but has its own Host lease. Neither a
 * finished model turn nor a saved record authorizes a second process launch. */
export class BotShellServicesStore {
  constructor(
    private readonly store: BotStore,
    private readonly event: (kind: string, id: string, payload: unknown) => void,
    private readonly notify: (runId: string, jobId: string, uncertain: boolean) => void
  ) {}

  attach(lease: BotRunLease, jobId: string, timeoutMs: number): BotShellServiceLease {
    const run = this.store.assertDispatch(lease)
    if (
      run.source === "workflow-child" ||
      run.lane !== "user" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 7200000
    )
      throw new BotDomainError("shell_service_scope", "跨轮次服务必须由用户任务在批准的时限内启动")
    this.store.assertHostOwner(lease.owner)
    const row = this.store.shellJobs.get(lease.runId, jobId, 0)
    if (row.status !== "queued" || row.fence !== lease.fence)
      throw new BotDomainError("stale_shell_job", "服务启动记录已失效")
    const token = randomUUID()
    this.store.db.run("INSERT INTO bot_shell_services VALUES(?,?,?,?,?)", [
      jobId,
      lease.owner,
      token,
      this.store.now() + 30_000,
      this.store.now() + timeoutMs
    ])
    return { jobId, runId: lease.runId, owner: lease.owner, token }
  }

  isService(jobId: string): boolean {
    return Boolean(
      this.store.db.exec("SELECT 1 FROM bot_shell_services WHERE job_id=?", [jobId])[0]?.values
        .length
    )
  }

  assert(lease: BotShellServiceLease) {
    this.store.assertHostOwner(lease.owner)
    const record = this.store.db.exec(
      "SELECT lease_until FROM bot_shell_services WHERE job_id=? AND owner=? AND token=?",
      [lease.jobId, lease.owner, lease.token]
    )[0]?.values[0]
    const job = this.store.shellJobs.get(lease.runId, lease.jobId, 0)
    if (
      !record ||
      Number(record[0]) <= this.store.now() ||
      job.fence !== this.store.getRun(lease.runId).fence ||
      !["queued", "running", "cancelling"].includes(job.status)
    )
      throw new BotDomainError("stale_shell_service", "后台服务执行权已失效")
    return job
  }

  renew(lease: BotShellServiceLease): void {
    this.store.transaction(() => {
      this.assert(lease)
      this.store.db.run("UPDATE bot_shell_services SET lease_until=? WHERE job_id=?", [
        this.store.now() + 30_000,
        lease.jobId
      ])
    })
  }

  progress(lease: BotShellServiceLease, value: BotShellProgress): void {
    this.store.transaction(() => {
      this.assert(lease)
      this.writeOutput(lease.jobId, value)
    })
  }

  private writeOutput(jobId: string, value: BotShellProgress): void {
    this.store.db.run("UPDATE bot_shell_jobs SET output=?,truncated=?,updated_at=? WHERE id=?", [
      value.output.slice(0, 262144),
      value.truncated || value.output.length > 262144 ? 1 : 0,
      this.store.now(),
      jobId
    ])
  }

  finish(
    lease: BotShellServiceLease,
    result: BotShellResult,
    neverStarted: boolean | "failed" = false
  ): void {
    this.store.transaction(() => {
      const row = this.assert(lease)
      const effect = this.store.db.exec(
        "SELECT 1 FROM bot_effects WHERE id=? AND run_id=? AND fence=? AND status='started'",
        [row.effect_id, lease.runId, row.fence]
      )[0]?.values[0]
      if (!effect) throw new BotDomainError("stale_effect", "后台服务操作记录已失效")
      this.writeOutput(lease.jobId, result)
      const uncertain = !neverStarted && [null, 124, 130].includes(result.exitCode)
      const receipt = JSON.stringify({
        jobId: row.id,
        status: uncertain
          ? "needs_review"
          : neverStarted === "failed"
            ? "failed"
            : neverStarted
              ? "cancelled"
              : result.exitCode === 0
                ? "succeeded"
                : "failed",
        exitCode: result.exitCode
      })
      const status = uncertain ? "unknown" : neverStarted === "failed" ? "failed" : "succeeded"
      this.store.db.run(
        "UPDATE bot_effects SET status=?,result=?,updated_at=? WHERE id=? AND fence=?",
        [status, receipt, this.store.now(), row.effect_id, row.fence]
      )
      this.store.shellJobs.settled(row.effect_id, receipt)
      this.event("effect.settled", row.effect_id, { runId: row.run_id, status })
      this.notify(row.run_id, row.id, uncertain)
    })
  }

  /** Historical access is restricted to this Bot and exact conversation branch. */
  address(currentRunId: string, jobId: string) {
    const current = this.store.getRun(currentRunId)
    const row = this.store.db.exec(
      "SELECT j.run_id FROM bot_shell_jobs j JOIN bot_shell_services s ON s.job_id=j.id WHERE j.id=?",
      [jobId]
    )[0]?.values[0]
    if (!row) throw new BotDomainError("shell_job_scope", "后台服务不属于当前对话")
    const origin = this.store.getRun(String(row[0]))
    if (
      origin.botId !== current.botId ||
      origin.conversationId !== current.conversationId ||
      origin.threadRootId !== current.threadRootId ||
      current.source === "workflow-child"
    )
      throw new BotDomainError("shell_job_scope", "后台服务不属于当前 Bot 或对话分支")
    return {
      runId: origin.id,
      conversationId: origin.conversationId,
      ...(origin.threadRootId ? { threadRootId: origin.threadRootId } : {}),
      jobId
    }
  }

  list(currentRunId: string) {
    const current = this.store.getRun(currentRunId)
    if (current.source === "workflow-child") return []
    const ids =
      this.store.db.exec(
        `SELECT j.id FROM bot_shell_services s JOIN bot_shell_jobs j ON j.id=s.job_id JOIN bot_runs r ON r.id=j.run_id
       LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
       WHERE r.bot_id=? AND r.conversation_id=? AND COALESCE(t.root_id,'')=?
       ORDER BY j.created_at DESC,j.id DESC LIMIT 32`,
        [current.botId, current.conversationId, current.threadRootId ?? ""]
      )[0]?.values ?? []
    return ids.map(([id]) => {
      const address = this.address(currentRunId, String(id))
      const job = this.store.shellJobs.get(address.runId, String(id), 0)
      return {
        task_id: job.id,
        command: job.command.slice(0, 1000),
        commandTruncated: job.command.length > 1000,
        reviewed: job.status === "needs_review" && this.store.shellJobs.wasReviewed(job.effect_id),
        status: job.status,
        exitCode: job.exit_code
      }
    })
  }

  activeForBot(botId: string): boolean {
    return Boolean(
      this.store.db.exec(
        `SELECT 1 FROM bot_shell_services s JOIN bot_shell_jobs j ON j.id=s.job_id JOIN bot_runs r ON r.id=j.run_id WHERE r.bot_id=? AND j.status IN ${live} LIMIT 1`,
        [botId]
      )[0]?.values.length
    )
  }

  unresolved(botId: string): boolean {
    return Boolean(
      this.store.db.exec(
        `SELECT 1 FROM bot_shell_services s JOIN bot_shell_jobs j ON j.id=s.job_id JOIN bot_effects e ON e.id=j.effect_id JOIN bot_runs r ON r.id=j.run_id WHERE r.bot_id=? AND e.status='unknown' LIMIT 1`,
        [botId]
      )[0]?.values.length
    )
  }

  /** Exclusive Host startup / clock fencing only. No process is recreated. */
  interrupt(owner?: string): void {
    this.interruptWhere(owner ? " AND s.owner=?" : "", owner ? [owner] : [])
  }

  expire(): void {
    this.interruptWhere(" AND s.lease_until<=?", [this.store.now()])
  }

  private interruptWhere(where: string, params: (string | number)[]): void {
    const rows =
      this.store.db.exec(
        `SELECT j.id,j.run_id,j.effect_id FROM bot_shell_services s JOIN bot_shell_jobs j ON j.id=s.job_id WHERE j.status IN ${live}${where}`,
        params
      )[0]?.values ?? []
    for (const [id, runId, effectId] of rows) {
      this.store.db.run(
        "UPDATE bot_effects SET status='unknown',updated_at=? WHERE id=? AND status='started'",
        [this.store.now(), String(effectId)]
      )
      this.store.db.run(
        "UPDATE bot_shell_jobs SET status='needs_review',revision=revision+1,updated_at=? WHERE id=?",
        [this.store.now(), String(id)]
      )
      this.notify(String(runId), String(id), true)
    }
  }
}
