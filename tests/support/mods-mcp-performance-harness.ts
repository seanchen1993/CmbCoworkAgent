import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import type { Plugin } from "esbuild"

export const MCP_PERFORMANCE_ESM_EXTERNAL = {
  from: "vscode-jsonrpc/node",
  to: "vscode-jsonrpc/node.js",
  scope: "MCP test ESM bundle only; same installed dependency and entry in both variants"
} as const

/** Real native Electron exports are required by the complete, unmodified source graph. */
export const MCP_PERFORMANCE_BOOTSTRAP_SOURCE = `const assert = require("node:assert/strict")
const { mkdirSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow } = require("electron")
const profile = join(__dirname, "electron-profile")
mkdirSync(profile, { recursive: true })
app.setPath("userData", profile)
app.commandLine.appendSwitch("disable-gpu")
const observed = { carrier: "real Electron main; no full App/renderer/provider transport", pid: process.pid,
  execPath: process.execPath, versions: process.versions, profile, unexpectedWindows: 0 }
app.on("browser-window-created", () => { observed.unexpectedWindows++ })
const save = () => writeFileSync(join(__dirname, "mcp-host-proof.json"), JSON.stringify(observed, null, 2))
function observe(stage) {
  const metrics = app.getAppMetrics()
  const ownedUtilities = metrics.filter(metric => ["CMB Mods", "CMB Function Mods"].includes(metric.name))
  observed[stage] = { windows: BrowserWindow.getAllWindows().length, ownedUtilities: ownedUtilities.length, metrics }
  save()
  assert.equal(observed[stage].windows, 0, "MCP_UNEXPECTED_WINDOW")
  assert.equal(observed.unexpectedWindows, 0, "MCP_UNEXPECTED_WINDOW_CREATED")
  assert.equal(ownedUtilities.length, 0, "MCP_UNEXPECTED_GUEST_UTILITY")
}
const drain = stream => new Promise((resolve, reject) => stream.write("", error => error ? reject(error) : resolve()))
void (async () => {
  try {
    await app.whenReady()
    observe("before")
    await import(pathToFileURL(join(__dirname, "performance-entry.mjs")).href)
    observed.fixtureImportCompleted = true
    observe("after")
    await drain(process.stdout)
    await drain(process.stderr)
    observed.stdioDrained = true
    save()
    app.exit(0)
  } catch (error) {
    console.error(error)
    observed.failed = true
    observed.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    try { if (app.isReady()) observe("failedAfter"); else save() } catch (diagnosticError) { console.error(diagnosticError) }
    try { await drain(process.stdout); await drain(process.stderr) } catch (drainError) { console.error(drainError) }
    app.exit(1)
  }
})()
`

/** Node ESM requires the extension of this installed package's existing CommonJS shim. */
export function mcpPerformanceEsmExternal(suite: string): Plugin {
  return {
    name: "mcp-performance-node-esm-external",
    setup(builder) {
      if (suite !== "mcp") return
      builder.onResolve({ filter: /^vscode-jsonrpc\/node$/ }, () => ({
        path: MCP_PERFORMANCE_ESM_EXTERNAL.to,
        external: true
      }))
    }
  }
}

export interface McpPerformanceChildOutput {
  code: number | null
  signal: NodeJS.Signals | null
  closeCode: number | null
  closeSignal: NodeJS.Signals | null
  exitObserved: boolean
  stdout: Buffer
  stderr: Buffer
}

/** Only close guarantees that a completed child's stdout and stderr have drained. */
export function collectMcpPerformanceChild(
  child: ChildProcess,
  forward: { stdout(bytes: Buffer): void; stderr(bytes: Buffer): void }
): Promise<McpPerformanceChildOutput> {
  assert(child.stdout && child.stderr, "MCP_CHILD_STDIO_UNAVAILABLE")
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let code: number | null = null
    let signal: NodeJS.Signals | null = null
    let exitObserved = false
    child.stdout!.on("data", (value: Buffer) => {
      const bytes = Buffer.from(value)
      stdout.push(bytes)
      forward.stdout(bytes)
    })
    child.stderr!.on("data", (value: Buffer) => {
      const bytes = Buffer.from(value)
      stderr.push(bytes)
      forward.stderr(bytes)
    })
    child.once("error", reject)
    child.once("exit", (value, reason) => {
      code = value
      signal = reason
      exitObserved = true
    })
    child.once("close", (closeCode, closeSignal) => {
      resolve({
        code,
        signal,
        closeCode,
        closeSignal,
        exitObserved,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      })
    })
  })
}

/** A failed process or malformed output is never a zero-filled timing sample. */
export function mcpPerformanceSamples(output: McpPerformanceChildOutput): number[] {
  assert(
    output.exitObserved &&
      output.code === 0 &&
      output.closeCode === 0 &&
      output.signal === null &&
      output.closeSignal === null,
    `MCP_PERFORMANCE_CHILD_EXIT:${output.code}:${output.signal}:${output.closeCode}:${output.closeSignal}`
  )
  const values: unknown = JSON.parse(output.stdout.toString("utf8"))
  assert(
    Array.isArray(values) &&
      values.length === 100 &&
      values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
    "MCP_PERFORMANCE_TIMINGS_INVALID"
  )
  return values
}
