import { randomUUID } from "node:crypto"
import {
  botBackupScheduleChange,
  botBackupScheduleState,
  initialBotBackupSchedule,
  type BotBackupScheduleState
} from "../../shared/bot-backup-schedule"
import { botBackupSummarySchema, type BotBackupSummary } from "../../shared/bot-backup"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { serializeBotFailure } from "./error-diagnostic"

/** Host-owned durable schedule. A pending snapshot identity survives process/reply loss. */
export class BotBackupScheduleStore {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}
  read(): BotBackupScheduleState {
    const raw = this.store.db.exec("SELECT state FROM bot_backup_schedule WHERE id=1")[0]
      ?.values[0]?.[0]
    return raw == null
      ? { ...initialBotBackupSchedule }
      : botBackupScheduleState.parse(JSON.parse(String(raw)))
  }
  epoch(): string {
    // Older computer checkpoints wrote only the specific marker. Both routes
    // share one durable cursor order, independently of their wall-clock times.
    return String(
      this.store.db.exec(
        "SELECT entity_id FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor DESC LIMIT 1"
      )[0]?.values[0]?.[0] ?? "initial"
    )
  }
  private write(value: BotBackupScheduleState): void {
    this.store.db.run(
      "INSERT INTO bot_backup_schedule(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      [JSON.stringify(botBackupScheduleState.parse(value))]
    )
  }
  change(raw: unknown): BotBackupScheduleState {
    const parsed = botBackupScheduleChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "定时备份配置无效")
    const input = parsed.data
    return this.store.transaction(() => {
      // Check before receipt replay: a restored database may include an older successful request.
      if (input.dataEpoch !== this.epoch())
        throw new BotDomainError("data_epoch", "数据已恢复，请重新读取备份配置")
      return this.receipt(input.nonce, { op: "backup.schedule", ...input }, () => {
        const current = this.read()
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "定时备份配置已变化，请刷新后重试")
        const next = {
          ...current,
          revision: current.revision + 1,
          enabled: input.enabled,
          intervalHours: input.intervalHours,
          nextAt: input.enabled
            ? current.enabled && current.intervalHours === input.intervalHours
              ? current.nextAt
              : this.store.now() + input.intervalHours * 3_600_000
            : null
        }
        this.write(next)
        this.event("backup.schedule_changed", "workspace", {
          revision: next.revision,
          enabled: next.enabled,
          intervalHours: next.intervalHours
        })
        return next
      })
    })
  }
  claim(): string | null {
    return this.store.transaction(() => {
      const state = this.read(),
        now = this.store.now()
      if (
        !state.enabled ||
        (state.pendingId
          ? state.retryAt != null && state.retryAt > now
          : state.nextAt == null || state.nextAt > now)
      )
        return null
      const id = state.pendingId ?? randomUUID()
      this.write({ ...state, pendingId: id, lastAttemptAt: now, retryAt: null })
      return id
    })
  }
  complete(id: string, raw: BotBackupSummary): void {
    const backup = botBackupSummarySchema.parse(raw)
    if (backup.id !== id || backup.reason !== "scheduled") throw new Error("定时备份结果与任务不符")
    this.store.transaction(() => {
      const state = this.read()
      if (state.pendingId !== id) throw new Error("定时备份任务已变化")
      this.write({
        ...state,
        pendingId: null,
        retryAt: null,
        lastBackup: backup,
        error: null,
        nextAt: state.enabled ? this.store.now() + state.intervalHours * 3_600_000 : null
      })
      this.event("backup.completed", id, { bytes: backup.bytes, files: backup.files })
    })
  }
  fail(id: string, error: unknown): boolean {
    const failure = serializeBotFailure(error)
    return this.store.transaction(() => {
      const state = this.read()
      if (state.pendingId !== id) return false
      this.write({
        ...state,
        retryAt: this.store.now() + 300_000,
        error: failure.message
      })
      this.event("backup.failed", id, {
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {})
      })
      return true
    })
  }

  skipDeleted(id: string): void {
    this.store.transaction(() => {
      const state = this.read()
      if (state.pendingId !== id) return
      this.write({
        ...state,
        pendingId: null,
        retryAt: null,
        error: null,
        nextAt: state.enabled ? this.store.now() + state.intervalHours * 3_600_000 : null
      })
      this.event("backup.skipped", id, { reason: "deleted" })
    })
  }
}
