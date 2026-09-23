import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy"
import type { ModJson } from "../../../shared/mods/types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function fixture(beforePublish?: (value: ModJson, signal?: AbortSignal) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mods-application-policy-"))
  const plugin = join(root, "plugin")
  await mkdir(join(plugin, "hooks"), { recursive: true })
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "policy", version: "1.0.0" }))
  await writeFile(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(
    join(plugin, "hooks/register.ts"),
    `export function register(on) {
    on("session.start", async($,e,next)=>{
      await $.command.register({name:"policy",description:"policy test"}); return next(e)
    })
    on("command.run", async($,e)=>{
      try {
      if(e.args==="set") await $.store.set("completion-config",{mode:"off"})
      if(e.args==="delete") await $.store.delete("completion-config")
      return {text:JSON.stringify(await $.store.get("completion-config"))}
      } catch(error) { return {text:String(error)} }
    })
    on("completion.check",()=>({decision:"block",reason:"review found a defect"}))
  }`
  )
  const path = join(root, "control.sqlite")
  let store = new ModControlStore(path)
  const create = () =>
    new FunctionModsManager(
      store,
      {
        plugins: () => [{ id: "policy", name: "policy", path: plugin, enabled: true }],
        enabled: () => true,
        publish: async (_root, value, signal) => {
          await beforePublish?.(value, signal)
          return value
        },
        changed: () => {}
      },
      () => {
        const guests: FunctionGuestRuntime[] = []
        return {
          async load(code, options) {
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
  let manager = create()
  const status = await manager.status(root)
  await manager.approve(root, "policy", status[0].digest!)
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const start = () =>
    manager.turnStart(
      root,
      "thread",
      { turnId: "turn", text: "review" },
      new AbortController().signal
    )
  const gate = () => manager.completionGate(root, "thread", () => ({ turnId: "turn" }))
  const run = async () =>
    (await gate())!({
      signal: new AbortController().signal,
      revisionAttempts: 0,
      maxRevisionAttempts: 2
    })
  const command = async (args: string) =>
    manager.runCommand(
      root,
      "thread",
      (await manager.commands(root, "thread"))[0],
      args,
      new AbortController().signal
    )
  return {
    root,
    start,
    gate,
    run,
    command,
    get manager() {
      return manager
    },
    get store() {
      return store
    },
    reopen() {
      manager.close()
      store.close()
      store = new ModControlStore(path)
      manager = create()
    }
  }
}
const rule = {
  ...DEFAULT_COMPLETION_POLICY,
  mode: "check" as const,
  scope: "diff" as const,
  checks: ["code-review" as const]
}

it("keeps legacy plugin policy until the user saves an application-owned project rule", async () => {
  const f = await fixture()
  f.store.functionState.set(JSON.stringify([f.root, "policy"]), "completion-config", {
    mode: "off"
  })
  expect(f.manager.completionPolicy(f.root, "thread", "policy").source).toBe("plugin")
  f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
  expect(f.manager.completionPolicy(f.root, "thread", "policy")).toMatchObject({
    source: "application",
    policy: rule
  })
  await f.start()
  expect(await f.run()).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("review found a defect")
  })
})

it("prevents a real guest from overwriting or deleting the application rule", async () => {
  const f = await fixture()
  f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
  await f.start()
  for (const args of ["set", "delete"])
    await expect(f.command(args)).resolves.toMatchObject({
      text: expect.stringContaining("MODS_COMPLETION_POLICY_HOST_OWNED")
    })
  expect(JSON.parse((await f.command("get")).text!)).toMatchObject(rule)
  expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toMatchObject(rule)
})

it("persists explicit off across restart and cannot be re-enabled by old plugin state", async () => {
  const f = await fixture()
  f.manager.setCompletionPolicy(f.root, "thread", "policy", { ...rule, mode: "off" })
  f.reopen()
  f.store.functionState.set(JSON.stringify([f.root, "policy"]), "completion-config", {
    mode: "repair"
  })
  await f.start()
  expect(await f.gate()).toBeUndefined()
  expect(f.store.completionEvidence(f.root, "thread")).toEqual([])
  expect(f.manager.completionPolicy(f.root, "thread", "policy")).toMatchObject({
    source: "application",
    policy: { mode: "off" }
  })
  expect(f.manager.completionPolicy(join(f.root, "other"), "other-thread", "policy").source).toBe(
    "default"
  )
})

it("rejects invalid and unapproved writes without changing the previous policy", async () => {
  const f = await fixture()
  f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
  expect(() =>
    f.manager.setCompletionPolicy(f.root, "thread", "policy", { ...rule, timeoutMs: 0 })
  ).toThrow()
  expect(() => f.manager.setCompletionPolicy(f.root, "thread", "unknown", rule)).toThrow(
    "MODS_PLUGIN_UNAPPROVED"
  )
  expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toMatchObject(rule)
})

it.each(["file", "feature"] as const)(
  "requires an explicit %s scope selector for an enabled application policy",
  async (scope) => {
    const f = await fixture()
    f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
    expect(() =>
      f.manager.setCompletionPolicy(f.root, "thread", "policy", { ...rule, scope })
    ).toThrow("MODS_COMPLETION_SCOPE_REQUIRED")
    expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toMatchObject(rule)
    expect(() =>
      f.manager.setCompletionPolicy(f.root, "thread", "policy", { ...rule, scope, mode: "off" })
    ).not.toThrow()
  }
)

it.each(["configuration", "runtime", "thread"])(
  "aborts an in-flight completion check on %s change",
  async (kind) => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let aborted = false
    const f = await fixture(async (value, signal) => {
      if (value && typeof value === "object" && !Array.isArray(value) && "evidenceId" in value) {
        signal!.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true }
        )
        entered()
        await hold
      }
    })
    f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
    await f.start()
    const running = f.run().catch((error: unknown) => error)
    try {
      await ready
      if (kind === "configuration")
        f.manager.setCompletionPolicy(f.root, "thread", "policy", { ...rule, mode: "off" })
      else if (kind === "runtime") f.manager.invalidate(f.root)
      else f.manager.closeThread("thread")
      expect(aborted).toBe(true)
    } finally {
      release()
      await running
    }
    expect(await f.gate()).toBeUndefined()
    expect(
      f.store.completionEvidence(f.root, "thread").some((record) => record.status === "pass")
    ).toBe(false)
  }
)

