/**
 * IM turns routed into the authoritative desktop run body.
 *
 * The bridge is a drop-in for executePreparedRemoteStandardTurn, so these tests
 * pin the mapping it performs: what the run body can derive for itself is left
 * alone — including the user's transcript message — and the two things it
 * cannot know about (an inbox turn's auto-approved edits and its scheduler
 * delivery binding) ride the remote policy that the shared controlled factory
 * applies for every caller alike.
 *
 * Run:
 *   npx tsx tests/im-desktop-run-bridge.spec.ts
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type {
  AgentRunDelivery,
  AgentRunExecutionContext,
  AgentRunRequest
} from "../src/main/agent/agent-run-service"
import {
  executeRemoteStandardTurnOnDesktopRunBody,
  IM_UNTRUSTED_INPUT_SYSTEM_PROMPT,
  withImInboxRuntimePolicy
} from "../src/main/services/im/desktop-run-bridge"
import type { PreparedRemoteStandardTurnInput } from "../src/main/services/im/remote-runner"

const PROJECT_ROOT = resolve(__dirname, "..")

const delivery: AgentRunDelivery = {
  window: {} as AgentRunDelivery["window"],
  isAvailable: () => true,
  send: () => undefined
}

function baseInput(
  overrides: Partial<PreparedRemoteStandardTurnInput> = {}
): PreparedRemoteStandardTurnInput {
  return {
    rawMessage: "查一下今天的构建",
    userMessageId: "im:42:user",
    threadId: "t1",
    targetKind: "thread",
    metadata: {},
    workspacePath: "/tmp/ws",
    runId: "run-1",
    runOwner: "im",
    source: "im",
    routingTaskSource: "chat",
    signal: new AbortController().signal,
    ...overrides
  }
}

interface Captured {
  request: AgentRunRequest | null
  context: AgentRunExecutionContext | null
}

function stubRun(
  captured: Captured,
  behaviour: (context: AgentRunExecutionContext) => Promise<void>
): Parameters<typeof executeRemoteStandardTurnOnDesktopRunBody>[1]["startRun"] {
  return async (request, _delivery, context) => {
    captured.request = request
    captured.context = context
    return { threadId: request.threadId, completion: behaviour(context) }
  }
}

function run(
  input: PreparedRemoteStandardTurnInput,
  captured: Captured,
  behaviour: (context: AgentRunExecutionContext) => Promise<void>
): Promise<string> {
  return executeRemoteStandardTurnOnDesktopRunBody(input, {
    getDelivery: () => delivery,
    startRun: stubRun(captured, behaviour)
  })
}

function testInboxOnlyRuntimeOptionsTravelOnThePolicy(): void {
  const deliveryContext = { taskId: "task-1" } as NonNullable<
    ReturnType<typeof withImInboxRuntimePolicy>
  >["imDeliveryContext"]

  const inbox = withImInboxRuntimePolicy(
    { disableSubagents: true },
    { targetKind: "inbox", imDeliveryContext: deliveryContext }
  )
  assert.equal(inbox?.autoApproveFileEdits, true, "an inbox turn has no human to approve an edit")
  assert.equal(inbox?.imDeliveryContext, deliveryContext)
  assert.equal(inbox?.disableSubagents, true, "the caller's policy must survive augmentation")

  const thread = withImInboxRuntimePolicy(
    { disableSubagents: true },
    { targetKind: "thread", imDeliveryContext: deliveryContext }
  )
  assert.deepEqual(
    thread,
    { disableSubagents: true },
    "a non-inbox turn must not silently gain auto-approved edits"
  )
  assert.equal(
    withImInboxRuntimePolicy(undefined, { targetKind: "thread" }),
    undefined,
    "no policy in, no policy out"
  )
}

function testTheBridgeLeavesTranscriptPersistenceToTheRunBody(): void {
  // persistVisibleUserTranscriptMessage (agent.ts) writes the user's message
  // under the same userMessageId this bridge passes in, and already skips the
  // marker prompts of internal notification turns. Persisting here as well
  // upserts the identical row a second time on every IM message.
  const source = readFileSync(
    join(PROJECT_ROOT, "src/main/services/im/desktop-run-bridge.ts"),
    "utf8"
  )
  assert(
    !source.includes("persistStandardTurnUserMessage"),
    "the run body owns the user transcript message; the bridge must not write it too"
  )
  const agent = readFileSync(join(PROJECT_ROOT, "src/main/ipc/agent.ts"), "utf8")
  assert(
    agent.includes("function persistVisibleUserTranscriptMessage("),
    "the owner this bridge defers to must still exist"
  )
  assert(
    agent.includes("userTranscriptMessagePersisted = persistVisibleUserTranscriptMessage("),
    "the run body must still persist the user transcript message for the turn it runs"
  )
}

function testTheRunBodyStillHonoursWhatTheBridgeDependsOn(): void {
  const agent = readFileSync(join(PROJECT_ROOT, "src/main/ipc/agent.ts"), "utf8")
  assert(
    agent.includes("runExecutionContext.onRunTerminated?.(terminal)"),
    "the run body must report its terminal state; a managed caller has no stream to read it from"
  )
  assert(
    agent.includes("runExecutionContext.verifyResolvedThread?.({"),
    "the run body must re-check the caller's authorization before running"
  )
  assert(
    agent.includes('reportTerminal({ outcome: "unknown", code: "unknown" })'),
    "the run body must guarantee a terminal report, or onRunTerminated is a lie"
  )
  // Every error branch has to carry the original error, or retryability is lost.
  for (const code of ["hook_halt", "failure_fuse", "provider_error"]) {
    assert(
      new RegExp(`markAutoModeTerminal\\("error", "${code}"[^)]*, error\\)`).test(agent),
      `the ${code} branch must pass the original error to the terminal report`
    )
  }
}

async function testTurnInputMapsOntoTheRunContext(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  const hooks = { onWaitStart: () => undefined, onWaitEnd: () => undefined }
  const skill = {
    name: "deploy",
    version: "1.0.0"
  } as PreparedRemoteStandardTurnInput["explicitSkill"]

  const text = await run(
    baseInput({
      agentMode: "coordinator",
      explicitSkill: skill,
      interactionWaitHooks: hooks,
      remotePolicy: { disableMcpTools: true }
    }),
    captured,
    async (context) => {
      await context.onFinalAssistant?.({ messageId: "m1", finalText: "  构建成功  " })
    }
  )

  assert.equal(text, "构建成功", "the reply text is trimmed, matching the runner it replaces")

  const request = captured.request
  const context = captured.context
  assert.ok(request && context)
  assert.equal(request.threadId, "t1")
  assert.equal(request.message, "查一下今天的构建")
  assert.equal(request.userMessageId, "im:42:user")
  assert.equal(request.agentMode, "coordinator")

  assert.equal(context.source, "im")
  assert.equal(context.trustedExplicitSkill, skill)
  assert.equal(context.interactionWaitHooks, hooks)
  assert.deepEqual(context.remotePolicy, { disableMcpTools: true })
  assert.equal(
    context.extraSystemPrompt,
    IM_UNTRUSTED_INPUT_SYSTEM_PROMPT,
    "every IM turn must carry the untrusted-input boundary into the prompt"
  )
}

async function testANotificationTurnIsMarkedAsInternal(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  await run(baseInput({ internalNotificationTurn: true }), captured, async (context) => {
    await context.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
  })
  // The run body keys its notification-turn handling — skipping prompt
  // preparation and the user bubble — off this flag plus the marker prompt.
  assert.equal(captured.request?.coordinatorInternalNotification, true)
}

async function testTheImRunnerKeepsOwningItsLease(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  await run(baseInput(), captured, async (context) => {
    await context.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
  })

  // The IM runner still has to send a reply after the run settles, so the run
  // body must not release the lease out from under it.
  assert.deepEqual(captured.context?.localRunLease, {
    owner: "im",
    runId: "run-1",
    managedExternally: true
  })
}

async function testCancellationSurfacesAsAnAbort(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  await assert.rejects(
    run(baseInput(), captured, async (context) => {
      context.onRunCancelled?.()
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    "a cancelled run must not be reported to the user as a completed turn"
  )
}

async function testAGoalNoticeStandsInForAMissingReply(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  const text = await run(baseInput(), captured, async (context) => {
    context.onGoalNotice?.({
      message: "Goal 已暂停",
      goalId: "g1",
      activeWindowId: null,
      eventId: 1,
      createdAt: 1
    })
  })
  assert.equal(text, "Goal 已暂停")
}

async function testAToolOnlyTurnStillReplies(): Promise<void> {
  // A successful turn that produced no assistant text is normal (tool-only
  // work). The runner this replaces answered "处理完成。"; failing the delivery
  // instead would surface as an error in the user's IM chat.
  const captured: Captured = { request: null, context: null }
  const text = await run(baseInput(), captured, async (context) => {
    context.onRunTerminated?.({ outcome: "success", code: "normal" })
  })
  assert.equal(text, "处理完成。")
}

async function testAFailedRunRethrowsTheOriginalError(): Promise<void> {
  // IM classifies retryability off the error itself (isRetryableApiError). The
  // run body reports failures to the renderer and returns, so without the
  // terminal callback every failure would reach IM as one generic "no reply"
  // and a retryable provider blip would be marked permanently failed.
  const captured: Captured = { request: null, context: null }
  const providerError = new Error("upstream 503")
  await assert.rejects(
    run(baseInput(), captured, async (context) => {
      context.onRunTerminated?.({
        outcome: "error",
        code: "provider_error",
        message: "upstream 503",
        error: providerError
      })
    }),
    (thrown: unknown) => thrown === providerError,
    "the original error must survive, not be replaced by a generic one"
  )
}

async function testAFailureWithoutAnErrorObjectStillFails(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  await assert.rejects(
    run(baseInput(), captured, async (context) => {
      context.onRunTerminated?.({ outcome: "error", code: "hook_halt", message: "Hook 拦截" })
    }),
    /Hook 拦截/,
    "a halt without an Error object must still surface its reason"
  )
}

async function testASuccessfulTerminalDoesNotMaskTheReply(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  const text = await run(baseInput(), captured, async (context) => {
    context.onRunTerminated?.({ outcome: "success", code: "normal" })
    await context.onFinalAssistant?.({ messageId: "m1", finalText: "完成" })
  })
  assert.equal(text, "完成")
}

async function testTheAuthorizationCheckReachesTheRunBody(): Promise<void> {
  // IM's capability guard validates a target, then does async work before the
  // run starts, while the run body reads the thread's current metadata.
  const captured: Captured = { request: null, context: null }
  const verify = (): string | null => "绑定已变化"
  await run(baseInput({ verifyResolvedThread: verify }), captured, async (context) => {
    await context.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
  })
  assert.equal(
    captured.context?.verifyResolvedThread,
    verify,
    "the caller's authorization check must reach the run body"
  )
}

async function main(): Promise<void> {
  for (const test of [
    testInboxOnlyRuntimeOptionsTravelOnThePolicy,
    testTheBridgeLeavesTranscriptPersistenceToTheRunBody,
    testTheRunBodyStillHonoursWhatTheBridgeDependsOn
  ]) {
    test()
    console.log(`PASS ${test.name}`)
  }

  for (const test of [
    testTurnInputMapsOntoTheRunContext,
    testANotificationTurnIsMarkedAsInternal,
    testTheImRunnerKeepsOwningItsLease,
    testCancellationSurfacesAsAnAbort,
    testAGoalNoticeStandsInForAMissingReply,
    testAToolOnlyTurnStillReplies,
    testAFailedRunRethrowsTheOriginalError,
    testAFailureWithoutAnErrorObjectStillFails,
    testASuccessfulTerminalDoesNotMaskTheReply,
    testTheAuthorizationCheckReachesTheRunBody
  ]) {
    await test()
    console.log(`PASS ${test.name}`)
  }
  console.log("im-desktop-run-bridge.spec.ts passed")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
