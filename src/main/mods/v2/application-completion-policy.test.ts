import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
async function fixture(
  beforePublish?: (value: ModJson, signal?: AbortSignal) => Promise<void>,
  example = false
) {
  const root = await mkdtemp(join(tmpdir(), "mods-application-policy-"))
  const plugin = join(root, "plugin")
  await mkdir(join(plugin, "hooks"), { recursive: true })
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "policy", version: "1.0.0" }))
  await writeFile(
    join(plugin, "hooks/hooks.json"),
    JSON.stringify({ modules: [example ? "./gate.ts" : "./register.ts"] })
  )
  if (example)
    for (const file of ["gate.ts", "core.js"])
      await cp(join("examples/autobiz-kanban-mods/hooks/kanban", file), join(plugin, "hooks", file))
  if (example)
    await writeFile(join(plugin, "hooks/workflow.generated.ts"), "export const variants = {}")
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
      if(e.args==="source") return {text: (await $.store.get("completion-config"))?._cmbPolicySource || "plugin"}
      if(e.args==="ordinary-write") await $.store.set("completion-config-source","changed")
      if(e.args==="ordinary-delete") await $.store.delete("completion-config-source")
      if(e.args==="ordinary-keys") return {text: JSON.stringify(await $.store.keys())}
      if(e.args.startsWith("ordinary-")) return {text: String(await $.store.get("completion-config-source"))}
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
  const command = async (args: string, name = "policy") =>
    manager.runCommand(
      root,
      "thread",
      (await manager.commands(root, "thread")).find((command) => command.command === name)!,
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
  expect(await f.command("source")).toMatchObject({ text: "application" })
  expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toMatchObject(rule)
})

it.each([false, true])(
  "preserves ordinary completion-config-source data across reload with app policy=%s",
  async (application) => {
    const f = await fixture()
    const namespace = JSON.stringify([f.root, "policy"])
    f.store.functionState.set(namespace, "completion-config-source", "old-user-value")
    if (application) f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
    f.reopen()
    await f.start()
    expect(await f.command("ordinary-read")).toMatchObject({ text: "old-user-value" })
    expect(JSON.parse((await f.command("ordinary-keys")).text!)).toContain(
      "completion-config-source"
    )
    expect(await f.command("ordinary-write")).toMatchObject({ text: "changed" })
    expect(await f.command("ordinary-delete")).toMatchObject({ text: "undefined" })
    expect(JSON.parse((await f.command("ordinary-keys")).text!)).not.toContain(
      "completion-config-source"
    )
    if (application) {
      expect(await f.command("source")).toMatchObject({ text: "application" })
      expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toEqual(rule)
      expect(await f.command("set")).toMatchObject({ text: expect.stringContaining("HOST_OWNED") })
    }
  }
)

it("explains application-managed rules in both public example commands without writing legacy aliases", async () => {
  const f = await fixture(undefined, true)
  f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
  await f.start()
  for (const [name, args] of [
    ["kanban-mode", "off"],
    ["kanban-target", "missing.ts"]
  ]) {
    expect(await f.command(args, name)).toMatchObject({ text: expect.stringContaining("应用设置") })
  }
  const namespace = JSON.stringify([f.root, "policy"])
  expect(f.store.functionState.get(namespace, "review-mode")).toBeUndefined()
  expect(f.store.functionState.get(namespace, "review-target")).toBeUndefined()
  expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toEqual(rule)
})

it.each(["kanban-mode", "kanban-target"])(
  "handles application ownership change during %s without writing aliases",
  async (command) => {
    let intercept = false
    const f = await fixture(async (value) => {
      // Host publication of the proposed write yields after the first writable check.
      if (
        intercept &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ((command === "kanban-mode" && value.mode === "repair") ||
          (command === "kanban-target" && value.target === "example.ts"))
      ) {
        intercept = false
        f.manager.setCompletionPolicy(f.root, "thread", "policy", rule)
      }
    }, true)
    await writeFile(join(f.root, "example.ts"), "export const value = 1")
    await f.start()
    intercept = true
    expect(
      await f.command(command === "kanban-mode" ? "repair" : "example.ts", command)
    ).toMatchObject({ text: expect.stringContaining("应用设置") })
    expect(intercept).toBe(false)
    const namespace = JSON.stringify([f.root, "policy"])
    expect(f.store.functionState.get(namespace, "review-mode")).toBeUndefined()
    expect(f.store.functionState.get(namespace, "review-target")).toBeUndefined()
    expect(f.manager.completionPolicy(f.root, "thread", "policy").policy).toEqual(rule)
  }
)

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
