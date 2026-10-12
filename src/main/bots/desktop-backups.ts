import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { shell } from "electron"
import { botBackupRequest, botBackupResult, type BotBackupResult } from "../../shared/bot-backup"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { listBotBackups } from "./backups"
import { runDesktopMaintenanceWorker } from "./desktop-maintenance-worker"

const directory = () => join(getCmbCoworkAgentDataRoot(), "bot-host")
export const listDesktopBotBackups = () => listBotBackups(directory())
export async function revealDesktopBotBackups(): Promise<void> {
  const path = join(directory(), "backups")
  await mkdir(path, { recursive: true, mode: 0o700 })
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

export async function executeDesktopBotBackup(untrusted: unknown): Promise<BotBackupResult> {
  const input = botBackupRequest.parse(untrusted)
  return runDesktopMaintenanceWorker("bot-backup", directory(), input, (value) =>
    botBackupResult.parse(value)
  )
}
