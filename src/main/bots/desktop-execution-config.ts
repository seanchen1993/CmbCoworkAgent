import { app } from "electron"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { getWindowsSandboxMode } from "../storage"
import type { BotExecutionConfig } from "./shell-contract"

export function desktopBotExecutionConfig(): BotExecutionConfig {
  const roots = [resolve(__dirname, "../../resources"), join(app.getAppPath(), "resources")]
  const resourceDirectory = app.isPackaged
    ? process.resourcesPath
    : (roots.find((root) => existsSync(join(root, "bin"))) ?? roots[0])
  return { resourceDirectory, windowsSandbox: getWindowsSandboxMode() }
}
