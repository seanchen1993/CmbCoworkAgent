import { expect, it, vi } from "vitest"
import type { HookScopeController } from "../../hooks/scope"
import { runCompletionHooksWithRevision } from "./completion-hooks"
import { parseCompletionGateDecision, type CompletionGateInput } from "./completion-gate"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))

function fixture() {
  const controller = new AbortController()
  const input = {
    threadId: "thread",
    abortSignal: controller.signal,
    getStopContext: () => ({}),
    hookScope: {} as HookScopeController,
    runRevision: vi.fn<(prompt: string) => Promise<void>>(async () => {}),
    sendNotice: vi.fn(),
    sendError: vi.fn(),
    maxRevisionAttempts: 2,
    revisionPromptPrefix: "test",
    runPostSkillUseHooks: vi.fn(async () => null),
    runStopHooks: vi.fn(async () => null),
    completionGate: vi.fn<(input: CompletionGateInput) => Promise<unknown>>(async () => ({
      decision: "pass"
    }))
  }
  return { controller, input }
}

it("rechecks all completion hooks after revision before accepting a pass", async () => {
  const { input } = fixture()
  input.completionGate.mockResolvedValueOnce({ decision: "revise", reason: "fix tax" })
  expect(await runCompletionHooksWithRevision(input)).toBe("passed")
  expect(input.runRevision).toHaveBeenCalledTimes(1)
  expect(input.runRevision.mock.calls[0]?.[0]).toContain("fix tax")
  expect(input.runStopHooks).toHaveBeenCalledTimes(2)
  expect(input.completionGate.mock.calls[1]?.[0]).toMatchObject({ revisionAttempts: 1 })
})

it.each([
  undefined,
  {},
  { decision: "pass", reason: "ignored" },
  { decision: "revise", reason: " " },
  { decision: "allow" }
])("does not approve malformed gate output %j", async (output) => {
  const { input } = fixture()
  input.completionGate.mockResolvedValue(output)
  expect(await runCompletionHooksWithRevision(input)).toBe("failed")
  expect(input.runRevision).not.toHaveBeenCalled()
  expect(input.sendError).toHaveBeenCalledTimes(1)
})

it("does not treat exceptions or explicit blocks as successful completion", async () => {
  for (const throwing of [true, false]) {
    const { input } = fixture()
    if (throwing) input.completionGate.mockRejectedValue(Error("unavailable"))
    else input.completionGate.mockResolvedValue({ decision: "block", reason: "needs approval" })
    expect(await runCompletionHooksWithRevision(input)).toBe("failed")
    expect(input.runRevision).not.toHaveBeenCalled()
  }
})

it.each(["post", "stop", "gate"])("cancellation during %s never starts revision", async (phase) => {
  const { controller, input } = fixture()
  const cancel = async () => {
    controller.abort()
    return null
  }
  if (phase === "post") input.runPostSkillUseHooks.mockImplementation(cancel)
  if (phase === "stop") input.runStopHooks.mockImplementation(cancel)
  if (phase === "gate")
    input.completionGate.mockImplementation(async () => {
      controller.abort()
      return { decision: "revise", reason: "must not run" }
    })
  expect(await runCompletionHooksWithRevision(input)).toBe("failed")
  expect(input.runRevision).not.toHaveBeenCalled()
  if (phase !== "gate") expect(input.completionGate).not.toHaveBeenCalled()
  if (phase === "post") expect(input.runStopHooks).not.toHaveBeenCalled()
})

it("shares the revision budget between Stop and the gate", async () => {
  const { input } = fixture()
  const stop = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 2,
      stdout: "",
      stderr: "",
      blocked: true,
      reason: "classic revision"
    })
    .mockResolvedValue(null)
  input.completionGate.mockResolvedValue({ decision: "revise", reason: "gate revision" })
  expect(await runCompletionHooksWithRevision({ ...input, runStopHooks: stop })).toBe("failed")
  expect(input.runRevision).toHaveBeenCalledTimes(2)
  expect(input.completionGate.mock.calls.at(-1)?.[0]).toMatchObject({ revisionAttempts: 2 })
})

it("a zero budget still checks once but does not repair", async () => {
  const { input } = fixture()
  input.completionGate.mockResolvedValue({ decision: "revise", reason: "fix" })
  expect(await runCompletionHooksWithRevision({ ...input, maxRevisionAttempts: 0 })).toBe("failed")
  expect(input.completionGate).toHaveBeenCalledTimes(1)
  expect(input.runRevision).not.toHaveBeenCalled()
})

it("rejects unbounded reason text", () => {
  expect(() =>
    parseCompletionGateDecision({ decision: "block", reason: "x".repeat(8001) })
  ).toThrow("COMPLETION_GATE_INVALID_RESULT")
})

it("never interprets a late PASS after cancellation as approval", async () => {
  const { controller, input } = fixture()
  input.completionGate.mockImplementation(async () => {
    controller.abort()
    return { decision: "pass" }
  })
  expect(await runCompletionHooksWithRevision(input)).toBe("failed")
  expect(input.runRevision).not.toHaveBeenCalled()
})

it("a traditional halt cannot be overridden by a gate", async () => {
  const { input } = fixture()
  const stop = async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    continue: false
  })
  expect(await runCompletionHooksWithRevision({ ...input, runStopHooks: stop })).toBe("halted")
  expect(input.completionGate).not.toHaveBeenCalled()
})

it("a refusal after a gate-requested revision never triggers another review", async () => {
  const { input } = fixture()
  let refused = false
  input.completionGate.mockResolvedValue({ decision: "revise", reason: "fix" })
  input.runRevision.mockImplementation(async () => {
    refused = true
  })
  expect(
    await runCompletionHooksWithRevision({
      ...input,
      hasTerminalModelRefusal: () => refused
    })
  ).toBe("passed")
  expect(input.completionGate).toHaveBeenCalledTimes(1)
  expect(input.runRevision).toHaveBeenCalledTimes(1)
})
