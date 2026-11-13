import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { analyzeStaticUiRenderSummary } from "./static-ui-render-summary"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const props = { isWorking: true, bodyColumns: 80, maxRows: 8 }

async function fixture(resourceCount = 0, literalDisplay = false) {
  const root = mkdtempSync(join(tmpdir(), "mods-source-sites-"))
  const workspace = join(root, "workspace"),
    path = join(root, "retained")
  mkdirSync(workspace)
  mkdirSync(join(path, "mods"), { recursive: true })
  writeFileSync(
    join(path, "plugin.json"),
    JSON.stringify({ name: "trial-label", version: "1.0.0", mods: "mods/manifest.json" })
  )
  writeFileSync(
    join(path, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "trial-label",
      entry: "main.ts"
    })
  )
  const imports = Array.from({ length: resourceCount }, (_, index) => {
    writeFileSync(join(path, `mods/resource-${index}.ts`), `export const marker = ${index}`)
    return `import "./resource-${index}"`
  }).join("\n")
  const code = `${imports}
export function register(on) {
    ${
      literalDisplay
        ? `on("ui.render",{component:"AbovePrompt"},()=>({type:"Text",props:{text:"ACTUAL_RETAINED_LABEL"}}))`
        : `on("session.start",async($,e,next)=>{
      await $.command.register({name:"label",description:"Actual retained label"});return next(e)
    });
    on("ui.render",{component:"AbovePrompt"},($,e)=>{
      const {Text}=$.ui.resolve(e);return Text({children:"ACTUAL_RETAINED_LABEL"})
    })`
    }
  }`
  writeFileSync(join(path, "mods/main.ts"), code)
  const plugin = {
    id: "uninstalled-source-uuid",
    name: "trial-label",
    path,
    enabled: true,
    version: "1.0.0",
    description: "",
    author: "",
    skillCount: 1,
    mcpServerCount: 0,
    hookCount: 0,
    createdAt: "2026-10-18",
    updatedAt: "2026-10-18"
  }
  const store = new ModControlStore(join(root, "control.sqlite"))
  const database = {}
  let active = true,
    incarnation = "original",
    enabled = true
  let compiledCode: string | undefined
  let publish = async (value: ModJson) => value
  const changed = vi.fn(),
    guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [], // The candidate is never installed, including after native consent.
      enabled: () => enabled,
      protects: () => true,
      clawApplicable: () => false,
      captureSiteGuard: () => {
        const captured = incarnation
        return () => {
          if (captured !== incarnation) throw Error("THREAD_REPLACED")
        }
      },
      captureDisplayScope: () => {
        const token = incarnation
        return {
          database,
          workspace,
          threadId: "stage",
          incarnation: { token, legacyCreatedAt: 1 },
          assertCurrent: () => {
            if (token !== incarnation) throw Error("THREAD_REPLACED")
          }
        }
      },
      changed,
      publish: async (_workspace, value) => publish(value)
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          compiledCode = code
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          owned.push(guest)
          return guest
        },
        stop() {
          for (const guest of owned) void guest.dispose()
        },
        async stopAndDrain() {
          await Promise.all(owned.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const input = { workspace, plugin, scope: { projectId: "trial", packageDigest: "a".repeat(64) } }
  const facts = await manager.prepareRuntimeSourceFacts(input)
  await manager.approveRuntimeSource({ ...input, digest: facts!.digest }, () => {})
  const mint = (operationId: string) => {
    const captured = incarnation
    const assertAuthority = () => {
      if (!active || !enabled || captured !== incarnation) throw Error("SOURCE_REVOKED")
    }
    const assertCurrent = () => {
      assertAuthority()
      if (readFileSync(join(path, "mods/main.ts"), "utf8") !== code) throw Error("SOURCE_CHANGED")
    }
    return issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        capabilitySources: [],
        preserveParentContext: true,
        threadId: "stage",
        incarnationKey: captured,
        projectId: "trial",
        operationId,
        stageId: "prd",
        workspace,
        packageDigest: "a".repeat(64),
        plugin
      },
      assertCurrent,
      assertAuthority
    )
  }
  const token = mint("original")
  const admit = async () =>
    withRuntimePluginSource(token, () => manager.commands(workspace, "stage"))
  const mount = () => manager.siteMountOutcome(workspace, "stage", "AbovePrompt")
  const render = (owner: string) => manager.siteRender(workspace, "stage", owner, props)
  return {
    root,
    workspace,
    path,
    manager,
    store,
    facts,
    token,
    mint,
    changed,
    guests,
    admit,
    mount,
    render,
    activeGuests: () => guests.filter((guest) => !guest.stats.disposed),
    compiledCode: () => compiledCode,
    revoke: () => {
      active = false
    },
    rebind: () => {
      incarnation = "replacement"
    },
    disable: () => {
      enabled = false
    },
    setPublish: (next: typeof publish) => {
      publish = next
    }
  }
}

