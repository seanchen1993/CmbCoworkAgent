import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ClawComponentSelection } from "../../../shared/mods/claw-components"
import type { ModIdentity } from "../../../shared/mods/types"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy"
import { ClawStore } from "../claw-store"
import { ModControlStore, type ModGrant } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { functionCallIdentity } from "./host-call"
import { FunctionModsManager } from "./manager"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const signal = () => new AbortController().signal
const selected = (ids: string[], label = "review"): ClawComponentSelection => ({
  mode: "selected",
  ids,
  config: ids.includes("review") ? { review: { label } } : {}
})

async function fixture(explosive = false) {
  const root = await mkdtemp(join(tmpdir(), "component-manager-"))
  const source = join(root, "plugin")
  await mkdir(join(source, "mods"), { recursive: true })
  await writeFile(
    join(source, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "components",
      claw: {
        componentsVersion: 1,
        components: [
          {
            id: "review",
            name: "Review",
            kind: "module",
            entry: "./review.ts",
            dependsOn: ["core"],
            actionIds: ["review"],
            configSchema: {
              type: "object",
              properties: { label: { type: "string", minLength: 1 } },
              additionalProperties: false
            }
          },
          {
            id: "core",
            name: "Core",
            kind: "module",
            entry: "./core.ts",
            dependsOn: [],
            actionIds: []
          },
          {
            id: "rewrite",
            name: "Rewrite",
            kind: "module",
            entry: "./rewrite.ts",
            dependsOn: [],
            actionIds: ["rewrite"]
          }
        ],
        actions: ["review", "rewrite"].map((id) => ({ id, name: id, command: id, inputSchema: {} }))
      }
    })
  )
  await writeFile(
    join(source, "mods/core.ts"),
    `export function register(on) {
    on("session.start", {}, async ($, e, next) => {
      await $.store.set("core-count", ((await $.store.get("core-count")) || 0) + 1)
      await $.command.register({name:"core",description:"core"})
      return next(e)
    })
    on("command.run", {command:"core"}, async ($) => ({text:String(await $.store.get("core-count"))}))
  }`
  )
  for (const id of ["review", "rewrite"])
    await writeFile(
      join(source, `mods/${id}.ts`),
      `
    ${id === "rewrite" && explosive ? "globalThis.unselectedMarker = true" : ""}
    export function register(on, options) {
      on("session.start", {}, async ($, e, next) => {
        await $.command.register({name:${JSON.stringify(id)},description:${JSON.stringify(id)}})
        return next(e)
      })
      on("command.run", {command:${JSON.stringify(id)}}, async ($) => {
        await $.model.complete({model:"default",prompt:"audit"})
        return {output:{label:options.label || "default",core:await $.store.get("core-count"),unselected:globalThis.unselectedMarker === true}}
      })
    }`
    )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const identities: ModIdentity[] = []
  const grants: ModGrant[] = []
  let loads = 0
  let beforeLoad = async (): Promise<void> => {}
  let scopeFailure: string | undefined
  const completeModel = vi.fn(async (workspace: string, threadId: string, grant: ModGrant) => {
    const identity = functionCallIdentity(workspace, threadId, grant, {
      origin: "mod",
      fallbackTurnId: "turn"
    })
    identities.push(identity)
    grants.push(grant)
    store.claim(identity.callId, "model.complete", {}, identity)
    store.settle(identity.callId, "succeeded")
    return {
      isAnswered: true as const,
      text: "model",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    }
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "components", path: source, enabled: true }],
      enabled: () => true,
      clawApplicable: (thread) => thread !== "harness",
      clawScope: (threadId) => {
        if (threadId === scopeFailure) throw Error("THREAD_SCOPE_UNREADABLE")
        return { threadId, identity: JSON.stringify([threadId, "incarnation"]) }
      },
      changed: () => {},
      publish: async (_, value) => value,
      completeModelResult: completeModel
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          loads++
          await beforeLoad()
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
  cleanups.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const [status] = await manager.status(root)
  expect(status.state, status.error).toBe("needs-approval")
  await manager.approve(root, "source", status.digest!)
  // Approval deliberately probes the complete package in a separate disposable guest.
  loads = 0
  const claws = new ClawStore(store)
  const profile = (components?: ClawComponentSelection) => ({
    id: "profile",
    name: "Profile",
    capabilities: [
      {
        pluginId: "source",
        name: "components",
        digest: status.digest!,
        ...(components ? { components } : {})
      }
    ]
  })
  const bind = (threadId: string, components?: ClawComponentSelection) => {
    manager.closeThread(threadId)
    claws.apply(
      root,
      JSON.stringify([threadId, "incarnation"]),
      profile(components),
      claws.read(root).revision
    )
  }
  const invoke = async (threadId: string, actionId: string) => {
    const action = (await manager.actionCatalog(root, threadId)).find(
      (item) => item.actionId === actionId
    )!
    const prepared = await manager.prepareAction(root, threadId, action, signal())
    const value = await manager.runAction(
      root,
      threadId,
      prepared,
      {
        version: 1,
        input: {},
        config: {},
        task: "test",
        runId: "run",
        stepId: "step",
        executionId: "execution"
      },
      signal()
    )
    return { prepared, value }
  }
  return {
    root,
    source,
    store,
    manager,
    profile,
    claws,
    bind,
    invoke,
    status,
    identities,
    grants,
    completeModel,
    loads: () => loads,
    setLoadBarrier: (run: typeof beforeLoad) => {
      beforeLoad = run
    },
    setScopeFailure: (threadId: string) => {
      scopeFailure = threadId
    }
  }
}

