import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { compileFunctionPlugin } from "./loader"
import { FunctionUserConfigValues } from "./user-config-values"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  drain: (batch: number) => Promise<void> = async () => {},
  configured = false,
  loaded: (batch: number) => Promise<void> = async () => {},
  protectedMode = false
) {
  const root = await mkdtemp(join(tmpdir(), "mods-runtime-recovery-"))
  const path = join(root, "plugin")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({
      name: "recovery-demo",
      ...(configured
        ? {
            userConfig: {
              tone: { type: "string", title: "Tone", description: "Tone", default: "warm" }
            }
          }
        : {})
    })
  )
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(path, "hooks/register.ts"),
    `export function register(on,options) {
    on("session.start",async($,e,next)=>{
      if (${!configured} || options.tone === "warm") await $.store.set("starts",(await $.store.get("starts")??0)+1);
      await $.command.register({name:"effect",description:"effect"}); return next(e)
    });
    on("command.run",async($)=>{
      await $.store.set("effects",(await $.store.get("effects")??0)+1);
      await $.clock.sleep(500); return {text:"effect finished"}
    });
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const guests: FunctionGuestRuntime[][] = []
  const changed = vi.fn()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "p", name: "recovery-demo", path, enabled: true }],
      enabled: () => true,
      protects: () => protectedMode,
      captureSiteGuard: () => () => {},
      publish: async (_workspace, value) => protectedMode
        ? JSON.parse(JSON.stringify(value).replaceAll("PRIVATE_BODY", "SAFE_BODY")) : value,
      changed
    },
    () => {
      const batch: FunctionGuestRuntime[] = []
      guests.push(batch)
      const batchIndex = guests.length
      return {
        load: async (code, options) => {
          const guest = await FunctionGuestRuntime.create(code, options)
          batch.push(guest)
          await loaded(batchIndex)
          return guest
        },
        stop: () => {
          for (const guest of batch) void guest.dispose()
        },
        stopAndDrain: async () => {
          await Promise.all(batch.map((guest) => guest.dispose()))
          await drain(batchIndex)
        }
      }
    }
  )
  const compiled = await compileFunctionPlugin(path)
  store.grant(root, "function:recovery-demo", compiled.digest, true)
  cleanup.push(async () => {
    manager.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    store.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-runtime-recovery-/)
    await rm(root, { recursive: true, force: true })
  })
  const read = (key: string) =>
    store.functionState.get(JSON.stringify([root, "recovery-demo"]), key)
  const values = new FunctionUserConfigValues(store)
  const saveConfig = () =>
    values.save(root, compiled.name, compiled.userConfig!, "tone", "new", 0, () => {})
  return { root, manager, guests, read, changed, saveConfig }
}

it("retires only the lost entry and requires trusted explicit initialization without replaying effects", async () => {
  const f = await fixture()
  const facts = { text: "healthy history", isFirstOfReply: true }
  const dead = await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  const healthy = await f.manager.siteMount(f.root, "healthy", "AssistantMessage")
  const stable = await f.manager.siteRender(f.root, "healthy", healthy!, facts)
  expect(f.read("starts")).toBe(2)
  const [command] = await f.manager.commands(f.root, "lost")
  const running = f.manager
    .runCommand(f.root, "lost", command, "", new AbortController().signal)
    .catch((error: unknown) => error)
  await vi.waitFor(() => expect(f.read("effects")).toBe(1))
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  expect(await running).toBeInstanceOf(Error)
  await expect(f.manager.siteRender(f.root, "lost", dead!, facts)).rejects.toThrow()
  await expect(f.manager.siteMount(f.root, "lost", "AssistantMessage")).resolves.toBeNull()
  await expect(f.manager.siteMountOutcome(f.root, "lost", "AssistantMessage")).resolves.toEqual({
    state: "inactive", reason: "no-protection-or-functions"
  })
  await expect(f.manager.commands(f.root, "lost")).resolves.toEqual([])
  expect(f.read("starts")).toBe(2)
  expect(f.read("effects")).toBe(1)
  expect((await f.manager.siteRender(f.root, "healthy", healthy!, facts))?.generation).toBe(
    stable?.generation
  )
  const signal = new AbortController().signal
  const view = await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
  expect(view.state).toBe("stopped")
  await expect(
    f.manager.reloadUserConfig(f.root, "lost", "p", view.digest, view.savedRevision, signal, () => {
      throw Error("OWNER_REVOKED")
    })
  ).rejects.toThrow("OWNER_REVOKED")
  expect(f.read("starts")).toBe(2)
  await f.manager.reloadUserConfig(
    f.root,
    "lost",
    "p",
    view.digest,
    view.savedRevision,
    signal,
    () => {}
  )
  expect(f.read("starts")).toBe(3)
  expect(f.read("effects")).toBe(1)
  await expect(f.manager.runCommand(f.root, "lost", command, "", signal)).rejects.toThrow(
    "MODS_COMMAND_STALE"
  )
  expect(await f.manager.siteMount(f.root, "lost", "AssistantMessage")).toBeTypeOf("string")
  expect((await f.manager.siteRender(f.root, "healthy", healthy!, facts))?.generation).toBe(
    stable?.generation
  )
})

it("keeps stopped transcript content protected without replaying guests and retires it on recovery", async () => {
  const f = await fixture(undefined, false, undefined, true)
  const [command] = await f.manager.commands(f.root, "lost")
  await Promise.all(f.guests[0].map(guest => guest.dispose()))
  await expect(f.manager.runCommand(f.root, "lost", command, "",
    new AbortController().signal)).rejects.toThrow()
  const owner = await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  expect(owner).toBeTypeOf("string")
  const frame = await f.manager.siteRender(f.root, "lost", owner!, {
    text: "PRIVATE_BODY", isFirstOfReply: true
  })
  expect(JSON.stringify(frame)).toContain("SAFE_BODY")
  expect(JSON.stringify(frame)).not.toContain("PRIVATE_BODY")
  expect(f.read("starts")).toBe(1)
  expect(f.read("effects")).toBeUndefined()
  const signal = new AbortController().signal
  const view = await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
  await f.manager.reloadUserConfig(f.root, "lost", "p", view.digest,
    view.savedRevision, signal, () => {})
  await expect(f.manager.siteRender(f.root, "lost", owner!, {
    text: "PRIVATE_BODY", isFirstOfReply: true
  })).rejects.toThrow()
  expect(f.read("starts")).toBe(2)
})

it("offers explicit recovery when settings are opened directly after guest loss", async () => {
  const f = await fixture()
  await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  const view = await f.manager.userConfig(
    f.root,
    "lost",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view.state).toBe("stopped")
  expect(view.error).toContain("未完成操作")
  expect(view.fields).toEqual([])
  expect(f.read("starts")).toBe(1)
})

it("blocks explicit initialization until the old physical drain is acknowledged", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(() => held)
  await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  const signal = new AbortController().signal
  const view = await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
  const reload = () =>
    f.manager.reloadUserConfig(
      f.root,
      "lost",
      "p",
      view.digest,
      view.savedRevision,
      signal,
      () => {}
    )
  await expect(reload()).rejects.toThrow("尚未确认结束")
  expect(f.read("starts")).toBe(1)
  release()
  await vi.waitFor(async () => {
    await reload()
    expect(f.read("starts")).toBe(2)
  })
})

it("retains the stopped fence when physical retirement fails", async () => {
  const f = await fixture(async () => {
    throw Error("PRIVATE_DRAIN_FAILURE")
  })
  await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  const signal = new AbortController().signal
  await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
  await vi.waitFor(async () => {
    const view = await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
    expect(view.error).toContain("清理失败")
    expect(view.error).not.toContain("PRIVATE_DRAIN_FAILURE")
    await expect(
      f.manager.reloadUserConfig(
        f.root,
        "lost",
        "p",
        view.digest,
        view.savedRevision,
        signal,
        () => {}
      )
    ).rejects.toThrow("清理失败")
  })
  expect(f.read("starts")).toBe(1)
})

it("requires an owned host operation to settle even after the guest drain acknowledges", async () => {
  let drained = false
  const f = await fixture(async () => {
    drained = true
  })
  const signal = new AbortController().signal
  const operation = await f.manager.prepareFlowScope(
    f.root,
    "lost",
    "recovery-demo",
    "owned-flow",
    "a".repeat(64),
    signal
  )
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  const view = await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
  await vi.waitFor(() => expect(drained).toBe(true))
  const reload = () =>
    f.manager.reloadUserConfig(
      f.root,
      "lost",
      "p",
      view.digest,
      view.savedRevision,
      signal,
      () => {}
    )
  await expect(reload()).rejects.toThrow("尚未确认结束")
  expect(f.read("starts")).toBe(1)
  operation.dispose()
  await reload()
  expect(f.read("starts")).toBe(2)
})

it("does not let pending automatic configuration initialize a replacement for a dead guest", async () => {
  const f = await fixture(undefined, true)
  await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  f.saveConfig()
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  await f.manager.commands(f.root, "lost").catch(() => [])
  expect(f.guests).toHaveLength(1)
  expect(f.read("starts")).toBe(1)
  const view = await f.manager.userConfig(
    f.root,
    "lost",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view.state).toBe("stopped")
})

it("rejects candidate adoption when the old guest exits during automatic preparation", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(undefined, true, async (batch) => {
    if (batch === 2) await held
  })
  await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  f.saveConfig()
  const preparing = f.manager.commands(f.root, "lost").catch(() => [])
  await vi.waitFor(() => expect(f.guests[1]).toHaveLength(1))
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  release()
  await preparing
  const view = await f.manager.userConfig(
    f.root,
    "lost",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view.state).toBe("stopped")
  expect(f.read("starts")).toBe(1)
  expect(f.guests).toHaveLength(2)
  expect(f.guests[1].every((guest) => guest.stats.disposed)).toBe(true)
  await expect(f.manager.commands(f.root, "lost")).resolves.toEqual([])
  expect(f.guests).toHaveLength(2)
})

it("retains an unconfirmed candidate cleanup in the same stopped recovery fence", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(
    async (batch) => {
      if (batch === 2) throw Error("CANDIDATE_DRAIN_UNKNOWN")
    },
    true,
    async (batch) => {
      if (batch === 2) await held
    }
  )
  await f.manager.siteMount(f.root, "lost", "AssistantMessage")
  f.saveConfig()
  const preparing = f.manager.commands(f.root, "lost").catch(() => [])
  await vi.waitFor(() => expect(f.guests[1]).toHaveLength(1))
  await Promise.all(f.guests[0].map((guest) => guest.dispose()))
  release()
  await preparing
  const signal = new AbortController().signal
  const view = await f.manager.userConfig(f.root, "lost", "p", signal, () => {})
  await expect(
    f.manager.reloadUserConfig(
      f.root,
      "lost",
      "p",
      view.digest,
      view.savedRevision,
      signal,
      () => {}
    )
  ).rejects.toThrow("清理失败")
  expect(f.guests).toHaveLength(2)
})
