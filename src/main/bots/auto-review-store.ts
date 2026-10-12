import { createHash } from "node:crypto"
import { z } from "zod"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import {
  botAutoReviewChange,
  botAutoReviewPolicy,
  type BotAutoReviewSettings,
  type BotAutoReviewResult
} from "../../shared/bot-auto-review"
import {
  normalizeSandAutoReviewInstructions,
  type SandAutoReviewInstructions
} from "../../shared/bot-auto-review-instructions"
import { canonicalJson, identifier } from "./validation"
import { readBotSecretCard } from "../../shared/bot-secrets"
import type { BotStore } from "./store"

import type { BotReviewTask as ReviewTask } from "./review-task"

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const recordSchema = z
  .object({
    decision: z.enum(["allow", "ask"]),
    reason: z.string().min(1).max(2000),
    model: z.string().min(1).max(512).nullable(),
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    taskHash: z.string().regex(/^[a-f0-9]{64}$/),
    settingsRevision: z.number().int().nonnegative(),
    rulesRevision: z.number().int().nonnegative(),
    botRevision: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    dataEpoch: z.string().min(1).max(160)
  })
  .strict()
export type BotAutoReviewRecord = z.infer<typeof recordSchema>

/** Settings and decisions share the task/effect transaction boundary. No model
 * or plugin tool exposes this owner; only the authenticated human UI edits it. */
