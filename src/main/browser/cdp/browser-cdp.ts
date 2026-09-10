import { randomInt } from "node:crypto"
import { getBrowserCdpConfig } from "../../storage"
import type { BrowserCdpConfig } from "../../../shared/browser-types"

const REMOTE_DEBUGGING_PORT_SWITCH = "remote-debugging-port"
export const BROWSER_CDP_PORT_MIN = 49_152
export const BROWSER_CDP_PORT_MAX = 65_535
let activeBrowserCdpPort: number | null | undefined

interface BrowserCdpCommandLine {
  appendSwitch(name: string, value: string): void
}

function generateBrowserCdpPort(): number {
  return randomInt(BROWSER_CDP_PORT_MIN, BROWSER_CDP_PORT_MAX + 1)
}

export function configureBrowserCdpEndpoint(
  commandLine: BrowserCdpCommandLine,
  config: Partial<BrowserCdpConfig> | null | undefined = getBrowserCdpConfig()
): number | null {
  if (config?.enabled === false) {
    activeBrowserCdpPort = null
    return null
  }
  const port = activeBrowserCdpPort ?? generateBrowserCdpPort()
  activeBrowserCdpPort = port
  commandLine.appendSwitch(REMOTE_DEBUGGING_PORT_SWITCH, String(port))
  return port
}

export function getCurrentBrowserCdpPort(): number | null {
  return activeBrowserCdpPort ?? null
}
