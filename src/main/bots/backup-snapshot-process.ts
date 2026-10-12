import { join } from "node:path"
import type { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { botSnapshotRequest, botSnapshotResult } from "./backup-snapshot-contract"
import { BotUtilityProcess, type BotUtilityLauncher } from "./utility-process"

/** The existing bounded worker transport keeps SQLite scanning and copying off the Host. */
export class BotBackupSnapshotProcess {
  private readonly worker: BotUtilityProcess
  constructor(launcher: BotUtilityLauncher = { entry: join(__dirname, "bot-backup-snapshot.js") }) {
    this.worker = new BotUtilityProcess(launcher, "定时备份", 5 * 60_000)
  }
  create(input: z.infer<typeof botSnapshotRequest>, signal: AbortSignal) {
    const request = botSnapshotRequest.parse(input)
    return this.worker
      .invoke(request, (value) => botSnapshotResult.parse(value), signal)
      .then((result) => {
        if (result.id !== request.nonce) throw new Error("定时备份结果与任务不符")
        if ("status" in result) throw new BotDomainError("snapshot_deleted", "本次定时备份已删除")
        return result
      })
  }
}
