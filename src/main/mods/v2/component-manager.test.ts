import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ClawComponentSelection } from "../../../shared/mods/claw-components"
import type { ModIdentity, ModJson, ModObject } from "../../../shared/mods/types"
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

async function fixture(explosive = false, scoped = false, middleware?: "tool.call" | "turn.*" | "agent.list") {
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
            ...(scoped ? { usage: "project" } : {}),
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
            ...(scoped ? { usage: "chat" } : {}),
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
    ${middleware === "tool.call" ? 'on("tool.call",async($,e,next)=>next(e))' : ""}
    ${middleware === "turn.*" ? 'on("turn.*",async function*($,e,next){return yield* next(e)})' : ""}
    on("session.start", {}, async ($, e, next) => {
      await $.store.set("core-count", ((await $.store.get("core-count")) || 0) + 1)
      await $.command.register({name:"core",description:"core"})
      return next(e)
    })
    on("command.run", {command:"core"}, async ($) => (${middleware === "agent.list"
      ? '{output:{agents:await $.agent.list()}}'
      : '{text:String(await $.store.get("core-count"))}'}))
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
  let usage: "chat" | "project" = "chat"
  const plugins = [{ id: "source", name: "components", path: source, enabled: true }]
  const installedPluginIds = vi.fn(() => new Set(plugins.map(plugin => plugin.id)))
  const publish = vi.fn(async (_workspace: string, value: ModJson) => value)
  const listAgents = vi.fn(async () => [{ id: "worker", description: "agent", type: "task", status: "idle" }])
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
      plugins: () => plugins,
      installedPluginIds,
      enabled: () => true,
      protects: () => true,
      captureSiteGuard: () => () => {},
      capabilityContext: () => ({ usage, identity: usage }),
      clawApplicable: (thread) => thread !== "harness",
      clawScope: (threadId) => {
        if (threadId === scopeFailure) throw Error("THREAD_SCOPE_UNREADABLE")
        return { threadId, identity: JSON.stringify([threadId, "incarnation"]) }
      },
      changed: () => {},
      publish,
      listAgents,
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
    publish,
    listAgents,
    plugins,
    installedPluginIds,
    setUsage: (next: typeof usage) => { usage = next },
    loads: () => loads,
    setLoadBarrier: (run: typeof beforeLoad) => {
      beforeLoad = run
    },
    setScopeFailure: (threadId: string) => {
      scopeFailure = threadId
    }
  }
}

it.each(["disable", "uninstall"])("keeps an unrelated selected guest after %s of another plugin", async (change) => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  const scope = await f.manager.prepareFlowScope(f.root, "a", undefined, "run", "digest", signal())
  const loads = f.loads()
  if (change === "disable")
    f.plugins.push({ id: "neighbor", name: "unused", path: join(f.root, "unused"), enabled: false })
  f.manager.pluginsChanged(f.root, ["neighbor"])
  expect(() => scope.assertLive()).not.toThrow()
  const command = (await f.manager.commands(f.root, "a")).find((item) => item.command === "core")!
  expect(await f.manager.runCommand(f.root, "a", command, "", signal())).toMatchObject({ text: "1" })
  expect(f.loads()).toBe(loads)
  scope.dispose()
})

it("repairs a cold cached binding after uninstall without requiring a previously mounted guest", async () => {
  const f = await fixture()
  f.bind("cold", selected(["core"]))
  expect(f.manager.clawSelection(f.root, "cold")?.capabilities).toHaveLength(1)
  f.plugins.splice(0)
  f.manager.pluginsChanged(f.root, ["source"])
  expect(f.manager.clawSelection(f.root, "cold")?.capabilities).toEqual([])
  expect(await f.manager.effectiveStatus(f.root, "cold")).toEqual([])
  expect(f.loads()).toBe(0)
})

