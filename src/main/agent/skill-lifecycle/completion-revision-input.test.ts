import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { afterEach, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import type { HookScopeController } from "../../hooks/scope"
import {
  consumeCompletionRevisionInput,
  isCompletionRevisionInput,
  runCompletionHooksWithRevision,
  type CompletionRevisionInput
} from "./completion-hooks"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const threadId = randomUUID(),
    runId = randomUUID(),
    workspace = tmpdir()
  const controller = new AbortController()
  expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
  cleanups.push(() => {
    releaseLocalThreadRunLease(threadId, "desktop", runId)
  })
  const expected = { threadId, runId, workspace }
  return {
    expected,
    controller,
    async revise(work: (input: CompletionRevisionInput) => Promise<void>) {
      let stops = 0
      return runCompletionHooksWithRevision({
        threadId,
        runId,
        workspacePath: workspace,
        abortSignal: controller.signal,
        hookScope: {} as HookScopeController,
        getStopContext: () => ({}),
        runPostSkillUseHooks: async () => null,
        runStopHooks: async () =>
          stops++ === 0
            ? {
                exitCode: 0,
                stdout: "",
                stderr: "",
                blocked: false,
                stopFeedbackContinuation: true,
                additionalContext: "actual host feedback"
              }
            : null,
        maxRevisionAttempts: 1,
        revisionPromptPrefix: "host",
        sendNotice: () => undefined,
        sendError: (value) => {
          throw Error(value)
        },
        runRevision: async (_prompt, _signal, input) => {
          expect(input).toBeDefined()
          await work(input!)
        }
      })
    }
  }
}

it("only consumes the exact one-shot input minted by the budgeted host completion loop", async () => {
  const f = fixture()
  await f.revise(async (input) => {
    expect(isCompletionRevisionInput(input)).toBe(true)
    const copied = { messages: [...input.messages] }
    const forged = { messages: [new HumanMessage(String(input.messages[0].content))] }
    for (const value of [copied, forged, { ...input, internal: true }]) {
      expect(isCompletionRevisionInput(value)).toBe(false)
      expect(consumeCompletionRevisionInput(value, f.expected)).toBeUndefined()
    }
    const source = consumeCompletionRevisionInput(input, f.expected)!
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.hasOwn(source, "used")).toBe(false)
    expect(source.message).toBe(input.messages[0])
    expect(source.signal).toBe(f.controller.signal)
    source.assertCurrent()
    expect(() => consumeCompletionRevisionInput(input, f.expected)).toThrow(
      "MODS_COMPLETION_REVISION_INPUT_INVALID"
    )
    expect(() => source.assertCurrent()).toThrow("MODS_COMPLETION_REVISION_INPUT_INVALID")
  })
})

it("rejects an unconsumed input escaped after its original revision callback", async () => {
  const f = fixture()
  let escaped!: CompletionRevisionInput
  await f.revise(async (input) => {
    escaped = input
  })
  expect(() => consumeCompletionRevisionInput(escaped, f.expected)).toThrow(
    "MODS_COMPLETION_REVISION_INPUT_INVALID"
  )
})

it.each(["thread", "run", "workspace", "content", "id", "lease", "abort"])(
  "rejects a revision whose original %s changed without reviving its certificate",
  async (change) => {
    const f = fixture()
    await f.revise(async (input) => {
      const expected = { ...f.expected }
      if (change === "thread") expected.threadId = randomUUID()
      if (change === "run") expected.runId = randomUUID()
      if (change === "workspace") expected.workspace = dirname(tmpdir())
      if (change === "content") input.messages[0].content = "replaced host feedback"
      if (change === "id") input.messages[0].id = randomUUID()
      if (change === "lease") {
        releaseLocalThreadRunLease(expected.threadId, "desktop", expected.runId)
        expect(claimLocalThreadRunLease({ ...expected, owner: "desktop" }).acquired).toBe(true)
      }
      if (change === "abort") f.controller.abort(Error("original run cancelled"))
      expect(() => consumeCompletionRevisionInput(input, expected)).toThrow()
      expect(() => consumeCompletionRevisionInput(input, f.expected)).toThrow(
        "MODS_COMPLETION_REVISION_INPUT_INVALID"
      )
    })
  }
)
