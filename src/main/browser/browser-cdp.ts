const REMOTE_DEBUGGING_PORT_SWITCH = "remote-debugging-port"

export const BROWSER_CDP_PORT_ENV = "CMB_BROWSER_CDP_PORT"

export interface BrowserCdpCommandLine {
  appendSwitch(name: string, value: string): void
}

export function parseBrowserCdpPort(value: string | undefined): number | null {
  const normalized = value?.trim()
  if (!normalized) return null
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${BROWSER_CDP_PORT_ENV} must be an integer between 1 and 65535`)
  }

  const port = Number(normalized)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${BROWSER_CDP_PORT_ENV} must be an integer between 1 and 65535`)
  }
  return port
}

export function configureBrowserCdpEndpoint(
  commandLine: BrowserCdpCommandLine,
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const port = parseBrowserCdpPort(env[BROWSER_CDP_PORT_ENV])
  if (port === null) return null

  commandLine.appendSwitch(REMOTE_DEBUGGING_PORT_SWITCH, String(port))
  return port
}
