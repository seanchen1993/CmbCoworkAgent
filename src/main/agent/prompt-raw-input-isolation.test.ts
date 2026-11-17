import { beforeEach, describe, expect, it, vi } from "vitest"
import { resolve } from "node:path"

vi.mock("../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getDisabledSkillDirs: () => [],
  getEnabledHooks: () => [],
  getEnabledPluginHookMetadata: vi.fn(() => []),
  getEnabledPluginSkillSourceMetadata: vi.fn(() => []),
  getEnabledSkillHookMetadata: () => [],
  getEnabledSkillsSources: async () => []
}))
vi.mock("../skills/discovery", async (original) => ({
  ...(await original<typeof import("../skills/discovery")>()),
  discoverSkillsSync: vi.fn(() => [])
}))

import { runHooksEnriched } from "../hooks/required-skill"
import { createHookScope, resolveEnabledHooksForRun } from "../hooks/scope"
import { discoverSkillsSync } from "../skills/discovery"
import { getEnabledPluginHookMetadata, getEnabledPluginSkillSourceMetadata } from "../storage"
import { createSkillUseTracker } from "./skill-lifecycle/tracker"
import { prepareStandardUserPrompt } from "./standard-thread-turn"

function input(onPersistentHookKeysChanged?: (keys: readonly string[]) => void) {
  const scope = createHookScope({ onPersistentHookKeysChanged })
  scope.rawUserInput = "已接受的输入 A"
  return {
    rawMessage: "待处理的输入 B",
    rawUserInput: "  原文 B\n",
    initialModelInput: "B 加上技能包装",
    threadId: "raw-input-review",
    workspacePath: process.cwd(),
    turnState: {
      hookScope: scope,
      skillHookKeys: new Set<string>(),
      skillUseTracker: createSkillUseTracker()
    },
    harnessAgentContext: {},
    onHookResult: vi.fn(),
    onHookSkippedFactory: () => vi.fn()
  }
}

function usePluginSkill() {
  const name = "fixture-skill"
  const rootDir = resolve(process.cwd(), name)
  const path = resolve(rootDir, "SKILL.md")
  const pluginId = "scoped-fixture"
  const stopHook = {
    id: "fixture-stop",
    event: "Stop" as const,
    type: "http" as const,
    url: "https://example.test/stop",
    enabled: true,
    createdAt: "",
    updatedAt: "",
    pluginId,
    pluginName: pluginId,
    pluginRoot: rootDir,
    pluginEnabled: true,
    hookPath: resolve(rootDir, "hooks.json")
  }
  vi.mocked(getEnabledPluginHookMetadata).mockReturnValue([
    stopHook,
    { ...stopHook, id: "fixture-tool", event: "PreToolUse", persistAfterInterrupt: true }
  ])
  vi.mocked(getEnabledPluginSkillSourceMetadata).mockReturnValue([
    {
      sourceDir: rootDir,
      pluginId,
      pluginName: pluginId,
      pluginRoot: rootDir,
      isProjectModePlugin: false
    }
  ])
  vi.mocked(discoverSkillsSync).mockReturnValue([
    { name, sourceDir: rootDir, rootDir, skillMdPath: path, relativePath: "", depth: 0 }
  ])
  return { skill: { name, path }, pluginId, stopHook }
}

beforeEach(() => {
  vi.mocked(runHooksEnriched).mockReset()
  vi.mocked(getEnabledPluginHookMetadata).mockReset()
  vi.mocked(getEnabledPluginSkillSourceMetadata).mockReset()
  vi.mocked(discoverSkillsSync).mockReset()
})

