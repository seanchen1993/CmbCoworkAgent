import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import type { PluginMetadata } from "../../types"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModControlStore } from "../control-store"
import {
  issueRuntimePluginSourceToken, withRuntimePluginSource, projectRuntimePluginSources,
  runtimeCapabilityAllowsPlugin, runtimeCapabilityAllowsMcp, runtimeCapabilitySkillSources
} from "../../plugins/runtime-source-scope"

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

async function fixture(approved = true) {
  const root = await mkdtemp(join(tmpdir(), "host-action-sources-"))
  const parent = join(root, "parent"), providerRoot = join(root, "provider")
  await mkdir(parent)
  await mkdir(join(providerRoot, "hooks"), { recursive: true })
  await writeFile(join(parent, "plugin.json"), '{"name":"parent","version":"2.0.0"}')
  await writeFile(join(providerRoot, "plugin.json"), JSON.stringify({ name: "provider", version: "2.0.0",
    skills: "skills", mcpServers: { forbidden: {} },
    claw: { actions: [{ id: "run", name: "Public action",
      platform: { id: "delivery", version: "1.0.0", action: "run" },
      inputSchema: { type: "object" }, outputSchema: { type: "object" } }] } }))
  await writeFile(join(providerRoot, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(join(providerRoot, "hooks/register.ts"), `export function register(on) {
    for (const event of ["session.start","tool.call","tool.check","turn.step","model.complete",
      "engine.create","classic.PreToolUse","prompt.compose","ui.render"])
      on(event, async () => { throw Error("AMBIENT_PROVIDER_LISTENER_EXECUTED:" + event) })
    on.capability({ apiVersion:"devclaw.capability/v1",id:"delivery",version:"1.0.0",
      title:"Delivery",scope:"conversation",stateSchema:{type:"object"},
      actions:[{id:"run",title:"Run",inputSchema:{type:"object"},outputSchema:{type:"object"},
        requiredPermissions:["store.get","store.set","clock.after","clock.sleep","ui.log"],cancellable:true,idempotency:"keyed"}] }, {
      act:async($,event)=> {
        if (event.input.input.timer) {
          $.clock.after(80,async()=>{await $.store.set("late",true);$.ui.log("callback-ran")})
          $.ui.log("timer-scheduled")
          await $.clock.sleep(160)
        }
        const count=Number(await $.store.get("calls")||0)+1
        await $.store.set("calls",count)
        return {status:"succeeded",text:"real public action",output:{count}}
      }
    })
  }`)
  const metadata = (id: string, path: string): PluginMetadata => ({ id, name: id, path, enabled: true,
    version: "2.0.0", description: "", author: "", skillCount: 1, mcpServerCount: 1,
    hookCount: 1, createdAt: "", updatedAt: "" })
  const source = metadata("provider", providerRoot), sources = [source]
  const store = new ModControlStore(join(root, "control.sqlite"))
  const scheduled = Promise.withResolvers<void>(), logs: string[] = []
  let active = true
  const manager = new FunctionModsManager(store, { plugins: () => sources, enabled: () => true,
    clawApplicable: () => false, changed: () => {}, publish: async (_workspace, value) => value,
    debugLog: (_plugin, text) => { logs.push(text); if (text === "timer-scheduled") scheduled.resolve() } },
  () => {
    const guests: FunctionGuestRuntime[] = []
    return {
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() { guests.forEach(guest => guest.dispose()) },
      async stopAndDrain() { await Promise.all(guests.map(guest => guest.dispose())) }
    }
  })
  closes.push(async () => {
    active = true
    await manager.closeThreadAndWait("thread")
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const [status] = await manager.status(root)
  if (approved) await manager.approve(root, source.id, status.digest!)
  const action = { pluginId: source.id, plugin: status.name, digest: status.digest!, actionId: "run" }
  const binding = { mode: "host" as const, capabilitySources: [], preserveParentContext: true,
    threadId: "thread", incarnationKey: "original", projectId: "project", operationId: "operation",
    stageId: "code", workspace: root, packageDigest: "a".repeat(64), plugin: metadata("parent", parent),
    actionSources: [{ plugin: { ...source }, name: status.name, digest: status.digest! }] }
  return { root, parent, source, sources, store, manager, binding, action,
    logs, scheduled: scheduled.promise, revoke: () => { active = false },
    run: <T>(work: () => T) => withRuntimePluginSource(issueRuntimePluginSourceToken(binding,
      () => { if (!active) throw Error("ORIGINAL_HOST_TOKEN_REVOKED") },
      () => { if (!active) throw Error("ORIGINAL_HOST_TOKEN_REVOKED") }), work) }
}

it("executes an exact approved public action in the original Host VM without ambient listeners or sources", async () => {
  const f = await fixture()
  await f.run(async () => {
    expect(projectRuntimePluginSources([]).map(item => item.id)).toEqual(["parent"])
    expect(runtimeCapabilityAllowsPlugin("provider")).toBe(false)
    expect(runtimeCapabilityAllowsMcp("provider", "forbidden")).toBe(false)
    expect(runtimeCapabilitySkillSources()).toEqual([])
    expect(await f.manager.commands(f.root, "thread")).toEqual([])
    for (const event of ["session.start", "tool.call", "tool.check", "turn.step", "model.complete",
      "engine.create", "classic.PreToolUse", "prompt.compose", "ui.render"])
      expect(await f.manager.hasEventHandler(f.root, "thread", event), event).toBe(false)
    expect(await f.manager.interceptTool(f.root, "thread", { tool: "read_file", tool_use_id: "native-call", input: { file_path: "file" } },
      undefined, async () => ({ text: "native tool" }))).toEqual({ text: "native tool" })
    for (const event of ["classic.PreToolUse"])
      expect(await f.manager.classicEvent(f.root, "thread", event,
        { tool: "read_file", tool_use_id: "native-call" }, new AbortController().signal,
        async () => ({}))).toEqual({})
    const stream = await f.manager.turnStep(f.root, "thread",
      { turnId: "model-turn", index: 0, messageCount: 1, model: "native" },
      async function* () { yield { kind: "text", text: "native model" }; return { answer: "native model" } },
      new AbortController().signal)
    for await (const chunk of stream) expect(chunk).toEqual({ kind: "text", text: "native model" })
    expect(await stream.result).toEqual({ answer: "native model" })
    const prepared = await f.manager.prepareAction(f.root, "thread", f.action, new AbortController().signal)
    expect(prepared.route).toBe("platform")
    const result = await f.manager.runAction(f.root, "thread", prepared,
      { version: 1, input: {}, config: {}, task: "Run retained workflow", runId: "workflow",
        stepId: "step", executionId: "original-execution" }, new AbortController().signal)
    expect(result.output).toMatchObject({ count: 1 })
    expect(result.passed).toBe(true)
    expect(f.store.getProjectFunctionGrant(f.root, "project", "a".repeat(64), "provider")).toBeNull()
  })
})

it.each(["wrong-digest", "missing", "same-name-other-id", "disabled", "path", "unapproved"] as const)(
  "refuses %s before public action admission", async change => {
    const f = await fixture(change !== "unapproved")
    if (change === "wrong-digest") f.binding.actionSources[0].digest = "b".repeat(64)
    if (change === "missing") f.sources.length = 0
    if (change === "same-name-other-id") f.source.id = "replacement-provider-id"
    if (change === "disabled") f.source.enabled = false
    if (change === "path") f.source.path = f.parent
    await expect(f.run(() => f.manager.runtimeReady(f.root, "thread"))).rejects.toThrow()
  })

it.each([false, true])("retains native resource callbacks and fences them with the original Host token (revoked=%s)", async revoked => {
  const f = await fixture()
  await f.run(async () => {
    const prepared = await f.manager.prepareAction(f.root, "thread", f.action, new AbortController().signal)
    const pending = f.manager.runAction(f.root, "thread", prepared,
      { version: 1, input: { timer: true }, config: {}, task: "Original resource boundary", runId: "workflow",
        stepId: "timer", executionId: "original-timer" }, new AbortController().signal)
    const result = revoked ? expect(pending).rejects.toThrow("ORIGINAL_HOST_TOKEN_REVOKED") : expect(pending).resolves.toMatchObject({ passed: true })
    await f.scheduled
    if (revoked) f.revoke()
    await result
    expect(f.logs.includes("callback-ran")).toBe(!revoked)
  })
})

it.each(["source", "grant", "disabled", "missing", "path"] as const)(
  "refuses %s changes after exact original preparation", async change => {
    const f = await fixture()
    await f.run(async () => {
      const prepared = await f.manager.prepareAction(f.root, "thread", f.action, new AbortController().signal)
      if (change === "source") await writeFile(join(f.source.path, "hooks/register.ts"), "export function register() {}")
      if (change === "grant") f.store.grant(f.root, "function:provider", f.action.digest, false)
      if (change === "disabled") f.source.enabled = false
      if (change === "missing") f.sources.length = 0
      if (change === "path") f.source.path = f.parent
      await expect(f.manager.runAction(f.root, "thread", prepared,
        { version: 1, input: {}, config: {}, task: "Run retained workflow", runId: "workflow",
          stepId: "step", executionId: "original-execution" }, new AbortController().signal)).rejects.toThrow()
    })
  })
