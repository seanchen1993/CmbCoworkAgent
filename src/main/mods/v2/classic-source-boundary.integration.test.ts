import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore, type ModGrant } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { ModPluginSource } from "../manager"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../../plugins/runtime-source-scope"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

// Fault injection only: production snapshots are private and cannot be changed by a caller.
function residentSnapshots(manager: FunctionModsManager, workspace: string, threadId: string) {
  type Snapshot = { sourceId?: string; sourcePath?: string; grant: ModGrant }
  const entries = (manager as unknown as {
    sessions: Map<string, { snapshots: Map<string, Snapshot> }>
  }).sessions
  const entry = entries.get(JSON.stringify([workspace, threadId]))
  if (!entry) throw Error("The real manager must already own the test session")
  return [...entry.snapshots.values()]
}

async function fixture(optIn = true, count = 3, runtime = false) {
  const workspace = await mkdtemp(join(tmpdir(), "classic-source-boundary-"))
  const sources = Array.from({ length: count }, (_, index) => ({
    id: "source-" + index,
    name: "classic-source-" + index,
    path: join(workspace, "plugin-" + index),
    enabled: true, version: "1.0.0", description: "", author: "",
    skillCount: 0, mcpServerCount: 0, createdAt: "2026-10-19", updatedAt: "2026-10-19"
  }))
  for (const source of sources) {
    await mkdir(join(source.path, "hooks"), { recursive: true })
    await writeFile(join(source.path, "plugin.json"), JSON.stringify({
      name: source.name, version: "1.0.0"
    }))
    await writeFile(join(source.path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(join(source.path, "hooks/register.ts"), `export function register(on) {
      on("ui.render", { component: "AbovePrompt" }, async ($, event, next) => next(event))
    }`)
  }
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  const counts = { ordinary: 0, fresh: 0 }
  let freshRead: (() => void) | undefined
  const registryFile = join(workspace, "plugins.json")
  const writeRegistry = (value: unknown = sources) =>
    writeFileSync(registryFile, JSON.stringify(value))
  writeRegistry()
  const read = (): ModPluginSource[] => {
    try {
      const value: unknown = JSON.parse(readFileSync(registryFile, "utf8"))
      return Array.isArray(value) ? value.filter((row): row is ModPluginSource =>
        !!row && typeof row === "object" && typeof row.id === "string" &&
        typeof row.name === "string" && typeof row.path === "string") : []
    } catch { return [] }
  }
  const host = {
    plugins: () => {
      counts.ordinary++
      return read()
    },
    ...(optIn ? { freshClassicPluginSources: () => {
      counts.fresh++
      freshRead?.()
      return read()
    } } : {}),
    enabled: () => true,
    clawApplicable: () => true,
    changed() { /* Resource state is checked through the manager. */ },
    publish: async (_workspace: string, value: Parameters<
      ConstructorParameters<typeof FunctionModsManager>[1]["publish"]
    >[1]) => value,
    threadIncarnationKey: () => "original-native-incarnation"
  }
  const manager = new FunctionModsManager(store, host, () => {
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
  cleanups.push(async () => {
    manager.close()
    await Promise.all(guests.map(guest => guest.dispose()))
    store.close()
    await rm(workspace, { recursive: true, force: true })
  })
  for (const source of sources) {
    const status = (await manager.status(workspace)).find(item => item.pluginId === source.id)
    expect(status?.digest).toBeTypeOf("string")
    await manager.approve(workspace, source.id, status!.digest!)
  }
  let runtimeActive = true, runtimeAssertions = 0
  const threadId = runtime ? "runtime-thread" : "thread"
  const mount = () => manager.siteMount(workspace, threadId, "AbovePrompt")
  let owner: string | null
  if (runtime) {
    const scope = { projectId: "controlled-source", packageDigest: "b".repeat(64) }
    const input = { workspace, plugin: sources[0], scope }
    const facts = await manager.prepareRuntimeSourceFacts(input)
    expect(facts?.digest).toBeTypeOf("string")
    await manager.approveRuntimeSource({ ...input, digest: facts!.digest }, () => {})
    const assertCurrent = () => {
      runtimeAssertions++
      if (!runtimeActive) throw Error("RUNTIME_AUTHORITY_REVOKED")
    }
    const token = issueRuntimePluginSourceToken({
      mode: "legacy", preserveParentContext: true, threadId, incarnationKey: "original-native-incarnation",
      projectId: scope.projectId, operationId: "controlled-operation", workspace,
      packageDigest: scope.packageDigest, stageId: "prd", plugin: sources[0]
    }, assertCurrent, assertCurrent)
    owner = await withRuntimePluginSource(token, mount)
  } else owner = await mount()
  expect(owner).toBeTypeOf("string")
  const render = () => manager.siteRender(workspace, threadId, owner!, {
    isWorking: false, bodyColumns: 80, maxRows: 8
  })
  counts.ordinary = 0
  counts.fresh = 0
  return { manager, store, sources, workspace, threadId, render, counts, registryFile, writeRegistry,
    runtimeAssertions: () => runtimeAssertions, revokeRuntime: () => { runtimeActive = false },
    onFreshRead: (run: () => void) => { freshRead = run } }
}

it("uses two fresh classic fences per synchronous boundary and rereads on the next public render", async () => {
  const f = await fixture()
  expect(await f.render()).not.toBeNull()
  const first = { ...f.counts }
  expect(first.fresh).toBeGreaterThan(0)
  expect(first.fresh % 2).toBe(0)
  expect(await f.render()).not.toBeNull()
  expect(f.counts.fresh).toBeGreaterThan(first.fresh)
})

it("rejects a source disabled before the next independent public render", async () => {
  const f = await fixture()
  expect(await f.render()).not.toBeNull()
  f.sources[1].enabled = false
  f.writeRegistry()
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_PLUGIN_CHANGED" })
})

it("rejects persistent registry revocation during the grant phase", async () => {
  const f = await fixture()
  const original = f.store.assertGrant.bind(f.store)
  let changed = false
  vi.spyOn(f.store, "assertGrant").mockImplementation(grant => {
    original(grant)
    if (!changed) {
      changed = true
      f.sources.at(-1)!.enabled = false
      f.writeRegistry()
    }
  })
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_PLUGIN_CHANGED" })
  expect(changed).toBe(true)
})

it("retains fresh grant revocation independently of the registry fences", async () => {
  const f = await fixture()
  const grant = f.store.getGrant(f.workspace, "function:" + f.sources[1].name)
  expect(grant).not.toBeNull()
  f.store.grant(f.workspace, grant!.modId, grant!.digest, false)
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_GRANT_REVOKED" })
})

it("does not return success when the final fresh registry fence fails", async () => {
  const f = await fixture()
  f.onFreshRead(() => {
    if (f.counts.fresh === 2) throw Error("FINAL_REGISTRY_READ_FAILED")
  })
  await expect(f.render()).rejects.toThrow("FINAL_REGISTRY_READ_FAILED")
})

it("keeps non-opt-in hosts on the original fresh source path", async () => {
  const f = await fixture(false)
  expect(await f.render()).not.toBeNull()
  expect(f.counts.fresh).toBe(0)
  expect(f.counts.ordinary).toBeGreaterThan(2)
  f.sources[2].path = join(f.workspace, "replaced-source")
  f.writeRegistry()
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_PLUGIN_CHANGED" })
})

it.each([1, 2])("retains the original path for %i classic sources", async count => {
  const f = await fixture(true, count)
  expect(await f.render()).not.toBeNull()
  expect(f.counts.fresh).toBe(0)
  expect(f.counts.ordinary).toBeGreaterThan(0)
})

it("rejects a persistent path replacement introduced at the post-read fence", async () => {
  const f = await fixture()
  f.onFreshRead(() => {
    if (f.counts.fresh === 2) {
      f.sources[2].path = join(f.workspace, "replacement-path")
      f.writeRegistry()
    }
  })
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_PLUGIN_CHANGED" })
})

it.each(["{malformed", '{"plugins":[]}'])(
  "rejects unreadable or unknown registry data at the post fence: %s", async raw => {
    const f = await fixture()
    f.onFreshRead(() => {
      if (f.counts.fresh === 2) writeFileSync(f.registryFile, raw)
    })
    await expect(f.render()).rejects.toMatchObject({ code: "MODS_PLUGIN_CHANGED" })
  }
)

it("retains the original existential predicate for duplicate source IDs", async () => {
  const f = await fixture()
  f.writeRegistry([{ ...f.sources[0], enabled: false }, ...f.sources])
  expect(await f.render()).not.toBeNull()
  expect(f.counts.fresh).toBeGreaterThan(0)
})

it("keeps an earlier grant denial ahead of a later missing registry source", async () => {
  const f = await fixture()
  const grant = f.store.getGrant(f.workspace, "function:" + f.sources[0].name)
  expect(grant).not.toBeNull()
  f.store.grant(f.workspace, grant!.modId, grant!.digest, false)
  f.writeRegistry(f.sources.slice(0, 2))
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_GRANT_REVOKED" })
})

it("keeps a real retained runtime mixed with installed sources on the original path", async () => {
  const f = await fixture(true, 3, true)
  const before = f.runtimeAssertions()
  expect(await f.render()).not.toBeNull()
  expect(f.counts.fresh).toBe(0)
  expect(f.runtimeAssertions()).toBeGreaterThan(before)
  f.revokeRuntime()
  await expect(f.render()).rejects.toThrow("RUNTIME_AUTHORITY_REVOKED")
  expect(f.counts.fresh).toBe(0)
})

it("rejects a missing first snapshot identity before calling either registry reader", async () => {
  const f = await fixture()
  residentSnapshots(f.manager, f.workspace, f.threadId)[0].sourceId = undefined
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_PLUGIN_CHANGED" })
  expect(f.counts).toEqual({ ordinary: 0, fresh: 0 })
})

it("preserves an earlier grant denial before a later missing private source identity", async () => {
  const f = await fixture()
  const snapshots = residentSnapshots(f.manager, f.workspace, f.threadId)
  snapshots[2].sourcePath = undefined
  const grant = snapshots[0].grant
  f.store.grant(f.workspace, grant.modId, grant.digest, false)
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_GRANT_REVOKED" })
  expect(f.counts.fresh).toBe(0)
})

it("keeps project grant scope on the original source-check path", async () => {
  const f = await fixture()
  const snapshot = residentSnapshots(f.manager, f.workspace, f.threadId)[1]
  snapshot.grant = { ...snapshot.grant, sourceScope: "unissued-project-scope" }
  await expect(f.render()).rejects.toMatchObject({ code: "MODS_GRANT_REVOKED" })
  expect(f.counts.fresh).toBe(0)
})
