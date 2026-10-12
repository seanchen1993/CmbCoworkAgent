import { createHash } from "node:crypto"
import { lstat, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  botComputerMaintenanceProgress,
  BOT_COMPUTER_PROGRESS_FLUSH_MS,
  type BotComputerMaintenanceProgress
} from "../../shared/bot-computer-maintenance-progress"
import { privateDirectory, writePrivateJson } from "./backup-io"
import type { ComputerOwner, ComputerProgress } from "./computer-checkpoint-ports"
export const COMPUTER_PROGRESS_FILE = "computer-recovery/progress.private.json"
export class ComputerCheckpointProgress {
  private value: BotComputerMaintenanceProgress
  private pending?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private write: Promise<void> = Promise.resolve()
  private dirty = false
  private stopped = false
  constructor(
    private readonly directory: string,
    private readonly owner: ComputerOwner,
    nonce: string,
    operation: BotComputerMaintenanceProgress["operation"],
    token: string,
    private readonly emit: (value: BotComputerMaintenanceProgress) => void,
    private readonly failed: (error: unknown) => void
  ) {
    const now = Date.now(),
      identity = owner.identity()
    this.value = botComputerMaintenanceProgress.parse({
      format: 1,
      owner: {
        pid: process.pid,
        hostTokenSha256: createHash("sha256").update(token).digest("hex"),
        ...identity
      },
      nonce,
      operation,
      phase: "verify",
      component: "control",
      activity: "atomic-mutation",
      startedAt: now,
      updatedAt: now,
      sequence: 0,
      workSequence: 0,
      entries: 0,
      bytes: 0
    })
  }
  async start() {
    await this.owner.checkCurrent()
    this.owner.assertCurrent()
    await privateDirectory(join(this.directory, "computer-recovery"))
    const pending = join(this.directory, COMPUTER_PROGRESS_FILE + ".pending")
    const info = await lstat(pending).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info) {
      if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink())
        throw new Error("电脑维护进度暂存记录位置无效")
      this.owner.assertCurrent()
      await rm(pending)
    }
    this.dirty = true
    await this.flush()
    this.heartbeat = setInterval(() => {
      this.dirty = true
      this.schedule()
    }, 5000)
  }
  update(value: ComputerProgress) {
    if (this.stopped) return
    this.value = { ...this.value, ...value, activity: "file-io" }
    this.dirty = true
    this.schedule()
  }
  native(active: boolean) {
    if (this.stopped) return
    this.value = { ...this.value, activity: active ? "native-sqlite" : "file-io" }
    this.dirty = true
    this.schedule()
  }
  git(active: boolean) {
    if (this.stopped) return
    this.value = { ...this.value, activity: active ? "git" : "file-io" }
    this.dirty = true
    this.schedule()
  }
  worked() {
    if (this.stopped) return
    this.value = { ...this.value, workSequence: (this.value.workSequence ?? 0) + 1 }
    this.dirty = true
    this.schedule()
  }
  stage(
    phase: BotComputerMaintenanceProgress["phase"],
    component: BotComputerMaintenanceProgress["component"]
  ) {
    if (this.stopped) return
    this.value = {
      ...this.value,
      phase,
      component,
      activity: "atomic-mutation",
      entries: 0,
      bytes: 0
    }
    this.dirty = true
    this.schedule()
  }
  private schedule() {
    if (this.pending || this.stopped) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      void this.flush().catch(this.failed)
    }, BOT_COMPUTER_PROGRESS_FLUSH_MS)
  }
  private flush() {
    this.write = this.write.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      await this.owner.checkCurrent()
      this.owner.assertCurrent()
      this.value = botComputerMaintenanceProgress.parse({
        ...this.value,
        updatedAt: Math.max(this.value.startedAt, Date.now()),
        sequence: this.value.sequence + 1
      })
      const value = this.value
      await writePrivateJson(join(this.directory, COMPUTER_PROGRESS_FILE), value)
      this.emit(value)
    })
    return this.write
  }
  async close() {
    this.stopped = true
    if (this.pending) clearTimeout(this.pending)
    if (this.heartbeat) clearInterval(this.heartbeat)
    await this.flush()
  }
}
