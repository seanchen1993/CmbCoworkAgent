import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { HookConfig, HookResult } from "./types"
import type { HookContext } from "./runner"

const state = vi.hoisted(() => ({ enabled: true, bridge: vi.fn(), native: vi.fn() }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({
    isEnabled: () => state.enabled,
    classicEvent: state.bridge
  })
}))
vi.mock("./http-runner", () => ({ executeHttpHook: state.native }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))

import { clearOnceStateForSession, runHooks } from "./runner"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import { mergePostSkillUseResults } from "../agent/skill-lifecycle/completion-hooks"

type SkillEvent = "PreSkillUse" | "PostSkillUse"
const cleanup: Array<() => Promise<void>> = []
const success: HookResult = { exitCode: 0, stdout: "", stderr: "", blocked: false }
beforeEach(() => {
  state.enabled = true
  state.native.mockReset().mockResolvedValue(success)
  state.bridge.mockReset()
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(event: SkillEvent, body = "return next(e)") {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.${event}",async($,e,next)=>{${body}})
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "skill-extension",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "skill-thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  cleanup.push(() => session.close(true))
  const order: string[] = []
  state.bridge.mockImplementation(async (_workspace, _thread, name, input, signal, core) => {
    order.push("mod-enter")
    const result = await session.classicEvent(name, input, signal, core)
    order.push("mod-return")
    return result
  })
  const context: HookContext = {
    workspacePath: "/workspace",
    sessionId: "skill-thread",
    agentId: "actual-child",
    skillName: "review",
    skillPath: "/plugin/skills/review/SKILL.md",
    skillRoot: "/plugin/skills/review",
    skillTriggerToolName: "read_file",
    toolName: "read_file",
    toolArgs: { file_path: "/plugin/skills/review/SKILL.md", trigger: "read_file" },
    toolResult: '{"content":"actual selected Skill"}',
    pluginId: "installed-uuid",
    pluginName: "original-plugin",
    pluginRoot: "/plugin",
    stopContext: {
      userMessage: "review changes",
      assistantResponse: "actual response",
      toolCalls: ["read_file"],
      usedSkills: ["review"]
    }
  }
  const hook = (id: string): HookConfig => ({
    id,
    event,
    matcher: "review",
    enabled: true,
    type: "http",
    url: "https://unused.invalid/native-hook",
    createdAt: "",
    updatedAt: ""
  })
  return {
    context,
    order,
    hook,
    run: (hooks: HookConfig[] = [], ctx = context) => runHooks(hooks, event, ctx)
  }
}

it.each(["PreSkillUse", "PostSkillUse"] as const)(
  "carries native %s identity and preserves an original denial through real guest next",
  async (event) => {
    const f = await fixture(event)
    state.native.mockResolvedValue({
      ...success,
      blocked: true,
      decision: "block",
      reason: "original denial",
      additionalContext: "original context",
      systemMessage: "original notice"
    })
    expect(await f.run([f.hook("native")])).toMatchObject({
      blocked: true,
      reason: "original denial",
      additionalContext: "original context",
      systemMessage: "original notice"
    })
    expect(state.bridge.mock.calls[0][3]).toMatchObject({
      hook_event_name: event,
      session_id: "skill-thread",
      agent_id: "actual-child",
      skill_name: "review",
      skill_path: f.context.skillPath,
      skill_root: f.context.skillRoot,
      skill_trigger_tool_name: "read_file",
      tool_name: "read_file",
      tool_input: f.context.toolArgs,
      tool_response: { content: "actual selected Skill" },
      plugin_id: "installed-uuid",
      plugin_name: "original-plugin",
      plugin_root: "/plugin"
    })
    if (event === "PostSkillUse")
      expect(state.bridge.mock.calls[0][3].stop_context).toEqual(f.context.stopContext)
    else expect(state.bridge.mock.calls[0][3]).not.toHaveProperty("stop_context")
  }
)

it("keeps the original PreSkillUse order inside next and appends Mod guidance afterward", async () => {
  const f = await fixture(
    "PreSkillUse",
    `const result=await next(e);
    return {...result,additionalContext:[...(result.additionalContext||[]),"Mod checked "+e.skill_name]}`
  )
  state.native.mockImplementation(async (hook) => {
    f.order.push(hook.id)
    return { ...success, additionalContext: hook.id }
  })
  const result = await f.run([f.hook("native-first"), f.hook("native-second")])
  expect(f.order).toEqual(["mod-enter", "native-first", "native-second", "mod-return"])
  expect(result?.additionalContext).toBe("native-first\nnative-second\nMod checked review")
})

it("blocks Skill activation before optional native Hooks when a Mod explicitly denies PreSkillUse", async () => {
  const f = await fixture("PreSkillUse", 'return {block:"missing review inputs"}')
  expect(await f.run([f.hook("optional")])).toMatchObject({
    blocked: true,
    reason: "missing review inputs"
  })
  expect(state.native).not.toHaveBeenCalled()
})

it.each(["revision", "halt", "observation"] as const)(
  "retains PostSkillUse %s semantics in the actual completion merger",
  async (mode) => {
    const body =
      mode === "revision"
        ? 'return {block:"repair artifact",additionalContext:["specific correction"]}'
        : mode === "halt"
          ? 'return {preventContinuation:true,stopReason:"explicitly stop"}'
          : 'return {additionalContext:["diagnostic only"]}'
    const f = await fixture("PostSkillUse", body)
    const result = await f.run()
    const merged = mergePostSkillUseResults(result ? [result] : [])
    if (mode === "revision")
      expect(merged).toMatchObject({
        blocked: true,
        decision: "block",
        reason: "repair artifact",
        additionalContext: "specific correction"
      })
    if (mode === "halt")
      expect(merged).toMatchObject({ continue: false, stopReason: "explicitly stop" })
    if (mode === "observation") expect(merged).toBeNull()
  }
)

it.each(['throw Error("optional failure")', "return {block:true}"])(
  "recovers an optional Skill Mod failure without deleting the original check",
  async (body) => {
    const f = await fixture("PreSkillUse", body)
    state.native.mockResolvedValue({
      ...success,
      blocked: true,
      reason: "native check still required"
    })
    expect(await f.run([f.hook("native")])).toMatchObject({
      blocked: true,
      reason: "native check still required"
    })
    expect(state.native).toHaveBeenCalledOnce()
  }
)

it("does not replay native effects when next is repeated and the guest fails", async () => {
  const f = await fixture("PreSkillUse", 'await next(e);await next(e);throw Error("after native")')
  await f.run([f.hook("native")])
  expect(state.native).toHaveBeenCalledOnce()
})

it("rejects forged downstream Skill identity while keeping original native inputs", async () => {
  const f = await fixture(
    "PreSkillUse",
    'return next({...e,skill_name:"forged",skill_path:"/foreign/SKILL.md"})'
  )
  await f.run([f.hook("native")])
  expect(state.native).toHaveBeenCalledOnce()
  expect(JSON.parse(state.native.mock.calls[0][1])).toMatchObject({
    skill_name: "review",
    skill_path: f.context.skillPath
  })
})

it.each(["PreSkillUse", "PostSkillUse"] as const)(
  "preserves native %s when Mods is disabled",
  async (event) => {
    const f = await fixture(event, 'return {block:"must not run"}')
    state.enabled = false
    await f.run([f.hook("native")])
    expect(state.bridge).not.toHaveBeenCalled()
    expect(state.native).toHaveBeenCalledOnce()
  }
)

it("cannot publish a Skill result after its original session generation is replaced", async () => {
  const f = await fixture("PreSkillUse")
  state.native.mockImplementation(async () => {
    clearOnceStateForSession("skill-thread")
    return success
  })
  await expect(f.run([f.hook("native")])).rejects.toThrow("HOOK_SESSION_CHANGED")
  expect(state.native).toHaveBeenCalledOnce()
})
