import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

export class BotModelSnapshotPendingError extends Error {
  constructor() {
    super("Bot 配置正在同步，已暂停使用旧配置，请稍后重试")
    this.name = "BotModelSnapshotPendingError"
  }
}

/** Reject stale execution configuration while a desktop settings change is being published.
 * The marker contains an opaque generation only, never credentials or model settings.
 */
export function invalidateBotModelSnapshot(path: string): void {
  if (!existsSync(path)) return
  try {
    writeFileSync(`${path}.pending`, randomUUID(), { mode: 0o600 })
  } catch (error) {
    // If storage cannot record invalidation, removing the old snapshot also prevents
    // new tasks/tools from using revoked connector or sandbox configuration.
    try {
      unlinkSync(path)
    } catch {
      /* The refresh reports storage failure. */
    }
    throw error
  }
}

export function botModelSnapshotGeneration(path: string): string | null {
  try {
    return readFileSync(`${path}.pending`, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function completeBotModelSnapshotGeneration(path: string, generation: string | null): void {
  if (generation === null || botModelSnapshotGeneration(path) !== generation) return
  // Synchronous compare/remove: a newer desktop change cannot interleave on this event loop.
  unlinkSync(`${path}.pending`)
}

export function assertBotModelSnapshotCurrent(path: string): void {
  if (existsSync(`${path}.pending`)) throw new BotModelSnapshotPendingError()
}

export function botConfigurationUnavailableReason(path: string): string | null {
  if (existsSync(`${path}.pending`)) return "Bot 配置正在同步，已提交的工作会在同步完成后继续。"
  if (!existsSync(path)) return "Bot 配置暂不可用，请检查 CMBDevClaw 设置和本机存储。"
  return null
}
