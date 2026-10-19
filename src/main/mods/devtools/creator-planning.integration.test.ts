import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { CreatorPlanningService } from "./creator-planning"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { FunctionModsManager } from "../v2/manager"
import { ModControlStore } from "../control-store"
import type { ModPluginSource } from "../manager"
import type { CreatorPlanningReference } from "../../../shared/mods/creator-planning"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creator-planning-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  const plugins: ModPluginSource[] = []
  let alive = true,
    loads = 0
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => plugins,
      enabled: () => true,
      publish: async (_, value) => value,
      changed: () => {}
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  const context = {
    scope: {
      workspace: root,
      threadId: "creator-thread",
      incarnation: { token: "original", legacyCreatedAt: 1 }
    },
    assertCurrent() {
      if (!alive) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    }
  }
  const changed = vi.fn()
  const service = new CreatorPlanningService({
    settings: store,
    current: (id, workspace) => {
      if (id !== context.scope.threadId || (workspace !== undefined && workspace !== root))
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      context.assertCurrent()
      return context
    },
    catalog: (workspace) => manager.status(workspace),
    invoke: (workspace, selected, signal, guard) =>
      manager.creatorPlanningPrompt(workspace, selected, signal, guard),
    changed
  })
  cleanups.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const add = async (
    name: string,
    body = `return {text: "${name}:先查看真实目录，再以最小差异完善功能。"}`
  ) => {
    const path = join(root, name)
    await mkdir(join(path, "mods"), { recursive: true })
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", mods: "mods/manifest.json" })
    )
    await writeFile(
      join(path, "mods/manifest.json"),
      JSON.stringify({ apiVersion: "cmb.mods/v2", id: name, entry: "main.ts" })
    )
    await writeFile(
      join(path, "mods/main.ts"),
      `export function register(on){on("prompt.section",{name:"creator.planning"},async($,event,next)=>{${body}})}`
    )
    const source = { id: name + "-uuid", name, path, enabled: true }
    plugins.push(source)
    const status = (await manager.status(root)).find((item) => item.pluginId === source.id)!
    if (status.digest) await manager.approve(root, source.id, status.digest)
    return {
      source,
      ref: { pluginId: source.id, name, digest: status.digest! } as CreatorPlanningReference
    }
  }
  return {
    root,
    manager,
    store,
    service,
    plugins,
    context,
    add,
    changed,
    loads: () => loads,
    signal: new AbortController().signal,
    setAlive(value: boolean) {
      alive = value
    }
  }
}

it("validates one actual installed Guest, replaces the exact selection and withdraws without granting tools or starting a normal session", async () => {
  const f = await fixture()
  const a = await f.add("review-first"),
    b = await f.add("compose-first")
  const initialLoads = f.loads()
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toBeNull()
  expect(f.loads()).toBe(initialLoads)
  expect((await f.service.catalog("creator-thread", f.root)).status.state).toBe("native")
  const selected = await f.service.select("creator-thread", f.root, 0, a.ref)
  expect(selected.status).toMatchObject({ state: "ready", revision: 1, selected: a.ref })
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toContain("review-first:")
  expect(f.manager.runtimeSessions().sessions).toEqual([])
  await f.service.select("creator-thread", f.root, 1, b.ref)
  const prompt = await f.service.prompt("creator-thread", f.root, f.signal)
  expect(prompt).toContain("compose-first:")
  expect(prompt).not.toContain("review-first:")
  const withdrawn = await f.service.select("creator-thread", f.root, 2, null)
  expect(withdrawn.status).toEqual({ state: "native", revision: 3 })
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toBeNull()
  await expect(f.service.select("creator-thread", f.root, 1, a.ref)).rejects.toThrow(
    "REVISION_CHANGED"
  )
})

