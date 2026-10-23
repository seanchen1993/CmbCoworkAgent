import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginMetadata, PluginHookMetadata } from "../../types"
import type { HookConfig } from "../../hooks/types"
import type { PluginSkillSourceMetadata } from "../../storage"

const state = vi.hoisted(() => ({
  sources: [] as PluginSkillSourceMetadata[],
  plugins: [] as PluginMetadata[],
  hooks: [] as HookConfig[],
  bridge: vi.fn(),
  presentation: vi.fn()
}))
vi.mock("../../storage", async (original) => ({
  ...(await original<typeof import("../../storage")>()),
  getEnabledSkillsSources: async () => [],
  getSkillsSources: () => [],
  getPlugins: () => state.plugins,
  getEnabledPluginSkillSourceMetadata: () => state.sources,
  getDisabledSkillDirs: () => [],
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("../../mods/manager", () => {
  const manager = {
    isEnabled: () => true,
    isActive: () => false,
    // The classic bridge below is real; these cases do not call a host tool through a Mod.
    bindThread: () => () => undefined,
    classicEvent: (...args: unknown[]) => state.bridge(...args),
    presentationEvent: (...args: unknown[]) => state.presentation(...args)
  }
  return {
    authorizeCurrentModInput: async () => {
      const { getModCallContext } = await import("../../mods/context")
      // These cases enter a native backend directly, never a guest-origin host tool call.
      if (getModCallContext()) throw Error("FIXTURE_REQUIRES_DIRECT_NATIVE_CALL")
    },
    getModsManager: () => manager
  }
})
vi.mock("../../hooks/scope", async (original) => ({
  ...(await original<typeof import("../../hooks/scope")>()),
  resolveEnabledHooksForRun: () => state.hooks
}))
vi.mock("../../hooks/log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: () => undefined
}))
vi.mock("../runtime", () => ({ createAgentRuntime: vi.fn() }))

import { LocalSandbox } from "../local-sandbox"
import { prepareStandardUserPrompt } from "../standard-thread-turn"
import { createHookScope } from "../../hooks/scope"
import { createSkillUseTracker } from "./tracker"
import { SkillLifecycleRegistry } from "./registry"
import { formatSkillUseBlock } from "./marker"
import {
  runCompletionHooksWithRevision,
  runPostSkillUseHooksForActivatedSkills
} from "./completion-hooks"
import { ModControlStore } from "../../mods/control-store"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { compileFunctionPlugin } from "../../mods/v2/loader"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"

const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
  state.sources = []
  state.plugins = []
  state.hooks = []
  state.bridge.mockReset()
  state.presentation.mockReset()
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const observe = (event: string) => `
  on("classic.${event}",async($,e,next)=>{
    const value=await next(e);
    return {...value,additionalContext:[...(value.additionalContext||[]),"SEEN:"+JSON.stringify(e)]}
  });`

async function fixture(code = observe("PreSkillUse") + observe("PostSkillUse")) {
  const root = await mkdtemp(join(tmpdir(), "mods-skill-lifecycle-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = join(root, "plugin"),
    skillRoot = join(pluginRoot, "skills", "review")
  const path = join(skillRoot, "SKILL.md")
  await mkdir(skillRoot, { recursive: true })
  await mkdir(join(pluginRoot, "hooks"))
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      name: "skill-lifecycle",
      version: "1.0.0",
      skills: ["skills"]
    })
  )
  await writeFile(
    join(pluginRoot, "hooks/hooks.json"),
    JSON.stringify({ modules: ["./register.ts"] })
  )
  await writeFile(join(pluginRoot, "hooks/register.ts"), `export function register(on){${code}}`)
  await writeFile(
    path,
    "---\nname: review\ndescription: Review actual artifacts\n---\nREAL_SKILL_BODY"
  )
  await writeFile(join(root, "ordinary.txt"), "ordinary native content")
  const plugin: PluginMetadata = {
    id: "skill-plugin",
    name: "skill-lifecycle",
    version: "1.0.0",
    path: pluginRoot,
    enabled: true,
    description: "",
    author: "",
    skillCount: 1,
    hookCount: 0,
    mcpServerCount: 0,
    createdAt: "fixture",
    updatedAt: "fixture"
  }
  state.sources = [
    {
      sourceDir: join(pluginRoot, "skills"),
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginRoot,
      isProjectModePlugin: false
    }
  ]
  const store = new ModControlStore(join(root, "control.sqlite"))
  const seen: Array<Record<string, unknown>> = []
  const threads = new Set<string>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [plugin],
      enabled: () => true,
      changed: () => {},
      publish: async (_workspace, value) => {
        if (
          value &&
          !Array.isArray(value) &&
          typeof value === "object" &&
          Array.isArray(value.additionalContext)
        )
          for (const note of value.additionalContext)
            if (typeof note === "string" && note.startsWith("SEEN:"))
              seen.push(JSON.parse(note.slice(5)))
        return value
      }
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(source, options) {
          const guest = await FunctionGuestRuntime.create(source, options)
          guests.push(guest)
          return guest
        },
        stop: () => {
          for (const guest of guests) void guest.dispose()
        },
        stopAndDrain: async () => {
          await Promise.all(guests.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(async () => {
    await Promise.all([...threads].map((thread) => manager.closeThreadAndWait(thread)))
    manager.close()
    store.close()
  })
  const status = (await manager.status(root))[0]
  expect(status.state).not.toBe("invalid")
  await manager.approve(root, status.pluginId, status.digest!)
  state.bridge.mockImplementation((workspace, thread, event, input, signal, core) =>
    manager.classicEvent(workspace, thread, event, input, signal, core)
  )
  state.presentation.mockImplementation((workspace, thread, event, input, signal) =>
    manager.presentationEvent(workspace, thread, event, input, signal)
  )
  function turn(threadId = "main", signal = new AbortController().signal, agentId?: string) {
    threads.add(threadId)
    const turnState = {
      hookScope: createHookScope(),
      skillHookKeys: new Set<string>(),
      skillUseTracker: createSkillUseTracker(),
      turnId: "turn-" + threadId
    }
    const sandbox = new LocalSandbox({
      rootDir: root,
      runId: threadId,
      agentId,
      abortSignal: signal,
      hookScope: turnState.hookScope,
      skillHookKeys: turnState.skillHookKeys,
      skillUseTracker: turnState.skillUseTracker,
      skillLifecycleRegistry: new SkillLifecycleRegistry(state.sources),
      hookResolver: () => state.hooks
    })
    return {
      turnState,
      sandbox,
      prepare: () =>
        prepareStandardUserPrompt({
          signal,
          agentId,
          rawMessage: formatSkillUseBlock({ name: "review", path }),
          initialModelInput: formatSkillUseBlock({ name: "review", path }),
          threadId,
          workspacePath: root,
          turnState,
          harnessAgentContext: {},
          onHookResult: vi.fn(),
          onHookSkippedFactory: () => vi.fn()
        }),
      complete: (assistantResponse: string) =>
        runPostSkillUseHooksForActivatedSkills({
          signal,
          agentId,
          threadId,
          workspacePath: root,
          hookScope: turnState.hookScope,
          skillUseTracker: turnState.skillUseTracker,
          getStopContext: () => ({ assistantResponse }),
          resolveHooks: () => state.hooks
        })
    }
  }
  return { root, path, pluginRoot, skillRoot, plugin, manager, store, seen, turn }
}

async function requiredArtifactFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  event: "PreSkillUse" | "PostSkillUse"
) {
  const artifact = join(f.root, "artifact.json"),
    validator = join(f.pluginRoot, "validate.cjs")
  await writeFile(artifact, JSON.stringify({ passed: false }))
  await writeFile(
    validator,
    `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const p=JSON.parse(fs.readFileSync(${JSON.stringify(artifact)},'utf8'));console.log(JSON.stringify(input.skill_path!==${JSON.stringify(f.path)}||input.skill_name!=='review'||input.plugin_id!=='skill-plugin'?{decision:'block',reason:'NATIVE_FACTS_CHANGED'}:p.passed?{}:{decision:'block',reason:'REAL_ARTIFACT_FAILED'}))`
  )
  const hook: PluginHookMetadata = {
    id: "plugin:skill-plugin/artifact",
    event,
    type: "command",
    command: `"${process.execPath}" "${validator}"`,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    pluginId: f.plugin.id,
    pluginName: f.plugin.name,
    pluginEnabled: true,
    pluginRoot: f.pluginRoot,
    hookPath: "hooks/hooks.json",
    hookSourceType: "plugin",
    hookSourceRoot: f.pluginRoot
  }
  state.hooks = [hook]
  const token = issueRuntimePluginSourceToken({
    mode: "legacy",
    threadId: "main",
    incarnationKey: "fixture",
    projectId: "project",
    operationId: "operation",
    workspace: f.root,
    packageDigest: "a".repeat(64),
    stageId: "review",
    plugin: f.plugin,
    requiredHooks: ["artifact"]
  })
  return { artifact, token }
}

it("routes actual explicit selection and read_file into one real guest lifecycle per turn", async () => {
  const f = await fixture(),
    t = f.turn()
  const prepared = await t.prepare()
  expect(prepared.accepted).toBe(true)
  if (!prepared.accepted) throw Error("Explicit fixture activation failed")
  expect(prepared.content).toContain("## Skill Hook Context")
  expect(prepared.content).toContain("SEEN:")
  expect(prepared.explicitSkillHookContext).toContain('"skill_trigger_tool_name":"skill_select"')
  expect(await t.sandbox.read(f.path)).toContain("REAL_SKILL_BODY")
  expect(await t.sandbox.read(f.path)).toContain("REAL_SKILL_BODY")
  await t.complete("Artifacts checked")
  await t.complete("Repeated completion")
  expect(f.seen.filter((event) => event.hook_event_name === "PreSkillUse")).toHaveLength(1)
  expect(f.seen.filter((event) => event.hook_event_name === "PostSkillUse")).toHaveLength(1)
  expect(f.seen[0]).toMatchObject({
    skill_name: "review",
    skill_path: f.path,
    skill_root: f.skillRoot,
    skill_trigger_tool_name: "skill_select",
    session_id: "main",
    plugin_id: f.plugin.id,
    plugin_name: f.plugin.name,
    plugin_root: f.pluginRoot
  })
  expect(f.seen[1].stop_context).toMatchObject({ assistantResponse: "Artifacts checked" })
})

it("emits no lifecycle for ordinary files and keeps actual child read lifecycles separate", async () => {
  const f = await fixture(),
    parent = f.turn(),
    child = f.turn("child", undefined, "worker-7")
  expect(await parent.sandbox.read(join(f.root, "ordinary.txt"))).toContain(
    "ordinary native content"
  )
  expect(f.seen).toEqual([])
  await parent.sandbox.read(f.path)
  await child.sandbox.read(f.path)
  expect(parent.sandbox.drainSkillHookContexts().join("\n")).toContain("SEEN:")
  expect(child.sandbox.drainSkillHookContexts().join("\n")).toContain('"agent_id":"worker-7"')
  await parent.complete("parent result")
  await child.complete("child result")
  expect(f.seen.map((event) => [event.hook_event_name, event.session_id])).toEqual([
    ["PreSkillUse", "main"],
    ["PreSkillUse", "child"],
    ["PostSkillUse", "main"],
    ["PostSkillUse", "child"]
  ])
  expect(f.seen[1]).toMatchObject({ agent_id: "worker-7", skill_trigger_tool_name: "read_file" })
})

it.each(["explicit", "read_file"])(
  "a real guest blocks %s before activation or Skill disclosure",
  async (trigger) => {
    const f = await fixture('on("classic.PreSkillUse",()=>({block:"REVIEW_INPUT_MISSING"}));')
    const t = f.turn()
    if (trigger === "explicit")
      expect(await t.prepare()).toMatchObject({ accepted: false, reason: "REVIEW_INPUT_MISSING" })
    else {
      const value = await t.sandbox.read(f.path)
      expect(value).toContain("REVIEW_INPUT_MISSING")
      expect(value).not.toContain("REAL_SKILL_BODY")
    }
    expect(t.turnState.skillUseTracker.getUsedSkillNames()).toEqual([])
    expect(t.turnState.skillUseTracker.getPendingPostSkillUses()).toEqual([])
  }
)

it("feeds actual completion context to guest artifact advice without treating it as approval", async () => {
  const f = await fixture(
      observe("PreSkillUse") +
        `on("classic.PostSkillUse",async($,e,next)=>{
    await next(e); return e.stop_context.assistantResponse.includes("artifact.json")?{}:{block:"ARTIFACT_REFERENCE_MISSING"}
  });`
    ),
    t = f.turn()
  await t.sandbox.read(f.path)
  expect(await t.complete("No generated output yet")).toMatchObject({
    blocked: true,
    decision: "block",
    reason: "ARTIFACT_REFERENCE_MISSING"
  })
})

it("consumes an explicit PostSkillUse halt once without leaving a repair pending", async () => {
  const f = await fixture(
    'on("classic.PostSkillUse",()=>({preventContinuation:true,stopReason:"native stop"}));'
  )
  const t = f.turn()
  expect(await t.sandbox.read(f.path)).toContain("REAL_SKILL_BODY")
  expect(await t.complete("Stopped output")).toMatchObject({
    continue: false,
    stopReason: "native stop"
  })
  expect(t.turnState.skillUseTracker.getPendingPostSkillUses()).toEqual([])
  expect(await t.complete("Repeated stopped completion")).toBeNull()
})

it.each([
  ["PreSkillUse", "short-circuit"],
  ["PostSkillUse", "short-circuit"],
  ["PreSkillUse", "forge identity"],
  ["PostSkillUse", "forge identity"]
] as const)(
  "preserves actual required %s artifact checks when a guest tries to %s",
  async (event, mode) => {
    const f = await fixture(
      `on("classic.${event}",async($,e,next)=>{
      ${mode === "forge identity" ? 'await next({...e,skill_name:"forged",skill_path:"C:/forged/SKILL.md",plugin_id:"forged"});' : ""}
      return {additionalContext:["pretend approved"]}
    });`
    )
    const { token } = await requiredArtifactFixture(f, event)
    const t = f.turn()
    if (event === "PreSkillUse") {
      expect(await withRuntimePluginSource(token, () => t.prepare())).toMatchObject({
        accepted: false,
        reason: expect.stringContaining("REAL_ARTIFACT_FAILED")
      })
      expect(t.turnState.skillUseTracker.getUsedSkillNames()).toEqual([])
      expect(t.turnState.skillUseTracker.getPendingPostSkillUses()).toEqual([])
    } else {
      expect(await withRuntimePluginSource(token, () => t.sandbox.read(f.path))).toContain(
        "REAL_SKILL_BODY"
      )
      expect(
        await withRuntimePluginSource(token, () => t.complete("Artifact ready"))
      ).toMatchObject({
        blocked: true,
        decision: "block",
        reason: expect.stringContaining("REAL_ARTIFACT_FAILED")
      })
    }
  }
)

it.each([false, true])(
  "revalidates a real required PostSkillUse artifact after revision (artifact repaired: %s)",
  async (repair) => {
    const f = await fixture(
      'on("classic.PostSkillUse",()=>({additionalContext:["claimed complete"]}));'
    )
    const { artifact, token } = await requiredArtifactFixture(f, "PostSkillUse")
    const t = f.turn()
    expect(await withRuntimePluginSource(token, () => t.sandbox.read(f.path))).toContain(
      "REAL_SKILL_BODY"
    )
    const revise = vi.fn(async () => {
      if (repair) await writeFile(artifact, JSON.stringify({ passed: true }))
    })
    const checked = vi.fn()
    const errors = vi.fn()
    const outcome = await withRuntimePluginSource(token, () =>
      runCompletionHooksWithRevision({
        threadId: "main",
        workspacePath: f.root,
        abortSignal: new AbortController().signal,
        hookScope: t.turnState.hookScope,
        skillUseTracker: t.turnState.skillUseTracker,
        getStopContext: () => ({ assistantResponse: "Artifact ready" }),
        runRevision: revise,
        runStopHooks: async () => null,
        sendNotice: vi.fn(),
        sendError: errors,
        onHookResult: checked,
        maxRevisionAttempts: 2,
        revisionPromptPrefix: "test"
      })
    )
    expect(outcome).toBe(repair ? "passed" : "failed")
    expect(revise).toHaveBeenCalledTimes(repair ? 1 : 2)
    expect(checked.mock.calls.filter(([event]) => event === "PostSkillUse")).toHaveLength(
      repair ? 2 : 3
    )
    expect(t.turnState.skillUseTracker.getPendingPostSkillUses()).toHaveLength(repair ? 0 : 1)
    if (repair) {
      expect(errors).not.toHaveBeenCalled()
      await t.complete("Repeated successful completion")
      expect(checked.mock.calls.filter(([event]) => event === "PostSkillUse")).toHaveLength(2)
    } else expect(errors).toHaveBeenCalledWith(expect.stringContaining("REAL_ARTIFACT_FAILED"))
  }
)

it.each(["cancel", "revoke"])(
  "rejects %s during real guest/native IO before activation",
  async (kind) => {
    const f = await fixture(observe("PreSkillUse")),
      controller = new AbortController()
    const t = f.turn("main", controller.signal)
    let received!: () => void
    const ready = new Promise<void>((resolve) => {
      received = resolve
    })
    let respond!: () => void
    const server = createServer((request, response) => {
      request.resume()
      received()
      respond = () => {
        response.writeHead(200)
        response.end('{"continue":true}')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string") throw Error("HTTP fixture unavailable")
    state.hooks = [
      {
        id: "native-wait",
        event: "PreSkillUse",
        type: "http",
        url: `http://127.0.0.1:${address.port}`,
        enabled: true,
        createdAt: "",
        updatedAt: ""
      }
    ]
    const pending = t.prepare().then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    await ready
    if (kind === "cancel") controller.abort(Error("SKILL_RUN_CANCELLED"))
    else {
      const compiled = await compileFunctionPlugin(f.pluginRoot)
      f.store.grant(f.root, `function:${compiled.name}`, compiled.digest, false)
    }
    respond()
    expect(await pending).toHaveProperty("error")
    expect(t.turnState.skillUseTracker.getUsedSkillNames()).toEqual([])
    expect(f.seen).toEqual([])
  }
)
