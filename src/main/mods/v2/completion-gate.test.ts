import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import { runCompletionHooksWithRevision } from "../../agent/skill-lifecycle/completion-hooks"
import type { HookScopeController } from "../../hooks/scope"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function fixture(...handlers: string[]) {
  const plugins: FunctionPlugin[] = []
  for (const [index, body] of handlers.entries()) {
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod = {
      register(on) { ${body} }
    }`)
    plugins.push({
      name: `gate${index}`,
      root: "/plugin",
      tier: "user" as const,
      guest,
      capabilities: [...SESSION_CAPABILITIES]
    })
  }
  const session = new FunctionSession(plugins, {
    workspace: "/project",
    threadId: "thread",
    assertLive: () => {},
    publish: async (value) => value
  })
  sessions.push(session)
  return session
}

const check = (session: FunctionSession, signal = new AbortController().signal) =>
  session.checkCompletion({ turnId: "turn", answer: "done" }, signal)

it("does not let a later PASS erase a revision vote", async () => {
  const session = await fixture(
    'on("completion.check", () => ({decision:"revise",reason:"missing test"}))',
    'on("completion.check", ($,e,next) => next(e))'
  )
  expect(session.hasCompletionGate()).toBe(true)
  expect(await check(session)).toEqual({ decision: "revise", reason: "gate0: missing test" })
})

it.each([
  'on("completion.check", () => {throw Error("offline")})',
  'on("completion.check", () => ({decision:"invalid"}))',
  'on("completion.check", () => {throw Error("offline")}).catch(() => ({decision:"pass"}))'
])("rejects failed or malformed mandatory handlers: %s", async (body) => {
  await expect(check(await fixture(body))).rejects.toThrow()
})

it("requires an exact opt-in event, not a wildcard observer", async () => {
  const session = await fixture('on("*", () => {throw Error("observer")})')
  expect(session.hasCompletionGate()).toBe(false)
  expect(await check(session)).toEqual({ decision: "pass" })
})

it("a block takes precedence over a revision", async () => {
  const session = await fixture(
    'on("completion.check", () => ({decision:"revise",reason:"fix"}))',
    'on("completion.check", () => ({decision:"block",reason:"manual check"}))',
    'on("completion.check", () => ({decision:"revise",reason:"also inspect tests"}))'
  )
  expect(await check(session)).toMatchObject({
    decision: "block",
    reason: "gate0: fix\ngate1: manual check\ngate2: also inspect tests"
  })
})

it("cancels a running guest check", async () => {
  const session = await fixture(
    'on("completion.check", async ($) => {await $.clock.sleep(10000);return {decision:"pass"}})'
  )
  const controller = new AbortController()
  const result = check(session, controller.signal)
  const assertion = expect(result).rejects.toThrow()
  controller.abort()
  await assertion
})

it("feeds real guest feedback into the existing revision loop and checks the updated answer", async () => {
  const session = await fixture(
    'on("completion.check", ($,e) => e.answer === "fixed" ? {decision:"pass"} : {decision:"revise",reason:"fix tax calculation"})'
  )
  let answer = "done"
  const runRevision = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("fix tax calculation")
    answer = "fixed"
  })
  expect(
    await runCompletionHooksWithRevision({
      threadId: "thread",
      abortSignal: new AbortController().signal,
      getStopContext: () => ({ assistantResponse: answer }),
      hookScope: {} as HookScopeController,
      runRevision,
      sendNotice: () => {},
      sendError: () => {},
      maxRevisionAttempts: 2,
      revisionPromptPrefix: "test",
      runPostSkillUseHooks: async () => null,
      runStopHooks: async () => null,
      completionGate: ({ signal, revisionAttempts }) =>
        session.checkCompletion(
          {
            turnId: "turn",
            answer,
            revisionAttempts
          },
          signal
        )
    })
  ).toBe("passed")
  expect(runRevision).toHaveBeenCalledTimes(1)
})
