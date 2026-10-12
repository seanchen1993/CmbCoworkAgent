import type { BotStorageStatus, BotStorageLevel } from "../../shared/bot-storage"
import { botVolumeSample } from "../../shared/bot-storage"
import {
  classifyDiskPressure,
  readDiskVolumeSnapshots,
  type DiskVolumeSample
} from "./upstream/grok-disk-pressure"

type Root = { volume: string; path: string }
/** Read-only Host monitor. Partial samples retain prior pressure; they never imply recovery. */
export class BotStorageMonitor {
  private readonly states = new Map<string, BotStorageStatus["volumes"][number]>()
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private closed = false
  private checkedAt: number | null = null
  private complete = false
  constructor(
    private readonly roots: () => Root[],
    private readonly read: (roots: Root[]) => Promise<DiskVolumeSample> = readDiskVolumeSnapshots,
    private readonly clock: () => number = Date.now
  ) {}
  view(): BotStorageStatus {
    const volumes = [...this.states.values()].map((value) => ({ ...value }))
    const levels = volumes.map((value) => value.level)
    const level: BotStorageLevel | "unknown" = levels.includes("hard")
      ? "hard"
      : levels.includes("soft")
        ? "soft"
        : this.complete
          ? "healthy"
          : "unknown"
    return { checkedAt: this.checkedAt, complete: this.complete, level, volumes }
  }
  start(): void {
    if (this.closed || this.timer) return
    void this.sample()
    this.timer = setInterval(() => void this.sample(), 30_000)
    this.timer.unref()
  }
  sample(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = Promise.resolve()
      .then(async () => {
        try {
          const sample = await this.read(this.roots())
          if (this.closed) return
          const now = this.clock(),
            seen = new Set<string>()
          let complete = sample.complete && sample.snapshots.length > 0
          for (const raw of sample.snapshots) {
            const parsed = botVolumeSample.safeParse(raw)
            if (!parsed.success) {
              complete = false
              continue
            }
            const value = parsed.data
            seen.add(value.deviceId)
            this.states.set(value.deviceId, {
              name: value.volume,
              totalBytes: value.totalBytes,
              availableBytes: value.availableBytes,
              level: classifyDiskPressure(value, this.states.get(value.deviceId)?.level),
              sampledAt: now
            })
          }
          if (complete)
            for (const key of this.states.keys()) if (!seen.has(key)) this.states.delete(key)
          this.checkedAt = now
          this.complete = complete
        } catch {
          if (!this.closed) {
            this.checkedAt = this.clock()
            this.complete = false
          }
        }
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  close(): void {
    this.closed = true
    clearInterval(this.timer)
    this.timer = undefined
    // Native asynchronous statfs cannot be aborted. Its late result has no write authority.
  }
}
