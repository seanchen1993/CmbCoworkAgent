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
import { createManagedRunResultCollector } from "../src/main/services/im/managed-run-result"
import {
  ImCompletionHookRejectedError,
  ImPreparedPromptRejectedError
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