it("loads only selected entries and explicit dependencies, never an unselected top level", async () => {
  const f = await fixture(true)
  f.bind("a", selected(["review", "core"], "chosen"))
  expect((await f.manager.commands(f.root, "a")).map((item) => item.command).sort()).toEqual([
    "core",
    "review"
  ])
  expect((await f.invoke("a", "review")).value.output).toEqual({
    label: "chosen",
    core: 1,
    unselected: false
  })
  expect((await f.manager.actionCatalog(f.root, "a")).map((item) => item.actionId)).toEqual([
    "review",
    "rewrite"
  ])
  await expect(f.invoke("a", "rewrite")).rejects.toThrow("CLAW_ACTION_NOT_EXPORTED")
  expect(f.completeModel).toHaveBeenCalledOnce()
  expect(f.loads()).toBe(1)
})

it("keeps distinct session grant objects and audit selections for the same package in two threads", async () => {
  const f = await fixture()
  f.bind("a", selected(["core", "review"], "A"))
  f.bind("b", selected(["rewrite"]))
  await f.invoke("a", "review")
  await f.invoke("b", "rewrite")
  await f.invoke("a", "review")
  expect(f.grants[0]).not.toBe(f.grants[1])
  expect(f.grants[0]).toBe(f.grants[2])
  expect(f.identities.map((entry) => entry.components?.ids)).toEqual([
    ["core", "review"],
    ["rewrite"],
    ["core", "review"]
  ])
  expect(f.identities[0].components?.selectionDigest).toBe(
    f.identities[2].components?.selectionDigest
  )
  expect(f.identities[0].components?.selectionDigest).not.toBe(
    f.identities[1].components?.selectionDigest
  )
  expect(
    f.store
      .audit(f.root)
      .filter((row) => row.identity?.threadId === "a")
      .map((row) => row.identity?.components?.ids)
  ).toEqual([
    ["core", "review"],
    ["core", "review"]
  ])
  expect(() =>
    functionCallIdentity(f.root, "b", f.grants[0], { origin: "mod", fallbackTurnId: "turn" })
  ).toThrow("CLAW_COMPONENT_SCOPE_CHANGED")
  f.bind("a", selected(["core", "review"], "A2"))
  await f.invoke("b", "rewrite")
  expect(f.grants[3]).toBe(f.grants[1])
  expect(f.identities[3].components).toEqual(f.identities[1].components)
})

