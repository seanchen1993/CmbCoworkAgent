import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import {
  botBrowserMaintenanceRequest,
  botBrowserMaintenanceResult
} from "../../shared/bot-browser-maintenance"
import { listBotBrowserCheckpoints } from "./browser-maintenance"
import { runDesktopMaintenanceWorker } from "./desktop-maintenance-worker"

const directory = () => join(getCmbCoworkAgentDataRoot(), "bot-host")
export const listDesktopBotBrowserCheckpoints = () => listBotBrowserCheckpoints(directory())
export async function executeDesktopBotBrowserMaintenance(untrusted: unknown) {
  const input = botBrowserMaintenanceRequest.parse(untrusted)
  return runDesktopMaintenanceWorker("bot-browser-maintenance", directory(), input, (value) =>
    botBrowserMaintenanceResult.parse(value)
  )
}
