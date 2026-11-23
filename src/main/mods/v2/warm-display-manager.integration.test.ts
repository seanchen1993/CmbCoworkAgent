import { fork as nodeFork } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { withFunctionMarkdownDisplay } from "./markdown-display-scope"
import { FunctionRuntimeClient } from "./runtime-client"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))

interface HostLaunch {
  empty: boolean
  requests: FunctionRequest["type"][]
  ready: Promise<void>
  exited: Promise<void>
}

const launches: HostLaunch[] = []
const clients: FunctionRuntimeClient[] = []
let directory: string
let hostEntry: string
let manager: FunctionModsManager | undefined
let control: ModControlStore | undefined

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cmb-warm-display-manager-"))
  hostEntry = join(directory, "host.cjs")
  const nodeModules = resolve("node_modules")
  await build({
    entryPoints: [resolve("src/main/mods/v2/host-entry.ts")],
    outfile: hostEntry,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    banner: {
      js: `module.paths.push(${JSON.stringify(nodeModules)});
process.parentPort={on:(_event,fn)=>process.on('message',data=>fn({data})),postMessage:value=>process.send(value)};`
    }
  })
  fork.mockImplementation((entry: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = nodeFork(entry, args, {
      env: { ...options.env, NODE_PATH: nodeModules },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    })
    const launch: HostLaunch = {
      empty: args.includes("--prepare-empty-function-host"),
      requests: [],
      ready: new Promise(resolve => {
        const onMessage = (message: { type?: string }) => {
          if (message.type !== "ready") return
          child.off("message", onMessage)
          resolve()
        }
        child.on("message", onMessage)
      }),
      exited: new Promise(resolve => child.once("exit", () => resolve()))
    }
    launches.push(launch)
    return Object.assign(child, {
      postMessage(request: FunctionRequest) {
        launch.requests.push(request.type)
        return child.send(request)
      }
    })
  })
}, 30_000)

afterEach(async () => {
  manager?.close()
  manager = undefined
  await Promise.all(clients.splice(0).map(client => client.stopAndDrain()))
  await Promise.all(launches.splice(0).map(host => host.exited))
  control?.close()
  control = undefined
})

