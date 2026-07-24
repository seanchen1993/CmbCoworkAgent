const REMOTE_DEBUGGING_PORT_SWITCH = "remote-debugging-port"
const DEFAULT_CDP_PORT = 7777

export interface BrowserCdpCommandLine {
  appendSwitch(name: string, value: string): void
}

export function parseBrowserCdpPort(value: string | undefined): number | null {
  const normalized = value?.trim()
  if (!normalized) return null
  if (!/^\d+$/.test(normalized)) {
    throw new Error("VITE_IN_APP_BROWSER_CDP_PORT must be an integer between 1 and 65535")
  }

  const port = Number(normalized)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("VITE_IN_APP_BROWSER_CDP_PORT must be an integer between 1 and 65535")
  }
  return port
}

export function resolveBrowserCdpPort(env: NodeJS.ProcessEnv = process.env): number | null {
  // VITE_IN_APP_BROWSER_CDP_ENABLED=0 in .env disables CDP
  if (env["VITE_IN_APP_BROWSER_CDP_ENABLED"]?.trim() === "0") return null
  return parseBrowserCdpPort(env["VITE_IN_APP_BROWSER_CDP_PORT"]) ?? DEFAULT_CDP_PORT
}

export function configureBrowserCdpEndpoint(
  commandLine: BrowserCdpCommandLine,
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const port = resolveBrowserCdpPort(env)
  if (port === null) return null

  commandLine.appendSwitch(REMOTE_DEBUGGING_PORT_SWITCH, String(port))
  return port
}
