import { botModelUsage } from "./model-usage"
import { createHash, randomUUID } from "node:crypto"
import {
  botErrorDiagnosticSchema,
  type BotErrorDiagnostic
} from "../../shared/bot-error-diagnostic"
import { safeBotErrorDiagnostic } from "./error-diagnostic"
import { z } from "zod"
import type { BotStore } from "./store"
import { BotDomainError, type BotMemory } from "../../shared/bot-types"
import { restrictsAutomaticMemory } from "./memory-retention"
import {
  botMemoryPolicyInput,
  botMemoryRetryInput,
  type BotMemoryPolicy,
  type BotMemoryEvidence
} from "../../shared/bot-memory"
import {
  boundedEvidenceText,
  memoryDedupeKey,
  normalizeMemoryContent,
  usesKnownEvidence,
  type MemoryChange,
  type MemoryEvidence,
  type SynthesisOutcome,
  MEMORY_SYNTHESIS_DEBOUNCE_MS,
  MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS
} from "./upstream/grok-memory-synthesis"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const contentHash = (text: string) => digest(memoryDedupeKey(text))
const evidenceSchema = z.array(
  z.object({
    runId: z.string(),
    conversationId: z.string(),
    messageId: z.string(),
    assistantMessageId: z.string(),
    occurredAt: z.number()
  })
)
const stateSchema = z.object({
  enabled: z.number(),
  revision: z.number(),
  epoch: z.number(),
  barrier_sequence: z.number(),
  temporal_at: z.number(),
  last_outcome: z.string().nullable(),
  last_attempt_at: z.number().nullable()
})
export interface BotMemorySynthesisSnapshot {
  botId: string
  fingerprint: string
  memories: {
    id: string
    content: string
    origin: "explicit" | "synthesized"
    kind: "profile" | "log"
  }[]
  evidence: MemoryEvidence[]
  sources: BotMemoryEvidence[]
  temporal: boolean
}

/** The queue contains message references, never a second copy of private conversations.
 * All writes, including task settlement, share the owning BotStore transaction.
 */
