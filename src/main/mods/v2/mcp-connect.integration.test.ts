import { existsSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import type { McpConnectAdmission, McpConnectOwner } from "../../mcp/capability-types"

const fixture = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{
    id: string
    name: string
    path: string
    enabled: boolean
    mcpServerCount: number
  }>
}))
vi.mock("../../storage", () => ({
  getEnabledMcpConnectors: () => [],
  getPlugins: () => fixture.plugins,
  getUserInfo: () => ({}),
  getOpenworkDir: () => fixture.root,
  parseMcpJsonFile: (path: string) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).mcpServers : null
}))
vi.mock("../manager", () => ({
  getModsManager: () => null,
  authorizeCurrentModInput: async () => {}
}))
import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService
} from "../../mcp/capability-service"
import { readClawMcpSources, restrictClawMcpService } from "../claw-mcp"
import { resolveFunctionMcpTool } from "./mcp-sdk"

const prefix = "mods-mcp-connect-"
const gates: string[] = []
const pending: Promise<unknown>[] = []
interface JournalRow {
  event: "boot" | "ready" | "call" | "closed"
  revision: string
  pid: number
  text?: string
}

function records(): JournalRow[] {
  const path = join(fixture.root, "journal.jsonl")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as JournalRow)
}

async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 8_000
  while (!check()) {
    if (Date.now() >= until) throw Error("MCP fixture stage did not complete")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function track<T>(value: Promise<T>): Promise<T> {
  pending.push(value)
  void value.catch(() => {})
  return value
}

afterEach(async () => {
  const failures: unknown[] = []
  const attempt = async (run: () => unknown | Promise<unknown>) => {
    try { await run() } catch (reason) { failures.push(reason) }
  }
  for (const path of gates.splice(0)) await attempt(() => writeFile(path, "release"))
  await attempt(() => Promise.allSettled(pending.splice(0)))
  await attempt(() => closeGlobalMcpCapabilityService())
  fixture.plugins = []
  const root = fixture.root
  fixture.root = ""
  if (root) await attempt(async () => {
    const absolute = resolve(root)
    if (dirname(absolute) !== resolve(tmpdir()) || !absolute.split(/[\\/]/).at(-1)?.startsWith(prefix))
      throw Error("Refusing cleanup outside the owned MCP fixture")
    await rm(absolute, { recursive: true, force: true })
  })
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "MCP fixture cleanup failed", {
    cause: failures[0]
  })
})

async function setup() {
  fixture.root = await mkdtemp(join(tmpdir(), prefix))
  const script = join(fixture.root, "server.mjs")
  const sdk = resolve("node_modules/@modelcontextprotocol/sdk/dist/esm")
  // The real protocol server holds its initialize response until the owned gate opens.
  await writeFile(script, `
import { appendFileSync, existsSync } from "node:fs"
import { Server } from ${JSON.stringify(pathToFileURL(join(sdk, "server/index.js")).href)}
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(sdk, "server/stdio.js")).href)}
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(pathToFileURL(join(sdk, "types.js")).href)}
const [journal, revision, gate, stop, mode] = process.argv.slice(2)
const record = entry => appendFileSync(journal, JSON.stringify({ pid: process.pid, revision, ...entry }) + "\\n")
const server = new Server({ name: "mods-connect-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mode === "empty" ? [] : [
  { name: "echo", description: "Fixture echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  const text = request.params.arguments?.text
  if (request.params.name !== "echo" || typeof text !== "string") throw Error("Invalid fixture request")
  record({ event: "call", text })
  return { content: [{ type: "text", text: revision + ":" + text }], structuredContent: { revision, text } }
})
server.oninitialized = () => record({ event: "ready" })
record({ event: "boot" })
while (gate !== "-" && !existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 20))
await server.connect(new StdioServerTransport())
const timer = setInterval(async () => {
  if (!existsSync(stop)) return
  clearInterval(timer)
  await server.close()
  record({ event: "closed" })
  process.exit(0)
}, 20)
`)
  const owner = async (id = "fixture") => {
    const path = join(fixture.root, id)
    await mkdir(path)
    fixture.plugins.push({ id, name: id, path, enabled: true, mcpServerCount: 1 })
    return { pluginId: id, sourcePath: path, root: realpathSync(path) } satisfies McpConnectOwner
  }
  const configure = async (
    target: McpConnectOwner, revision: string,
    options: { held?: boolean; empty?: boolean } = {}
  ) => {
    const gate = join(fixture.root, `${revision}.release`)
    if (options.held) gates.push(gate)
    const stop = join(fixture.root, `${revision}.stop`)
    await writeFile(join(target.sourcePath, ".mcp.json"), JSON.stringify({ mcpServers: {
      own: { command: process.execPath, args: [script, join(fixture.root, "journal.jsonl"),
        revision, options.held ? gate : "-", stop, options.empty ? "empty" : "echo"] }
    } }))
    return { gate, stop }
  }
  const service = getGlobalMcpCapabilityService()
  const connect = (target: McpConnectOwner, signal = new AbortController().signal) => {
    if (!service.connectPluginServer) throw Error("Native MCP connect is unavailable")
    return track(service.connectPluginServer(target, "own", signal, () => signal.throwIfAborted()))
  }
  return { service, owner, configure, connect }
}

