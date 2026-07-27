import { getBrowserCdpConfig, getMcpConnectors, upsertMcpConnector } from "../../storage"
import { DEFAULT_BROWSER_CDP_PORT, type BrowserCdpConfig } from "../../../shared/browser-types"

const REMOTE_DEBUGGING_PORT_SWITCH = "remote-debugging-port"
const PLAYWRIGHT_MCP_NAME = "In-app-browser"
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

function findManagedPlaywrightMcpConnector() {
  return getMcpConnectors().find(
    (connector) => connector.name.trim().toLowerCase() === PLAYWRIGHT_MCP_NAME.toLowerCase()
  )
}

function buildPlaywrightMcpArgs(cdpPort: number): string[] {
  return ["-y", "@playwright/mcp@latest", `--cdp-endpoint=http://127.0.0.1:${cdpPort}`]
}

export async function autoRegisterPlaywrightMcpConnector(cdpPort: number | null): Promise<void> {
  const existing = findManagedPlaywrightMcpConnector()

  if (cdpPort === null) {
    if (!existing || existing.enabled === false) return
    upsertMcpConnector({
      id: existing.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: existing.command?.trim() || "npx",
      args: existing.args ?? [],
      env: existing.env,
      enabled: false,
      lazyLoad: existing.lazyLoad ?? false
    })
    console.info("[Main] Disabled Playwright MCP connector because Browser CDP is turned off.")
    return
  }

  const nextArgs = buildPlaywrightMcpArgs(cdpPort)
  const isAlreadySynced =
    existing?.enabled === true &&
    existing.command?.trim() === "npx" &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(nextArgs)

  if (isAlreadySynced) return

  upsertMcpConnector({
    id: existing?.id,
    name: PLAYWRIGHT_MCP_NAME,
    kind: "stdio",
    command: "npx",
    args: nextArgs,
    env: existing?.env,
    enabled: true,
    lazyLoad: existing?.lazyLoad ?? false
  })
  console.info(
    `[Main] ${existing ? "Synced" : "Auto-registered"} Playwright MCP connector on port ${cdpPort}.`
  )
}

export async function syncPlaywrightMcpConnectorForBrowserCdpConfig(
  config: BrowserCdpConfig
): Promise<{ invalidateCapabilities: boolean }> {
  const existing = findManagedPlaywrightMcpConnector()
  const desiredPort = resolveBrowserCdpPort(config)
  const runtimePort = getCurrentBrowserCdpPort()

  if (desiredPort === null) {
    if (!existing || existing.enabled === false) {
      return { invalidateCapabilities: false }
    }

    upsertMcpConnector({
      id: existing.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: existing.command?.trim() || "npx",
      args: existing.args ?? [],
      env: existing.env,
      enabled: false,
      lazyLoad: existing.lazyLoad ?? false
    })
    console.info(
      "[Main] Synced Playwright MCP connector disabled state from Browser CDP config."
    )
    return { invalidateCapabilities: true }
  }

  const connectorPort = runtimePort ?? desiredPort
  const nextArgs = buildPlaywrightMcpArgs(connectorPort)
  const isAlreadySynced =
    existing?.enabled === true &&
    existing.command?.trim() === "npx" &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(nextArgs)

  if (!isAlreadySynced) {
    upsertMcpConnector({
      id: existing?.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: "npx",
      args: nextArgs,
      env: existing?.env,
      enabled: true,
      lazyLoad: existing?.lazyLoad ?? false
    })
    console.info(
      `[Main] Synced Playwright MCP connector enabled state from Browser CDP config; runtimePort=${connectorPort}, desiredPort=${desiredPort}.`
    )
  }

  return { invalidateCapabilities: runtimePort !== null }
}
