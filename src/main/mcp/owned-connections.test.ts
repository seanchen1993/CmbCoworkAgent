import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import type { CapabilitySource } from "./capability-service"
import { OwnedMcpConnections } from "./owned-connections"
import type { OwnedMcpTransport } from "./owned-transport"

vi.mock("../mods/manager", () => ({ authorizeCurrentModInput: vi.fn(async () => {}) }))
vi.mock("../mods/adapters", () => ({
  withRawModMcp: (_tool: unknown, args: unknown, run: (input: unknown) => unknown) => run(args),
  publishCurrentModResult: async (value: unknown) => value
}))

const roots: string[] = []
const registries: OwnedMcpConnections[] = []
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close().catch(() => {})))
  for (const root of roots.splice(0)) {
    const actual = realpathSync(root)
    if (dirname(actual) !== realpathSync(tmpdir()) || !/^owned-mcp-[A-Za-z0-9]{6}$/.test(basename(actual)))
      throw Error("TEST_CLEANUP_SCOPE")
    rmSync(actual, { recursive: true, force: true })
  }
})

const script = `const fs=require("node:fs"), rl=require("node:readline").createInterface({input:process.stdin});
if(process.env.PID_FILE)fs.writeFileSync(process.env.PID_FILE,String(process.pid));
let calls=0;rl.on("line",line=>{const q=JSON.parse(line);if(q.id===undefined)return;
let result;if(q.method==="initialize"){if(process.env.HOLD==="1")return;result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}}
else if(q.method==="tools/list")result={tools:process.env.EMPTY==="1"?[]:[{name:"echo",description:"echo",inputSchema:{type:"object",properties:{text:{type:"string"}}}}]};
else if(q.method==="tools/call")result={content:[{type:"text",text:JSON.stringify({args:q.params.arguments,calls:++calls,pid:process.pid})}]};
else result={};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:q.id,result})+"\\n")});
rl.on("close",()=>process.exit(0));`

function fixture(env: Record<string, string> = {}, transport?: (source: CapabilitySource) => OwnedMcpTransport) {
  let current = true
  let ownerCurrent = true
  let digest = "digest-one"
  let selected = true
  const source: CapabilitySource = { kind: "connector", providerKey: "connector-one",
    providerDisplayName: "One", visibility: "eager", priority: 100, scope: "global",
    serverConfig: { transport: "stdio", command: process.execPath, args: ["-e", script], env } }
  const resolve = vi.fn((id: string, expected: string) => {
    if (id !== source.providerKey || expected !== digest) throw Error("MODS_MCP_SOURCE_CHANGED")
    return source
  })
  const registry = new OwnedMcpConnections({
    assertOwner: () => { if (!ownerCurrent) throw Error("MODS_OWNER_CHANGED") },
    assertCurrent: () => { if (!current) throw Error("MODS_SCOPE_CHANGED") },
    sources: () => selected ? [{ id: source.providerKey, name: "One", digest: "digest-one" }] : [],
    resolve, transport
  })
  registries.push(registry)
  return { registry, source, resolve, revoke: () => { current = false },
    replaceOwner: () => { ownerCurrent = false },
    deselect: () => { selected = false }, change: () => { digest = "digest-two" } }
}
const signal = () => new AbortController().signal
async function connect(registry: OwnedMcpConnections) {
  const result = await registry.connect("connector-one", signal())
  expect(result.value.isConnected).toBe(true)
  if (!result.value.isConnected) throw Error("CONNECT_FAILED")
  return result.value.server
}

it("initializes exactly one real stdio source, lists real tools, calls once and disconnects physically", async () => {
  const { registry, resolve } = fixture()
  expect(registry.view().connections).toEqual([])
  expect(resolve).not.toHaveBeenCalled()
  const server = await connect(registry)
  expect(server).toMatch(/^devclaw-mcp:/)
  expect(registry.status(server)).toMatchObject({ state: "connected", toolCount: 1,
    tools: [{ name: "echo", inputSchema: { type: "object" } }] })
  const service = registry.service(server)
  const [tool] = await service.listTools()
  const first = await service.invoke(tool.capabilityId, { text: "hello" })
  expect(JSON.stringify(first)).toContain('hello')
  expect(JSON.stringify(first)).toContain('calls')
  expect(await connect(registry)).toBe(server)
  expect(await registry.disconnect(server)).toMatchObject({ state: "closed" })
  expect(() => registry.service(server).peekTools!()).toThrow("EXPIRED")
  expect((await connect(registry))).not.toBe(server)
})

it("accepts a real server with zero tools without falling back to any global source", async () => {
  const { registry } = fixture({ EMPTY: "1" })
  const server = await connect(registry)
  expect(registry.status(server)).toMatchObject({ state: "connected", toolCount: 0, tools: [] })
  await expect(registry.service(server).invoke("missing", {})).rejects.toThrow("NOT_FOUND")
})