it("persists an explicitly app-owned checkpoint stage without allowing guest state to enable it", async () => {
  const f = await fixture()
  const policy = {
    ...rule,
    checks: ["autobiz-validator"],
    feature: "order-export",
    autobizStartCheckpoint: "requirements_eval_in_progress"
  }
  f.store.functionState.set(
    JSON.stringify([f.root, "policy"]),
    "completion-config",
    policy as unknown as ModJson
  )
  expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).not.toHaveProperty(
    "autobizStartCheckpoint"
  )
  expect(f.manager.setCompletionPolicy(f.root, "thread", "policy", policy).policy).toMatchObject(
    policy
  )
  f.reopen()
  expect(f.manager.completionPolicy(f.root, "thread", "policy")).toMatchObject({
    source: "application",
    policy
  })
})

it.each([
  { mode: "report" },
  { feature: undefined },
  { checks: ["unit-test"] },
  { autobizStartCheckpoint: "../checkpoint" }
])("rejects an unsafe automatic checkpoint configuration: %j", async (patch) => {
  const f = await fixture()
  expect(() =>
    f.manager.setCompletionPolicy(f.root, "thread", "policy", {
      ...rule,
      checks: ["autobiz-validator"],
      feature: "order-export",
      autobizStartCheckpoint: "requirements_eval_in_progress",
      ...patch
    })
  ).toThrow("MODS_AUTOBIZ_STAGE_CONFIG_INVALID")
})
