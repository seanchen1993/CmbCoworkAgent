/**
 * Configuration for the remote HTTP API gateway.
 *
 * Read from process.env at startup. Env var names are deliberately NOT
 * `VITE_`-prefixed: VITE_ vars get bundled into the renderer, which would leak
 * the token into client code.
 *
 * Posture on this (security-test) build:
 *  - The gateway is ON by default — launching the app starts it, so a remote
 *    client (e.g. Postman) can reach it at http://<machine-ip>:<port> with no
 *    setup. Set CMB_API_ENABLED=0 to turn it off.
 *  - A token is OPTIONAL. If CMB_API_TOKEN is set, every request must carry it
 *    (Authorization: Bearer <token>); if unset, the gateway runs OPEN (no auth).
 *
 * WARNING: with no token, anyone who can reach the port can drive the agent —
 * API threads bypass all tool approvals (arbitrary code/file access on this
 * machine). The startup log states which mode is active.
 */

export interface ApiGatewayConfig {
  /** Whether the gateway starts. On by default; CMB_API_ENABLED=0 disables. */
  enabled: boolean
  host: string
  port: number
  /** Bearer token. Empty string means auth is OFF (open access). */
  token: string
}

const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 8765

function truthy(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

function parsePort(value: string | undefined): number {
  const n = value ? Number.parseInt(value.trim(), 10) : NaN
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

export function readApiGatewayConfig(env: NodeJS.ProcessEnv = process.env): ApiGatewayConfig {
  const enabledRaw = env.CMB_API_ENABLED
  return {
    // Default ON: unset (or empty) means enabled. Any explicit falsy value off.
    enabled: enabledRaw === undefined || enabledRaw.trim() === "" ? true : truthy(enabledRaw),
    host: env.CMB_API_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.CMB_API_PORT),
    token: env.CMB_API_TOKEN?.trim() || ""
  }
}

/**
 * Reason the gateway must NOT start, or null when cleared. Now that a token is
 * optional, the only blocker is being explicitly disabled.
 */
export function apiGatewayStartBlockReason(config: ApiGatewayConfig): string | null {
  if (!config.enabled) return "disabled via CMB_API_ENABLED"
  return null
}
