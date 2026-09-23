import { expect, it, vi } from "vitest"
import type { HookScopeController } from "../../hooks/scope"
import {
  runCompletionHooksWithRevision,
  runPostSkillUseHooksForActivatedSkills
} from "./completion-hooks"
import { runHooksEnriched } from "../../hooks/required-skill"
import {
  CompletionBudget,
  bindCompletionGateBudget,
  chargeCompletionModelUsage,
  currentCompletionBudget
} from "../../mods/v2/completion-budget"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))

function fixture() {
  const blocked = { exitCode: 2, stdout: "", stderr: "", blocked: true, reason: "repair" }
  const gate = vi
    .fn()
    .mockResolvedValueOnce({ decision: "revise", reason: "repair" })
    .mockResolvedValue({ decision: "pass" })
  const input = {
    threadId: "thread",
    abortSignal: new AbortController().signal,
    getStopContext: () => ({}),
    hookScope: {} as HookScopeController,
    sendNotice: vi.fn(),
    sendError: vi.fn(),
    maxRevisionAttempts: 4,
    revisionPromptPrefix: "test",
    completionGate: gate,
    runPostSkillUseHooks: vi.fn().mockResolvedValueOnce(blocked).mockResolvedValue(null),
    runStopHooks: vi.fn().mockResolvedValueOnce(blocked).mockResolvedValue(null),
    runRevision: vi.fn<(prompt: string, signal?: AbortSignal) => Promise<void>>(async () => {})
  }
  return { input, gate }
}

it("shares one total budget across PostSkillUse, Stop and gate repair revisions", async () => {
  const { input, gate } = fixture()
  const budget = new CompletionBudget(120, 10000)
  bindCompletionGateBudget(gate, budget)
  const observed: unknown[] = []
  input.runRevision.mockImplementation(async () => {
    observed.push(currentCompletionBudget())
    chargeCompletionModelUsage(30, 20)
  })
  expect(await runCompletionHooksWithRevision(input)).toBe("failed")
  expect(observed).toEqual([budget, budget, budget])
  expect(budget.inputTokens).toBe(90)
  expect(budget.outputTokens).toBe(60)
})

it("keeps the same deadline and rejects unknown repair usage before any PASS", async () => {
  for (const cause of ["deadline", "unknown", "pending"]) {
    const { input, gate } = fixture()
    let now = 0
    const budget = new CompletionBudget(1000, 100, () => now)
    bindCompletionGateBudget(gate, budget)
    input.runRevision.mockImplementation(async (_prompt, signal) => {
      expect(signal).toBeDefined()
      if (cause === "deadline") now = 101
      else if (cause === "unknown") chargeCompletionModelUsage(undefined, undefined)
      else currentCompletionBudget()?.reserve(10, 10)
    })
    expect(await runCompletionHooksWithRevision(input)).toBe("failed")
    expect(input.sendError).toHaveBeenCalled()
  }
})

it("creates no completion budget scope when the module gate is off", async () => {
  const { input } = fixture()
  input.runRevision.mockImplementation(async (_prompt, signal) => {
    expect(currentCompletionBudget()).toBeUndefined()
    expect(signal).toBe(input.abortSignal)
  })
  expect(await runCompletionHooksWithRevision({ ...input, completionGate: undefined })).toBe(
    "passed"
  )
  expect(input.runRevision).toHaveBeenCalledTimes(2)
})

it("passes the repair deadline signal into the original Stop and PostSkillUse hook contexts", async () => {
  const { input, gate } = fixture()
  gate.mockReset().mockResolvedValue({ decision: "pass" })
  input.runPostSkillUseHooks.mockReset().mockResolvedValue(null)
  const budget = new CompletionBudget(1000, 10000)
  bindCompletionGateBudget(gate, budget)
  let stopSignal: AbortSignal | undefined
  vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
    stopSignal = context.signal
    return null
  })
  expect(await runCompletionHooksWithRevision({ ...input, runStopHooks: undefined })).toBe("passed")
  expect(stopSignal).toBeDefined()
  expect(stopSignal).not.toBe(input.abortSignal)
  let postSignal: AbortSignal | undefined
  await runPostSkillUseHooksForActivatedSkills({
    threadId: "thread",
    getStopContext: () => ({}),
    hookScope: {} as HookScopeController,
    signal: stopSignal,
    skillUseTracker: {
      getPendingPostSkillUses: () => [{ name: "skill", key: "skill" }],
      markPostSkillUseFired: () => {}
    } as never,
    resolveHooks: () => [],
    executeHooks: async (_hooks, _event, context) => {
      postSignal = context.signal
      return null
    }
  })
  expect(postSignal).toBe(stopSignal)
})
