/**
 * The single place both IM entry points read a run's outcome from.
 *
 * An ordinary turn and a Goal turn drive the same run body, which reports
 * failures to the renderer and then resolves its completion promise like any
 * other run. "No final text" is therefore ambiguous between a successful
 * tool-only turn and a provider error, and the two paths used to decide that
 * separately — which is how the Goal path kept turning retryable errors into a
 * flat "未产生可回传结果".
 *
 * Run:
 *   npx tsx tests/im-managed-run-result.spec.ts
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import ts from "typescript"
import { createManagedRunResultCollector } from "../src/main/services/im/managed-run-result"
import {
  ImCompletionHookRejectedError,
  ImPreparedPromptRejectedError,
  ImTurnIncompleteError
} from "../src/main/services/im/turn-failures"

const PROJECT_ROOT = resolve(__dirname, "..")

function testAReplyWins(): void {
  const collected = createManagedRunResultCollector()
  void collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "  完成了  " })
  assert.equal(
    collected.resolve(() => "fallback"),
    "完成了"
  )
}

function testAnEmptySuccessIsTheCallersDecision(): void {
  // An ordinary turn answers with a placeholder; a Goal turn has nothing to
  // report and fails. Same collector, opposite policy.
  const ordinary = createManagedRunResultCollector()
  ordinary.hooks.onRunTerminated?.({ outcome: "success", code: "normal" })
  assert.equal(
    ordinary.resolve(() => "处理完成。"),
    "处理完成。"
  )

  const goal = createManagedRunResultCollector()
  goal.hooks.onRunTerminated?.({ outcome: "success", code: "normal" })
  assert.throws(
    () =>
      goal.resolve(() => {
        throw new Error("Goal 运行未产生可回传结果")
      }),
    /Goal 运行未产生可回传结果/
  )
}

function testAFailureRethrowsTheOriginalError(): void {
  // IM classifies retryability off the error object itself. Replacing it with a
  // generic one turns a transient provider blip into a permanent failure.
  const providerError = new Error("upstream 503")
  const collected = createManagedRunResultCollector()
  collected.hooks.onRunTerminated?.({
    outcome: "error",
    code: "provider_error",
    message: "upstream 503",
    error: providerError
  })
  assert.throws(
    () => collected.resolve(() => "处理完成。"),
    (thrown: unknown) => thrown === providerError
  )
}

function testABlockedTurnKeepsItsReasonCode(): void {
  // The IM runner maps a thrown error to a reason code by instanceof, so a
  // plain Error becomes REMOTE_RUNTIME_FAILED — the user is told the robot
  // broke rather than that policy stopped their message. The two blocks are
  // also distinct: one never reached the model, the other refused to finish.
  const blockedInput = createManagedRunResultCollector()
  blockedInput.hooks.onRunTerminated?.({
    outcome: "error",
    code: "prompt_blocked",
    message: "UserPromptSubmit hook stopped the turn"
  })
  assert.throws(
    () => blockedInput.resolve(() => "处理完成。"),
    (error: unknown) =>
      error instanceof ImPreparedPromptRejectedError && error.reasonCode === "REMOTE_PROMPT_BLOCKED"
  )

  const blockedCompletion = createManagedRunResultCollector()
  blockedCompletion.hooks.onRunTerminated?.({
    outcome: "error",
    code: "hook_halt",
    message: "Stop hook halted the turn"
  })
  assert.throws(
    () => blockedCompletion.resolve(() => "处理完成。"),
    (error: unknown) =>
      error instanceof ImCompletionHookRejectedError &&
      error.reasonCode === "REMOTE_COMPLETION_HOOK_BLOCKED"
  )
}

function testAClassifiedBlockOutranksItsRawError(): void {
  // A hook halt arrives with a HookHaltError attached. Rethrowing that would
  // lose the reason code, since the runner only recognizes its own classes.
  const collected = createManagedRunResultCollector()
  collected.hooks.onRunTerminated?.({
    outcome: "error",
    code: "hook_halt",
    message: "Stop hook halted the turn",
    error: new Error("raw hook halt")
  })
  assert.throws(
    () => collected.resolve(() => "处理完成。"),
    (error: unknown) => error instanceof ImCompletionHookRejectedError
  )
}

function testAFailureOutranksAReply(): void {
  // A halt can arrive after some assistant text was already streamed; replying
  // with that text would report a blocked turn as a successful one.
  const collected = createManagedRunResultCollector()
  void collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "部分输出" })
  collected.hooks.onRunTerminated?.({
    outcome: "error",
    code: "hook_halt",
    message: "Hook 拦截了本轮"
  })
  assert.throws(() => collected.resolve(() => "处理完成。"), /Hook 拦截了本轮/)
}

function testAnUnreportedTerminalIsNotTreatedAsFailure(): void {
  // The run body guarantees a terminal, but a caller-supplied stub may not.
  // Absent a terminal, fall back to the reply or the caller's empty policy.
  const collected = createManagedRunResultCollector()
  void collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
  assert.equal(
    collected.resolve(() => "处理完成。"),
    "ok"
  )
}

function testCancellationOutranksEverything(): void {
  const collected = createManagedRunResultCollector({ cancelledMessage: "IM run was cancelled" })
  void collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
  collected.hooks.onRunCancelled?.()
  assert.throws(
    () => collected.resolve(() => "处理完成。"),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError"
  )
}

function testANoticeStandsInForAMissingReply(): void {
  const collected = createManagedRunResultCollector()
  collected.hooks.onGoalNotice?.({
    message: "Goal 已暂停",
    goalId: "g1",
    activeWindowId: null,
    eventId: 1,
    createdAt: 1
  })
  assert.equal(
    collected.resolve(() => "处理完成。"),
    "Goal 已暂停"
  )
}

async function testTheCallersOwnFinalAssistantStillRuns(): Promise<void> {
  const seen: string[] = []
  const collected = createManagedRunResultCollector({
    onFinalAssistant: (result) => {
      seen.push(result.finalText)
    }
  })
  await collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
  assert.deepEqual(seen, ["ok"], "chaining must not be dropped when the collector records")
}

function testResumeStatusNoticesSurviveTerminalFallback(): void {
  const agent = readFileSync(join(PROJECT_ROOT, "src/main/ipc/agent.ts"), "utf8")
  const entry = agent.slice(agent.indexOf("registerAgentRunImplementation(("))
  // Matched loosely on purpose: this slice used to name the call verbatim, and a
  // formatter wrapping it onto two lines silently turned indexOf into -1 — the
  // whole run body then landed in the evaluated wrapper and the failure pointed
  // at a missing global rather than at the real cause.
  const wrapperEnd = entry.search(/return agentRunExecutionContextStorage\s*\n?\s*\.?run\(/)
  assert(wrapperEnd > 0, "the run-body wrapper boundary must still be findable")
  const wrapper = entry.slice(entry.indexOf("let terminalReported = false"), wrapperEnd)
  const resume = entry.slice(entry.indexOf('if (goalCommand.type === "resume")'))
  // Execute the actual early-return branches and once-only wrapper. The rest
  // of the run body requires Electron; these status replies need no runtime.
  const earlyReturns = resume.slice(0, resume.indexOf("if (!getThreadWorkspacePath(threadId))"))
  const body = ts.transpileModule(
    `${wrapper}
     try { ${earlyReturns} } }
     finally { runExecutionContext.onRunTerminated?.({ outcome: "unknown", code: "unknown" }) }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const execute = new Function(
    "incomingRunExecutionContext",
    "goalCommand",
    "goalManager",
    "activeRuns",
    "threadId",
    "window",
    "channel",
    "emitGoalNotice",
    "safeSendToWindow",
    body
  )
  for (const [goal, busy, expected] of [
    [null, false, "没有可继续的 goal。"],
    [{ status: "complete" }, false, "Goal 已完成，不能 resume。清除请发送 /goal clear。"],
    [{ status: "active" }, true, "Goal 正在进行中，无需 resume。"],
    [{ status: "paused" }, true, "当前线程正在运行，稍后发送 /goal resume。"]
  ] as const) {
    const collected = createManagedRunResultCollector()
    execute(
      collected.hooks,
      { type: "resume" },
      { get: () => goal },
      { has: () => busy },
      "t1",
      {},
      "channel",
      (_window: unknown, _channel: string, _thread: string, message: string) =>
        collected.hooks.onGoalNotice?.({
          message,
          goalId: "g1",
          activeWindowId: null,
          eventId: 1,
          createdAt: 1
        }),
      () => undefined
    )
    assert.equal(
      collected.resolve(() => "unexpected empty result"),
      expected
    )
  }
  // An exit that classified nothing and wrote nothing is still not a success.
  const unknown = createManagedRunResultCollector()
  unknown.hooks.onRunTerminated?.({ outcome: "unknown", code: "unknown" })
  assert.throws(
    () => unknown.resolve(() => "处理完成。"),
    (error: unknown) => error instanceof ImTurnIncompleteError
  )
}

function testAnIncompleteTurnKeepsTheAnswerItWrote(): void {
  // The completion gate bounces a turn for HOW it ended — a truncated final
  // message, todos left open — not for what it wrote. The desktop transcript
  // shows that text next to the reason; IM has one message, so it must carry
  // both. Answering a usable turn with a bare short code throws away work the
  // user already paid a model call for.
  const collected = createManagedRunResultCollector()
  void collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "改完了前两处，" })
  collected.hooks.onRunTerminated?.({
    outcome: "error",
    code: "unknown",
    message: "模型未能给出有效的最终结果：length_truncated（已重试 2 次）。本回合按未完成处理。"
  })
  const reply = collected.resolve(() => "处理完成。")
  assert(reply.startsWith("改完了前两处，"), `answer must survive, got: ${reply}`)
  assert(reply.includes("length_truncated"), `reason must ride along, got: ${reply}`)
  assert(
    reply.includes("本回合按未完成处理"),
    `the reply must not read as a completed turn, got: ${reply}`
  )
}

function testAnIncompleteTurnWithNoAnswerStillExplainsItself(): void {
  // empty_response is the gate's most common defect and leaves nothing to
  // preserve. The reason is then the only thing the user has, so it must reach
  // them under a code of its own — REMOTE_RUNTIME_FAILED replies with a short
  // code and nothing else.
  const collected = createManagedRunResultCollector()
  collected.hooks.onRunTerminated?.({
    outcome: "error",
    code: "unknown",
    message: "模型未能给出有效的最终结果：empty_response（已重试 2 次）。本回合按未完成处理。"
  })
  assert.throws(
    () => collected.resolve(() => "处理完成。"),
    (error: unknown) =>
      error instanceof ImTurnIncompleteError &&
      error.reasonCode === "REMOTE_TURN_INCOMPLETE" &&
      error.message.includes("empty_response")
  )
}

function testAPolicyBlockStillDiscardsItsPartialText(): void {
  // The contrast that makes the branch above safe to have. "Incomplete" means
  // the answer is unfinished; "blocked" means it must not be delivered at all.
  // A Stop hook keeping its text would ship exactly what policy refused.
  const collected = createManagedRunResultCollector()
  void collected.hooks.onFinalAssistant?.({ messageId: "m1", finalText: "机密内容" })
  collected.hooks.onRunTerminated?.({
    outcome: "error",
    code: "hook_halt",
    message: "Stop hook halted the turn"
  })
  assert.throws(
    () => collected.resolve(() => "处理完成。"),
    (error: unknown) => error instanceof ImCompletionHookRejectedError
  )
}

function testTheRunnerSurfacesAnIncompleteReasonInsteadOfAShortCode(): void {
  // failureReply is not exported and the runner needs the whole IM stack, so
  // the wiring is pinned at the source. Three separate things must hold, and
  // dropping any one of them silently restores the generic failure reply.
  const runner = readFileSync(join(PROJECT_ROOT, "src/main/services/im/remote-runner.ts"), "utf8")
  assert(
    runner.includes('if (reasonCode === "REMOTE_TURN_INCOMPLETE")'),
    "failureReply must have a branch that renders the incomplete reason"
  )
  assert(
    /error instanceof ImTurnIncompleteError \? error\.message : undefined/.test(runner),
    "the thrown reason must be passed into failureReply, not dropped"
  )
  assert(
    runner.includes("!(error instanceof ImTurnIncompleteError) &&"),
    "an incomplete turn must never be retried: its retries were already spent in the gate"
  )
}

function testBothImEntryPointsUseThisCollector(): void {
  // The whole point: neither path may grow its own outcome reading again.
  for (const file of [
    "src/main/services/im/desktop-run-bridge.ts",
    "src/main/services/im/goal-runner.ts"
  ]) {
    const source = readFileSync(join(PROJECT_ROOT, file), "utf8")
    assert(
      source.includes("createManagedRunResultCollector("),
      `${file} must read its run outcome through the shared collector`
    )
    assert(
      !source.includes("onRunCancelled: () =>"),
      `${file} must not re-implement outcome collection alongside the collector`
    )
  }
}

async function main(): Promise<void> {
  for (const test of [
    testAReplyWins,
    testAnEmptySuccessIsTheCallersDecision,
    testAFailureRethrowsTheOriginalError,
    testABlockedTurnKeepsItsReasonCode,
    testAClassifiedBlockOutranksItsRawError,
    testAFailureOutranksAReply,
    testAnUnreportedTerminalIsNotTreatedAsFailure,
    testCancellationOutranksEverything,
    testANoticeStandsInForAMissingReply,
    testResumeStatusNoticesSurviveTerminalFallback,
    testAnIncompleteTurnKeepsTheAnswerItWrote,
    testAnIncompleteTurnWithNoAnswerStillExplainsItself,
    testAPolicyBlockStillDiscardsItsPartialText,
    testTheRunnerSurfacesAnIncompleteReasonInsteadOfAShortCode,
    testBothImEntryPointsUseThisCollector
  ]) {
    test()
    console.log(`PASS ${test.name}`)
  }
  await testTheCallersOwnFinalAssistantStillRuns()
  console.log("PASS testTheCallersOwnFinalAssistantStillRuns")
  console.log("im-managed-run-result.spec.ts passed")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
