import type { BotBackupScheduleView } from "../../shared/bot-backup-schedule"
import type { BotBackupScheduleStore } from "./backup-schedule-store"
import { BotBackupSnapshotProcess } from "./backup-snapshot-process"
import { BotDomainError } from "../../shared/bot-types"
import { randomUUID } from "node:crypto"
import { serializeBotFailure } from "./error-diagnostic"
import {
  reportBotBackgroundFailure,
  type BotBackgroundFailureReporter
} from "./background-error-reporter"

/** One disposable worker at a time; shutting down preserves the pending nonce. */
export class BotBackupScheduler {
  private timer?: ReturnType<typeof setInterval>
  private active?: { controller: AbortController; promise: Promise<void> }
  private closed = false
  private failureReporter?: BotBackgroundFailureReporter
  constructor(
    private readonly state: BotBackupScheduleStore,
    private readonly directory: string,
    private readonly hostId: string,
    private readonly worker: Pick<
      BotBackupSnapshotProcess,
      "create"
    > = new BotBackupSnapshotProcess(),
    private readonly assertOwnership: () => void = () => {}
  ) {}
  bindFailureReporter(report: BotBackgroundFailureReporter): void {
    this.failureReporter = report
  }
  view(): BotBackupScheduleView {
    return {
      ...this.state.read(),
      dataEpoch: this.state.epoch(),
      running: !!this.active,
      available: !this.closed
    }
  }
  start(): void {
    if (this.timer || this.closed) return
    this.assertOwnership()
    this.timer = setInterval(() => void this.tick(), 30_000)
    this.timer.unref()
    void this.tick()
  }
  tick(): Promise<void> {
    if (this.active) return this.active.promise
    if (this.closed) return Promise.resolve()
    const controller = new AbortController()
    const promise = Promise.resolve()
      .then(async () => {
        if (this.closed) return
        let id: string | null = null
        let dataEpoch = ""
        const episodeId = `backup:${randomUUID()}`
        try {
          this.assertOwnership()
          id = this.state.claim()
          if (!id) return
          dataEpoch = this.state.epoch()
          this.assertOwnership()
          const result = await this.worker.create(
            { directory: this.directory, hostId: this.hostId, nonce: id },
            controller.signal
          )
          if (!this.closed) {
            this.assertOwnership()
            this.state.complete(id, result)
          }
        } catch (error) {
          if (!this.closed && id) {
            try {
              this.assertOwnership()
              if (error instanceof BotDomainError && error.code === "snapshot_deleted")
                this.state.skipDeleted(id)
              else if (this.state.fail(id, error))
                reportBotBackgroundFailure(
                  this.failureReporter,
                  {
                    dataEpoch,
                    episodeId,
                    groupKey: "scheduled",
                    source: "backup",
                    title: "定时备份失败"
                  },
                  error
                )
            } catch (failure) {
              console.error(
                "[BotBackup] Could not persist failure",
                serializeBotFailure(failure).message
              )
            }
          } else if (!this.closed) console.error("[BotBackup]", serializeBotFailure(error).message)
        }
      })
      .finally(() => {
        this.active = undefined
      })
    this.active = { controller, promise }
    return promise
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.timer = undefined
    this.active?.controller.abort(new Error("后台正在关闭，备份将在重启后继续"))
    await this.active?.promise
  }
}
