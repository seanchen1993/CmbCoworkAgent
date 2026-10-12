import { createHash } from "node:crypto"
import { BotDomainError, type BotArtifact, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"

export const evidenceHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")
export type EvidenceToolCallDiagnostic = {
  source: "raw" | "normalized" | "terminal"
  field: "calls" | "call" | "type" | "index" | "id" | "function" | "name" | "arguments"
  valueType: "missing" | "null" | "array" | "object" | "string" | "number" | "boolean" | "other"
  /** Closed classification only; never retain an arbitrary provider value. */
  typeClass?: "empty" | "normalized_tool_call" | "non_function"
}
export type EvidenceReviewDiagnostic = {
  stage: "dispatch" | "stream" | "projection" | "terminal" | "json" | "schema"
  reason:
    | "timeout"
    | "dispatch_failed"
    | "stream_failed"
    | "unexpected_tool_call"
    | "unexpected_content"
    | "missing_tool_call"
    | "invalid_tool_call"
    | "invalid_stream_order"
    | "refusal"
    | "missing_finish"
    | "truncated_finish"
    | "unsupported_finish"
    | "output_limit"
    | "reasoning_invalid"
    | "reasoning_incomplete"
    | "invalid_json"
    | "invalid_schema"
    | "unexpected_error"
  finish: "missing" | "stop" | "truncated" | "tool_call" | "filtered" | "other"
  /** Closed shape labels; no provider values, names, arguments or reasoning. */
  toolCall?: EvidenceToolCallDiagnostic
  /** Closed validation labels only, never arbitrary provider keys or values. */
  schemaIssues?: ("decision" | "finding_size" | "finding_format" | "object")[]
  schemaShape?: {
    findingType: "missing" | "null" | "array" | "object" | "string" | "empty_string" | "other"
  }
}
export type EvidenceVerdict = {
  decision: "pass" | "revise" | "uncertain" | "not_reviewed"
  coverage?: "text_limit" | "unsupported_type" | "unsupported_encoding"
  findings: string[]
  /** Host-generated closed labels only; never model text or exception details. */
  diagnostic?: EvidenceReviewDiagnostic
}
export type EvidenceBinding = {
  /** Bumps whenever the verifier's protocol changes. A prior failure must not
   * permanently block an identical candidate after a compatible repair. */
  reviewProtocol: string
  epoch: string
  task: string
  sources: { id: string; sha256: string }[]
  model: string
  name: string
  sha256: string
}
type Attempt = {
  index: number
  artifactId: string
  binding: EvidenceBinding
  verdict: EvidenceVerdict
}
type CompletionIssue = { reason: string; repairable: boolean }
const PREFIX = "delivery-evidence:"
const MAX_ATTEMPTS = 48
const reviewError = (reason: string) => new BotDomainError("delivery_evidence_review", reason)

/** Host-only receipts share the existing writer, backup, lease and transaction.
 * They contain identities and bounded visible findings, never source texts or reasoning. */
export class BotDeliveryEvidence {
  constructor(
    private readonly store: BotStore,
    private readonly announce: (lease: BotRunLease, text: string) => void
  ) {}
  private read<T>(runId: string, key: string): T | undefined {
    const value = this.store.db.exec("SELECT response FROM bot_receipts WHERE nonce=?", [
      `tool:${runId}:${PREFIX}${key}`
    ])[0]?.values[0]?.[0]
    return typeof value === "string" ? (JSON.parse(value) as T) : undefined
  }
  private list<T>(runId: string, kind: string, limit: number): T[] {
    const prefix = `tool:${runId}:${PREFIX}${kind}:`
    return (
      this.store.db.exec(
        "SELECT response FROM bot_receipts WHERE nonce>=? AND nonce<? ORDER BY nonce LIMIT ?",
        [prefix, `${prefix}\uffff`, limit]
      )[0]?.values ?? []
    ).map(([value]) => JSON.parse(String(value)) as T)
  }
  private attempts(runId: string): Attempt[] {
    return this.list<Attempt>(runId, "attempt", MAX_ATTEMPTS + 1).sort((a, b) => a.index - b.index)
  }
  task(runId: string) {
    const run = this.store.getRun(runId)
    if (run.source !== "user") return undefined
    const messages = [run.messageId, ...this.store.steering.acceptedMessageIds(runId)]
      .map((id) => this.store.message({ conversationId: run.conversationId, id }))
      .filter((message) => message.sender === "user" && !message.importedContext)
    if (!messages.length || messages[0].id !== run.messageId) return undefined
    const sourceIds = [...new Set(messages.flatMap((message) => message.attachments))].sort()
    return {
      messages: messages.map(({ id, text }) => ({ id, text })),
      sourceIds,
      key: evidenceHash(
        messages.map(({ id, text, attachments }) => ({
          id,
          text,
          attachments
        }))
      )
    }
  }
  assertBinding(lease: BotRunLease, binding: EvidenceBinding): void {
    this.store.assertDispatch(lease)
    this.store.steering.assertNoPending(lease.runId)
    if (this.store.dataEpoch() !== binding.epoch || this.task(lease.runId)?.key !== binding.task)
      throw reviewError("任务要求或数据已变化，请按当前原件重新生成并核验交付文件")
    for (const source of binding.sources)
      if (this.store.artifactForRun(lease.runId, source.id).sha256 !== source.sha256)
        throw reviewError("核验原件已变化，请重新生成并核验交付文件")
  }
  cached(lease: BotRunLease, binding: EvidenceBinding): EvidenceVerdict | undefined {
    this.assertBinding(lease, binding)
    return this.read(lease.runId, `verdict:${evidenceHash(binding)}`)
  }
  /** A started receipt without a verdict is uncertain, never a free retry. */
  begin(lease: BotRunLease, binding: EvidenceBinding): boolean {
    this.assertBinding(lease, binding)
    const key = `started:${evidenceHash(binding)}`
    if (this.read(lease.runId, key)) return false
    const started = this.list(lease.runId, "started", MAX_ATTEMPTS + 1).length
    const through = Math.max(
      0,
      ...this.list<{ startedThrough?: number }>(lease.runId, "resume", 101).map((item) =>
        typeof item.startedThrough === "number" &&
        Number.isSafeInteger(item.startedThrough) &&
        item.startedThrough >= 0 &&
        item.startedThrough <= started
          ? item.startedThrough
          : 0
      )
    )
    // A formal human recovery opens a new bounded review window; it does not
    // erase earlier usage, uncertain receipts, or the lifetime task ceiling.
    if (started >= MAX_ATTEMPTS || started - through >= 12) return false
    this.store.toolOnce(lease, PREFIX + key, binding, () => ({
      started: true
    }))
    return true
  }
  saveVerdict(lease: BotRunLease, binding: EvidenceBinding, verdict: EvidenceVerdict): void {
    this.assertBinding(lease, binding)
    this.store.toolOnce(lease, `${PREFIX}verdict:${evidenceHash(binding)}`, binding, () => verdict)
  }
  record(
    lease: BotRunLease,
    callId: string,
    artifactId: string,
    binding: EvidenceBinding,
    verdict: EvidenceVerdict
  ): EvidenceVerdict {
    this.assertBinding(lease, binding)
    return this.store.toolOnce(
      lease,
      `${PREFIX}attempt:${evidenceHash(callId)}`,
      { artifactId, binding },
      () => {
        const attempts = this.attempts(lease.runId)
        if (attempts.length >= MAX_ATTEMPTS)
          throw reviewError("本任务交付核验次数已达上限，请结束后创建新任务")
        return { index: attempts.length, artifactId, binding, verdict }
      }
    ).verdict
  }
  hasUnresolvedFailure(runId: string): boolean {
    const latest = new Map(this.attempts(runId).map((item) => [item.binding.name, item]))
    return [...latest.values()].some((item) =>
      ["revise", "uncertain"].includes(item.verdict.decision)
    )
  }
  hasReviewedArtifact(runId: string, artifactId: string): boolean {
    return this.attempts(runId).some((item) => item.artifactId === artifactId)
  }
  private publicationKey(attempt: Attempt): string {
    return `published:${evidenceHash(attempt.artifactId)}:${evidenceHash(attempt.binding)}`
  }
  /** Same publication transaction as the immutable artifact/attachment. */
  commit(lease: BotRunLease, artifact: Pick<BotArtifact, "id" | "name" | "sha256">): void {
    const attempt = this.attempts(lease.runId).findLast((item) => item.artifactId === artifact.id)
    if (!attempt) return
    this.assertBinding(lease, attempt.binding)
    if (
      !["pass", "not_reviewed"].includes(attempt.verdict.decision) ||
      evidenceHash(
        this.read<EvidenceVerdict>(lease.runId, `verdict:${evidenceHash(attempt.binding)}`)
      ) !== evidenceHash(attempt.verdict) ||
      attempt.binding.name !== artifact.name ||
      attempt.binding.sha256 !== artifact.sha256
    )
      throw reviewError("当前文件未通过原件核验，不能发布")
    // Called inside BotStore's publication transaction; no nested tool transaction.
    // One immutable original may be rechecked under new accepted instructions.
    // Preserve the earlier publication receipt; bind this receipt to its verdict.
    const key = this.publicationKey(attempt)
    const nonce = `tool:${lease.runId}:${PREFIX}${key}`
    const existed = this.read(lease.runId, key)
    const identity = {
      verdict: attempt.verdict,
      artifactId: artifact.id,
      sha256: artifact.sha256,
      binding: attempt.binding
    }
    this.store.db.run("INSERT INTO bot_receipts VALUES(?,?,?,?) ON CONFLICT(nonce) DO NOTHING", [
      nonce,
      evidenceHash(identity),
      JSON.stringify(identity),
      this.store.now()
    ])
    if (!existed && attempt.verdict.decision === "not_reviewed")
      this.announce(
        lease,
        `文件 ${artifact.name} 已交付，尚未自动核验内容：${attempt.verdict.findings.join("；")}`
      )
  }
  private issue(runId: string, complete: boolean, historical = false): CompletionIssue | undefined {
    const attempts = this.attempts(runId)
    if (!attempts.length) return undefined
    const through = Math.max(
      -1,
      ...this.list<{ through: number }>(runId, "resume", 101).map((item) => item.through)
    )
    const active = attempts.filter((item) => item.index > through)
    const lastPass = active.findLastIndex((item) =>
      ["pass", "not_reviewed"].includes(item.verdict.decision)
    )
    const failures = active.slice(lastPass + 1)
    if (
      (attempts.length >= MAX_ATTEMPTS && failures.length > 0) ||
      failures.some((item) => item.verdict.decision === "uncertain") ||
      failures.length >= 3
    )
      return {
        reason: "交付原件核验未能完成或连续失败，请核对后继续；已完成的外部操作不会重做。",
        repairable: false
      }
    if (!complete) return undefined
    const latest = new Map(attempts.map((item) => [item.binding.name, item]))
    // Validate every retained source before offering any model repair. A stale
    // first output must not hide a deleted source belonging to a later output.
    if (!historical) {
      for (const attempt of latest.values()) {
        if (attempt.binding.epoch !== this.store.dataEpoch())
          return { reason: "交付核验所属数据已变化，请核对后继续。", repairable: false }
        try {
          for (const source of attempt.binding.sources)
            if (this.store.artifactForRun(runId, source.id).sha256 !== source.sha256)
              return { reason: "核验原件已变化，请重新核验。", repairable: false }
        } catch {
          return { reason: "核验原件已不可读取，请核对后继续。", repairable: false }
        }
      }
    }
    const currentTask = historical ? undefined : this.task(runId)?.key
    for (const attempt of latest.values()) {
      type Publication = { artifactId: string; sha256: string; binding: EvidenceBinding }
      const published =
        this.read<Publication>(runId, this.publicationKey(attempt)) ??
        // Existing schema69 receipts stay readable without a rewrite/migration.
        this.read<Publication>(runId, `published:${evidenceHash(attempt.artifactId)}`)
      if (
        !["pass", "not_reviewed"].includes(attempt.verdict.decision) ||
        !published ||
        published.artifactId !== attempt.artifactId ||
        published.sha256 !== attempt.binding.sha256 ||
        evidenceHash(published.binding) !== evidenceHash(attempt.binding)
      )
        return {
          reason: `文件 ${attempt.binding.name} 尚未通过原件核验并完成交付，请修正后重新交付。`,
          repairable: true
        }
      if (!historical && attempt.binding.task !== currentTask)
        return {
          reason: `文件 ${attempt.binding.name} 的核验早于当前要求，请重新交付以核验新要求。`,
          repairable: true
        }
    }
    return undefined
  }
  assertCanContinue(lease: BotRunLease): void {
    this.store.assertDispatch(lease)
    const issue = this.issue(lease.runId, false)
    if (issue) throw reviewError(issue.reason)
  }
  assertComplete(lease: BotRunLease, historical = false): void {
    this.store.assertDispatch(lease)
    const issue = this.issue(lease.runId, true, historical)
    if (issue) throw reviewError(issue.reason)
  }
  /** Only an incomplete publication/current-task binding permits model repair.
   * Uncertain reviews, exhausted attempts and changed sources require a person. */
  repairableCompletionIssue(lease: BotRunLease): string | undefined {
    this.store.assertDispatch(lease)
    this.store.steering.assertNoPending(lease.runId)
    const issue = this.issue(lease.runId, true)
    if (issue && !issue.repairable) throw reviewError(issue.reason)
    return issue?.reason
  }
  completionIssue(runId: string, succeeded: boolean): string | undefined {
    const historical = Boolean(
      this.store.db.exec("SELECT 1 FROM bot_receipts WHERE nonce=?", [
        `tool:${runId}:lifecycle:session-end`
      ])[0]?.values.length
    )
    return this.issue(runId, succeeded, historical)?.reason
  }
  /** Reuses the original human steering inbox; attempts and model reserves survive. */
  resume(runId: string, note: string, append: (text: string) => string): void {
    const issue = this.issue(runId, true)
    if (!issue) return
    const attempts = this.attempts(runId)
    if (
      attempts.length >= MAX_ATTEMPTS ||
      this.list(runId, "started", MAX_ATTEMPTS + 1).length >= MAX_ATTEMPTS
    )
      throw reviewError("本任务交付核验次数已达上限，请结束后创建新任务")
    const queued = Number(
      this.store.db.exec("SELECT count(*) FROM bot_steering WHERE run_id=?", [runId])[0]
        ?.values[0]?.[0] ?? 0
    )
    if (queued >= 100) throw reviewError("本任务补充消息已达上限，请结束后创建新任务")
    const value = {
      through: attempts.length - 1,
      startedThrough: this.list(runId, "started", MAX_ATTEMPTS + 1).length
    }
    this.store.db.run("INSERT INTO bot_receipts VALUES(?,?,?,?)", [
      `tool:${runId}:${PREFIX}resume:${this.store.getRun(runId).revision}`,
      evidenceHash(value),
      JSON.stringify(value),
      this.store.now()
    ])
    const id = append(note)
    this.store.db.run("INSERT INTO bot_steering VALUES(?,?,NULL,NULL)", [id, runId])
  }
}