it("rejects a prepared action after a config-only rebind and applies only the new component configuration", async () => {
  const f = await fixture()
  f.bind("a", selected(["core", "review"], "before"))
  const { prepared } = await f.invoke("a", "review")
  f.bind("a", selected(["core", "review"], "after"))
  await expect(
    f.manager.runAction(
      f.root,
      "a",
      prepared,
      {
        version: 1,
        input: {},
        config: {},
        task: "test",
        runId: "run",
        stepId: "step",
        executionId: "execution"
      },
      signal()
    )
  ).rejects.toThrow("CLAW_ACTION_CHANGED")
  expect(f.completeModel).toHaveBeenCalledOnce()
  expect((await f.invoke("a", "review")).value.output?.label).toBe("after")
  expect(f.identities[1].components?.selectionDigest).not.toBe(
    f.identities[0].components?.selectionDigest
  )
})

it.each([
  selected(["review"]),
  { ...selected(["core", "review"]), config: { review: { label: 42 } } }
])("rejects invalid dependencies/configuration before loading a guest: %j", async (selection) => {
  const f = await fixture()
  f.bind("a", selection as ClawComponentSelection)
  await expect(f.manager.commands(f.root, "a")).rejects.toThrow("组件选择、依赖或配置无效")
  expect(f.loads()).toBe(0)
  expect(f.completeModel).not.toHaveBeenCalled()
})

it("invalidates prepared actions, audit grants and Flow scope when component bindings change", async () => {
  const f = await fixture()
  f.bind("a", selected(["core", "review"], "first"))
  const { prepared } = await f.invoke("a", "review")
  const old = (await f.manager.commands(f.root, "a")).find((entry) => entry.command === "review")!
  const scope = await f.manager.prepareFlowScope(f.root, "a", undefined, "run", "digest", signal())
  expect(scope.components).toMatchObject({
    components: { ids: ["core", "review"], selectionDigest: expect.any(String) }
  })
  const first = await scope.captureBinding(signal())
  f.bind("a", selected(["rewrite"]))
  expect(() => scope.assertLive()).toThrow()
  expect(() =>
    functionCallIdentity(f.root, "a", f.grants[0], { origin: "mod", fallbackTurnId: "turn" })
  ).toThrow("MODS_SCOPE_CHANGED")
  await expect(f.manager.runCommand(f.root, "a", old, "", signal())).rejects.toThrow()
  await expect(
    f.manager.runAction(
      f.root,
      "a",
      prepared,
      {
        version: 1,
        input: {},
        config: {},
        task: "test",
        runId: "run",
        stepId: "step",
        executionId: "execution"
      },
      signal()
    )
  ).rejects.toThrow("CLAW_ACTION_NOT_EXPORTED")
  const next = await f.manager.prepareFlowScope(f.root, "a", undefined, "run", "digest", signal())
  const second = await next.captureBinding(signal())
  expect(first.pluginDigests).toEqual(second.pluginDigests)
  expect(first.configFingerprint).not.toBe(second.configFingerprint)
  scope.dispose()
  next.dispose()
})

it("checks the real thread binding for mandatory rules and invalidates another warm partial session", async () => {
  const f = await fixture()
  const full = f.profile()
  f.claws.write(f.root, { revision: 0, profiles: [full], active: full }, 0)
  f.bind("a", selected(["core", "review", "rewrite"]))
  const mandatory = { ...DEFAULT_COMPLETION_POLICY, mode: "check" }
  expect(() => f.manager.setCompletionPolicy(f.root, "a", "components", mandatory)).toThrow(
    "全部组件"
  )
  f.bind("a", selected(["core", "review"]))
  f.bind("b", { mode: "all", ids: [], config: {} })
  await f.invoke("a", "review")
  const otherWorkspace = join(f.root, "other-workspace")
  await mkdir(otherWorkspace)
  await f.manager.approve(otherWorkspace, "source", f.status.digest!)
  const otherCommand = (await f.manager.commands(otherWorkspace, "other-thread")).find(
    (item) => item.command === "core"
  )!
  f.manager.setCompletionPolicy(f.root, "b", "components", mandatory)
  expect(() =>
    functionCallIdentity(f.root, "a", f.grants[0], { origin: "mod", fallbackTurnId: "turn" })
  ).toThrow("MODS_SCOPE_CHANGED")
  await expect(f.manager.commands(f.root, "a")).rejects.toThrow("强制完成规则")
  expect((await f.manager.commands(f.root, "b")).map((item) => item.command).sort()).toEqual([
    "core",
    "review",
    "rewrite"
  ])
  await expect(
    f.manager.runCommand(otherWorkspace, "other-thread", otherCommand, "", signal())
  ).resolves.toMatchObject({ text: "1" })
})

