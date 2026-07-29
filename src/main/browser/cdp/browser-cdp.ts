import { getBrowserCdpConfig } from "../../storage"
import { DEFAULT_BROWSER_CDP_PORT, type BrowserCdpConfig } from "../../../shared/browser-types"

const REMOTE_DEBUGGING_PORT_SWITCH = "remote-debugging-port"
let activeBrowserCdpPort: number | null | undefined

interface BrowserCdpCommandLine {
  appendSwitch(name: string, value: string): void
}

function parseBrowserCdpPort(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Browser CDP port must be an integer between 1 and 65535")
  }
  return value
}

export function resolveBrowserCdpPort(
  config: Partial<BrowserCdpConfig> | null | undefined = getBrowserCdpConfig()
): number | null {
  if (config?.enabled === false) return null
  return parseBrowserCdpPort(config?.port) ?? DEFAULT_BROWSER_CDP_PORT
}

export function getCurrentBrowserCdpPort(): number | null {
  if (activeBrowserCdpPort !== undefined) return activeBrowserCdpPort
  return DEFAULT_BROWSER_CDP_PORT
}

export function configureBrowserCdpEndpoint(
  commandLine: BrowserCdpCommandLine,
  config: Partial<BrowserCdpConfig> | null | undefined = getBrowserCdpConfig()
): number | null {
  const port = resolveBrowserCdpPort(config)
  activeBrowserCdpPort = port
  if (port === null) return null

  commandLine.appendSwitch(REMOTE_DEBUGGING_PORT_SWITCH, String(port))
  return port
}
