import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import {
  BOT_COMPUTER_PROGRESS_MAX_BYTES,
  BOT_COMPUTER_PROGRESS_FRESH_MS,
  botComputerMaintenanceProgress,
  type BotComputerMaintenanceProgress
} from "../../shared/bot-computer-maintenance-progress"
import type { BotHostDescriptor } from "./transport-client"
import { BotHostLock } from "./host-lock"
import { readPrivateJson } from "./backup-io"

/** A starting descriptor alone never extends startup. The private bounded
 * record must match the live OS lock, physical root/lock and token generation. */
export async function readVerifiedComputerStartupProgress(
  directory: string,
  descriptor: BotHostDescriptor | undefined
): Promise<BotComputerMaintenanceProgress | undefined> {
  if (!descriptor || descriptor.hostId !== "starting") return undefined
  try {
    if (
      !Number.isSafeInteger(descriptor.pid) ||
      descriptor.pid <= 0 ||
      typeof descriptor.token !== "string" ||
      descriptor.token.length < 1 ||
      descriptor.token.length > 512
    )
      return undefined
    directory = await realpath(directory)
    const observer = BotHostLock.observe(directory)
    const identity = observer.recoveryOwnershipIdentity()
    const root = join(directory, "computer-recovery")
    if ((await realpath(root)) !== root) return undefined
    const value = botComputerMaintenanceProgress.parse(
      (await readPrivateJson(root, "progress.private.json", BOT_COMPUTER_PROGRESS_MAX_BYTES)).value
    )
    const now = Date.now()
    if (
      value.operation !== "startup-restore" ||
      value.owner.pid !== descriptor.pid ||
      value.owner.hostTokenSha256 !== createHash("sha256").update(descriptor.token).digest("hex") ||
      JSON.stringify(value.owner.root) !== JSON.stringify(identity.root) ||
      JSON.stringify(value.owner.lock) !== JSON.stringify(identity.lock) ||
      value.updatedAt > now + 1000 ||
      now - value.updatedAt > BOT_COMPUTER_PROGRESS_FRESH_MS
    )
      return undefined
    process.kill(descriptor.pid, 0)
    // A reused PID or leftover JSON is insufficient. If the OS lock is free,
    // release the disposable probe without publishing/removing a descriptor.
    const available = BotHostLock.acquire(directory)
    if (available) {
      available.release()
      return undefined
    }
    await observer.checkCurrent()
    const current = (await readPrivateJson(directory, "host.json", 4096))
      .value as Partial<BotHostDescriptor> | null
    if (
      !current ||
      current.hostId !== "starting" ||
      current.pid !== descriptor.pid ||
      current.token !== descriptor.token
    )
      return undefined
    return value
  } catch {
    return undefined
  }
}
