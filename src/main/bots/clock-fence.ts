import { BotDomainError } from "../../shared/bot-types"

const CLOCK_DRIFT_MS = 5000
const MAX_HEARTBEAT_GAP_MS = 30_000

/** Wall time schedules work; monotonic time detects a lost supervision interval.
 * Small NTP adjustments are tolerated. Once invalid, reverting the clock does
 * not restore authority: the Host must durably fence its leases first.
 */
export class BotClockFence {
  private baseline: { wall: number; monotonic: number }
  private invalid = false
  constructor(
    private readonly wall: () => number,
    private readonly monotonic: () => number = () => performance.now()
  ) {
    this.baseline = this.sample()
  }
  private sample() {
    return { wall: this.wall(), monotonic: this.monotonic() }
  }
  private observe(): { wall: number; monotonic: number } {
    const current = this.sample()
    const elapsed = current.monotonic - this.baseline.monotonic
    if (
      !Number.isFinite(current.wall) ||
      !Number.isFinite(current.monotonic) ||
      elapsed < 0 ||
      elapsed >= MAX_HEARTBEAT_GAP_MS ||
      Math.abs(current.wall - this.baseline.wall - elapsed) > CLOCK_DRIFT_MS
    )
      this.invalid = true
    return current
  }
  assert(): void {
    this.observe()
    if (this.invalid)
      throw new BotDomainError("clock_changed", "系统时间或运行状态发生变化，任务需要重新核对")
  }
  /** Only a normal heartbeat advances the reference; tool traffic cannot mask a lost heartbeat. */
  heartbeat(): boolean {
    const current = this.observe()
    if (this.invalid) return false
    this.baseline = current
    return true
  }
  resetAfterFencing(): void {
    this.baseline = this.sample()
    this.invalid = false
  }
}
