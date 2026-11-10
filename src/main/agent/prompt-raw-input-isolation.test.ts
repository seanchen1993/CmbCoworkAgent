import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getEnabledHooks: () => [],
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => []
}))

import { runHooksEnriched } from "../hooks/required-skill"
import { createHookScope } from "../hooks/scope"
import { createSkillUseTracker } from "./skill-lifecycle/tracker"
import { prepareStandardUserPrompt } from "./standard-thread-turn"

function input() {
  const scope = createHookScope()
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

beforeEach(() => {
  vi.mocked(runHooksEnriched).mockReset()
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

  it("commits the original input for an accepted normal turn, preserving an empty string", async () => {
    const options = input()
    vi.mocked(runHooksEnriched).mockResolvedValue(null)
    expect((await prepareStandardUserPrompt({ ...options, rawUserInput: "" })).accepted).toBe(true)
    expect(options.turnState.hookScope.rawUserInput).toBe("")
  })
})
