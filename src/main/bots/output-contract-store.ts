import { createHash } from "node:crypto"
import { BotDomainError, type BotArtifact, type BotRunLease } from "../../shared/bot-types"
import type { BotOutputContract, BotOutputFileContract } from "../../shared/bot-output-contract"
import type { BotStore } from "./store"
import { BOT_WORKFLOW_CHILD_SOURCE } from "./workflow-children"
import {
  BOT_OUTPUT_FILE_BYTES,
  inferBotOutputContract,
  parseBotOutputContract,
  validateBotOutputBytes
} from "./output-contract"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
type Current = { revision: number; contract: BotOutputContract; stop?: string }
export type BotOutputCheck = { status: "validated" | "not_generated"; errors?: string[] }

/** Uses the existing writer and task lease. Only human message declarations can
 * create a contract; no prompt/model output or attachment can supply its schema. */
export class BotOutputContracts {
  private parsedEpoch: string | undefined
  // At most 16 already-validated declarations, each capped at 32K characters.
  // No file data, message history, timers or independent lifecycle is retained.
  private readonly parsed = new Map<string, { serialized: string; contract: BotOutputContract }>()
  constructor(private readonly store: BotStore) {}
  private isDelegated(runId: string): boolean {
    return (
      this.store.getRun(runId).source === BOT_WORKFLOW_CHILD_SOURCE &&
      Boolean(this.store.workflowChildren.metadata(runId))
    )
  }
  private rows(sql: string, parameters: (string | number | null)[] = []) {
    const statement = this.store.db.prepare(sql, parameters),
      rows: Record<string, unknown>[] = []
    try {
      while (statement.step()) rows.push(statement.getAsObject())
    } finally {
      statement.free()
    }
    return rows
  }
  saveMessage(
    messageId: string,
    text: string,
    explicit: unknown,
    quotes: readonly { from: number; to: number }[]
  ): void {
    let source = text
    for (const quote of [...quotes].sort((a, b) => b.from - a.from))
      source = source.slice(0, quote.from) + "\n" + source.slice(quote.to)
    const contract =
      explicit === undefined ? inferBotOutputContract(source) : parseBotOutputContract(explicit)
    if (contract)
      this.store.db.run("INSERT INTO bot_output_messages VALUES(?,?,?)", [
        messageId,
        hash(text),
        JSON.stringify(contract)
      ])
  }
  /** Called within the owning transaction. Accepted human steering replaces the
   * complete format declaration. Ordinary follow-up text cannot weaken it. */
  private current(runId: string): Current | undefined {
    const run = this.store.getRun(runId)
    const ids = [run.messageId, ...this.store.steering.acceptedMessageIds(runId)]
    const latest = this.rows(
      `SELECT o.message_id,o.source_hash,o.contract FROM bot_output_messages o JOIN bot_messages m ON m.id=o.message_id WHERE m.sender='user' AND m.conversation_id=? AND o.message_id IN (${ids.map(() => "?").join(",")}) ORDER BY m.sequence DESC LIMIT 1`,
      [run.conversationId, ...ids]
    )[0]
    if (!latest) return undefined
    const sourceKey = hash(JSON.stringify([latest.message_id, latest.source_hash]))
    const previous = this.rows("SELECT * FROM bot_output_contracts WHERE run_id=?", [runId])[0]
    const serialized = String(latest.contract),
      epoch = this.store.backupSchedule.epoch()
    if (epoch !== this.parsedEpoch) {
      this.parsed.clear()
      this.parsedEpoch = epoch
    }
    const cached = this.parsed.get(sourceKey)
    const contract =
      cached?.serialized === serialized
        ? cached.contract
        : parseBotOutputContract(JSON.parse(serialized))
    if (cached?.serialized !== serialized) {
      if (this.parsed.size >= 16) this.parsed.delete(this.parsed.keys().next().value!)
      this.parsed.set(sourceKey, { serialized, contract })
    }
    if (!previous || previous.source_key !== sourceKey) {
      const revision = Number(previous?.revision ?? 0) + 1
      this.store.db.run(
        "INSERT INTO bot_output_contracts(run_id,revision,source_key,contract,stop_reason) VALUES(?,?,?,?,NULL) ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,source_key=excluded.source_key,contract=excluded.contract,stop_reason=NULL",
        [runId, revision, sourceKey, JSON.stringify(contract)]
      )
      return { revision, contract }
    }
    return {
      revision: Number(previous.revision),
      contract,
      ...(previous.stop_reason ? { stop: String(previous.stop_reason) } : {})
    }
  }
  requirement(lease: BotRunLease, name: string): BotOutputFileContract | undefined {
    return this.store.transaction(() => {
      this.store.assertDispatch(lease)
      return this.current(lease.runId)?.contract.files.find((file) => file.name === name)
    })
  }
  /** Returns model-visible feedback instead of throwing. LangGraph must save the
   * ToolMessage before beforeModel stops a repeatedly invalid delivery. */
  authorize(
    lease: BotRunLease,
    callId: string,
    name: string,
    bytes: Uint8Array | Pick<BotArtifact, "sha256" | "size">,
    artifactId: string
  ): BotOutputCheck {
    return this.store.transaction(() => {
      this.store.assertDispatch(lease)
      this.store.steering.assertNoPending(lease.runId)
      const current = this.current(lease.runId),
        requirement = current?.contract.files.find((file) => file.name === name)
      if (!current || !requirement) return { status: "validated" }
      const originalTooLarge = !(bytes instanceof Uint8Array)
      if (originalTooLarge && bytes.size <= BOT_OUTPUT_FILE_BYTES)
        throw new Error("原件在校验范围内时必须读取真实字节")
      const sha = originalTooLarge ? bytes.sha256 : hash(bytes)
      const previous = this.rows("SELECT * FROM bot_output_attempts WHERE run_id=? AND call_id=?", [
        lease.runId,
        callId
      ])[0]
      if (previous) {
        if (
          Number(previous.revision) !== current.revision ||
          previous.name !== name ||
          previous.sha256 !== sha ||
          previous.artifact_id !== artifactId
        )
          throw new BotDomainError("nonce_conflict", "交付调用已用于不同的格式要求或文件内容")
        return previous.errors
          ? { status: "not_generated", errors: JSON.parse(String(previous.errors)) as string[] }
          : { status: "validated" }
      }
      const attempts = this.rows(
        "SELECT errors,name FROM bot_output_attempts WHERE run_id=? AND revision=?",
        [lease.runId, current.revision]
      )
      if (attempts.length >= 64) {
        this.stop(lease.runId, "本轮交付校验已达上限，请核对格式要求后继续")
        return { status: "not_generated", errors: ["本轮交付校验已达上限"] }
      }
      const errors =
        bytes instanceof Uint8Array
          ? validateBotOutputBytes(requirement, bytes)
          : [`文件超过交付格式校验上限（${BOT_OUTPUT_FILE_BYTES} 字节）`]
      this.store.db.run("INSERT INTO bot_output_attempts VALUES(?,?,?,?,?,?,?)", [
        lease.runId,
        current.revision,
        callId,
        name,
        sha,
        artifactId,
        errors.length ? JSON.stringify(errors) : null
      ])
      if (
        errors.length &&
        (attempts.filter((item) => item.errors).length >= 4 ||
          attempts.filter((item) => item.errors === JSON.stringify(errors) && item.name === name)
            .length >= 2)
      )
        this.stop(
          lease.runId,
          `文件 ${name} 多次未满足交付格式，请核对后继续：${errors.join("；")}`
        )
      return errors.length ? { status: "not_generated", errors } : { status: "validated" }
    })
  }
  /** Executed by the original artifact/attachment transaction after actual bytes
   * were written. A stale permit cannot satisfy revised requirements. */
  commit(lease: BotRunLease, artifact: Pick<BotArtifact, "id" | "name" | "sha256">): void {
    this.store.assertDispatch(lease)
    const attempt = this.rows(
      "SELECT revision,name,sha256,errors FROM bot_output_attempts WHERE run_id=? AND artifact_id=? ORDER BY revision DESC LIMIT 1",
      [lease.runId, artifact.id]
    )[0]
    if (!attempt) return // Browser downloads are visible, but not claimed validated.
    const current = this.current(lease.runId)
    if (
      !current ||
      current.revision !== Number(attempt.revision) ||
      attempt.name !== artifact.name ||
      attempt.sha256 !== artifact.sha256 ||
      attempt.errors
    )
      throw new BotDomainError(
        "output_contract_changed",
        "交付格式或文件已变化，请按当前要求重新校验"
      )
    this.store.db.run(
      "INSERT INTO bot_output_deliveries VALUES(?,?,?,?,?) ON CONFLICT(run_id,revision,name) DO UPDATE SET artifact_id=excluded.artifact_id,sha256=excluded.sha256",
      [lease.runId, current.revision, artifact.name, artifact.id, artifact.sha256]
    )
    if (!this.missing(lease.runId, current).length)
      this.store.db.run("UPDATE bot_output_contracts SET stop_reason=NULL WHERE run_id=?", [
        lease.runId
      ])
  }
  private missing(runId: string, current: Current): string[] {
    const delivered = this.rows(
      "SELECT d.name FROM bot_output_deliveries d JOIN bot_artifacts a ON a.id=d.artifact_id LEFT JOIN bot_artifact_lifecycle l ON l.artifact_id=a.id WHERE d.run_id=? AND d.revision=? AND a.sha256=d.sha256 AND l.deleted_at IS NULL",
      [runId, current.revision]
    )
    return current.contract.files
      .filter((file) => !delivered.some((item) => item.name === file.name))
      .map((file) => file.name)
  }
  private stop(runId: string, reason: string): void {
    this.store.db.run("UPDATE bot_output_contracts SET stop_reason=? WHERE run_id=?", [
      reason,
      runId
    ])
  }
  instructions(lease: BotRunLease): string | undefined {
    return this.store.transaction(() => {
      this.store.assertDispatch(lease)
      const current = this.current(lease.runId)
      if (current?.stop) throw new BotDomainError("output_contract_review", current.stop)
      if (!current) return undefined
      const obligation = this.isDelegated(lease.runId)
        ? "These are the parent's final file formats, not additional work assigned to this child. Complete only your delegated scope and return its required result. If that scope includes producing one of these files, use deliver_file and preserve its exact name and columns. A read-only or analysis child need not produce the parent's final files."
        : "Deliver each required file through deliver_file. Preserve exact names and columns."
      return `Human-required output format (revision ${current.revision}): ${JSON.stringify(current.contract)}. ${obligation} Validation checks structure only; verify values against source evidence separately.`
    })
  }
  assertCanContinue(lease: BotRunLease): void {
    const reason = this.store.transaction(() => {
      this.store.assertDispatch(lease)
      return this.current(lease.runId)?.stop
    })
    if (reason) throw new BotDomainError("output_contract_review", reason)
  }
  assertComplete(lease: BotRunLease): void {
    const reason = this.store.transaction(() => {
      this.store.assertDispatch(lease)
      return this.completionIssue(lease.runId, true)
    })
    if (reason) throw new BotDomainError("output_contract_review", reason)
  }
  /** Only delivery quality failures change failed -> needs_review. A model/network
   * failure without this marker keeps its existing classification. */
  completionIssue(runId: string, succeeded: boolean): string | undefined {
    const current = this.current(runId)
    if (!current) return undefined
    if (current.stop) return current.stop
    if (!succeeded) return undefined
    // Internal agents share the human message for authorization, but their
    // assigned result can be read-only evidence. Own invalid publications still
    // pause above; the parent remains responsible for all final deliverables.
    if (this.isDelegated(runId)) return undefined
    const missing = this.missing(runId, current)
    if (!missing.length) return undefined
    const reason = `尚未交付符合当前格式的文件：${missing.join("、")}`
    this.stop(runId, reason)
    return reason
  }
  /** Human recovery preserves attempts, graph state and usage. It queues a real
   * human instruction in the existing inbox instead of replaying the failed call. */
  resume(runId: string, note: string, append: (text: string) => string): void {
    const current = this.current(runId)
    if (!current?.stop) return
    const queued = this.rows("SELECT count(*) AS count FROM bot_steering WHERE run_id=?", [
      runId
    ])[0]
    if (Number(queued.count) >= 100)
      throw new BotDomainError(
        "output_contract_review",
        "本任务补充消息已达上限，请结束后创建新任务"
      )
    this.store.db.run("UPDATE bot_output_contracts SET stop_reason=NULL WHERE run_id=?", [runId])
    const instruction = this.isDelegated(runId)
      ? "继续原子任务的分工并返回其要求的结果；父任务负责最终文件交付。若原分工包括生成文件，请修正其格式并重新交付。已经完成的外部操作不需要重复执行。"
      : "请修正文件并重新交付，已经完成的外部操作不需要重复执行。"
    const id = append(`核对交付格式后继续：${note}\n待处理问题：${current.stop}\n${instruction}`)
    this.store.db.run("INSERT INTO bot_steering VALUES(?,?,NULL,NULL)", [id, runId])
  }
}
