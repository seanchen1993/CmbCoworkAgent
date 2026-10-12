import { shell } from "electron"
import { lstat, realpath } from "node:fs/promises"
import { dirname } from "node:path"
import { BotSharedWorkspace } from "./shared-workspace"
import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import {
  botWorkspaceMaintenanceRequest,
  botWorkspaceMaintenanceResult
} from "../../shared/bot-workspace-maintenance"
import { listBotWorkspaceCheckpoints } from "./workspace-maintenance"
import { runDesktopMaintenanceWorker } from "./desktop-maintenance-worker"

const directory = () => join(getCmbCoworkAgentDataRoot(), "bot-host")
export const listDesktopBotWorkspaceCheckpoints = () => listBotWorkspaceCheckpoints(directory())
export async function executeDesktopBotWorkspaceMaintenance(untrusted: unknown) {
  const input = botWorkspaceMaintenanceRequest.parse(untrusted)
  return runDesktopMaintenanceWorker("bot-workspace-maintenance", directory(), input, (value) =>
    botWorkspaceMaintenanceResult.parse(value)
  )
}

export async function revealDesktopBotWorkspaceRecovery(): Promise<void> {
  const workspace = await BotSharedWorkspace.reference(directory())
  const container = dirname(workspace.path)
  if (!(await lstat(container)).isDirectory() || (await realpath(container)) !== container)
    throw new Error("共享工作目录位置已变化")
  const error = await shell.openPath(container)
  if (error) throw new Error(error)
}