it("probes the legacy hooks path once and keeps actual source rejection checks", () => {
  const root = mkdtempSync(join(tmpdir(), "mods-source-sites-"))
  const path = join(root, "plugin"), directory = join(path, "hooks")
  const hooks = join(directory, "hooks.json"), outside = join(root, "outside")
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("mods-source-sites-"))
    throw Error("Unexpected source fixture cleanup path")
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(directory, { recursive: true })
  const source = { id: "legacy", name: "legacy", path, enabled: true }
  const hasSource = () => FunctionModsManager.prototype["isSource"](source)
  const valid = '{"modules":["register.ts"]}'
  expect(hasSource()).toBe(false)
  writeFileSync(hooks, valid)
  const resolved = fs.realpathSync(hooks)
  const exists = vi.spyOn(fs, "existsSync")
  const stat = vi.spyOn(fs, "statSync")
  try {
    expect(hasSource()).toBe(true)
    const probes = exists.mock.calls.filter(([name]) => name === hooks || name === resolved)
    expect(probes).toEqual([[hooks]])
    expect(stat.mock.calls.filter(([name]) => name === resolved)).toHaveLength(2)
  } finally {
    exists.mockRestore()
    stat.mockRestore()
  }
  writeFileSync(hooks, "{")
  expect(hasSource()).toBe(false)
  writeFileSync(hooks, valid + " ".repeat(32768))
  expect(hasSource()).toBe(false)
  fs.unlinkSync(hooks)
  mkdirSync(hooks)
  expect(hasSource()).toBe(false)
  fs.rmdirSync(hooks)
  fs.rmdirSync(directory)
  mkdirSync(outside)
  writeFileSync(join(outside, "hooks.json"), valid)
  fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir")
  expect(hasSource()).toBe(false)
})