it.each(["off", "report", "check"] as const)(
  "keeps existing whole-package commands alive when policy becomes %s",
  async (mode) => {
    const f = await fixture()
    f.bind("a", { mode: "all", ids: [], config: {} })
    const command = (await f.manager.commands(f.root, "a")).find((item) => item.command === "core")!
    const loads = f.loads()
    f.manager.setCompletionPolicy(f.root, "a", "components", {
      ...DEFAULT_COMPLETION_POLICY,
      mode
    })
    await expect(f.manager.runCommand(f.root, "a", command, "", signal())).resolves.toMatchObject({
      text: "1"
    })
    expect(f.loads()).toBe(loads)
  }
)

it.each(["off", "report"] as const)(
  "does not discard a partial-component instance when policy becomes %s",
  async (mode) => {
    const f = await fixture()
    f.bind("a", selected(["core", "review"]))
    const command = (await f.manager.commands(f.root, "a")).find((item) => item.command === "core")!
    f.manager.setCompletionPolicy(f.root, "a", "components", {
      ...DEFAULT_COMPLETION_POLICY,
      mode
    })
    await expect(f.manager.runCommand(f.root, "a", command, "", signal())).resolves.toMatchObject({
      text: "1"
    })
  }
)

it("closes a loaded empty composition when another thread enables a mandatory package", async () => {
  const f = await fixture()
  f.claws.apply(
    f.root,
    JSON.stringify(["empty", "incarnation"]),
    {
      id: "empty",
      name: "Empty",
      capabilities: []
    },
    f.claws.read(f.root).revision
  )
  const scope = await f.manager.prepareFlowScope(
    f.root,
    "empty",
    undefined,
    "run",
    "digest",
    signal()
  )
  f.bind("whole", { mode: "all", ids: [], config: {} })
  f.manager.setCompletionPolicy(f.root, "whole", "components", {
    ...DEFAULT_COMPLETION_POLICY,
    mode: "check"
  })
  expect(() => scope.assertLive()).toThrow()
  await expect(f.manager.commands(f.root, "empty")).rejects.toThrow("强制完成规则")
  scope.dispose()
})

it("rejects a partial instance before its first snapshot when another thread enables a mandatory package", async () => {
  const f = await fixture()
  f.bind("partial", selected(["core", "review"]))
  f.bind("whole", { mode: "all", ids: [], config: {} })
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setLoadBarrier(async () => {
    entered()
    await hold
  })
  const loading = f.manager.commands(f.root, "partial").catch((error: unknown) => error)
  try {
    await ready
    f.manager.setCompletionPolicy(f.root, "whole", "components", {
      ...DEFAULT_COMPLETION_POLICY,
      mode: "check"
    })
  } finally {
    release()
  }
  expect(await loading).toBeInstanceOf(Error)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "components"]), "core-count")
  ).toBeUndefined()
  await expect(f.manager.commands(f.root, "partial")).rejects.toThrow("强制完成规则")
})

it("fails closed on an unreadable thread binding without skipping later partial instances", async () => {
  const f = await fixture()
  f.bind("broken", selected(["core", "review"]))
  f.bind("partial", selected(["rewrite"]))
  f.bind("whole", { mode: "all", ids: [], config: {} })
  await f.invoke("broken", "review")
  await f.invoke("partial", "rewrite")
  f.setScopeFailure("broken")
  expect(() =>
    f.manager.setCompletionPolicy(f.root, "whole", "components", {
      ...DEFAULT_COMPLETION_POLICY,
      mode: "check"
    })
  ).not.toThrow()
  for (const [index, threadId] of ["broken", "partial"].entries())
    expect(() =>
      functionCallIdentity(f.root, threadId, f.grants[index], {
        origin: "mod",
        fallbackTurnId: "turn"
      })
    ).toThrow("MODS_SCOPE_CHANGED")
  await expect(f.manager.commands(f.root, "partial")).rejects.toThrow("强制完成规则")
})
