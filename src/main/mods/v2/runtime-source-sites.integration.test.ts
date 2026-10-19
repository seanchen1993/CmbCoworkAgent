import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import {
  currentRuntimePluginSource,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const props = { isWorking: true, bodyColumns: 80, maxRows: 8 }

async function fixture() {
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
  const code = `export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"label",description:"Actual retained label"});return next(e)
    });
    on("ui.render",{component:"AbovePrompt"},($,e)=>{
      const {Text}=$.ui.resolve(e);return Text({children:"ACTUAL_RETAINED_LABEL"})
    })
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
  let active = true,
    incarnation = "original",
    enabled = true
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
      changed,
      publish: async (_workspace, value) => publish(value)
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
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
    const assertCurrent = () => {
      if (!active || !enabled || captured !== incarnation) throw Error("SOURCE_REVOKED")
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
      assertCurrent
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

it("retires the protected native drawing and cold-mounts a new exact retained Guest owner", async () => {
  const f = await fixture()
  const cold = await f.mount()
  expect(cold.state).toBe("mounted")
  if (cold.state !== "mounted") throw Error("native owner required")
  expect(JSON.stringify(await f.render(cold.owner))).not.toContain("ACTUAL_RETAINED_LABEL")
  expect(f.activeGuests()).toHaveLength(0)
  expect((await f.admit()).map((item) => item.command)).toEqual(["label"])
  expect(f.activeGuests()).toHaveLength(1)
  expect(f.store.getGrant(f.workspace, "function:trial-label")).toBeNull()
  await expect(f.render(cold.owner)).rejects.toThrow("MODS_UI_SITE_CLOSED")
  expect(f.changed.mock.calls.some(([, scope]) => scope?.startsWith("source-replaced:"))).toBe(true)
  const fresh = await f.mount()
  expect(fresh.state).toBe("mounted")
  if (fresh.state !== "mounted") throw Error("new Guest owner required")
  expect(fresh.owner).not.toBe(cold.owner)
  expect(JSON.stringify(await f.render(fresh.owner))).toContain("ACTUAL_RETAINED_LABEL")
  expect(f.activeGuests()).toHaveLength(1)
})

it("native consent alone does not load or grant an uninstalled candidate to a display caller", async () => {
  const f = await fixture(),
    cold = await f.mount()
  expect(cold.state).toBe("mounted")
  if (cold.state !== "mounted") throw Error("native owner required")
  expect(JSON.stringify(await f.render(cold.owner))).not.toContain("ACTUAL_RETAINED_LABEL")
  expect(f.activeGuests()).toHaveLength(0)
  expect(await f.manager.commands(f.workspace, "ordinary-thread")).toEqual([])
})

it("rejects an old native render held across retained-source admission instead of publishing it", async () => {
  const f = await fixture(),
    cold = await f.mount()
  if (cold.state !== "mounted") throw Error("native owner required")
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  f.setPublish(async (value) => {
    entered.resolve()
    await release.promise
    return value
  })
  const rendering = f.render(cold.owner)
  void rendering.catch(() => {})
  await entered.promise
  f.setPublish(async (value) => value)
  await f.admit()
  release.resolve()
  await expect(rendering).rejects.toThrow()
})

it.each(["revoke", "rebind", "disable"] as const)(
  "does not reuse a retained display admission after %s",
  async (change) => {
    const f = await fixture()
    await f.admit()
    const fresh = await f.mount()
    if (fresh.state !== "mounted") throw Error("Guest owner required")
    expect(JSON.stringify(await f.render(fresh.owner))).toContain("ACTUAL_RETAINED_LABEL")
    f[change]()
    await expect(f.render(fresh.owner)).rejects.toThrow()
    if (change !== "disable") await expect(f.mount()).rejects.toThrow()
  }
)

it("does not borrow another opaque operation or keep an old owner after same-thread replacement", async () => {
  const f = await fixture()
  await f.admit()
  const fresh = await f.mount()
  if (fresh.state !== "mounted") throw Error("Guest owner required")
  const other = issueRuntimePluginSourceToken({
    ...withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!),
    operationId: "foreign"
  })
  await expect(withRuntimePluginSource(other, f.mount)).rejects.toThrow(
    "MODS_RUNTIME_SOURCE_CHANGED"
  )
  await expect(withRuntimePluginSource(other, () => f.render(fresh.owner))).rejects.toThrow(
    "MODS_RUNTIME_SOURCE_CHANGED"
  )
  await f.manager.closeThreadAndWait("stage")
  f.rebind()
  const replacement = f.mint("replacement")
  await withRuntimePluginSource(replacement, () => f.manager.commands(f.workspace, "stage"))
  const next = await f.mount()
  if (next.state !== "mounted") throw Error("replacement owner required")
  expect(next.owner).not.toBe(fresh.owner)
  await expect(f.render(fresh.owner)).rejects.toThrow("MODS_UI_SITE_CLOSED")
  expect(JSON.stringify(await f.render(next.owner))).toContain("ACTUAL_RETAINED_LABEL")
})

it("checks the exact project grant and current source bytes on each new drawing admission", async () => {
  const f = await fixture()
  await f.admit()
  f.store.grantProjectFunction(
    f.workspace,
    "trial",
    "a".repeat(64),
    "trial-label",
    f.facts!.digest,
    false
  )
  await expect(f.mount()).rejects.toThrow("MODS_GRANT_REVOKED")
  f.store.grantProjectFunction(
    f.workspace,
    "trial",
    "a".repeat(64),
    "trial-label",
    f.facts!.digest,
    true
  )
  // Regranting cannot revive an entry captured under the previous grant epoch.
  await expect(f.mount()).rejects.toThrow("MODS_GRANT_REVOKED")
  await f.manager.closeThreadAndWait("stage")
  await f.admit()
  writeFileSync(join(f.path, "mods/main.ts"), "export function register() {}")
  await expect(f.mount()).rejects.toThrow("SOURCE_CHANGED")
})

it("keeps the protected native drawing when source admission itself fails", async () => {
  const f = await fixture(),
    cold = await f.mount()
  if (cold.state !== "mounted") throw Error("native owner required")
  f.revoke()
  await expect(f.admit()).rejects.toThrow("SOURCE_REVOKED")
  expect(JSON.stringify(await f.render(cold.owner))).not.toContain("ACTUAL_RETAINED_LABEL")
  expect(f.activeGuests()).toHaveLength(0)
})

it("rejects parallel drawing and remount continuations when the original source is revoked", async () => {
  const f = await fixture()
  await f.admit()
  const fresh = await f.mount()
  if (fresh.state !== "mounted") throw Error("Guest owner required")
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  f.setPublish(async (value) => {
    entered.resolve()
    await release.promise
    return value
  })
  const rendering = f.render(fresh.owner)
  void rendering.catch(() => {})
  await entered.promise
  const remount = f.mount()
  void remount.catch(() => {})
  f.revoke()
  release.resolve()
  await expect(rendering).rejects.toThrow()
  await expect(remount).rejects.toThrow()
  expect(f.activeGuests()).toHaveLength(1)
})
