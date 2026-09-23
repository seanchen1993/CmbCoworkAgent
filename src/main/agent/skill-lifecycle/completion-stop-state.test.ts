import { afterEach, expect, it, vi } from "vitest"
import { runCompletionHooksWithRevision } from "./completion-hooks"
import { runHooksEnriched } from "../../hooks/required-skill"
import { createHookScope } from "../../hooks/scope"
import type { HookContext } from "../../hooks/runner"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", async (original) => ({
  ...(await original<typeof import("../../hooks/scope")>()),
  resolveEnabledHooksForRun: () => []
}))

afterEach(() => vi.clearAllMocks())
const blocked = { exitCode: 2, stdout: "", stderr: "", blocked: true, reason: "repair" }
function fixture() {
  return {
    threadId: "thread",
    workspacePath: "/workspace",
    abortSignal: new AbortController().signal,
    getStopContext: () => ({ assistantResponse: "actual answer" }),
    hookScope: createHookScope(),
    runPostSkillUseHooks: vi.fn(async () => null),
    runRevision: vi.fn(async (_prompt: string, _signal?: AbortSignal): Promise<void> => {
      void _prompt
      void _signal
    }),
    sendNotice: vi.fn(),
    sendError: vi.fn(),
    maxRevisionAttempts: 3,
    revisionPromptPrefix: "test"
  }
}
const active = (context: HookContext) =>
  (context as HookContext & { stopHookActive?: boolean }).stopHookActive

it("marks only the Stop-induced continuation and resets on a new physical completion loop", async () => {
  const flags: unknown[] = []
  vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
    flags.push(active(context))
    return flags.length === 1 ? blocked : null
  })
  const input = fixture()
  expect(await runCompletionHooksWithRevision(input)).toBe("passed")
  expect(input.runRevision).toHaveBeenCalledTimes(1)
  expect(await runCompletionHooksWithRevision(fixture())).toBe("passed")
  expect(flags).toEqual([false, true, false])
})

it("does not mislabel independent PostSkillUse or completion-gate repair as a Stop continuation", async () => {
  const flags: unknown[] = []
  vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
    flags.push(active(context))
    return null
  })
  const input = fixture()
  const post = vi.fn().mockResolvedValueOnce(blocked).mockResolvedValue(null)
  const gate = vi
    .fn()
    .mockResolvedValueOnce({ decision: "revise", reason: "test failed" })
    .mockResolvedValue({ decision: "pass" })
  expect(
    await runCompletionHooksWithRevision({
      ...input,
      runPostSkillUseHooks: post,
      completionGate: gate
    })
  ).toBe("passed")
  expect(flags).toEqual([false, false])
  expect(input.runRevision).toHaveBeenCalledTimes(2)
})

it("keeps shared budgets and cancellation authoritative over Stop continuation", async () => {
  const input = fixture(),
    controller = new AbortController()
  vi.mocked(runHooksEnriched).mockResolvedValue(blocked)
  input.runRevision.mockImplementation(async () => {
    controller.abort()
  })
  expect(await runCompletionHooksWithRevision({ ...input, abortSignal: controller.signal })).toBe(
    "failed"
  )
  expect(runHooksEnriched).toHaveBeenCalledTimes(1)
  expect(input.runRevision).toHaveBeenCalledTimes(1)
})

it("feeds non-error Stop context through the original revision loop and marks the continuation", async () => {
  const input = fixture(),
    flags: unknown[] = []
  vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
    flags.push(active(context))
    return flags.length === 1
      ? {
          exitCode: 0,
          stdout: "",
          stderr: "",
          blocked: false,
          stopFeedbackContinuation: true,
          additionalContext: "Run the targeted tests"
        }
      : null
  })
  expect(await runCompletionHooksWithRevision(input)).toBe("passed")
  expect(flags).toEqual([false, true])
  expect(input.runRevision).toHaveBeenCalledTimes(1)
  expect(input.runRevision.mock.calls[0]?.[0]).toContain("Run the targeted tests")
  expect(input.sendNotice).toHaveBeenCalledWith(expect.stringContaining("Stop hook feedback"))
  expect(input.sendError).not.toHaveBeenCalled()
})

it("charges non-error Stop feedback to the existing shared repair budget", async () => {
  const input = fixture()
  vi.mocked(runHooksEnriched).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    stopFeedbackContinuation: true,
    additionalContext: "Keep checking"
  })
  const gate = vi.fn().mockResolvedValue({ decision: "pass" })
  expect(
    await runCompletionHooksWithRevision({ ...input, maxRevisionAttempts: 1, completionGate: gate })
  ).toBe("failed")
  expect(input.runRevision).toHaveBeenCalledTimes(1)
  expect(gate).not.toHaveBeenCalled()
})

it("keeps halt and empty feedback from starting a new model turn", async () => {
  for (const result of [
    {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      stopFeedbackContinuation: true as const,
      additionalContext: "   "
    },
    {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      continue: false,
      stopFeedbackContinuation: true as const,
      additionalContext: "do not restart"
    }
  ]) {
    const input = fixture()
    vi.mocked(runHooksEnriched).mockResolvedValue(result)
    expect(await runCompletionHooksWithRevision(input)).toBe(
      result.continue === false ? "halted" : "passed"
    )
    expect(input.runRevision).not.toHaveBeenCalled()
  }
})

it("clears Stop attribution when a later required gate initiates a separate repair", async () => {
  const input = fixture(),
    flags: unknown[] = []
  vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, _event, context) => {
    flags.push(active(context))
    return flags.length === 1 ? blocked : null
  })
  const gate = vi
    .fn()
    .mockResolvedValueOnce({ decision: "revise", reason: "validator" })
    .mockResolvedValue({ decision: "pass" })
  expect(await runCompletionHooksWithRevision({ ...input, completionGate: gate })).toBe("passed")
  expect(flags).toEqual([false, true, false])
})

it("keeps legacy unmarked Stop context observational when Mods feedback is not enabled", async () => {
  const input = fixture()
  vi.mocked(runHooksEnriched).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    additionalContext: "legacy note"
  })
  expect(await runCompletionHooksWithRevision(input)).toBe("passed")
  expect(input.runRevision).not.toHaveBeenCalled()
})