it("does not reread the registry for every native chunk and refreshes it after uninstall", async () => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  await f.manager.commands(f.root, "a")
  const reads = f.installedPluginIds.mock.calls.length
  const stream = await f.manager.turnStep(f.root, "a", {
    turnId: "turn", index: 0, messageCount: 1, model: "native"
  }, async function* () {
    for (let i = 0; i < 5; i++) yield { kind: "text", text: String(i) }
    return { answer: "01234" }
  }, signal())
  await stream.next()
  await stream.next()
  expect(f.installedPluginIds).toHaveBeenCalledTimes(reads)
  f.plugins.splice(0)
  f.manager.pluginsChanged(f.root, ["source"])
  const remaining: ModJson[] = []
  for await (const chunk of stream) remaining.push(chunk)
  expect(remaining).toEqual([2, 3, 4].map(i => ({ kind: "text", text: String(i) })))
  expect(await stream.result).toEqual({ answer: "01234" })
  expect(f.installedPluginIds).toHaveBeenCalledTimes(reads + 1)
})

it("does not erase a live binding when the host registry cannot be read", async () => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  const before = f.claws.selection(f.root, '["a","incarnation"]')
  f.installedPluginIds.mockImplementation(() => { throw Error("PLUGIN_REGISTRY_INVALID") })
  expect(() => f.manager.clawSelection(f.root, "a")).toThrow("PLUGIN_REGISTRY_INVALID")
  expect(f.claws.selection(f.root, '["a","incarnation"]')).toEqual(before)
})

it.each([false, true])("keeps history and the next native turn usable after uninstall (bound=%s)", async (bound) => {
  const f = await fixture()
  if (bound) f.bind("a", selected(["core"]))
  const command = (await f.manager.commands(f.root, "a")).find(item => item.command === "core")!
  const old = await f.manager.siteMountOutcome(f.root, "a", "AssistantMessage")
  expect(old.state).toBe("mounted")
  f.plugins.splice(0)
  await rm(f.source, { recursive: true, force: true })
  f.manager.pluginsChanged(f.root, ["source"])
  await expect(f.manager.runCommand(f.root, "a", command, "", signal())).rejects.toThrow()
  for (const component of ["UserMessage", "AssistantMessage"] as const) {
    const mount = await f.manager.siteMountOutcome(f.root, "a", component)
    expect(mount.state).toBe("mounted")
    if (mount.state !== "mounted") throw Error("history must retain protected native presentation")
    const props: ModObject = component === "UserMessage"
      ? { text: "retained-history", isExpanded: false }
      : { text: "retained-history", isFirstOfReply: true }
    expect(JSON.stringify(await f.manager.siteRender(f.root, "a", mount.owner, props)))
      .toContain("retained-history")
  }
  const core = vi.fn(async () => ({ text: "next-tool" }))
  await expect(f.manager.interceptTool(f.root, "a", { tool: "read_file", tool_use_id: "next" }, signal(), core))
    .resolves.toEqual({ text: "next-tool" })
  expect(core).toHaveBeenCalledOnce()
  const stream = await f.manager.turnStep(f.root, "a", {
    turnId: "next-turn", index: 0, messageCount: 2, model: "native"
  }, async function* () { yield { kind: "text", text: "next-answer" }; return { answer: "next-answer" } }, signal())
  const chunks: ModJson[] = []
  for await (const chunk of stream) chunks.push(chunk)
  expect(chunks).toEqual([{ kind: "text", text: "next-answer" }])
  expect(await stream.result).toEqual({ answer: "next-answer" })
})

it.each(["disable", "uninstall"])("retires the actual source on %s while a host native tool completes once", async (change) => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  const scope = await f.manager.prepareFlowScope(f.root, "a", undefined, "run", "digest", signal())
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const core = vi.fn(async () => { entered.resolve(); await finish.promise; return { text: "NATIVE_RESULT" } })
  const pending = f.manager.interceptTool(f.root, "a", { tool: "mod_authoring", tool_use_id: "native" }, signal(), core)
  await entered.promise
  if (change === "disable") f.plugins[0].enabled = false
  else f.plugins.splice(0)
  f.manager.pluginsChanged(f.root, ["source"])
  expect(() => scope.assertLive()).toThrow()
  finish.resolve()
  await expect(pending).resolves.toEqual({ text: "NATIVE_RESULT" })
  expect(core).toHaveBeenCalledOnce()
  scope.dispose()
})

