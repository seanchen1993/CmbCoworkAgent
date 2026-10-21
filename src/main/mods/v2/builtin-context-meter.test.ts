import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ClawProfile } from "../../../shared/mods/claw"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import { ClawStore } from "../claw-store"
import { ModControlStore } from "../control-store"
import type { ModPluginSource } from "../manager"
import { CONTEXT_METER_NAME } from "./builtin-context-meter"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const props = { isWorking: false, bodyColumns: 80, maxRows: 8 }
const profile = (): ClawProfile => ({
  id: "meter",
  name: "Context meter",
  capabilities: [],
  builtins: { contextMeter: true }
})
const drawnText = (tree: FunctionUiElement | string): string => {
  if (typeof tree === "string") return tree
  if (tree.type === "engine") return ""
  return (tree.children ?? []).map(drawnText).join("")
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-builtin-meter-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  const claws = new ClawStore(store)
  const sources: ModPluginSource[] = []
  const guests = new Set<FunctionGuestRuntime>()
  const state = { enabled: true }
  const readSession = vi.fn(
    async (): Promise<ModJson> => ({
      context: { window: 1000, tokens: 250 },
      rateLimits: []
    })
  )
  const changed = vi.fn()
  const load = vi.fn(async (code: string, options: Record<string, ModJson>) => {
    const guest = await FunctionGuestRuntime.create(code, options)
    guests.add(guest)
    return guest
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => state.enabled,
      clawApplicable: (threadId) => threadId !== "harness",
      readSession,
      publish: async (_workspace, value) => value,
      changed
    },
    () => {
      const local = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          const guest = await load(code, options)
          local.add(guest)
          return guest
        },
        stop() {
          for (const guest of local) guest.dispose()
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const bind = (active: ClawProfile | null, threadId = "thread") => {
    claws.apply(root, JSON.stringify([threadId, "legacy"]), active, claws.read(root).revision)
    manager.closeThread(threadId)
  }
  const add = async (
    id: string,
    name: string,
    hooks: string,
    manifest: Record<string, unknown> = {}
  ) => {
    const path = join(root, id)
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(join(path, "plugin.json"), JSON.stringify({ name, ...manifest }))
    await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(join(path, "hooks/register.ts"), `export function register(on) { ${hooks} }`)
    sources.push({ id, name, path, enabled: true })
    manager.invalidate(root)
    const status = (await manager.status(root)).find((item) => item.pluginId === id)!
    if (status.digest) store.grant(root, `function:${name}`, status.digest, true)
    return { pluginId: id, name, digest: status.digest! }
  }
  return { root, manager, store, claws, state, readSession, changed, load, guests, bind, add }
}

it("defaults off and discovers an opted-in builtin without allocating a guest or a fake grant", async () => {
  const f = await fixture()
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(false)
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
  expect(f.load).not.toHaveBeenCalled()
  f.bind(profile())
  expect(await f.manager.status(f.root)).toEqual([])
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(true)
  expect(f.load).not.toHaveBeenCalled()
  expect(f.store.getGrant(f.root, `function:${CONTEXT_METER_NAME}`)).toBeNull()
  expect(await f.manager.runtimeReady(f.root, "harness")).toBe(false)
  f.state.enabled = false
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(false)
})

it("refreshes actual context, omits absent usage and preserves fatal host read errors", async () => {
  const f = await fixture()
  f.bind(profile())
  const owner = await f.manager.siteMount(f.root, "thread", "AbovePrompt")
  expect(owner).toBeTypeOf("string")
  const first = await f.manager.siteRender(f.root, "thread", owner!, props)
  expect(drawnText(first!.tree)).toBe("上下文：250 / 1000 tokens · 25%")
  expect(f.readSession).toHaveBeenCalledWith(
    f.root,
    "thread",
    "session.usage",
    expect.any(AbortSignal),
    {}
  )
  f.readSession.mockResolvedValue({ context: { window: 2000, tokens: 700 }, rateLimits: [] })
  const signal = new AbortController().signal
  await f.manager.turnStart(f.root, "thread", { turnId: "turn", text: "refresh usage" }, signal)
  await f.manager.turnComplete(
    f.root,
    "thread",
    {
      answer: "Done",
      durationMs: 1,
      isAborted: false,
      turnId: "turn",
      reason: "answer"
    },
    signal
  )
  await expect.poll(() => f.changed.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0)
  const updated = await f.manager.siteRender(f.root, "thread", owner!, props)
  expect(drawnText(updated!.tree)).toBe("上下文：700 / 2000 tokens · 35%")
  f.readSession.mockResolvedValue({ context: { window: 2000 }, rateLimits: [] })
  const missingSignal = new AbortController().signal
  await f.manager.turnStart(f.root, "thread", { turnId: "missing", text: "absent usage" }, missingSignal)
  await f.manager.turnComplete(f.root, "thread", {
    answer: "Done", durationMs: 1, isAborted: false, turnId: "missing", reason: "answer"
  }, missingSignal)
  expect(drawnText((await f.manager.siteRender(f.root, "thread", owner!, props))!.tree)).toBe("")
  f.readSession.mockRejectedValue(Error("No current model"))
  const failedSignal = new AbortController().signal
  await f.manager.turnStart(f.root, "thread", { turnId: "failed", text: "failed read" }, failedSignal)
  await f.manager.turnComplete(f.root, "thread", {
    answer: "Done", durationMs: 1, isAborted: false, turnId: "failed", reason: "answer"
  }, failedSignal)
  await expect(f.manager.siteRender(f.root, "thread", owner!, props)).rejects.toThrow("No current model")
})

it("closes old drawings and guests when the applied builtin is disabled or the thread closes", async () => {
  const f = await fixture()
  f.bind(profile())
  const owner = (await f.manager.siteMount(f.root, "thread", "AbovePrompt"))!
  await f.manager.siteRender(f.root, "thread", owner, props)
  const original = [...f.guests]
  f.bind({ ...profile(), builtins: { contextMeter: false } })
  expect(original.every((guest) => guest.stats.disposed)).toBe(true)
  await expect(f.manager.siteRender(f.root, "thread", owner, props))
    .rejects.toMatchObject({ code: "MODS_UI_SITE_CLOSED" })
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
  f.bind(profile())
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeTypeOf("string")
  f.manager.closeThread("thread")
  expect([...f.guests].every((guest) => guest.stats.disposed)).toBe(true)
})

it("reloads an enabled builtin without replaying its old drawing or retaining its guest", async () => {
  const f = await fixture()
  f.bind(profile())
  const oldOwner = (await f.manager.siteMount(f.root, "thread", "AbovePrompt"))!
  await f.manager.siteRender(f.root, "thread", oldOwner, props)
  const oldGuest = [...f.guests][0]
  f.manager.invalidate(f.root)
  expect(oldGuest.stats.disposed).toBe(true)
  await expect(f.manager.siteRender(f.root, "thread", oldOwner, props))
    .rejects.toMatchObject({ code: "MODS_UI_SITE_CLOSED" })
  const freshOwner = (await f.manager.siteMount(f.root, "thread", "AbovePrompt"))!
  expect(freshOwner).not.toBe(oldOwner)
  f.readSession.mockResolvedValue({ context: { window: 4000, tokens: 600 }, rateLimits: [] })
  expect(drawnText((await f.manager.siteRender(f.root, "thread", freshOwner, props))!.tree)).toBe(
    "上下文：600 / 4000 tokens · 15%"
  )
  expect(f.load).toHaveBeenCalledTimes(2)
})

it.each([false, true])("lets a user hook replace or wrap the builtin, wrap=%s", async (wrap) => {
  const f = await fixture()
  const user = await f.add(
    "user",
    "user-meter",
    wrap
      ? `on("ui.render", {component:"AbovePrompt"}, async ($,e,next) => {
        const tree=await next(e)
        return $.ui.resolve(e).Box({children:[$.ui.resolve(e).Text({children:"Wrapped:"}),tree]})
      })`
      : `on("ui.render", {component:"AbovePrompt"}, ($,e) =>
        $.ui.resolve(e).Text({children:"Replacement"}))`
  )
  f.bind({ ...profile(), capabilities: [user] })
  const owner = (await f.manager.siteMount(f.root, "thread", "AbovePrompt"))!
  const rendered = await f.manager.siteRender(f.root, "thread", owner, props)
  expect(drawnText(rendered!.tree)).toBe(
    wrap ? "Wrapped:上下文：250 / 1000 tokens · 25%" : "Replacement"
  )
  expect(f.readSession).toHaveBeenCalledTimes(wrap ? 1 : 0)
})

it("rejects external identity collisions and keeps claimed manifest tiers at user authority", async () => {
  const f = await fixture()
  await f.add("collision", CONTEXT_METER_NAME, "", { tier: "builtin" })
  const collision = (await f.manager.status(f.root))[0]
  expect(collision.state).toBe("invalid")
  expect(collision.error).toContain("MODS_RESERVED_BUILTIN_NAME")
  const claims = await f.add(
    "claims",
    "claims",
    `
    on("session.start", async ($,e,next) => {
      await $.tool.register({
        name:"claim_tool",description:"tool",inputSchema:{type:"object",properties:{}}
      })
      return next(e)
    })
    on("tool.describe", ($,e) => ({description:e.provider.tier}))`,
    { tier: "builtin", builtin: true, prepend: true }
  )
  f.bind({ ...profile(), capabilities: [claims], builtins: { contextMeter: false } })
  const value = await f.manager.presentationEvent(
    f.root,
    "thread",
    "tool.describe",
    {
      tool: "mcp__claims__claim_tool",
      description: "original"
    },
    new AbortController().signal
  )
  expect(value.description).toBe("user")
})

it("loads applied capability arrays in saved order and preserves the legacy source ID order", async () => {
  const f = await fixture()
  const hooks = (name: string) => `on("skill.prompt",async($,e,next)=>{
    const result=await next(e)
    return {text:"${name}("+result.text+")"}
  })`
  const a = await f.add("a", "alpha", hooks("A"))
  const z = await f.add("z", "zeta", hooks("Z"))
  const read = () =>
    f.manager.presentationEvent(
      f.root,
      "thread",
      "skill.prompt",
      {
        skill: "review",
        text: "seed"
      },
      new AbortController().signal
    )
  expect((await read()).text).toBe("A(Z(seed))")
  f.bind({ ...profile(), capabilities: [z, a], builtins: { contextMeter: false } })
  expect((await read()).text).toBe("Z(A(seed))")
  f.bind({ ...profile(), capabilities: [a, z], builtins: { contextMeter: false } })
  expect((await read()).text).toBe("A(Z(seed))")
  f.bind(null)
  expect((await read()).text).toBe("A(Z(seed))")
})