describe("prompt original-input isolation", () => {
  it("passes B to its submission hook without exposing it to running hooks when rejected", async () => {
    const options = input()
    vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
      expect(context.rawUserInput).toBe(options.rawUserInput)
      expect(options.turnState.hookScope.rawUserInput).toBe("已接受的输入 A")
      return { blocked: true, reason: "denied", exitCode: 2, stdout: "", stderr: "" }
    })
    expect((await prepareStandardUserPrompt(options)).accepted).toBe(false)
    expect(options.turnState.hookScope.rawUserInput).toBe("已接受的输入 A")
  })

  it("preserves the active original input if preparation throws or becomes stale", async () => {
    const options = input()
    vi.mocked(runHooksEnriched).mockRejectedValueOnce(new Error("hook failed"))
    await expect(prepareStandardUserPrompt(options)).rejects.toThrow("hook failed")
    expect(options.turnState.hookScope.rawUserInput).toBe("已接受的输入 A")
    const result = await prepareStandardUserPrompt({
      ...options,
      isPreparationCurrent: () => false
    })
    expect(result.accepted).toBe(false)
    expect(options.turnState.hookScope.rawUserInput).toBe("已接受的输入 A")
  })

  it("does not commit a late submission to a replacement turn's hook scope", async () => {
    const options = input()
    const previousScope = options.turnState.hookScope
    const replacementScope = createHookScope()
    replacementScope.rawUserInput = "替换回合的原文 C"
    let markHookStarted!: () => void
    let releaseHook!: () => void
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve
    })
    const hookCanFinish = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    vi.mocked(runHooksEnriched).mockImplementationOnce(async () => {
      markHookStarted()
      await hookCanFinish
      return null
    })

    const prepared = prepareStandardUserPrompt(options)
    await hookStarted
    options.turnState.hookScope = replacementScope
    releaseHook()

    const result = await prepared
    expect(replacementScope.rawUserInput).toBe("替换回合的原文 C")
    expect(previousScope.rawUserInput).toBe("已接受的输入 A")
    expect(result).toMatchObject({ accepted: false, blockedBy: "run_not_ready" })
  })

  it("keeps a successful steering preparation pending until actual injection", async () => {
    const options = input()
    vi.mocked(runHooksEnriched).mockResolvedValue(null)
    const result = await prepareStandardUserPrompt({
      ...options,
      deferRawUserInputCommit: true
    })
    expect(result.accepted).toBe(true)
    expect(options.turnState.hookScope.rawUserInput).toBe("已接受的输入 A")
  })

  it("keeps a rejected steering skill out of the running turn's Hook scope", async () => {
    const { skill, pluginId } = usePluginSkill()
    const options = input()
    const { hookScope, skillUseTracker, skillHookKeys } = options.turnState
    vi.mocked(runHooksEnriched).mockResolvedValueOnce(null).mockResolvedValueOnce({
      blocked: true,
      reason: "denied",
      exitCode: 2,
      stdout: "",
      stderr: ""
    })
    const result = await prepareStandardUserPrompt({
      ...options,
      trustedExplicitSkill: skill,
      deferRawUserInputCommit: true
    })
    expect(result).toMatchObject({ accepted: false, blockedBy: "user_prompt_submit" })
    const stopContext = {}
    expect(
      resolveEnabledHooksForRun(options.workspacePath, "Stop", stopContext, hookScope)
    ).toEqual([])
    expect(stopContext).toHaveProperty("rawUserInput", "已接受的输入 A")
    expect(hookScope.activePluginIds.has(pluginId)).toBe(false)
    expect(hookScope.persistentHookKeys.size).toBe(0)
    expect(skillUseTracker.getPendingPostSkillUses()).toEqual([])
    expect(skillHookKeys.size).toBe(0)
  })

  it("does not persist a skill rejected by an ordinary submission hook", async () => {
    const { skill, pluginId } = usePluginSkill()
    const persist = vi.fn()
    const options = input(persist)
    const onExplicitSkillActivated = vi.fn()
    vi.mocked(runHooksEnriched)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ blocked: true, exitCode: 2, stdout: "", stderr: "" })

    const result = await prepareStandardUserPrompt({
      ...options,
      trustedExplicitSkill: skill,
      onExplicitSkillActivated
    })

    expect(result).toMatchObject({ accepted: false, blockedBy: "user_prompt_submit" })
    expect(persist).not.toHaveBeenCalled()
    expect(options.turnState.hookScope.activePluginIds.has(pluginId)).toBe(false)
    expect(options.turnState.skillHookKeys.size).toBe(0)
    expect(options.turnState.skillUseTracker.getUsedSkillNames()).toEqual([])
    expect(onExplicitSkillActivated).not.toHaveBeenCalled()
  })

  it.each(["cancelled", "replaced"])(
    "does not persist an ordinary skill when the turn is %s during PreSkillUse",
    async (state) => {
      const { skill, pluginId } = usePluginSkill()
      const persist = vi.fn()
      const options = input(persist)
      const previousScope = options.turnState.hookScope
      const controller = new AbortController()
      let markHookStarted!: () => void
      let finishHook!: () => void
      const hookStarted = new Promise<void>((resolve) => {
        markHookStarted = resolve
      })
      const hookCanFinish = new Promise<void>((resolve) => {
        finishHook = resolve
      })
      vi.mocked(runHooksEnriched).mockImplementationOnce(async (_hooks, event) => {
        expect(event).toBe("PreSkillUse")
        markHookStarted()
        await hookCanFinish
        return null
      })
      const pending = prepareStandardUserPrompt({
        ...options,
        trustedExplicitSkill: skill,
        isPreparationCurrent: () => !controller.signal.aborted
      })
      await hookStarted
      if (state === "cancelled") controller.abort()
      else options.turnState.hookScope = createHookScope()
      finishHook()

      await expect(pending).resolves.toMatchObject({ accepted: false, blockedBy: "run_not_ready" })
      expect(persist).not.toHaveBeenCalled()
      expect(previousScope.activePluginIds.has(pluginId)).toBe(false)
      expect(options.turnState.hookScope.activePluginIds.has(pluginId)).toBe(false)
      expect(options.turnState.skillHookKeys.size).toBe(0)
      expect(options.turnState.skillUseTracker.getUsedSkillNames()).toEqual([])
      expect(runHooksEnriched).toHaveBeenCalledTimes(1)
    }
  )

  it("commits an accepted ordinary skill before returning the prepared prompt", async () => {
    const { skill, pluginId, stopHook } = usePluginSkill()
    const persist = vi.fn()
    const options = input(persist)
    const onExplicitSkillActivated = vi.fn()
    vi.mocked(runHooksEnriched).mockResolvedValue(null)

    const result = await prepareStandardUserPrompt({
      ...options,
      trustedExplicitSkill: skill,
      onExplicitSkillActivated
    })

    expect(result.accepted).toBe(true)
    expect(result).not.toHaveProperty("onInjected")
    expect(options.turnState.hookScope.activePluginIds.has(pluginId)).toBe(true)
    expect(options.turnState.hookScope.rawUserInput).toBe(options.rawUserInput)
    expect(
      resolveEnabledHooksForRun(options.workspacePath, "Stop", {}, options.turnState.hookScope)
    ).toContain(stopHook)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(options.turnState.skillUseTracker.getUsedSkillNames()).toEqual([skill.name])
    expect(options.turnState.skillHookKeys.size).toBe(1)
    expect(onExplicitSkillActivated).toHaveBeenCalledTimes(1)
  })

  it.each(["original run", "continuation"])(
    "activates a prepared steering skill only on injection in the %s",
    async (owner) => {
      const { skill, pluginId, stopHook } = usePluginSkill()
      const options = input()
      const { hookScope, skillUseTracker, skillHookKeys } = options.turnState
      hookScope.activatePlugin("pruned-before-injection")
      const onExplicitSkillActivated = vi.fn()
      let originalRunCurrent = true
      vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
        expect(context.rawUserInput).toBe(options.rawUserInput)
        return null
      })
      const result = await prepareStandardUserPrompt({
        ...options,
        trustedExplicitSkill: skill,
        deferRawUserInputCommit: true,
        isPreparationCurrent: () => originalRunCurrent,
        onExplicitSkillActivated
      })
      if (!result.accepted) throw new Error(result.reason)
      expect(result.onInjected).toBeTypeOf("function")
      expect(hookScope.activePluginIds.has(pluginId)).toBe(false)
      expect(hookScope.persistentHookKeys.size).toBe(0)
      expect(skillUseTracker.getPendingPostSkillUses()).toEqual([])
      expect(skillHookKeys.size).toBe(0)
      expect(onExplicitSkillActivated).not.toHaveBeenCalled()

      hookScope.pruneActivations({
        keepPluginId: () => false,
        keepSkillName: () => false,
        keepSkillPath: () => false
      })
      originalRunCurrent = owner === "original run"
      result.onInjected?.()
      result.onInjected?.()

      const stopHooks = resolveEnabledHooksForRun(options.workspacePath, "Stop", {}, hookScope)
      expect(stopHooks).toContain(stopHook)
      expect(hookScope.activePluginIds).toEqual(new Set([pluginId]))
      expect(hookScope.persistentHookKeys.size).toBe(1)
      expect(skillUseTracker.getUsedSkillNames()).toEqual([skill.name])
      expect(skillHookKeys.size).toBe(1)
      expect(onExplicitSkillActivated).toHaveBeenCalledTimes(Number(originalRunCurrent))
    }
  )

  it("commits the original input for an accepted normal turn, preserving an empty string", async () => {
    const options = input()
    vi.mocked(runHooksEnriched).mockResolvedValue(null)
    expect((await prepareStandardUserPrompt({ ...options, rawUserInput: "" })).accepted).toBe(true)
    expect(options.turnState.hookScope.rawUserInput).toBe("")
  })
})
