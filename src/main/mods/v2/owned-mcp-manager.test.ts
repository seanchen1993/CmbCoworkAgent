import { afterEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModControlStore } from "../control-store"
import type { CapabilitySource } from "../../mcp/capability-service"
import { withFunctionExecution } from "./execution-context"
import { compileFunctionPlugin } from "./loader"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"

const sources = vi.hoisted(() => new Map<string, { digest: string; source: CapabilitySource }>())
vi.mock("../../mcp/capability-service", async original => ({
  ...await original<typeof import("../../mcp/capability-service")>(),
  resolveSelectedMcpSource: (id: string, digest: string) => {
    const source = sources.get(id)
    if (!source || source.digest !== digest) throw Error("MODS_MCP_SOURCE_CHANGED")
    return source.source
  }
}))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  sources.clear()
})

async function fixture(trial = false) {
  const root = await mkdtemp(join(tmpdir(), "owned-mcp-vm-"))
  const plugin = join(root, "plugin")
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true })
  await mkdir(join(plugin, "hooks"))
  await writeFile(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({
    name: "owned-mcp", version: "1.0.0", cmbCompatibility: { modelProtocol: "legacy-v1" }
  }))
  await writeFile(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(join(plugin, "hooks/register.ts"), `export function register(on){
    let server;
    on("session.start",async($,e,next)=>{await $.command.register({name:"lease",description:"Lease"});return next(e)});
    on("command.run",{command:"lease"},async($,e)=>{
      if(e.args==="list")return {text:JSON.stringify(await $.mcp.list())};
      if(e.args==="status")return {text:JSON.stringify(await $.mcp.status({server}))};
      if(e.args==="disconnect")return {text:JSON.stringify(await $.mcp.disconnect({server}))};
      const connected=await $.mcp.connect("selected");if(connected.isConnected)server=connected.server;
      return {text:JSON.stringify(connected)};
    })
  }`)
  const serverPath = resolve("tests/support/native-flow-mcp-server.mjs")
  const trialServerPath = join(root, "trial-server.mjs")
  if (trial) await writeFile(trialServerPath, `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(join(root, "server-pids"))}, process.pid + "\\n");
    await import(${JSON.stringify(pathToFileURL(serverPath).href)});
  `)
  sources.set("selected", { digest: "proof", source: {
    kind: "connector", providerKey: "selected", providerDisplayName: "Selected",
    priority: 100, scope: "global", visibility: "eager", serverConfig: {
      transport: "stdio", command: process.execPath,
      args: [trial ? trialServerPath : serverPath, join(root, "journal"), "selected"]
    }
  } })
  const store = new ModControlStore(join(root, "control.sqlite"))
  let selected = true
  const manager = new FunctionModsManager(store, {
    plugins: () => trial ? [] : [{ id: "source", name: "owned-mcp", path: plugin, enabled: true }],
    enabled: () => true, changed: () => {}, publish: async (_, value) => value,
    selectedMcpSources: () => selected ? [{ id: "selected", name: "Selected", digest: "proof" }] : [],
    captureSiteGuard: () => () => {}
  }, () => {
    const guests = new Set<FunctionGuestRuntime>()
    return {
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.add(guest); return guest
      },
      stop() { for (const guest of guests) void guest.dispose() },
      async stopAndDrain() { await Promise.all([...guests].map(guest => guest.dispose())) }
    }
  })
  cleanups.push(async () => {
    await manager.closeThreadAndWait("one")
    await manager.closeThreadAndWait("two")
    manager.close()
    store.close()
    const actual = await realpath(root)
    if (dirname(actual) !== await realpath(tmpdir()) || !/^owned-mcp-vm-[A-Za-z0-9]{6}$/.test(basename(actual)))
      throw Error("TEST_CLEANUP_SCOPE")
    await rm(actual, { recursive: true, force: true })
  })
  const scope = { workspace: root, threadId: "one",
    incarnation: { token: "mcp-trial-incarnation", legacyCreatedAt: 1 } }
  const componentId = "mcp-trial"
  if (trial) {
    manager.configureDevelopmentAccess({ assertScope: value => {
      if (value.workspace !== root || value.threadId !== scope.threadId ||
        value.incarnation.token !== scope.incarnation.token) throw Error("TEST_SCOPE_CHANGED")
    } })
    const compiled = await compileFunctionPlugin(plugin)
    const revision = {
      componentId, draftId: "mcp-draft", revision: 1, bundleDigest: "a".repeat(64),
      compiledDigest: compiled.digest, sourcePath: plugin, turnId: "creator-turn",
      validation: "authorized-real" as const,
      capabilities: ["command.register", "event:session.start", "event:command.run",
        "mcp.list", "mcp.connect", "mcp.status", "mcp.disconnect"]
    }
    manager.stageDevelopment(scope, revision, () => assertFunctionSourcesCurrent(compiled))
    expect(manager.developmentStatus(scope)[0]?.phase).toBe("needs-approval")
    expect(manager.mcpConnections(root, "one").connections).toEqual([])
    manager.approveDevelopment(scope, componentId, compiled.digest, revision.capabilities, () => {})
    manager.noteDevelopmentTurnSettled(scope, revision.turnId, "completed")
    await vi.waitFor(() => {
      const status = manager.developmentStatus(scope)[0]
      expect(status?.phase, status?.error).toBe("active")
    })
  } else {
    const [status] = await manager.status(root)
    await manager.approve(root, "source", status.digest!)
  }
  const run = async (threadId: string, args: string) => {
    const [command] = await manager.commands(root, threadId)
    return withFunctionExecution({ workspace: root, threadId, turnId: `command-${threadId}`,
      leased: true, immediate: false, userInitiated: true }, async () =>
      JSON.parse(String((await manager.runCommand(root, threadId, command, args,
        new AbortController().signal)).text)))
  }
  return { root, store, manager, run, scope, componentId, deselect: () => { selected = false } }
}