it.each(["approve", "revoke"] as const)("retires old guest authority after %s without cancelling a source-free native tool", async (change) => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  const scope = await f.manager.prepareFlowScope(f.root, "a", undefined, "run", "digest", signal())
  const command = (await f.manager.commands(f.root, "a")).find((item) => item.command === "core")!
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const core = vi.fn(async () => { entered.resolve(); await finish.promise; return { text: "NATIVE_RESULT" } })
  const pending = f.manager.interceptTool(f.root, "a", { tool: "mod_authoring", tool_use_id: "native" }, signal(), core)
  await entered.promise
  if (change === "approve") await f.manager.approve(f.root, "source", f.status.digest!)
  else f.manager.revoke(f.root, "components")
  expect(() => scope.assertLive()).toThrow()
  if (change === "revoke")
    await expect(f.manager.runCommand(f.root, "a", command, "", signal())).rejects.toThrow()
  finish.resolve()
  await expect(pending).resolves.toEqual({ text: "NATIVE_RESULT" })
  expect(core).toHaveBeenCalledOnce()
  expect(f.store.getGrant(f.root, "function:components")?.enabled).toBe(change === "approve")
  scope.dispose()
})

it("keeps the native model stream independent from a retired guest with no turn.step registration", async () => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  await f.manager.commands(f.root, "a")
  const finish = Promise.withResolvers<void>()
  const stream = await f.manager.turnStep(f.root, "a", { turnId: "turn", index: 0, messageCount: 1, model: "native" },
    async function* () { yield { kind: "text", text: "one" }; await finish.promise; yield { kind: "text", text: "two" }; return { answer: "onetwo" } }, signal())
  expect((await stream.next()).value).toEqual({ kind: "text", text: "one" })
  f.plugins[0].enabled = false
  f.manager.pluginsChanged(f.root, ["source"])
  finish.resolve()
  expect((await stream.next()).value).toEqual({ kind: "text", text: "two" })
  await stream.next()
  expect(await stream.result).toEqual({ answer: "onetwo" })
})

it.each(["disable", "uninstall"])("does not replay a real tool.call chain after %s", async (change) => {
  const f = await fixture(false, false, "tool.call")
  f.bind("a", selected(["core"]))
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const core = vi.fn(async () => { entered.resolve(); await finish.promise; return { text: "OLD_RESULT" } })
  const pending = f.manager.interceptTool(f.root, "a", { tool: "mod_authoring", tool_use_id: "native", args: {} }, signal(), core)
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  if (change === "disable") f.plugins[0].enabled = false
  else f.plugins.splice(0)
  f.manager.pluginsChanged(f.root, ["source"])
  finish.resolve()
  await rejected
  expect(core).toHaveBeenCalledOnce()
})

it("keeps a captured wildcard turn handler participating after its source is retired", async () => {
  const f = await fixture(false, false, "turn.*")
  f.bind("a", selected(["core"]))
  const stream = await f.manager.turnStep(f.root, "a", { turnId: "turn", index: 0, messageCount: 1, model: "native" },
    async function* () { yield { kind: "text", text: "one" }; yield { kind: "text", text: "two" }; return { answer: "onetwo" } }, signal())
  expect((await stream.next()).value).toEqual({ kind: "text", text: "one" })
  f.plugins[0].enabled = false
  f.manager.pluginsChanged(f.root, ["source"])
  await expect(stream.next()).rejects.toThrow()
})