it("aborts a real held initialize and waits for process exit without releasing its handshake", async () => {
  const root = mkdtempSync(join(tmpdir(), "owned-mcp-")); roots.push(root)
  const pidFile = join(root, "pid")
  const { registry } = fixture({ HOLD: "1", PID_FILE: pidFile })
  const controller = new AbortController()
  const pending = registry.connect("connector-one", controller.signal)
  await vi.waitFor(() => expect(Number(readFileSync(pidFile, "utf8"))).toBeGreaterThan(0))
  const pid = Number(readFileSync(pidFile, "utf8"))
  const rejection = expect(pending).rejects.toThrow("CANCELLED")
  controller.abort()
  await rejection
  expect(registry.inspect()[0].state).toBe("closed")
  expect(() => process.kill(pid, 0)).toThrow()
})

it("rejects other owners and changed selection/configuration without global fallback or tool retry", async () => {
  const first = fixture(), other = fixture()
  const server = await connect(first.registry)
  expect(() => other.registry.service(server)).toThrow("NOT_OWNED")
  first.change()
  expect(() => first.registry.status(server)).toThrow("SOURCE_CHANGED")
  await vi.waitFor(() => expect(first.registry.inspect()[0].state).toBe("closed"), { timeout: 3_000 })
  await expect(first.registry.connect("connector-one", signal())).rejects.toThrow("SOURCE_CHANGED")
})

it("coalesces pending initialization but cancels only the caller's waiter", async () => {
  let finish!: (value: []) => void
  const close = vi.fn(async () => true)
  const initialize = vi.fn(() => new Promise<[]>(resolve => { finish = resolve }))
  const { registry } = fixture({}, () => ({ initialize, close, call: vi.fn() }))
  const controller = new AbortController()
  const one = registry.connect("connector-one", controller.signal)
  const two = registry.connect("connector-one", signal())
  const rejected = expect(one).rejects.toThrow("CANCELLED")
  controller.abort(); await rejected
  expect(close).not.toHaveBeenCalled()
  finish([])
  expect((await two).value.isConnected).toBe(true)
  expect(initialize).toHaveBeenCalledTimes(1)
})

it("retains unknown cleanup and refuses reconnect, while retired successful leases do not exhaust live capacity", async () => {
  const transport = () => ({ initialize: async () => [], call: vi.fn(), close: async () => true })
  const normal = fixture({}, transport)
  for (let index = 0; index < 70; index++) {
    const server = await connect(normal.registry)
    await normal.registry.disconnect(server)
  }
  expect(normal.registry.inspect().length).toBeLessThanOrEqual(64)
  const unknown = fixture({}, () => ({ ...transport(), close: async () => false }))
  const server = await connect(unknown.registry)
  expect(await unknown.registry.disconnect(server)).toMatchObject({ state: "unknown" })
  await expect(unknown.registry.connect("connector-one", signal())).rejects.toThrow("UNCONFIRMED")
})

it("refuses unsupported transport policy and missing selections without starting a transport", async () => {
  const remote = fixture()
  remote.source.serverConfig = { transport: "websocket", url: "https://private.invalid/secret" }
  expect((await remote.registry.connect("connector-one", signal())).value)
    .toMatchObject({ isConnected: false, reason: "policy" })
  remote.deselect()
  expect((await remote.registry.connect("connector-one", signal())).value)
    .toMatchObject({ isConnected: false, reason: "unapproved" })
  expect(JSON.stringify(remote.registry.view())).not.toContain("private")
})

it("records an invalid executable as a failed connection with confirmed physical cleanup", async () => {
  const { registry, source } = fixture()
  source.serverConfig.command = "devclaw-nonexistent-mcp-executable-8e9e8f"
  expect((await registry.connect("connector-one", signal())).value)
    .toMatchObject({ isConnected: false, reason: "failed" })
  expect(registry.inspect()[0].state).toBe("failed")
})

it("reclaims confirmed natural exits observed by status without exhausting application slots", async () => {
  let exited = false
  const { registry } = fixture({}, () => ({ initialize: async () => [], call: vi.fn(),
    isClosed: () => exited, close: async () => true }))
  for (let index = 0; index < 70; index++) {
    exited = false
    const server = await connect(registry)
    exited = true
    expect(registry.status(server).state).toBe("closed")
  }
  expect(registry.inspect()).toHaveLength(64)
})

it("does not project an old account/incarnation's tombstones into a replacement owner", async () => {
  const f = fixture({}, () => ({ initialize: async () => [], call: vi.fn(), close: async () => false }))
  const server = await connect(f.registry)
  await f.registry.disconnect(server)
  expect(f.registry.inspect()).toHaveLength(1)
  f.replaceOwner()
  expect(f.registry.inspect()).toEqual([])
  expect(() => f.registry.status(server)).toThrow("OWNER_CHANGED")
})

it("retires a failed tool call and preserves an unconfirmed cleanup tombstone", async () => {
  const call = vi.fn(async () => { throw Error("MODS_CANCELLED") })
  const close = vi.fn(async () => false)
  const f = fixture({}, () => ({ initialize: async () => [{ name: "echo", inputSchema: {} }],
    call, close }))
  const server = await connect(f.registry)
  const [tool] = await f.registry.service(server).listTools()
  await expect(f.registry.service(server).invoke(tool.capabilityId, {})).rejects.toThrow("CANCELLED")
  expect(f.registry.status(server).state).toBe("unknown")
  await expect(f.registry.connect("connector-one", signal())).rejects.toThrow("UNCONFIRMED")
  expect(call).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
})
