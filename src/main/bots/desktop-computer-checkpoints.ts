import { join } from "node:path"
import { lstat, realpath } from "node:fs/promises"
import { z } from "zod"
import { shell } from "electron"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import {
  botComputerCheckpointId,
  botComputerCheckpointRequest,
  botComputerCheckpointResult,
  botComputerCheckpointSelection,
  botComputerDeliverablesSummary
} from "../../shared/bot-computer-checkpoint"
import {
  listBotComputerCheckpoints,
  listBotComputerRecoveryCopies,
  resolveBotComputerDeliverables,
  listBotComputerDeliverables
} from "./computer-checkpoint-service"
import {
  desktopComputerMaintenanceProgress,
  runDesktopMaintenanceWorker
} from "./desktop-maintenance-worker"
import { readVerifiedComputerStartupProgress } from "./computer-startup-progress"
import { readPrivateJson } from "./backup-io"
import type { BotHostDescriptor } from "./transport-client"
import { botComputerMaintenancePublicProgress } from "../../shared/bot-computer-maintenance-progress"

const directory = () => join(getCmbCoworkAgentDataRoot(), "bot-host")
export const listDesktopBotComputerCheckpoints = () => listBotComputerCheckpoints(directory())
export const listDesktopBotComputerRecoveryCopies = () => listBotComputerRecoveryCopies(directory())
export async function listDesktopBotComputerDeliverables() {
  return z
    .array(botComputerDeliverablesSummary)
    .max(20)
    .parse(await listBotComputerDeliverables(directory()))
}
export async function desktopBotComputerProgress() {
  const current = desktopComputerMaintenanceProgress()
  if (current) return current
  try {
    const root = directory()
    const descriptor = (await readPrivateJson(root, "host.json", 4096)).value as BotHostDescriptor
    const progress = await readVerifiedComputerStartupProgress(root, descriptor)
    if (!progress) return null
    return botComputerMaintenancePublicProgress.strip().parse(progress)
  } catch {
    return null
  }
}
export async function executeDesktopBotComputerCheckpoint(untrusted: unknown) {
  const input = botComputerCheckpointRequest.parse(untrusted)
  return runDesktopMaintenanceWorker("bot-computer-checkpoint", directory(), input, (value) =>
    botComputerCheckpointResult.parse(value)
  )
}
export async function deleteDesktopBotComputerRecoveryCopy(untrusted: unknown): Promise<void> {
  const recovery = botComputerCheckpointSelection.parse(untrusted)
  await runDesktopMaintenanceWorker(
    "bot-computer-checkpoint",
    directory(),
    { action: "delete-recovery", recovery },
    (value) =>
      z
        .object({ action: z.literal("delete-recovery") })
        .strict()
        .parse(value)
  )
}
export async function revealDesktopBotComputerRecoveryCopy(untrusted: unknown): Promise<void> {
  const id = botComputerCheckpointId.parse(untrusted)
  const copies = await listBotComputerRecoveryCopies(directory())
  if (!copies.some((copy) => copy.id === id)) throw new Error("电脑恢复副本不存在或已删除")
  const root = await realpath(directory())
  const path = join(root, "computer-recovery", "recovery", id)
  if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
    throw new Error("电脑恢复副本位置已变化")
  const failure = await shell.openPath(path)
  if (failure) throw new Error("无法打开电脑恢复副本目录")
}

export async function revealDesktopBotComputerDeliverables(untrusted: unknown): Promise<void> {
  const id = botComputerCheckpointId.parse(untrusted)
  const path = await resolveBotComputerDeliverables(directory(), id)
  const failure = await shell.openPath(path)
  if (failure) throw new Error("无法打开恢复的代码成果目录")
}