it("tracks a pure native workspace through application invalidation without any guest session", async () => {
  const f = await fixture()
  f.plugins.splice(0)
  const stream = await f.manager.turnStep(f.root, "a", { turnId: "turn", index: 0, messageCount: 1, model: "native" },
    async function* () { yield { kind: "text", text: "one" }; yield { kind: "text", text: "two" }; return { answer: "onetwo" } }, signal())
  expect((await stream.next()).value).toEqual({ kind: "text", text: "one" })
  f.manager.invalidateAll()
  await expect(stream.next()).rejects.toThrow("MODS_SCOPE_CHANGED")
})

it("fences a disabled source during guest load before its first snapshot or startup effect", async () => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  f.setLoadBarrier(async () => { entered.resolve(); await finish.promise })
  const pending = f.manager.commands(f.root, "a")
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  f.plugins[0].enabled = false
  f.manager.pluginsChanged(f.root, ["source"])
  finish.resolve()
  await rejected
  expect(f.store.functionState.get(JSON.stringify([f.root, "components"]), "core-count")).toBeUndefined()
})

it("still rejects a native core after a real workspace policy invalidation", async () => {
  const f = await fixture()
  f.bind("a", selected(["core"]))
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const pending = f.manager.interceptTool(f.root, "a", { tool: "mod_authoring", tool_use_id: "native" }, signal(), async () => {
    entered.resolve(); await finish.promise; return { text: "POLICY_CHANGED" }
  })
  const rejected = expect(pending).rejects.toThrow("MODS_SCOPE_CHANGED")
  await entered.promise
  f.manager.invalidate(f.root)
  finish.resolve()
  await rejected
})

it.each(["disable", "revoke"] as const)("does not publish delayed agent rows after %s during the real guest SDK call", async (change) => {
  const f = await fixture(false, false, "agent.list")
  f.bind("a", selected(["core"]))
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>()
  f.listAgents.mockImplementationOnce(async () => {
    entered.resolve()
    await finish.promise
    settled.resolve()
    return [{ id: "OLD_AGENT_ROWS", description: "old source", type: "task", status: "idle" }]
  })
  const command = (await f.manager.commands(f.root, "a")).find((item) => item.command === "core")!
  const pending = f.manager.runCommand(f.root, "a", command, "", signal())
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  if (change === "disable") {
    f.plugins[0].enabled = false
    f.manager.pluginsChanged(f.root, ["source"])
  } else f.manager.revoke(f.root, "components")
  finish.resolve()
  await Promise.all([rejected, settled.promise])
  await Promise.resolve()
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain("OLD_AGENT_ROWS")
})

it("projects mixed-mode defaults before guest initialization and preserves legacy components", async () => {
  const f = await fixture(true, true)
  expect((await f.manager.commands(f.root, "chat")).map((item) => item.command).sort())
    .toEqual(["core", "rewrite"])
  f.manager.closeThread("chat")
  f.setUsage("project")
  expect((await f.manager.commands(f.root, "project")).map((item) => item.command).sort())
    .toEqual(["core", "review"])
  expect((await f.invoke("project", "review")).value.output)
    .toMatchObject({ unselected: false })
})

it("rejects an explicit all selection or an other-mode component before loading", async () => {
  const f = await fixture(false, true)
  f.bind("chat")
  await expect(f.manager.commands(f.root, "chat")).rejects.toThrow("当前模式")
  expect(f.loads()).toBe(0)
  f.bind("chat", selected(["core", "review"]))
  await expect(f.manager.commands(f.root, "chat")).rejects.toThrow("当前模式")
  expect(f.loads()).toBe(0)
})

it("rejects a context change during asynchronous guest loading", async () => {
  const f = await fixture(false, true)
  f.setLoadBarrier(async () => { f.setUsage("project") })
  await expect(f.manager.commands(f.root, "chat")).rejects.toThrow("MODS_SCOPE_CHANGED")
  expect(f.completeModel).not.toHaveBeenCalled()
})

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
