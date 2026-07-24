import { parseMcpImportConfig, buildMcpImportOperations } from "../mcp/config-import"
import { getMcpConnectors, upsertMcpConnector } from "../storage"

const REMOTE_DEBUGGING_PORT_SWITCH = "remote-debugging-port"
const DEFAULT_CDP_PORT = 7777
const PLAYWRIGHT_MCP_NAME = "In-app-browser"

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
  // VITE_IN_APP_BROWSER_CDP_ENABLED=0 in .env disables CDP.
  const enabled = readCdpEnv("VITE_IN_APP_BROWSER_CDP_ENABLED", env)
  if (enabled === "0") return null
  return parseBrowserCdpPort(readCdpEnv("VITE_IN_APP_BROWSER_CDP_PORT", env)) ?? DEFAULT_CDP_PORT
}

// Read a VITE_ config key from the explicit env object, falling back to
// import.meta.env only when the caller uses the default process.env (i.e. at
// runtime). Tests pass their own env objects and must not be affected by .env.
function readCdpEnv(key: string, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env[key]?.trim()
  if (explicit) return explicit
  if (env !== process.env) return undefined
  return metaEnv(key)
}

function metaEnv(key: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (import.meta as any).env?.[key]?.trim() || undefined
  } catch {
    return undefined
  }
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

export async function autoRegisterPlaywrightMcpConnector(cdpPort: number | null): Promise<void> {
  if (cdpPort === null) return

  const existing = getMcpConnectors()
  if (existing.some((c) => c.name.trim().toLowerCase() === PLAYWRIGHT_MCP_NAME.toLowerCase())) return

  const rawJson = JSON.stringify({
    mcpServers: {
      [PLAYWRIGHT_MCP_NAME]: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", `--cdp-endpoint=http://127.0.0.1:${cdpPort}`]
      }
    }
  })

  const parsed = parseMcpImportConfig({ rawJson, autoEnable: true })
  for (const op of buildMcpImportOperations({
    parsed: parsed.connectors,
    existingConnectors: existing,
    conflictStrategy: "skip"
  })) {
    if (op.action === "create" || op.action === "update") {
      upsertMcpConnector(op.connector)
      console.info(`[Main] Auto-registered Playwright MCP connector on port ${cdpPort}.`)
      return
    }
  }
}