it.each(["disabled", "uninstalled", "changed", "broken", "revoked"])(
  "falls back to native creation when the selected real Mod is %s and withdrawal still works",
  async (reason) => {
    const f = await fixture(),
      a = await f.add("review-first")
    await f.service.select("creator-thread", f.root, 0, a.ref)
    if (reason === "disabled") a.source.enabled = false
    if (reason === "uninstalled") f.plugins.splice(0)
    if (reason === "changed")
      await writeFile(
        join(a.source.path, "mods/main.ts"),
        'export function register(on){on("prompt.section",()=>({text:"other"}))}'
      )
    if (reason === "broken")
      await writeFile(join(a.source.path, "mods/main.ts"), "this is invalid TypeScript {{")
    if (reason === "revoked") f.manager.revoke(f.root, a.ref.name)
    expect(await f.service.prompt("creator-thread", f.root, f.signal)).toBeNull()
    const status = (await f.service.catalog("creator-thread", f.root)).status
    expect(status.state).toBe("fallback")
    expect(status.diagnostic).toContain("停止、安装核对和恢复入口仍可使用")
    expect(status.selected).toEqual(a.ref)
    expect((await f.service.select("creator-thread", f.root, 1, null)).status.state).toBe("native")
  }
)

it.each([
  'return {status:"unknown",text:"已批准"}',
  'return {text:"建议",tools:["fake"]}',
  "return undefined",
  'return {text:""}',
  'await $.fs.write("owned.txt","unsafe"); return {text:"已完成"}',
  'throw Error("planning unavailable")',
  'await new Promise(()=>{}); return {text:"late"}'
])(
  "rejects unknown facts, invalid advice and SDK side effects without replacing the current selection: %s",
  async (body) => {
    const f = await fixture(),
      good = await f.add("review-first")
    await f.service.select("creator-thread", f.root, 0, good.ref)
    const bad = await f.add("bad-strategy", body)
    await expect(f.service.select("creator-thread", f.root, 1, bad.ref)).rejects.toThrow()
    expect((await f.service.catalog("creator-thread", f.root)).status.selected).toEqual(good.ref)
    expect(await f.service.prompt("creator-thread", f.root, f.signal)).toContain("review-first:")
    await expect(readFile(join(f.root, "owned.txt"))).rejects.toThrow()
  }
)

it("keeps scope cancellation meaningful instead of converting it into an authority-bearing fallback", async () => {
  const f = await fixture(),
    a = await f.add("review-first")
  await f.service.select("creator-thread", f.root, 0, a.ref)
  f.setAlive(false)
  await expect(f.service.prompt("creator-thread", f.root, f.signal)).rejects.toThrow(
    "SCOPE_CHANGED"
  )
})

it("does not retry a stopped strategy implicitly and only native revalidation clears its diagnostic", async () => {
  const f = await fixture(),
    a = await f.add("review-first")
  await f.service.select("creator-thread", f.root, 0, a.ref)
  a.source.enabled = false
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toBeNull()
  a.source.enabled = true
  const loads = f.loads()
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toBeNull()
  expect(f.loads()).toBe(loads)
  expect((await f.service.catalog("creator-thread", f.root)).status.state).toBe("fallback")
  await f.service.select("creator-thread", f.root, 1, a.ref)
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toContain("review-first:")
})

it("gives a defensive planner no SDK even when it catches a missing capability and still returns pure advice", async () => {
  const f = await fixture(),
    a = await f.add(
      "defensive-planner",
      'try{await $.fs.write("owned.txt","unsafe")}catch{}; return {text:"仅供参考的规划建议"}'
    )
  const grant = f.store.getGrant(f.root, `function:${a.ref.name}`)
  await f.service.select("creator-thread", f.root, 0, a.ref)
  expect(await f.service.prompt("creator-thread", f.root, f.signal)).toContain("仅供参考的规划建议")
  expect(f.manager.runtimeSessions().sessions).toEqual([])
  expect(f.store.getGrant(f.root, `function:${a.ref.name}`)).toEqual(grant)
  await expect(readFile(join(f.root, "owned.txt"))).rejects.toThrow()
  await expect(readFile(join(a.source.path, "owned.txt"))).rejects.toThrow()
})

it("rejects an ordinary Mod whose prompt section matcher does not implement creator.planning", async () => {
  const f = await fixture(),
    a = await f.add("ordinary-mod")
  await writeFile(
    join(a.source.path, "mods/main.ts"),
    'export function register(on){on("prompt.section",{name:"unrelated"},()=>({text:"ordinary section"}))}'
  )
  const status = (await f.manager.status(f.root))[0]
  await f.manager.approve(f.root, a.ref.pluginId, status.digest!)
  await expect(
    f.service.select("creator-thread", f.root, 0, { ...a.ref, digest: status.digest! })
  ).rejects.toThrow("HANDLER_MISSING")
  expect((await f.service.catalog("creator-thread", f.root)).status.state).toBe("native")
})
