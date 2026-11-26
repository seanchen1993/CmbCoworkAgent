import { dirname, join } from "node:path"
import { getMcpConnectors, upsertMcpConnector } from "../../storage"
import { type BrowserCdpConfig } from "../../../shared/browser-types"
import { getCurrentBrowserCdpPort } from "./browser-cdp"
import { BUILTIN_BROWSER_LOG_PREFIX } from "../../../shared/browser-types"

const PLAYWRIGHT_MCP_NAME = "In-app-browser"
const PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[McpConnector]`
const MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD = false
const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE"

/**
 * Resolve the CLI from the dependency bundled with the app. Resolving the
 * exported package entry first avoids relying on the non-exported `cli.js`
 * subpath while still working from app.asar in packaged Electron builds.
 */
export function resolveBundledPlaywrightMcpCliPath(): string {
  return join(dirname(require.resolve("@playwright/mcp")), "cli.js")
}

function buildManagedPlaywrightMcpEnv(
  existingEnv?: Record<string, string>
): Record<string, string> {
  return {
    ...existingEnv,
    [ELECTRON_RUN_AS_NODE_ENV]: "1"
  }
}

function findManagedPlaywrightMcpConnector() {
  return getMcpConnectors().find(
    (connector) => connector.name.trim().toLowerCase() === PLAYWRIGHT_MCP_NAME.toLowerCase()
  )
}

function buildPlaywrightMcpArgs(cdpPort: number): string[] {
  return [resolveBundledPlaywrightMcpCliPath(), `--cdp-endpoint=http://127.0.0.1:${cdpPort}`]
}

function buildDisabledPlaywrightMcpArgs(existingArgs?: string[]): string[] {
  const cdpEndpoint = existingArgs?.find((arg) => arg.startsWith("--cdp-endpoint="))
  return [resolveBundledPlaywrightMcpCliPath(), ...(cdpEndpoint ? [cdpEndpoint] : [])]
}

function sameArgs(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function getCdpEndpoint(args?: string[]): string | null {
  return (
    args?.find((arg) => arg.startsWith("--cdp-endpoint="))?.slice("--cdp-endpoint=".length) ?? null
  )
}

function isManagedPlaywrightMcpConnectorSynced(
  existing: ReturnType<typeof findManagedPlaywrightMcpConnector>,
  options: { enabled: boolean; args: string[] }
): boolean {
  if (!existing) return false
  return (
    existing.kind === "stdio" &&
    existing.enabled === options.enabled &&
    existing.command?.trim() === process.execPath &&
    sameArgs(existing.args ?? [], options.args) &&
    existing.env?.[ELECTRON_RUN_AS_NODE_ENV] === "1" &&
    (existing.lazyLoad ?? MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD) === MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
  )
}

export async function autoRegisterPlaywrightMcpConnector(cdpPort: number | null): Promise<void> {
  const existing = findManagedPlaywrightMcpConnector()
  console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} startup sync`, {
    runtimePort: cdpPort,
    existingEnabled: existing?.enabled ?? null,
    existingEndpoint: getCdpEndpoint(existing?.args)
  })

  if (cdpPort === null) {
    if (!existing) {
      return
    }
    const nextArgs = buildDisabledPlaywrightMcpArgs(existing.args)
    if (isManagedPlaywrightMcpConnectorSynced(existing, { enabled: false, args: nextArgs })) {
      return
    }
    upsertMcpConnector({
      id: existing.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: process.execPath,
      args: nextArgs,
      env: buildManagedPlaywrightMcpEnv(existing.env),
      enabled: false,
      lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
    })
    console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} connector disabled`)
    return
  }

  const nextArgs = buildPlaywrightMcpArgs(cdpPort)
  if (isManagedPlaywrightMcpConnectorSynced(existing, { enabled: true, args: nextArgs })) {
    console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} connector already synchronized`)
    return
  }

  upsertMcpConnector({
    id: existing?.id,
    name: PLAYWRIGHT_MCP_NAME,
    kind: "stdio",
    command: process.execPath,
    args: nextArgs,
    env: buildManagedPlaywrightMcpEnv(existing?.env),
    enabled: true,
    lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
  })
  console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} connector updated`, {
    endpoint: getCdpEndpoint(nextArgs)
  })
}

export async function syncPlaywrightMcpConnectorForBrowserCdpConfig(
  config: BrowserCdpConfig
): Promise<{ invalidateCapabilities: boolean }> {
  const existing = findManagedPlaywrightMcpConnector()
  const runtimePort = getCurrentBrowserCdpPort()
  console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} settings sync`, {
    configEnabled: config.enabled,
    runtimePort,
    existingEndpoint: getCdpEndpoint(existing?.args)
  })

  if (config.enabled === false) {
    if (!existing) {
      return { invalidateCapabilities: false }
    }
    const nextArgs = buildDisabledPlaywrightMcpArgs(existing.args)
    if (isManagedPlaywrightMcpConnectorSynced(existing, { enabled: false, args: nextArgs })) {
      return { invalidateCapabilities: false }
    }

    upsertMcpConnector({
      id: existing.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: process.execPath,
      args: nextArgs,
      env: buildManagedPlaywrightMcpEnv(existing.env),
      enabled: false,
      lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
    })
    console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} connector disabled from settings`)
    return { invalidateCapabilities: true }
  }

  // A changed setting takes effect only after restart. Do not publish a
  // connector endpoint unless this process actually started CDP on that port.
  if (runtimePort === null) {
    console.warn(
      `${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} config enabled but runtime CDP port is missing`
    )
    return { invalidateCapabilities: false }
  }

  const nextArgs = buildPlaywrightMcpArgs(runtimePort)
  const connectorChanged = !isManagedPlaywrightMcpConnectorSynced(existing, {
    enabled: true,
    args: nextArgs
  })
  if (connectorChanged) {
    upsertMcpConnector({
      id: existing?.id,
      name: PLAYWRIGHT_MCP_NAME,
      kind: "stdio",
      command: process.execPath,
      args: nextArgs,
      env: buildManagedPlaywrightMcpEnv(existing?.env),
      enabled: true,
      lazyLoad: MANAGED_PLAYWRIGHT_MCP_LAZY_LOAD
    })
    console.info(`${PLAYWRIGHT_MCP_CONNECTOR_LOG_PREFIX} connector updated from settings`, {
      endpoint: getCdpEndpoint(nextArgs)
    })
  }

  return { invalidateCapabilities: connectorChanged }
}