it("checks a warm classic drawing source before earlier nonexecutable packages", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mods-source-sites-"))
  if (dirname(resolve(workspace)) !== resolve(tmpdir()) ||
    !basename(workspace).startsWith("mods-source-sites-"))
    throw Error("Unexpected source fixture cleanup path")
  cleanup.push(async () => { rmSync(workspace, { recursive: true, force: true }) })

  const installed = ["first-v1", "second-v1", "legacy"].map(id => ({
    id, name: id, path: join(workspace, id), enabled: true
  }))
  const v1Files = installed.slice(0, 2).map(source => {
    mkdirSync(join(source.path, "mods"), { recursive: true })
    const path = join(source.path, "mods/manifest.json")
    writeFileSync(path, JSON.stringify({
      apiVersion: "cmb.mods/v1", id: source.id, entry: "main.ts"
    }))
    writeFileSync(join(source.path, "mods/main.ts"), "export function register() {}")
    return fs.realpathSync(path)
  })
  const legacy = installed[2]
  mkdirSync(join(legacy.path, "hooks"), { recursive: true })
  writeFileSync(join(legacy.path, "plugin.json"), JSON.stringify({
    name: legacy.name, version: "1.0.0"
  }))
  const hooks = join(legacy.path, "hooks/hooks.json")
  writeFileSync(hooks, '{"modules":["./register.ts"]}')
  writeFileSync(join(legacy.path, "hooks/register.ts"), `export function register(on) {
    on("ui.render", { component: "AbovePrompt" }, async ($, event, next) => next(event))
  }`)
  const hookFile = fs.realpathSync(hooks)
  const registry = join(workspace, "plugins.json")
  writeFileSync(registry, JSON.stringify(installed))

  const store = new ModControlStore(join(workspace, "control.sqlite"))
  cleanup.push(async () => { store.close() })
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(store, {
    plugins: () => JSON.parse(readFileSync(registry, "utf8")) as typeof installed,
    enabled: () => true,
    protects: () => false,
    clawApplicable: () => false,
    publish: async (_workspace, value) => value,
    changed: () => {}
  }, () => {
    const owned: FunctionGuestRuntime[] = []
    return {
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        owned.push(guest)
        guests.push(guest)
        return guest
      },
      stop() { for (const guest of owned) void guest.dispose() },
      async stopAndDrain() { await Promise.all(owned.map(guest => guest.dispose())) }
    }
  })
  cleanup.push(async () => {
    manager.close()
    await Promise.all(guests.map(guest => guest.dispose()))
  })
  const statuses = await manager.status(workspace)
  expect(statuses.map(item => item.pluginId)).toEqual([legacy.id])
  expect(statuses[0].digest).toBeTypeOf("string")
  await manager.approve(workspace, legacy.id, statuses[0].digest!)
  const mount = () => manager.siteMountOutcome(workspace, "thread", "AssistantMessage")
  const initial = await mount()
  if (initial.state !== "mounted") throw Error("A real classic drawing owner must be warm")
  await manager.siteUnmount(workspace, "thread", initial.owner)
  const guestCount = guests.length
  expect(guests.filter(guest => !guest.stats.disposed)).toHaveLength(1)

  const lstat = vi.spyOn(fs, "lstatSync")
  const sourceReads = () => lstat.mock.calls.flatMap(([path]) =>
    typeof path === "string" && (path === hookFile || v1Files.includes(path)) ? [path] : [])
  try {
    const warm = await mount()
    if (warm.state !== "mounted") throw Error("Expected the existing classic drawing owner")
    expect(sourceReads()).toEqual([hookFile])
    expect(guests).toHaveLength(guestCount)
    await manager.siteUnmount(workspace, "thread", warm.owner)
    fs.unlinkSync(hooks)
    lstat.mockClear()

    expect(await mount()).toEqual({ state: "inactive", reason: "no-protection-or-functions" })
    expect(sourceReads()).toEqual(v1Files)
    expect(guests).toHaveLength(guestCount)
  } finally {
    lstat.mockRestore()
  }
})

// Diagnostic only: exercise the actual retained manager, guest and source fences.
// Counts describe costs, not a cache TTL or permission to bypass fresh validation.
it.each([0, 24])(
  "measures protected resident drawing with %i imported resources",
  async (resources) => {
    const f = await fixture(resources)
    await f.admit()
    const read = vi.spyOn(fs, "readSync")
    const readFile = vi.spyOn(fs, "readFileSync")
    const stat = vi.spyOn(fs, "lstatSync")
    const realpath = vi.spyOn(fs, "realpathSync")
    const matches = vi.spyOn(f.activeGuests()[0], "matches")
    const invoke = vi.spyOn(f.activeGuests()[0], "invoke")
    const trace: Array<Record<string, number | string>> = []
    const measure = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      const before = [
        read.mock.calls.length,
        stat.mock.calls.length,
        realpath.mock.calls.length,
        matches.mock.calls.length,
        invoke.mock.calls.length,
        readFile.mock.calls.length
      ]
      const start = performance.now()
      const result = await run()
      trace.push({
        phase,
        ms: performance.now() - start,
        read: read.mock.calls.length - before[0],
        stat: stat.mock.calls.length - before[1],
        realpath: realpath.mock.calls.length - before[2],
        matches: matches.mock.calls.length - before[3],
        invokes: invoke.mock.calls.length - before[4],
        readFile: readFile.mock.calls.length - before[5]
      })
      return result
    }
    const matched = await measure("matched.mount", () => f.mount())
    if (matched.state !== "mounted") throw Error("actual mounted owner required")
    expect(
      JSON.stringify(await measure("matched.render", () => f.render(matched.owner)))
    ).toContain("ACTUAL_RETAINED_LABEL")
    await measure("matched.unmount", () =>
      f.manager.siteUnmount(f.workspace, "stage", matched.owner)
    )
    const missing = await measure("unmatched.mount", () =>
      f.manager.siteMountOutcome(f.workspace, "stage", "AssistantMessage")
    )
    if (missing.state !== "mounted") throw Error("actual protected native owner required")
    const message = { text: "NATIVE_ASSISTANT_MESSAGE", isFirstOfReply: true }
    const rendered = await measure("unmatched.render", () =>
      f.manager.siteRender(f.workspace, "stage", missing.owner, message)
    )
    expect(JSON.stringify(rendered)).toContain("NATIVE_ASSISTANT_MESSAGE")
    await measure("unmatched.unmount", () =>
      f.manager.siteUnmount(f.workspace, "stage", missing.owner)
    )
    expect(trace.find((item) => item.phase === "unmatched.render")!.invokes).toBe(0)
    // The existing security behavior remains live: a changed import cannot reuse a drawing owner.
    const original = readFileSync(join(f.path, "mods/main.ts"), "utf8")
    writeFileSync(join(f.path, "mods/main.ts"), original + "\n// changed source")
    await expect(f.mount()).rejects.toThrow("SOURCE_CHANGED")
    writeFileSync(join(f.path, "mods/main.ts"), original)
    const output = join(process.cwd(), "output", "runtime-source-site-cost")
    mkdirSync(output, { recursive: true })
    writeFileSync(
      join(output, `resources-${resources}.json`),
      JSON.stringify({ resources, trace }, null, 2)
    )
    console.log("SITE_SOURCE_COST", JSON.stringify({ resources, trace }))
  }
)