it("connects an own manifest server once and uses its canonical key for a real call", async () => {
  const f = await setup()
  const owner = await f.owner()
  await f.configure(owner, "original")
  const connected = await f.connect(owner)
  expect(connected.value).toEqual({ isConnected: true, server: "plugin:fixture/own" })
  connected.assertCurrent()
  expect((await f.connect(owner)).value).toEqual(connected.value)
  const tool = resolveFunctionMcpTool(await f.service.listTools(), "plugin:fixture/own", "echo")
  const result = await f.service.invoke(tool.capabilityId, { text: "native-call" })
  expect(result.raw).toMatchObject({
    content: [{ type: "text", text: "original:native-call" }],
    structuredContent: { revision: "original", text: "native-call" }
  })
  expect(records().filter(row => row.event === "ready")).toHaveLength(1)
  expect(records().filter(row => row.event === "call").map(row => row.text)).toEqual(["native-call"])
}, 30_000)

it("denies unlisted, mismatched-owner and Claw-unselected servers before initialization", async () => {
  const f = await setup()
  const owner = await f.owner()
  await f.configure(owner, "selected")
  const other = await f.owner("other")
  await f.configure(other, "other")
  const signal = new AbortController().signal
  expect((await f.service.connectPluginServer!(owner, "not-owned", signal, () => {})).value)
    .toMatchObject({ isConnected: false, reason: "unlisted" })
  expect((await f.connect({ ...owner, root: other.root })).value)
    .toMatchObject({ isConnected: false, reason: "unlisted" })
  const selected = readClawMcpSources().filter(entry => entry.id === "plugin:other/own")
  const restricted = restrictClawMcpService(f.service, { mode: "selected", items: selected })
  expect((await restricted.connectPluginServer!(owner, "own", signal, () => {})).value)
    .toMatchObject({ isConnected: false, reason: "policy" })
  fixture.plugins[0].enabled = false
  expect((await f.connect(owner)).value).toMatchObject({ isConnected: false, reason: "disabled" })
  expect(records()).toEqual([])
}, 30_000)

it("keeps same-name plugin servers distinct and accepts a real connection with zero tools", async () => {
  const f = await setup()
  const first = await f.owner("first")
  const second = await f.owner("second")
  await f.configure(first, "first", { empty: true })
  await f.configure(second, "second")
  const empty = await f.connect(first)
  expect(empty.value).toEqual({ isConnected: true, server: "plugin:first/own" })
  empty.assertCurrent()
  const full = await f.connect(second)
  expect(full.value).toEqual({ isConnected: true, server: "plugin:second/own" })
  const tools = await f.service.listTools()
  expect(tools.filter(tool => tool.providerKey === "plugin:first/own")).toEqual([])
  const tool = resolveFunctionMcpTool(tools, "plugin:second/own", "echo")
  expect((await f.service.invoke(tool.capabilityId, { text: "second-only" })).text)
    .toContain("second:second-only")
  expect(() => resolveFunctionMcpTool(tools, "plugin:first/own", "echo"))
    .toThrow("MODS_MCP_TOOL_UNAVAILABLE")
  expect(records().filter(row => row.event === "ready").map(row => row.revision).sort())
    .toEqual(["first", "second"])
}, 30_000)

it.each(["invalidate", "configuration"] as const)(
  "rejects a real held initialization after %s and never publishes the stale candidate",
  async change => {
    const f = await setup()
    const owner = await f.owner()
    const held = await f.configure(owner, "held", { held: true })
    const result = f.connect(owner)
    await waitFor(() => records().some(row => row.event === "boot" && row.revision === "held"))
    if (change === "invalidate") await f.service.invalidate("fixture-held-initialize")
    else await f.configure(owner, "replacement")
    await writeFile(held.gate, "release")
    await expect(result).rejects.toThrow("MODS_MCP_CONTEXT_EXPIRED")
    expect(f.service.peekTools?.()).toBeNull()
    expect(records().filter(row => row.event === "call")).toEqual([])
    const next = await f.connect(owner)
    expect(next.value).toEqual({ isConnected: true, server: "plugin:fixture/own" })
    next.assertCurrent()
    const tool = resolveFunctionMcpTool(await f.service.listTools(), "plugin:fixture/own", "echo")
    const revision = change === "invalidate" ? "held" : "replacement"
    expect((await f.service.invoke(tool.capabilityId, { text: "recovered" })).text)
      .toContain(`${revision}:recovered`)
    expect(records().filter(row => row.event === "call").map(row => row.revision))
      .toEqual([revision])
  }, 30_000
)

it("cancels one caller without closing another borrower's real connection", async () => {
  const f = await setup()
  const owner = await f.owner()
  await f.configure(owner, "borrowed")
  const controller = new AbortController()
  const cancelled = await f.connect(owner, controller.signal)
  const other = await f.connect(owner)
  controller.abort()
  expect(() => cancelled.assertCurrent()).toThrow()
  other.assertCurrent()
  const tool = resolveFunctionMcpTool(await f.service.listTools(), "plugin:fixture/own", "echo")
  expect((await f.service.invoke(tool.capabilityId, { text: "still-live" })).text)
    .toContain("borrowed:still-live")
  expect(records().filter(row => row.event === "ready")).toHaveLength(1)
  expect(records().filter(row => row.event === "closed")).toEqual([])
}, 30_000)

it("does not label a cached but disconnected real client as connected", async () => {
  const f = await setup()
  const owner = await f.owner()
  const control = await f.configure(owner, "disconnect")
  const first: McpConnectAdmission = await f.connect(owner)
  await writeFile(control.stop, "stop")
  await waitFor(() => records().some(row => row.event === "closed"))
  await waitFor(() => {
    try { first.assertCurrent(); return false } catch { return true }
  })
  expect((await f.connect(owner)).value).toMatchObject({ isConnected: false, reason: "failed" })
  await f.service.invalidate("fixture-disconnected")
  await unlink(control.stop)
  const recovered = await f.connect(owner)
  expect(recovered.value).toEqual({ isConnected: true, server: "plugin:fixture/own" })
  recovered.assertCurrent()
}, 30_000)
