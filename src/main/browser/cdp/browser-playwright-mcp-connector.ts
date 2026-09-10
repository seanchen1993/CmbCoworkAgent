import { getMcpConnectors, upsertMcpConnector } from "../../storage"
import {
  BUILTIN_BROWSER_LOG_PREFIX,
  type BrowserCdpConfig
} from "../../../shared/browser-types"
import { getCurrentBrowserCdpPort } from "./browser-cdp"

const PLAYWRIGHT_MCP_NAME = "In-app-browser"
const BROWSER_MAIN_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[Main]`
const MANAGED_PLAYWRIGHT_MCP_COMMAND = "npx"
const MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD = false

function findManagedPlaywrightMcpConnector() {
  return getMcpConnectors().find(
    (connector) => connector.name.trim().toLowerCase() === PLAYWRIGHT_MCP_NAME.toLowerCase()
  )
}

function buildPlaywrightMcpArgs(cdpPort: number): string[] {
  return ["-y", "@playwright/mcp@latest", `--cdp-endpoint=http://127.0.0.1:${cdpPort}`]
}

function sameArgs(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isManagedPlaywrightMcpConnectorSynced(
  existing: ReturnType<typeof findManagedPlaywrightMcpConnector>,
  options: { enabled: boolean; args: string[] }
): boolean {
  if (!existing) return false
  return (
    existing.kind === "stdio" &&
    existing.enabled === options.enabled &&
    existing.command?.trim() === MANAGED_PLAYWRIGHT_MCP_COMMAND &&
    sameArgs(existing.args ?? [], options.args) &&
    (existing.lazyLoad ?? MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD) === MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
  )
}

export async function autoRegisterPlaywrightMcpConnector(cdpPort: number | null): Promise<void> {
  const existing = findManagedPlaywrightMcpConnector()

  if (cdpPort === null) {
    if (!existing) return
    const nextArgs = existing.args ?? []
    if (isManagedPlaywrightMcpConnectorSynced(existing, { enabled: false, args: nextArgs })) return
    upsertMcpConnector({
      id: existing.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: MANAGED_PLAYWRIGHT_MCP_COMMAND,
      args: nextArgs,
      env: existing.env,
      enabled: false,
      lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
    })
    console.info(`${BROWSER_MAIN_LOG_PREFIX} Disabled Playwright MCP connector because Browser CDP is turned off.`)
    return
  }

  const nextArgs = buildPlaywrightMcpArgs(cdpPort)
  if (isManagedPlaywrightMcpConnectorSynced(existing, { enabled: true, args: nextArgs })) return

  upsertMcpConnector({
    id: existing?.id,
    name: PLAYWRIGHT_MCP_NAME,
    kind: "stdio",
    command: MANAGED_PLAYWRIGHT_MCP_COMMAND,
    args: nextArgs,
    env: existing?.env,
    enabled: true,
    lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
  })
  console.info(
    `${BROWSER_MAIN_LOG_PREFIX} ${existing ? "Synced" : "Auto-registered"} Playwright MCP connector on port ${cdpPort}.`
  )
}

export async function syncPlaywrightMcpConnectorForBrowserCdpConfig(
  config: BrowserCdpConfig
): Promise<{ invalidateCapabilities: boolean }> {
  const existing = findManagedPlaywrightMcpConnector()
  const runtimePort = getCurrentBrowserCdpPort()

  if (config.enabled === false) {
    if (!existing) {
      return { invalidateCapabilities: false }
    }
    const nextArgs = existing.args ?? []
    if (isManagedPlaywrightMcpConnectorSynced(existing, { enabled: false, args: nextArgs })) {
      return { invalidateCapabilities: false }
    }

    upsertMcpConnector({
      id: existing.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: MANAGED_PLAYWRIGHT_MCP_COMMAND,
      args: nextArgs,
      env: existing.env,
      enabled: false,
      lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
    })
    console.info(
      `${BROWSER_MAIN_LOG_PREFIX} Synced Playwright MCP connector disabled state from Browser CDP config.`
    )
    return { invalidateCapabilities: true }
  }

  // A changed setting takes effect only after restart. Do not publish a
  // connector endpoint unless this process actually started CDP on that port.
  if (runtimePort === null) {
    return { invalidateCapabilities: false }
  }

  const nextArgs = buildPlaywrightMcpArgs(runtimePort)
  if (!isManagedPlaywrightMcpConnectorSynced(existing, { enabled: true, args: nextArgs })) {
    upsertMcpConnector({
      id: existing?.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: MANAGED_PLAYWRIGHT_MCP_COMMAND,
      args: nextArgs,
      env: existing?.env,
      enabled: true,
      lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
    })
    console.info(
      `${BROWSER_MAIN_LOG_PREFIX} Synced Playwright MCP connector enabled state from Browser CDP config; runtimePort=${runtimePort}.`
    )
  }

  return { invalidateCapabilities: runtimePort !== null }
}
