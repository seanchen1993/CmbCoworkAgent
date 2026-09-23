import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import type { ModObject } from "../../../shared/mods/types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function fixture(code = 'on("tool.call",($,e,next)=>next(e))') {
  const root = await mkdtemp(join(tmpdir(), "mods-classic-empty-"))
  const plugin = join(root, "plugin")
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  await writeFile(join(plugin, "hooks/register.ts"), `export function register(on){${code}}`)
  const store = new ModControlStore(join(root, "control.sqlite"))
  const plugins = vi.fn(() => [
    { id: "source", name: "function-commands", path: plugin, enabled: true }
  ])
  const publish = vi.fn(async (_workspace: string, value: unknown) =>
    JSON.parse(JSON.stringify(value).replaceAll("SECRET", "FILTERED"))
  )
  let enabled = true
  const manager = new FunctionModsManager(
    store,
    { plugins, enabled: () => enabled, publish, changed: () => undefined },
    () => {
      const guests = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.add(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const status = await manager.status(root)
  await manager.approve(root, "source", status[0].digest!)
  await manager.commands(root, "thread")
  plugins.mockClear()
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "thread",
    cwd: root,
    transcript_path: "",
    tool_response: "SECRET"
  }
  const core = vi.fn(async (input: ModObject) => {
    void input
    return { additionalContext: ["native"] }
  })
  const call = () =>
    manager.classicEvent(
      root,
      "thread",
      "classic.PostToolUse",
      input,
      new AbortController().signal,
      core
    )
  return {
    manager,
    store,
    root,
    plugins,
    publish,
    core,
    call,
    setEnabled(value: boolean) {
      enabled = value
      manager.invalidate(root)
    }
  }
}

it("avoids repeated source discovery for a live session with no matching classic handler", async () => {
  const f = await fixture()
  await expect(f.call()).resolves.toEqual({ additionalContext: ["native"] })
  expect(f.plugins).not.toHaveBeenCalled()
  expect(f.core).toHaveBeenCalledOnce()
  expect(f.core.mock.calls[0]?.[0]).toMatchObject({ tool_response: "FILTERED" })
  expect(f.publish).toHaveBeenCalled()
})

it("still checks grants before the native core on an empty classic chain", async () => {
  const f = await fixture()
  const grant = f.store.getGrant(f.root, "function:function-commands")!
  f.store.grant(f.root, grant.modId, grant.digest, false)
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
  expect(f.core).not.toHaveBeenCalled()
})

it("keeps wildcard classic handlers and reload discovery on their original route", async () => {
  const f = await fixture(
    'on("classic.*",async($,e,next)=>{await next(e);return {additionalContext:["wildcard"]}})'
  )
  await expect(f.call()).resolves.toEqual({ additionalContext: ["wildcard"] })
  expect(f.plugins).toHaveBeenCalled()
  f.manager.invalidate(f.root)
  f.plugins.mockClear()
  await f.call()
  expect(f.plugins).toHaveBeenCalled()
})

it("keeps disabled calls free of discovery and respects invalidation while publication waits", async () => {
  const f = await fixture()
  f.setEnabled(false)
  await f.call()
  expect(f.plugins).not.toHaveBeenCalled()
  f.setEnabled(true)
  await f.manager.commands(f.root, "thread")
  f.core.mockClear()
  f.publish.mockImplementationOnce(async () => {
    f.manager.invalidate(f.root)
    return {}
  })
  await expect(f.call()).rejects.toThrow("MODS_SCOPE_CHANGED")
  expect(f.core).not.toHaveBeenCalled()
})
