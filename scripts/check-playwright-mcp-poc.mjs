import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const port = process.env.CMB_BROWSER_CDP_PORT?.trim() || "9222"
const endpoint = `http://127.0.0.1:${port}`
let failed = false

try {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const targets = await response.json()
  const pages = Array.isArray(targets)
    ? targets.filter((target) => target && typeof target === "object" && target.type === "page")
    : []

  console.log(`CDP endpoint: OK (${endpoint})`)
  if (pages.length === 0) {
    console.error("CDP page targets: missing. Confirm that the Electron app finished starting.")
    failed = true
  } else {
    console.log("CDP page targets:")
    for (const [index, page] of pages.entries()) {
      console.log(`  ${index}: ${page.title || "(untitled)"} ${page.url || ""}`.trimEnd())
    }
    if (pages.some((page) => !page.url)) {
      console.error(
        "CDP page targets: an empty URL target is still initializing and will block Playwright."
      )
      failed = true
    }
  }
} catch (error) {
  console.error(`CDP endpoint: unavailable (${endpoint})`)
  console.error(
    "Quit every running CMBDevClaw instance, then start npm run dev:playwright-mcp-poc."
  )
  console.error(`Reason: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
}

const connectorPath = join(homedir(), ".cmbcoworkagent", "mcp-connectors.json")
try {
  const connectors = JSON.parse(await readFile(connectorPath, "utf8"))
  const enabled = Array.isArray(connectors)
    ? connectors.filter((connector) => connector?.enabled)
    : []
  const playwright = enabled.find(
    (connector) =>
      Array.isArray(connector?.args) &&
      connector.args.some((arg) => typeof arg === "string" && arg.includes("@playwright/mcp"))
  )
  const browserUse = enabled.find(
    (connector) =>
      Array.isArray(connector?.args) &&
      connector.args.some((arg) => typeof arg === "string" && arg.includes("browser-use"))
  )

  if (playwright) {
    console.log(`Playwright MCP connector: OK (${playwright.name})`)
  } else {
    console.error("Playwright MCP connector: missing or disabled")
    failed = true
  }
  if (browserUse) {
    console.error(`Browser Use MCP connector: still enabled (${browserUse.name})`)
    failed = true
  } else {
    console.log("Browser Use MCP connector: disabled")
  }
} catch (error) {
  console.error(
    `MCP connector check failed: ${error instanceof Error ? error.message : String(error)}`
  )
  failed = true
}

process.exitCode = failed ? 1 : 0
