import { getMcpConnectors, upsertMcpConnector } from "../../storage"
import {
  BUILTIN_BROWSER_LOG_PREFIX,
  type BrowserCdpConfig
} from "../../../shared/browser-types"
import { getCurrentBrowserCdpPort, resolveBrowserCdpPort } from "./browser-cdp"

const PLAYWRIGHT_MCP_NAME = "In-app-browser"
const BROWSER_MAIN_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[Main]`

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
    console.info(`${BROWSER_MAIN_LOG_PREFIX} Disabled Playwright MCP connector because Browser CDP is turned off.`)
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
    `${BROWSER_MAIN_LOG_PREFIX} ${existing ? "Synced" : "Auto-registered"} Playwright MCP connector on port ${cdpPort}.`
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
      `${BROWSER_MAIN_LOG_PREFIX} Synced Playwright MCP connector disabled state from Browser CDP config.`
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
      `${BROWSER_MAIN_LOG_PREFIX} Synced Playwright MCP connector enabled state from Browser CDP config; runtimePort=${connectorPort}, desiredPort=${desiredPort}.`
    )
  }

  return { invalidateCapabilities: runtimePort !== null }
}