it("uses production-default QuickJS SDK and persisted source grants; turn completion retains only its own lease", async () => {
  const f = await fixture()
  expect(await f.run("one", "list")).toMatchObject({ connections: [], sources: [{ sourceId: "selected" }] })
  const first = await f.run("one", "connect")
  expect(first.isConnected).toBe(true)
  const turnSignal = new AbortController().signal
  await f.manager.turnStart(f.root, "one", { text: "A real turn", turnId: "turn" },
    turnSignal)
  await f.manager.turnComplete(f.root, "one", { turnId: "turn", answer: "Done", durationMs: 1,
    isAborted: false, reason: "answer" }, turnSignal)
  expect(await f.run("one", "status")).toMatchObject({ state: "connected", server: first.server })
  const second = await f.run("two", "connect")
  expect(second.server).not.toBe(first.server)
  const one = f.manager.mcpConnections(f.root, "one").connections[0]
  await expect(f.manager.mcpDisconnect(f.root, "two", one.owner, first.server)).rejects.toThrow()
  expect(await f.run("one", "disconnect")).toMatchObject({ state: "closed" })
  expect(await f.run("two", "status")).toMatchObject({ state: "connected" })
  f.deselect()
  await vi.waitFor(() => expect(f.manager.mcpConnections(f.root, "two").connections[0].state).toBe("closed"),
    { timeout: 3_000 })
}, 30_000)

it("keeps an authorized-real draft lease usable across calls and native settings without installed grants, then drains on trial stop", async () => {
  const f = await fixture(true)
  const assertNoInstalledGrants = () => {
    expect(f.store.getGrant(f.root, "function:owned-mcp")).toBeNull()
    const database = new DatabaseSync(join(f.root, "control.sqlite"), { readOnly: true })
    try {
      expect(database.prepare("SELECT count(*) AS n FROM mods_grants").get()?.n).toBe(0)
    } finally { database.close() }
  }
  assertNoInstalledGrants()
  expect(await f.manager.status(f.root)).toEqual([])
  expect(await f.run("one", "list")).toMatchObject({ connections: [], sources: [{ sourceId: "selected" }] })
  const first = await f.run("one", "connect")
  expect(first.isConnected).toBe(true)
  assertNoInstalledGrants()
  // Each run has finished its request-local development authority before the next one starts.
  expect(await f.run("one", "status")).toMatchObject({ state: "connected", server: first.server })
  const entry = f.manager.mcpConnections(f.root, "one").connections[0]
  expect(entry).toMatchObject({ state: "connected", server: first.server, sourceId: "selected" })
  const disconnected = await f.manager.mcpDisconnect(f.root, "one", entry.owner, first.server)
  expect(disconnected.connections).toContainEqual(expect.objectContaining({
    server: first.server, state: "closed"
  }))
  expect(await f.run("one", "status")).toMatchObject({ state: "closed" })
  const second = await f.run("one", "connect")
  expect(second.isConnected).toBe(true)
  expect(second.server).not.toBe(first.server)
  await f.manager.stopDevelopment(f.scope, f.componentId, () => {})
  expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("stopped")
  expect(f.manager.developmentRetention(f.scope).releasable).toBe(true)
  expect(f.manager.mcpConnections(f.root, "one").connections).toEqual([])
  await expect(f.manager.mcpDisconnect(f.root, "one", entry.owner, second.server)).rejects.toThrow()
  expect(await f.manager.commands(f.root, "one")).toEqual([])
  const pids = (await readFile(join(f.root, "server-pids"), "utf8")).trim().split("\n").map(Number)
  expect(pids).toHaveLength(2)
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  assertNoInstalledGrants()
}, 30_000)
