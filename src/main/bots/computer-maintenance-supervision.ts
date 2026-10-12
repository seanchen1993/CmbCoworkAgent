import {
  BOT_COMPUTER_FILE_IDLE_MS,
  BOT_COMPUTER_NATIVE_PHASE_MS,
  BOT_COMPUTER_OPERATION_MS,
  BOT_COMPUTER_PROGRESS_FRESH_MS,
  type BotComputerMaintenanceProgress
} from "../../shared/bot-computer-maintenance-progress"

/** Heartbeats prove liveness, not useful work. One authority/operation is pinned
 * for a supervision attempt; neither replayed progress nor owner replacement
 * can renew its deadlines. All elapsed deadlines use a monotonic clock. */
export class ComputerMaintenanceSupervision {
  private current?: BotComputerMaintenanceProgress
  private phaseStarted = 0
  private lastMovement = 0
  private readonly started: number
  constructor(private readonly now = () => performance.now()) {
    this.started = now()
  }

  accept(value: BotComputerMaintenanceProgress, wallNow = Date.now()): boolean {
    if (
      value.updatedAt > wallNow + 1000 ||
      wallNow - value.updatedAt > BOT_COMPUTER_PROGRESS_FRESH_MS ||
      wallNow - value.startedAt > BOT_COMPUTER_OPERATION_MS
    )
      return false
    const previous = this.current
    if (previous) {
      if (
        value.nonce !== previous.nonce ||
        value.operation !== previous.operation ||
        value.startedAt !== previous.startedAt ||
        JSON.stringify(value.owner) !== JSON.stringify(previous.owner) ||
        value.sequence <= previous.sequence ||
        value.updatedAt < previous.updatedAt ||
        (previous.workSequence !== undefined &&
          (value.workSequence === undefined || value.workSequence < previous.workSequence))
      )
        return false
    }
    const now = this.now()
    const phaseChanged =
      !previous ||
      value.phase !== previous.phase ||
      value.component !== previous.component ||
      value.activity !== previous.activity
    if (phaseChanged) this.phaseStarted = this.lastMovement = now
    else if (
      (value.workSequence !== undefined && value.workSequence > (previous.workSequence ?? 0)) ||
      value.entries > previous.entries ||
      value.bytes > previous.bytes
    )
      this.lastMovement = now
    this.current = value
    return true
  }

  alive(wallNow = Date.now()): boolean {
    const current = this.current
    const now = this.now()
    if (
      !current ||
      now - this.started >= BOT_COMPUTER_OPERATION_MS ||
      wallNow < current.updatedAt - 1000 ||
      wallNow - current.updatedAt > BOT_COMPUTER_PROGRESS_FRESH_MS
    )
      return false
    if (current.activity === "native-sqlite" || current.activity === "git")
      return now - this.phaseStarted < BOT_COMPUTER_NATIVE_PHASE_MS
    return now - this.lastMovement < BOT_COMPUTER_FILE_IDLE_MS
  }
}