afterAll(async () => {
  if (!directory) return
  if (dirname(directory) !== tmpdir() || !basename(directory).startsWith("cmb-warm-display-manager-"))
    throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const displayBody = `()=>({type:"Text",props:{},children:["MATCHED BODY"]})`
const assistant = `on("ui.render", {component:"AssistantMessage"}, ${displayBody})`

it.each([
  { title: "a Pane-only Mod in chat", selector: `on("ui.render", {component:"Pane"}, ${displayBody})`,
    usage: "chat" as const, match: false, extra: false },
  { title: "a different transcript site in chat", selector: `on("ui.render", {component:"ToolResult"}, ${displayBody})`,
    usage: "chat" as const, match: false, extra: false },
  { title: "a dynamic no-match in chat", selector: `on("ui.render", input=>input.component === "Pane", ${displayBody})`,
    usage: "chat" as const, match: false, extra: false },
  { title: "a literal AssistantMessage match in a project", selector: assistant,
    usage: "project" as const, match: true, extra: false },
  { title: "a literal AssistantMessage match in ordinary chat", selector: assistant,
    usage: "chat" as const, match: true, extra: true },
  { title: "an ordinary chat invalidated after its protected drawing", selector: assistant,
    usage: "chat" as const, match: true, extra: true, invalidateBeforeRefill: true }
])("uses the expected empty-host budget for $title", async (scenario) => {
  const { selector, usage, match, extra } = scenario
  const workspace = await mkdtemp(join(directory, "case-"))
  const source = join(workspace, "installed")
  await mkdir(join(source, "mods"), { recursive: true })
  await writeFile(join(source, "plugin.json"), JSON.stringify({
    name: "display",
    version: "1.0.0",
    mods: "mods/manifest.json"
  }))
  await writeFile(join(source, "mods/manifest.json"), JSON.stringify({
    apiVersion: "cmb.mods/v2",
    id: "display",
    entry: "main.ts"
  }))
  await writeFile(join(source, "mods/main.ts"), `export function register(on) { ${selector} }`)
  const installed = {
    id: "installed-source", name: "display", path: source, enabled: true, version: "1.0.0",
    description: "", author: "", skillCount: 0, mcpServerCount: 0, hookCount: 0,
    createdAt: "2026-10-22", updatedAt: "2026-10-22"
  }
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  control = store
  const database = {}
  manager = new FunctionModsManager(store, {
    plugins: () => [installed],
    enabled: () => true,
    protects: () => false,
    capabilityContext: () => usage === "project"
      ? { usage, identity: "project-display", projectId: "project" }
      : { usage, identity: "ordinary-display" },
    captureSiteGuard: () => () => {},
    captureDisplayScope: (_workspace, threadId) => ({
      database, workspace, threadId,
      incarnation: { token: threadId, legacyCreatedAt: 1 },
      assertCurrent: () => {}
    }),
    changed: () => {},
    publish: async (_workspace, value) => value
  }, () => {
    const client = new FunctionRuntimeClient(hostEntry)
    clients.push(client)
    return client
  })
  const [status] = await manager.status(workspace)
  expect(status.state, status.error).toBe("needs-approval")
  expect(status.digest).toBeTruthy()
  await manager.approve(workspace, installed.id, status.digest!)
  expect(store.getGrant(workspace, "function:display")).toMatchObject({
    enabled: true,
    digest: status.digest
  })
  const approvalLaunches = launches.length
  const current = manager
  const read = (threadId: string) => withFunctionMarkdownDisplay({ epoch: {}, assertCurrent: () => {} }, () =>
    current.siteRead(workspace, threadId, "AssistantMessage", {
      text: "verified body", isFirstOfReply: true
    }, "assistant-row"))
  const drawing = await read("thread")
  if (match) expect(JSON.stringify(drawing)).toContain("MATCHED BODY")
  else {
    const contents = drawing.state === "projected" ? drawing.snapshot.data
      : drawing.state === "mounted" ? drawing.snapshot : undefined
    expect(contents).toMatchObject({
      nativeContent: {
        component: "AssistantMessage",
        nativeUnchanged: true,
        entries: expect.arrayContaining([expect.objectContaining({
          props: { text: "verified body", isFirstOfReply: true }
        })])
      }
    })
  }

  const newLaunches = launches.slice(approvalLaunches)
  expect(newLaunches).toHaveLength(extra ? 2 : 1)
  const active = newLaunches.filter(host => !host.empty)
  expect(active).toHaveLength(1)
  expect(active[0].requests.filter(request => request === "load")).toHaveLength(1)
  const prepared = newLaunches.filter(host => host.empty)
  expect(prepared).toHaveLength(extra ? 1 : 0)
  await Promise.all(prepared.map(host => host.ready))
  expect(prepared.map(host => host.requests)).toEqual(extra ? [[]] : [])
  if (extra) {
    const rendering = Promise.withResolvers<void>()
    const allowDraw = Promise.withResolvers<void>()
    const render = current.siteRender.bind(current)
    const renderSpy = vi.spyOn(current, "siteRender").mockImplementationOnce(async (...args) => {
      rendering.resolve()
      await allowDraw.promise
      return render(...args)
    })
    const secondRead = read("next-thread")
    try {
      await Promise.race([rendering.promise, secondRead])
      expect(prepared[0].requests.filter(request => request === "load")).toHaveLength(1)
      expect(launches).toHaveLength(approvalLaunches + 2)
    } finally {
      allowDraw.resolve()
      renderSpy.mockRestore()
    }
    const second = await secondRead
    expect(JSON.stringify(second)).toContain("MATCHED BODY")
    if ("invalidateBeforeRefill" in scenario) {
      current.invalidate(workspace)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(launches).toHaveLength(approvalLaunches + 2)
      return
    }

    await vi.waitFor(() => expect(launches).toHaveLength(approvalLaunches + 3))
    const replacement = launches.at(-1)!
    expect(replacement).not.toBe(prepared[0])
    expect(replacement.empty).toBe(true)
    expect(replacement.requests).toEqual([])
    current.invalidate(workspace)
    await replacement.exited
  }
}, 30_000)
