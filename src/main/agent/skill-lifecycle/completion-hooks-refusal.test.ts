import { expect, it, vi } from "vitest"
import type { HookScopeController } from "../../hooks/scope"
import { runCompletionHooksWithRevision } from "./completion-hooks"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))

it.each(["initial", "Stop", "PostSkillUse"])(
  "does not revise a provider refusal at %s",
  async (stage) => {
    let refused = stage === "initial"
    const revision = vi.fn(async () => {
      refused = true
    })
    const blocked = {
      decision: "block" as const,
      reason: "revise",
      exitCode: 2,
      stdout: "",
      stderr: "",
      blocked: true
    }
    const post = vi.fn(async () => (stage === "PostSkillUse" ? blocked : null))
    const stop = vi.fn(async () => blocked)
    expect(
      await runCompletionHooksWithRevision({
        threadId: "thread",
        abortSignal: new AbortController().signal,
        getStopContext: () => ({}),
        hookScope: {} as HookScopeController,
        runRevision: revision,
        sendNotice: vi.fn(),
        sendError: vi.fn(),
        maxRevisionAttempts: 2,
        revisionPromptPrefix: "test",
        runPostSkillUseHooks: post,
        runStopHooks: stop,
        hasTerminalModelRefusal: () => refused
      })
    ).toBe("passed")
    expect(revision).toHaveBeenCalledTimes(stage === "initial" ? 0 : 1)
    expect(post).toHaveBeenCalledTimes(stage === "initial" ? 0 : 1)
    expect(stop).toHaveBeenCalledTimes(stage === "Stop" ? 1 : 0)
  }
)