it("measures the actual protected host-only fallback without allocating a guest", async () => {
  const f = await fixture()
  const read = vi.spyOn(fs, "readSync")
  const stat = vi.spyOn(fs, "lstatSync")
  const readFile = vi.spyOn(fs, "readFileSync")
  const start = performance.now()
  const owner = await f.manager.siteMountOutcome(f.workspace, "stage", "AssistantMessage")
  if (owner.state !== "mounted") throw Error("actual protected owner required")
  const mounted = performance.now()
  const value = await f.manager.siteRender(f.workspace, "stage", owner.owner, {
    text: "NATIVE_PROTECTED_ONLY",
    isFirstOfReply: true
  })
  expect(JSON.stringify(value)).toContain("NATIVE_PROTECTED_ONLY")
  expect(f.activeGuests()).toHaveLength(0)
  const result = {
    mountMs: mounted - start,
    renderMs: performance.now() - mounted,
    read: read.mock.calls.length,
    stat: stat.mock.calls.length,
    readFile: readFile.mock.calls.length
  }
  const output = join(process.cwd(), "output", "runtime-source-site-cost")
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "native-only.json"), JSON.stringify(result, null, 2))
  console.log("SITE_NATIVE_COST", JSON.stringify(result))
})

it("keeps retained project source proof while a native projection avoids guest drawing", async () => {
  const f = await fixture(24, true)
  await f.admit()
  const invokes = vi.spyOn(f.activeGuests()[0], "invoke")
  const mounts = vi.spyOn(f.manager, "siteMountOutcome")
  const body = { text: "NATIVE_ASSISTANT_MESSAGE", isFirstOfReply: true }
  const read = () =>
    f.manager.siteRead(f.workspace, "stage", "AssistantMessage", body, "message:block")
  const first = await read()
  expect(first.state).toBe("projected")
  mounts.mockClear()
  invokes.mockClear()
  const before = performance.now()
  const cached = await read()
  expect(cached).toEqual(first)
  expect(mounts).not.toHaveBeenCalled()
  expect(invokes).not.toHaveBeenCalled()
  console.log(
    "SITE_PROJECTED_COST",
    JSON.stringify({
      resources: 24,
      ms: performance.now() - before,
      guestInvokes: invokes.mock.calls.length,
      mounts: mounts.mock.calls.length
    })
  )
  f.revoke()
  await expect(read()).rejects.toThrow("SOURCE_REVOKED")
})

it("keeps the original dynamic retained AbovePrompt source on its actual owner path", async () => {
  const f = await fixture(24)
  await f.admit()
  const compiled = f.compiledCode()
  expect(compiled).toBeTypeOf("string")
  const summary = analyzeStaticUiRenderSummary(compiled!)
  expect(summary.kind).toBe("unknown")
  const result = await f.manager.siteRead(
    f.workspace,
    "stage",
    "AssistantMessage",
    { text: "NATIVE_ASSISTANT_MESSAGE", isFirstOfReply: true },
    "message:block"
  )
  expect(result.state).toBe("mounted")
  if (result.state !== "mounted")
    throw Error("Original retained source must keep its actual native owner")
  await f.manager.siteUnmount(f.workspace, "stage", result.owner)
  console.log("SITE_UNPROVED_ROUTING", JSON.stringify(summary))
})
