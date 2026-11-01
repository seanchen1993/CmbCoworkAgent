import { fork as nodeFork } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { functionUiResolveRuntimeBinding } from "./ui-resolve-runtime-binding"
import { FunctionModuleAdmission } from "./module-admission"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

let directory: string, client: FunctionRuntimeClient
const sessions: FunctionSession[] = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mods-admission-process-"))
  const host = join(directory, "host.cjs")
  await build({
    entryPoints: [resolve("src/main/mods/v2/host-entry.ts")],
    outfile: host,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    banner: {
      js: `module.paths.push(${JSON.stringify(resolve("node_modules"))});
process.parentPort={on:(_event,fn)=>process.on('message',data=>fn({data})),postMessage:value=>process.send(value)};`
    }
  })
  fork.mockImplementation((path: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const childOptions = {
      env: { ...options.env, NODE_PATH: resolve("node_modules") },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"] as ["ignore", "pipe", "pipe", "ipc"]
    }
    const child = nodeFork(path, args, childOptions)
    return Object.assign(child, { postMessage: child.send.bind(child) })
  })
  client = new FunctionRuntimeClient(host)
}, 30000)
afterAll(async () => {
  await Promise.all(sessions.map((value) => value.close(true)))
  client?.stop()
  if (directory) {
    if (
      dirname(directory) !== tmpdir() ||
      !directory.split(/[\\/]/).at(-1)?.startsWith("mods-admission-process-")
    )
      throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = join(directory, crypto.randomUUID())
  await mkdir(join(root, ".claude-plugin"), { recursive: true })
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "native-gate" }))
  await writeFile(
    join(root, "hooks/hooks.json"),
    JSON.stringify({ modules: ["guard.ts", "denied.ts"] })
  )
  await writeFile(
    join(root, "hooks/guard.ts"),
    `export function register(on){
    on("plugin.register",($,e,next)=>e.uses.events.includes("ui.resolve")?{refuse:"no foreign UI"}:next(e))}`
  )
  const descriptor = {
    apiVersion: "devclaw.capability/v1",
    id: "ghost",
    version: "1.0.0",
    title: "ghost",
    scope: "conversation",
    stateSchema: { type: "object" },
    actions: []
  }
  await writeFile(
    join(root, "hooks/denied.ts"),
    `export function register(on){
    on("ui.resolve",($,e,next)=>next(e));
    on.capability(${JSON.stringify(descriptor)},{act:async()=>({})});
    on("ui.render",($,e)=>{const{Client}=$.ui.resolve(e);return Client({key:"ghost",module:"./canvas.ts"})})}`
  )
  await writeFile(join(root, "hooks/canvas.ts"), `export default function Canvas(){return "ghost"}`)
  const compiled = await compileFunctionPlugin(root)
  const original = await client.load(compiled.code, compiled.options)
  const plugin = {
    ...compiled,
    guest: original,
    tier: "user" as const,
    capabilities: [...SESSION_CAPABILITIES]
  }
  return { plugin, original }
}

it("narrows the real native binding and excludes rejected capabilities and VM invocation IDs", async () => {
  const { plugin, original } = await fixture()
  const before = functionUiResolveRuntimeBinding(original)
  const denied = original.registrations.find((row) => row.pattern === "ui.resolve")!
  expect(before.registrations.some((row) => row.id === denied.id)).toBe(true)
  const session = new FunctionSession([plugin], {
    workspace: directory,
    threadId: "native-gate",
    assertLive: () => {},
    publish: async (input) => input
  })
  sessions.push(session)
  await session.start()
  const after = functionUiResolveRuntimeBinding(plugin.guest)
  expect(after.runtimeId).toBe(before.runtimeId)
  expect(after.physical).toBe(before.physical)
  expect(Object.isFrozen(after.registrations)).toBe(true)
  expect(after.registrations.map((row) => row.pattern)).toEqual(["plugin.register"])
  expect(session.platform.list().some((item) => item.ref.id === "ghost")).toBe(false)
  expect(() => plugin.guest.matches(denied.id, {})).toThrow("MODS_MODULE_NOT_ADMITTED")
  expect(() =>
    plugin.guest.invoke(
      denied.id,
      {},
      async () => {
        throw Error("UNEXPECTED_HOST")
      },
      {
        event: "ui.resolve",
        origin: { plugin: "engine", tier: "core" },
        plugin: { name: plugin.name, root: plugin.root },
        capabilities: [...SESSION_CAPABILITIES]
      }
    )
  ).toThrow("MODS_MODULE_NOT_ADMITTED")
})

it("permits only the Client import closure of modules actually admitted", async () => {
  const { plugin } = await fixture()
  const admission = new FunctionModuleAdmission([plugin])
  await admission.run(
    new AbortController().signal,
    async (input) =>
      input.uses.events.includes("ui.resolve") ? { refuse: "no foreign UI" } : { allow: true },
    () => {},
    () => {}
  )
  expect(() => admission.assertClient(plugin.name, "hooks/canvas.ts")).toThrow(
    "MODS_CLIENT_MODULE_NOT_ADMITTED"
  )
  await plugin.guest.dispose()
})