export class BotMemoryStore {
  constructor(
    private readonly store: BotStore,
    private readonly event: (kind: string, id: string, payload: unknown) => void,
    private readonly receipt: <T>(nonce: string, input: unknown, operation: () => T) => T
  ) {}
  private rows(sql: string, args: (string | number | null)[] = []) {
    const stmt = this.store.db.prepare(sql, args),
      result: Record<string, unknown>[] = []
    try {
      while (stmt.step()) result.push(stmt.getAsObject())
    } finally {
      stmt.free()
    }
    return result
  }
  private state(botId: string) {
    this.store.getBot(botId)
    return stateSchema.parse(
      this.rows("SELECT * FROM bot_memory_state WHERE bot_id=?", [botId])[0] ?? {
        enabled: 1,
        revision: 0,
        epoch: 0,
        barrier_sequence: 0,
        temporal_at: 0,
        last_outcome: null,
        last_attempt_at: null
      }
    )
  }
  private ensure(botId: string) {
    this.store.db.run("INSERT OR IGNORE INTO bot_memory_state(bot_id) VALUES(?)", [botId])
  }
  policy(botId: string): BotMemoryPolicy {
    const state = this.state(botId)
    return {
      enabled: !!state.enabled,
      revision: state.revision,
      pending: Number(
        this.rows(
          "SELECT COUNT(*) AS n FROM bot_memory_evidence WHERE bot_id=? AND state='pending'",
          [botId]
        )[0].n
      ),
      failed: Number(
        this.rows(
          "SELECT COUNT(*) AS n FROM bot_memory_evidence WHERE bot_id=? AND state='failed'",
          [botId]
        )[0].n
      ),
      dataEpoch: this.store.backupSchedule.epoch(),
      usage: botModelUsage(this.store, { memoryBotId: botId }),
      lastOutcome: state.last_outcome,
      lastAttemptAt: state.last_attempt_at
    }
  }
  setPolicy(raw: unknown): BotMemoryPolicy {
    const input = botMemoryPolicyInput.parse(raw)
    return this.store.transaction(() => {
      this.store.assertMutationEpoch(input.expectedDataEpoch)
      const current = this.state(input.botId)
      if (current.revision !== input.revision)
        throw new BotDomainError("revision_conflict", "记忆设置已变化，请刷新后重试")
      this.manualBarrier(input.botId)
      this.store.db.run(
        "UPDATE bot_memory_state SET enabled=?,revision=revision+1 WHERE bot_id=?",
        [Number(input.enabled), input.botId]
      )
      this.event("memory.policy", input.botId, {})
      return this.policy(input.botId)
    })
  }
  retry(raw: unknown): BotMemoryPolicy {
    const input = botMemoryRetryInput.parse(raw)
    return this.store.transaction(() => {
      this.store.getBot(input.botId)
      if (input.dataEpoch !== this.store.backupSchedule.epoch())
        throw new BotDomainError("data_epoch", "数据已恢复，请刷新记忆后重试")
      return this.receipt(input.nonce, { method: "retryMemory", ...input }, () => {
        const state = this.state(input.botId)
        if (state.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "记忆设置已变化，请刷新后重试")
        if (!state.enabled) throw new BotDomainError("memory_disabled", "请先开启自动整理任务经验")
        if (state.last_outcome === "running")
          throw new BotDomainError("memory_running", "正在整理，请等待本轮结束")
        // Old failures predate this feature. A manual correction/deletion/disable
        // must also fence their retry, even if their previous state was 'failed'.
        this.store.db.run(
          `UPDATE bot_memory_evidence SET state='skipped'
          WHERE bot_id=? AND state='failed' AND user_id IN
          (SELECT id FROM bot_messages WHERE sequence<=?)`,
          [input.botId, state.barrier_sequence]
        )
        const capacity = Math.max(0, 64 - this.policy(input.botId).pending)
        if (!capacity)
          throw new BotDomainError("memory_queue_full", "待整理记录较多，请等待后再重试")
        this.ensure(input.botId)
        this.store.db.run(
          `UPDATE bot_memory_evidence SET state='pending',attempts=0,next_at=?
          WHERE run_id IN (SELECT run_id FROM bot_memory_evidence
          WHERE bot_id=? AND state='failed' ORDER BY occurred_at,run_id LIMIT ?)`,
          [this.store.now(), input.botId, capacity]
        )
        this.store.db.run(
          `UPDATE bot_memory_state SET revision=revision+1,epoch=epoch+1,
          temporal_at=?,last_outcome='queued' WHERE bot_id=?`,
          [this.store.now() - MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS, input.botId]
        )
        this.event("memory.retry", input.botId, {})
        return this.policy(input.botId)
      })
    })
  }
  metadata(id: string): Pick<BotMemory, "origin" | "kind" | "evidence"> {
    const row = this.rows("SELECT * FROM bot_memory_metadata WHERE memory_id=?", [id])[0]
    return row
      ? {
          origin: z.enum(["explicit", "synthesized"]).parse(row.origin),
          kind: z.enum(["profile", "log"]).parse(row.kind),
          evidence: evidenceSchema.parse(JSON.parse(String(row.evidence)))
        }
      : { origin: "explicit", kind: "profile", evidence: [] }
  }
  /** Include all messages already present, including unfinished tasks. A late summary of
   * any old task cannot re-create a paraphrase of a fact the person corrected/deleted.
   */
  private manualBarrier(botId: string) {
    this.ensure(botId)
    this.store.db.run(
      `UPDATE bot_memory_state SET epoch=epoch+1,
      barrier_sequence=(SELECT COALESCE(MAX(sequence),0) FROM bot_messages),temporal_at=? WHERE bot_id=?`,
      [this.store.now(), botId]
    )
    this.store.db.run(
      "UPDATE bot_memory_evidence SET state='skipped' WHERE bot_id=? AND state IN ('pending','failed')",
      [botId]
    )
  }
  explicitWrite(botId: string, id: string, previous?: string) {
    if (previous) this.tombstone(botId, previous)
    this.manualBarrier(botId)
    this.store.db.run(
      `INSERT INTO bot_memory_metadata VALUES(?,'explicit','profile','[]')
      ON CONFLICT(memory_id) DO UPDATE SET origin='explicit'`,
      [id]
    )
  }
  explicitDelete(botId: string, text: string) {
    this.tombstone(botId, text)
    this.manualBarrier(botId)
  }
  private tombstone(botId: string, text: string) {
    this.store.db.run("INSERT OR IGNORE INTO bot_memory_tombstones VALUES(?,?)", [
      botId,
      contentHash(text)
    ])
  }
  /** Explicitly shared facts can have appeared in any Bot's earlier answers. Revoke
   * those old synthesis snapshots without exposing the originating private messages.
   */
  sharedCorrection(previous: string) {
    for (const bot of this.rows("SELECT id FROM bots WHERE deleted_at IS NULL")) {
      this.tombstone(String(bot.id), previous)
      this.manualBarrier(String(bot.id))
    }
  }
  recordCompleted(runId: string, assistantId: string) {
    const run = this.store.getRun(runId),
      state = this.state(run.botId)
    if (!state.enabled || run.status !== "succeeded" || run.parentRunId) return
    const message = this.store.message({ conversationId: run.conversationId, id: run.messageId })
    // Routine triggers, Teach, delegated work and group discussions are not private user evidence.
    if (
      message.sender !== "user" ||
      run.source !== "user" ||
      this.store.getConversation(run.conversationId).kind !== "direct" ||
      message.sequence <= state.barrier_sequence ||
      this.rows("SELECT id FROM bot_teach_sessions WHERE learning_run_id=?", [run.id]).length ||
      this.retentionRestricted(run.id, message.conversationId, message.text)
    )
      return
    this.ensure(run.botId)
    this.store.db.run(
      `INSERT OR IGNORE INTO bot_memory_evidence(run_id,bot_id,user_id,assistant_id,occurred_at,next_at)
      VALUES(?,?,?,?,?,?)`,
      [
        runId,
        run.botId,
        message.id,
        assistantId,
        this.store.now(),
        this.store.now() + MEMORY_SYNTHESIS_DEBOUNCE_MS
      ]
    )
    // Bounded outstanding queue per Bot. Preserve a visible skipped state; never block task settlement.
    this.store.db.run(
      `UPDATE bot_memory_evidence SET state='skipped' WHERE bot_id=? AND state='pending' AND run_id NOT IN
      (SELECT run_id FROM bot_memory_evidence WHERE bot_id=? AND state='pending' ORDER BY occurred_at DESC,run_id DESC LIMIT 64)`,
      [run.botId, run.botId]
    )
  }
  targets(): string[] {
    return this.rows(
      `SELECT b.id FROM bots b LEFT JOIN bot_memory_state s ON s.bot_id=b.id
      WHERE b.deleted_at IS NULL AND COALESCE(s.enabled,1)=1 AND (
      EXISTS(SELECT 1 FROM bot_memory_evidence e WHERE e.bot_id=b.id AND e.state='pending' AND e.next_at<=?) OR
      (COALESCE(s.temporal_at,0)<=? AND EXISTS(SELECT 1 FROM bot_memories m JOIN bot_memory_metadata d ON d.memory_id=m.id
        WHERE m.bot_id=b.id AND m.deleted_at IS NULL AND d.origin='synthesized')))
      ORDER BY COALESCE(s.last_attempt_at,0),b.id LIMIT 64`,
      [this.store.now(), this.store.now() - MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS]
    ).map((row) => String(row.id))
  }
  private fingerprint(botId: string): string {
    return digest(
      JSON.stringify([
        this.state(botId).epoch,
        this.store.getBot(botId).revision,
        this.rows("SELECT id,revision,deleted_at FROM bot_memories WHERE bot_id=? ORDER BY id", [
          botId
        ])
      ])
    )
  }
  private retentionRestricted(runId: string, conversationId: string, user: string): boolean {
    if (restrictsAutomaticMemory(user)) return true
    return this.store.steering.acceptedMessageIds(runId).some((id) => {
      const message = this.store.message({ conversationId, id })
      return (
        message.sender === "user" &&
        message.botId === null &&
        !message.importedContext &&
        restrictsAutomaticMemory(message.text)
      )
    })
  }
  prepare(botId: string): BotMemorySynthesisSnapshot | null {
    const state = this.state(botId)
    if (!state.enabled) return null
    const pending = this.rows(
      `SELECT e.*,m.text AS user,m.conversation_id,a.text AS assistant FROM bot_memory_evidence e
      JOIN bot_messages m ON m.id=e.user_id JOIN bot_messages a ON a.id=e.assistant_id
      WHERE e.bot_id=? AND e.state='pending' AND e.next_at<=? AND e.attempts<3
      ORDER BY e.occurred_at,e.run_id LIMIT 12`,
      [botId, this.store.now()]
    )
    // Retire pre-upgrade evidence too. Its queue row remains visible for audit,
    // while no new synthesis request can retain a task the user excluded.
    const records = this.store.transaction(() =>
      pending.filter((row) => {
        if (
          !this.retentionRestricted(
            String(row.run_id),
            String(row.conversation_id),
            String(row.user)
          )
        )
          return true
        this.store.db.run(
          "UPDATE bot_memory_evidence SET state='skipped' WHERE run_id=? AND state='pending'",
          [String(row.run_id)]
        )
        return false
      })
    )
    const memories: BotMemorySynthesisSnapshot["memories"] = []
    let budget = 48_000
    for (const memory of this.store
      .memories(botId)
      .sort(
        (a, b) =>
          Number(b.origin === "explicit") - Number(a.origin === "explicit") ||
          b.updatedAt - a.updatedAt
      )) {
      if (memory.text.length > budget || memories.length >= 512) continue
      memories.push({
        id: memory.id,
        content: memory.text,
        origin: memory.origin ?? "explicit",
        kind: memory.kind ?? "profile"
      })
      budget -= memory.text.length
    }
    const temporal =
      state.temporal_at <= this.store.now() - MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS &&
      (records.length > 0 || memories.some((item) => item.origin === "synthesized"))
    if (!records.length && !temporal) return null
    return {
      botId,
      fingerprint: this.fingerprint(botId),
      memories,
      temporal,
      evidence: records.map((row) => ({
        id: String(row.run_id),
        occurredAt: Number(row.occurred_at),
        user: boundedEvidenceText(
          [
            String(row.user),
            ...this.rows(
              `SELECT m.id,m.text FROM bot_steering s JOIN bot_messages m ON m.id=s.message_id
            WHERE s.run_id=? AND s.accepted_at IS NOT NULL AND m.sender='user' ORDER BY m.sequence`,
              [String(row.run_id)]
            ).map((message) => `[User follow-up ${message.id}] ${message.text}`)
          ].join("\n\n")
        ),
        assistant: boundedEvidenceText(String(row.assistant))
      })),
      sources: records.map((row) => ({
        runId: String(row.run_id),
        conversationId: String(row.conversation_id),
        messageId: String(row.user_id),
        assistantMessageId: String(row.assistant_id),
        occurredAt: Number(row.occurred_at)
      }))
    }
  }
  isCurrent(snapshot: BotMemorySynthesisSnapshot): boolean {
    try {
      return (
        !!this.state(snapshot.botId).enabled &&
        this.fingerprint(snapshot.botId) === snapshot.fingerprint &&
        snapshot.evidence.every(
          (e) =>
            this.rows("SELECT state FROM bot_memory_evidence WHERE run_id=?", [e.id])[0]?.state ===
            "pending"
        )
      )
    } catch {
      return false
    }
  }
  begin(snapshot: BotMemorySynthesisSnapshot): boolean {
    return this.store.transaction(() => {
      if (!this.isCurrent(snapshot)) return false
      this.ensure(snapshot.botId)
      for (const e of snapshot.evidence)
        this.store.db.run("UPDATE bot_memory_evidence SET attempts=attempts+1 WHERE run_id=?", [
          e.id
        ])
      this.store.db.run(
        "UPDATE bot_memory_state SET last_attempt_at=?,last_outcome='running' WHERE bot_id=?",
        [this.store.now(), snapshot.botId]
      )
      return true
    })
  }
  /** Validate the entire proposal before any mutation. A verifier verdict never overrides
   * explicit origin, evidence ownership, deleted-content tombstones or the CAS fence.
   */
  commit(snapshot: BotMemorySynthesisSnapshot, changes: readonly MemoryChange[]): SynthesisOutcome {
    return this.store.transaction(() => {
      if (!this.isCurrent(snapshot)) return "stale"
      // Check full immutable inputs once at commit, not at each 250 ms heartbeat
      // and not against the truncated strings supplied to the model.
      for (const evidence of snapshot.evidence) {
        const run = this.store.getRun(evidence.id)
        const message = this.store.message({
          conversationId: run.conversationId,
          id: run.messageId
        })
        if (this.retentionRestricted(run.id, run.conversationId, message.text))
          return "invalid-output"
      }
      const existing = this.store.memories(snapshot.botId),
        touched = new Set<string>(),
        newKeys = new Set<string>()
      if (
        !usesKnownEvidence(new Set(snapshot.evidence.map((e) => e.id)), changes, snapshot.temporal)
      )
        return "invalid-output"
      for (const change of changes) {
        if (change.action !== "create") {
          const old = existing.find((m) => m.id === change.id)
          if (
            !old ||
            old.origin !== "synthesized" ||
            !snapshot.memories.some((m) => m.id === change.id) ||
            touched.has(change.id)
          )
            return "invalid-output"
          touched.add(change.id)
        }
        if (change.action !== "remove") {
          const content = normalizeMemoryContent(change.content),
            key = contentHash(content)
          if (
            !content ||
            newKeys.has(key) ||
            this.rows("SELECT 1 FROM bot_memory_tombstones WHERE bot_id=? AND content_hash=?", [
              snapshot.botId,
              key
            ]).length
          )
            return "invalid-output"
          if (
            existing.some(
              (m) =>
                contentHash(m.text) === key && (change.action === "create" || m.id !== change.id)
            )
          )
            return "invalid-output"
          newKeys.add(key)
        }
      }
      if (
        changes.some((c) => c.action === "create") &&
        existing.length +
          changes.filter((c) => c.action === "create").length -
          changes.filter((c) => c.action === "remove").length >
          512
      )
        return "invalid-output"
      for (const change of changes) {
        const id = change.action === "create" ? randomUUID() : change.id
        if (change.action === "remove") {
          this.store.db.run(
            "UPDATE bot_memories SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
            [this.store.now(), this.store.now(), id]
          )
        } else {
          const previous =
            change.action === "update" ? existing.find((m) => m.id === id) : undefined
          const sources = snapshot.sources.filter((e) => change.sourceEvidenceIds.includes(e.runId))
          // Clock-only rewrites retain the original evidence instead of inventing a new source.
          const evidence = sources.length ? sources : (previous?.evidence ?? [])
          if (change.action === "create")
            this.store.db.run("INSERT INTO bot_memories VALUES(?,?,?,1,?,NULL,?)", [
              id,
              snapshot.botId,
              normalizeMemoryContent(change.content),
              evidence[0]?.messageId ?? null,
              this.store.now()
            ])
          else
            this.store.db.run(
              "UPDATE bot_memories SET text=?,revision=revision+1,source_message_id=?,updated_at=? WHERE id=?",
              [
                normalizeMemoryContent(change.content),
                evidence[0]?.messageId ?? null,
                this.store.now(),
                id
              ]
            )
          this.store.db.run(
            `INSERT INTO bot_memory_metadata VALUES(?,'synthesized',?,?) ON CONFLICT(memory_id)
            DO UPDATE SET kind=excluded.kind,evidence=excluded.evidence`,
            [id, change.kind, JSON.stringify(evidence)]
          )
        }
        this.event(change.action === "remove" ? "memory.deleted" : "memory.updated", id, {
          botId: snapshot.botId,
          origin: "synthesized"
        })
      }
      this.settled(snapshot, changes.length ? "committed" : "no-work")
      this.store.db.run("UPDATE bot_memory_state SET epoch=epoch+1 WHERE bot_id=?", [
        snapshot.botId
      ])
      return changes.length ? "committed" : "no-work"
    })
  }
  private settled(snapshot: BotMemorySynthesisSnapshot, outcome: string) {
    for (const evidence of snapshot.evidence)
      this.store.db.run("UPDATE bot_memory_evidence SET state='done' WHERE run_id=?", [evidence.id])
    this.store.db.run("UPDATE bot_memory_state SET last_outcome=?,temporal_at=? WHERE bot_id=?", [
      outcome,
      this.store.now(),
      snapshot.botId
    ])
    this.event("memory.synthesis", snapshot.botId, { outcome })
  }
  deferForBudget(snapshot: BotMemorySynthesisSnapshot, begun: boolean) {
    this.store.transaction(() => {
      if (!this.isCurrent(snapshot)) return
      this.ensure(snapshot.botId)
      for (const evidence of snapshot.evidence)
        this.store.db.run(
          "UPDATE bot_memory_evidence SET attempts=MAX(0,attempts-?),next_at=? WHERE run_id=? AND state='pending'",
          [Number(begun), this.store.now() + 60_000, evidence.id]
        )
      this.store.db.run(
        "UPDATE bot_memory_state SET last_outcome='budget',last_attempt_at=?,temporal_at=? WHERE bot_id=?",
        [this.store.now(), this.store.now(), snapshot.botId]
      )
    })
  }
  failed(
    snapshot: BotMemorySynthesisSnapshot,
    outcome: string,
    diagnostic?: BotErrorDiagnostic
  ): boolean {
    const safe =
      diagnostic === undefined
        ? undefined
        : safeBotErrorDiagnostic(botErrorDiagnosticSchema.parse(diagnostic))
    return this.store.transaction(() => {
      if (!this.isCurrent(snapshot)) return false
      for (const evidence of snapshot.evidence)
        this.store.db.run(
          `UPDATE bot_memory_evidence SET
        state=CASE WHEN attempts>=3 OR ?='context-limit' THEN 'failed' ELSE 'pending' END,next_at=? WHERE run_id=?`,
          [outcome, this.store.now() + 30_000, evidence.id]
        )
      this.store.db.run("UPDATE bot_memory_state SET last_outcome=?,temporal_at=? WHERE bot_id=?", [
        outcome,
        this.store.now(),
        snapshot.botId
      ])
      this.event("memory.synthesis", snapshot.botId, {
        outcome,
        ...(safe === undefined ? {} : { diagnostic: safe })
      })
      return true
    })
  }
  stale(snapshot: BotMemorySynthesisSnapshot) {
    this.store.transaction(() => {
      // A manual barrier has already marked affected evidence skipped. Never revive it.
      for (const evidence of snapshot.evidence)
        this.store.db.run(
          "UPDATE bot_memory_evidence SET attempts=MAX(0,attempts-1),next_at=? WHERE run_id=? AND state='pending'",
          [this.store.now() + MEMORY_SYNTHESIS_DEBOUNCE_MS, evidence.id]
        )
    })
  }
  recover() {
    this.store.transaction(() => {
      this.store.db.run(
        "UPDATE bot_memory_evidence SET state='failed' WHERE state='pending' AND attempts>=3"
      )
      this.store.db.run(
        "UPDATE bot_memory_state SET last_outcome='interrupted' WHERE last_outcome='running'"
      )
    })
  }
}
