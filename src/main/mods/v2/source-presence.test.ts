import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import type { ModPluginSource } from "../manager"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-source-presence-"))
  const reads = [0, 0]
  const sources: ModPluginSource[] = []
  for (let n = 0; n < 2; n++) {
    const path = join(root, `plugin-${n}`)
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({ name: `source-${n}`, version: "1.0.0" })
    )
    await writeFile(join(path, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    await writeFile(
      join(path, "hooks/register.ts"),
      'export function register(on){on("tool.call",($,e,next)=>next({...e,hops:e.hops+1}))}'
    )
    sources.push({
      id: `source-${n}`,
      name: `source-${n}`,
      enabled: true,
      get path() {
        reads[n]++
        return path
      }
    })
  }
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true,
    available = true
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => (available ? sources : []),
      enabled: () => enabled,
      publish: async (_root, value) => value,
      changed: () => {}
    },
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
  for (const entry of await manager.status(root))
    await manager.approve(root, entry.pluginId, entry.digest!)
  await manager.commands(root, "thread")
  reads.fill(0)
  const call = () =>
    manager.interceptTool(
      root,
      "thread",
      { tool: "read_file", tool_use_id: "test-call", hops: 0 },
      new AbortController().signal,
      async (input) => ({ result: input.hops })
    )
  return {
    root,
    manager,
    store,
    reads,
    call,
    setEnabled(value: boolean) {
      enabled = value
    },
    removeSources() {
      available = false
    }
  }
}

it("stops presence discovery at the first source while both live guests still intercept", async () => {
  const f = await fixture()
  await expect(f.call()).resolves.toEqual({ result: 2 })
  expect(f.reads[0]).toBeGreaterThan(0)
  expect(f.reads[1]).toBe(0)
})

it("keeps off source-free and respects disappearance of every source without a cached answer", async () => {
  const f = await fixture()
  f.setEnabled(false)
  await expect(f.call()).resolves.toEqual({ result: 0 })
  expect(f.reads).toEqual([0, 0])
  f.setEnabled(true)
  f.removeSources()
  await expect(f.call()).resolves.toEqual({ result: 0 })
})

it("does not skip later guest grant checks when only the first source is inspected", async () => {
  const f = await fixture()
  const grant = f.store.getGrant(f.root, "function:source-1")!
  f.store.grant(f.root, grant.modId, grant.digest, false)
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
})