export class BotAutoReviewStore {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}
  read(botId: string): BotAutoReviewSettings {
    this.store.getBot(identifier(botId))
    const row = this.store.db.exec(
      "SELECT revision,policy FROM bot_auto_review_settings WHERE bot_id=?",
      [botId]
    )[0]?.values[0]
    return {
      botId,
      revision: row ? Number(row[0]) : 0,
      dataEpoch: this.store.backupSchedule.epoch(),
      ...(row
        ? botAutoReviewPolicy.parse(JSON.parse(String(row[1])))
        : { isEnabled: false, allowInstructions: [], blockInstructions: [] })
    }
  }
  change(raw: unknown): BotAutoReviewSettings {
    const parsed = botAutoReviewChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "自动审核设置格式不正确")
    const input = parsed.data
    return this.store.transaction(() => {
      const current = this.read(input.botId)
      if (current.dataEpoch !== input.dataEpoch)
        throw new BotDomainError("data_epoch", "数据已恢复，请重新读取自动审核设置")
      return this.receipt(input.nonce, { op: "auto-review.settings", ...input }, () => {
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "自动审核设置已变化，请刷新后重试")
        const policy = normalizeSandAutoReviewInstructions(input)
        return this.write(input.botId, current.revision + 1, policy)
      })
    })
  }
  /** Store owner only, inside its create transaction and protected create receipt. */
  initializeCreatedBot(botId: string, isEnabled: boolean): void {
    if (this.read(botId).revision !== 0)
      throw new BotDomainError("revision_conflict", "新 Bot 已存在操作审核设置")
    this.write(botId, 1, { isEnabled, allowInstructions: [], blockInstructions: [] })
  }
  private write(
    botId: string,
    revision: number,
    policy: SandAutoReviewInstructions
  ): BotAutoReviewSettings {
    this.store.db.run(
      "INSERT INTO bot_auto_review_settings VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy",
      [botId, revision, JSON.stringify(policy)]
    )
    this.event("auto_review.settings_changed", botId, { revision, enabled: policy.isEnabled })
    return this.read(botId)
  }
  private authorityRoot(runId: string): string | null {
    const run = this.store.getRun(runId)
    if (
      ["user", "plugin-command"].includes(run.source) ||
      this.trialTask(run.id) ||
      this.store.routineAuthority.task(run.id) ||
      this.store.peerAuthority.task(run.id) ||
      this.store.groups.reviewTask(run.id)
    )
      return run.id
    if (run.source !== "workflow-child") return null
    const child = this.store.workflowChildren.metadata(runId)
    if (!child) return null
    const parent = this.store.getRun(child.parentLease.runId)
    if (
      (!["user", "plugin-command"].includes(parent.source) &&
        !this.trialTask(parent.id) &&
        !this.store.routineAuthority.task(parent.id) &&
        !this.store.peerAuthority.task(parent.id) &&
        !this.store.groups.reviewTask(parent.id)) ||
      parent.botId !== run.botId ||
      parent.conversationId !== run.conversationId ||
      parent.rootRunId !== run.rootRunId
    )
      return null
    try {
      this.store.workflowChildren.assertParent(runId)
    } catch {
      return null
    }
    return parent.id
  }

  /** trialSkill is a human-only RPC. Its durable row binds the selected version
   * and the two human fields; the formatted execution message also contains
   * model-authored skill steps and must never be promoted into authorization. */
  private trialTask(runId: string): ReviewTask | null {
    const run = this.store.getRun(runId)
    if (run.source !== "skill-trial") return null
    const trial = this.store.trialForRun(runId)
    if (!trial || trial.botId !== run.botId) return null
    const first = this.store.message({ conversationId: run.conversationId, id: run.messageId })
    if (first.sender !== "user" || first.importedContext) return null
    return {
      source: run.source,
      messages: [
        {
          id: first.id,
          text: `试跑选中的技能版本 ${trial.version}。\n任务输入：\n${trial.inputs}\n验收条件：\n${trial.criteria}`
        }
      ],
      rejectedActions: [],
      skillTrial: { id: trial.id, skillId: trial.skillId, version: trial.version }
    }
  }

  private additions(
    runId: string,
    sender: "user" | "bot",
    secondRunId = runId
  ): { id: string; text: string }[] {
    return (
      this.store.db.exec(
        `SELECT m.id,m.text FROM bot_steering s JOIN bot_messages m ON m.id=s.message_id
         WHERE s.run_id IN (?,?) AND s.accepted_at IS NOT NULL AND m.sender=? ORDER BY m.sequence`,
        [runId, secondRunId, sender]
      )[0]?.values ?? []
    ).map(([id, text]) => ({ id: String(id), text: String(text) }))
  }

  /** Reuse the executor's bounded discussion window, but retain only original
   * human assignments/accepted additions with durable provenance. A transcript
   * labelled user can also be a machine-generated form or dependency request. */
  private priorContext(runId: string): ReviewTask["priorContext"] {
    const run = this.store.getRun(runId)
    const first = this.store.message({ conversationId: run.conversationId, id: run.messageId })
    const candidates = this.store
      .messagesForRun(runId)
      .filter(
        (message) =>
          message.sequence < first.sequence && message.sender === "user" && !message.importedContext
      )
    if (!candidates.length) return undefined
    const ids = candidates.map((message) => message.id)
    const placeholders = ids.map(() => "?").join(",")
    const sources =
      this.store.db.exec(
        `SELECT r.message_id,r.root_run_id FROM bot_runs r
       WHERE r.bot_id=? AND r.conversation_id=? AND r.source IN ('user','plugin-command')
       AND r.message_id IN (${placeholders})
       UNION
       SELECT s.message_id,r.root_run_id FROM bot_steering s JOIN bot_runs r ON r.id=s.run_id
       WHERE r.bot_id=? AND r.conversation_id=? AND r.source IN ('user','plugin-command')
       AND s.accepted_at IS NOT NULL AND s.message_id IN (${placeholders})`,
        [run.botId, run.conversationId, ...ids, run.botId, run.conversationId, ...ids]
      )[0]?.values ?? []
    const acceptedIds = new Set(sources.map(([id]) => String(id)))
    const messageEvents = new Map(
      (
        this.store.db.exec(
          `SELECT entity_id,MIN(cursor) FROM bot_events WHERE kind='message.created'
         AND entity_id IN (${placeholders}) GROUP BY entity_id`,
          ids
        )[0]?.values ?? []
      ).map(([id, cursor]) => [String(id), Number(cursor)])
    )
    const messages = candidates
      .filter((message) => acceptedIds.has(message.id))
      .map(({ id, text }) => ({
        id,
        text,
        eventCursor: messageEvents.get(id) ?? null
      }))
    if (!messages.length) return undefined
    const roots = [...new Set(sources.map(([, root]) => String(root)))]
    const rejected =
      this.store.db.exec(
        `SELECT i.id,i.run_id,i.prompt,
       (SELECT MAX(e.cursor) FROM bot_events e WHERE e.entity_id=i.id AND e.kind='interaction.answered') AS answer_cursor
       FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id
       WHERE r.root_run_id IN (${roots.map(() => "?").join(",")})
       AND i.kind='approval' AND i.status='answered' AND i.answer='reject'
       ORDER BY answer_cursor DESC,i.created_at DESC,i.id DESC LIMIT 201`,
        roots
      )[0]?.values ?? []
    return {
      messages,
      rejectedActions: rejected
        .slice(0, 200)
        .reverse()
        .map(([id, runId, prompt, cursor]) => ({
          id: String(id),
          runId: String(runId),
          eventCursor: cursor === null ? null : Number(cursor),
          prompt: readBotSecretCard(String(prompt)) ? "凭据输入已被用户拒绝" : String(prompt)
        })),
      refusalsTruncated: rejected.length > 200
    }
  }

  /** Only current human instructions confer authority. A delegated assignment
   * and agent notes are separately labelled data for the parent's reviewer;
   * they must never be injected into the child executor's model context. */
  task(runId: string): ReviewTask | null {
    const rootId = this.authorityRoot(runId)
    if (!rootId) return null
    const run = this.store.getRun(rootId)
    if (rootId !== runId && this.store.steering.hasPending(rootId)) return null
    const first = this.store.message({ conversationId: run.conversationId, id: run.messageId })
    const standing =
      this.store.peerAuthority.task(rootId) ??
      this.store.routineAuthority.task(rootId) ??
      this.trialTask(rootId) ??
      this.store.groups.reviewTask(rootId)
    if (!standing && (first.sender !== "user" || first.importedContext)) return null
    // Delegations keep their captured source context, never the recipient's history.
    const priorContext = standing ? standing.priorContext : this.priorContext(rootId)
    const messages = [
      ...(standing?.messages ?? [{ id: first.id, text: first.text }]),
      ...this.additions(rootId, "user", runId)
    ]
    const rejectedActions = [
      ...new Map(
        [
          ...(standing?.rejectedActions ?? []),
          ...(
            this.store.db.exec(
              `SELECT i.prompt FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id
         WHERE r.root_run_id=? AND i.kind='approval' AND i.status='answered' AND i.answer='reject'
         ORDER BY i.created_at,i.id`,
              [run.rootRunId]
            )[0]?.values ?? []
          ).map(([prompt]) => ({
            prompt: readBotSecretCard(String(prompt)) ? "凭据输入已被用户拒绝" : String(prompt)
          }))
        ].map((item) => [item.prompt, item])
      ).values()
    ]
    if (rootId === runId)
      return {
        ...standing,
        ...(priorContext ? { priorContext } : {}),
        source: run.source,
        messages,
        rejectedActions
      }
    const child = this.store.workflowChildren.metadata(runId)!
    return {
      ...(standing?.skillTrial ? { skillTrial: standing.skillTrial } : {}),
      ...(standing?.routine ? { routine: standing.routine } : {}),
      ...(standing?.peer ? { peer: standing.peer } : {}),
      source: "workflow-child",
      ...(priorContext ? { priorContext } : {}),
      messages,
      rejectedActions,
      delegation: {
        parentRunId: rootId,
        assignment: child.input.prompt,
        role: child.input.agentType ?? null,
        roleInstructions: child.input.roleSystemPrompt ?? null,
        model: child.input.model ?? null,
        shellAccess: child.input.shellAccess ?? "full",
        disallowedTools: child.input.disallowedTools ?? [],
        isolation: child.input.isolation ?? null,
        agentNotes: this.additions(runId, "bot")
      }
    }
  }
  wasRejected(runId: string, action: unknown): boolean {
    const rootId = this.authorityRoot(runId) ?? runId
    // A model-created schedule retains the creator task's actual refusals.
    // Matching an exact refused action must stay manual, even in a later occurrence.
    if (
      (
        this.store.peerAuthority.task(rootId) ??
        this.store.routineAuthority.task(rootId) ??
        this.store.groups.reviewTask(rootId)
      )?.rejectedActions.some(({ prompt }) => {
        try {
          return digest(JSON.parse(prompt)) === digest(action)
        } catch {
          return false
        }
      })
    )
      return true
    return Boolean(
      this.store.db.exec(
        `SELECT 1 FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id
         WHERE r.root_run_id=? AND i.kind='approval' AND i.action_hash=? AND i.status='answered' AND i.answer='reject' LIMIT 1`,
        [this.store.getRun(runId).rootRunId, digest(action)]
      )[0]?.values.length
    )
  }
  stamp(
    lease: BotRunLease,
    action: unknown,
    settings: BotAutoReviewSettings,
    result: BotAutoReviewResult
  ): BotAutoReviewRecord {
    const run = this.store.assertDispatch(lease)
    this.store.steering.assertNoPending(run.id)
    const current = this.read(run.botId)
    if (
      current.revision !== settings.revision ||
      current.dataEpoch !== settings.dataEpoch ||
      !current.isEnabled
    )
      throw new BotDomainError("approval_required", "自动审核设置已变化，请重新发起操作")
    return recordSchema.parse({
      ...result,
      actionHash: digest(action),
      taskHash: digest(this.task(run.id)),
      settingsRevision: current.revision,
      rulesRevision: this.store.approvalRules.read(run.botId).revision,
      botRevision: this.store.getBot(run.botId).revision,
      expiresAt: this.store.now() + 600_000,
      dataEpoch: current.dataEpoch
    })
  }
  prepare(
    lease: BotRunLease,
    interactionId: string,
    action: unknown,
    raw: BotAutoReviewRecord
  ): boolean {
    const record = recordSchema.parse(raw)
    if (record.actionHash !== digest(action))
      throw new BotDomainError("approval_required", "自动审核参数不一致")
    this.assertRecord(lease.runId, record)
    this.store.db.run("INSERT INTO bot_auto_review_decisions VALUES(?,?)", [
      interactionId,
      JSON.stringify(record)
    ])
    return record.decision === "allow"
  }
  private record(id: string): BotAutoReviewRecord | undefined {
    const row = this.store.db.exec(
      "SELECT record FROM bot_auto_review_decisions WHERE interaction_id=?",
      [id]
    )[0]?.values[0]
    return row ? recordSchema.parse(JSON.parse(String(row[0]))) : undefined
  }
  view(id: string): BotAutoReviewResult | undefined {
    const record = this.record(id)
    return record
      ? { decision: record.decision, reason: record.reason, model: record.model }
      : undefined
  }
  private assertRecord(runId: string, record: BotAutoReviewRecord): void {
    const run = this.store.getRun(runId),
      current = this.read(run.botId)
    if (
      !current.isEnabled ||
      current.revision !== record.settingsRevision ||
      current.dataEpoch !== record.dataEpoch ||
      record.botRevision !== this.store.getBot(run.botId).revision ||
      record.rulesRevision !== this.store.approvalRules.read(run.botId).revision ||
      record.expiresAt <= this.store.now() ||
      record.taskHash !== digest(this.task(runId))
    )
      throw new BotDomainError("approval_required", "自动审核依据已变化，原自动批准失效")
  }
  assertCurrent(id: string, runId: string): void {
    const record = this.record(id)
    // A later explicit human answer is checked by the ordinary approval contract.
    if (record?.decision === "allow") this.assertRecord(runId, record)
  }
}
