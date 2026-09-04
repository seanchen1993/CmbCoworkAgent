/**
 * IM turns routed into the authoritative desktop run body.
 *
 * The bridge is a drop-in for executePreparedRemoteStandardTurn, so these tests
 * pin the mapping it performs: what the run body can derive for itself is left
 * alone, and the two things it cannot know about (an inbox turn's auto-approved
 * edits and its scheduler delivery binding) ride the remote policy that the
 * shared controlled factory applies for every caller alike.
 *
 * Run:
 *   npx tsx tests/im-desktop-run-bridge.spec.ts
 */

import assert from "node:assert/strict"
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

async function testTurnInputMapsOntoTheRunContext(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  const hooks = { onWaitStart: () => undefined, onWaitEnd: () => undefined }
  const skill = { name: "deploy", version: "1.0.0" } as PreparedRemoteStandardTurnInput["explicitSkill"]

  const text = await executeRemoteStandardTurnOnDesktopRunBody(
    baseInput({
      agentMode: "coordinator",
      explicitSkill: skill,
      interactionWaitHooks: hooks,
      remotePolicy: { disableMcpTools: true }
    }),
    {
      getDelivery: () => delivery,
      persistUserMessage: () => undefined,
      startRun: stubRun(captured, async (context) => {
        await context.onFinalAssistant?.({ messageId: "m1", finalText: "  构建成功  " })
      })
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

async function testTheImRunnerKeepsOwningItsLease(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  await executeRemoteStandardTurnOnDesktopRunBody(baseInput(), {
    getDelivery: () => delivery,
    persistUserMessage: () => undefined,
    startRun: stubRun(captured, async (context) => {
      await context.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
    })
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
    executeRemoteStandardTurnOnDesktopRunBody(baseInput(), {
      getDelivery: () => delivery,
      persistUserMessage: () => undefined,
      startRun: stubRun(captured, async (context) => {
        context.onRunCancelled?.()
      })
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    "a cancelled run must not be reported to the user as a completed turn"
  )
}

async function testAGoalNoticeStandsInForAMissingReply(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  const text = await executeRemoteStandardTurnOnDesktopRunBody(baseInput(), {
    getDelivery: () => delivery,
    persistUserMessage: () => undefined,
    startRun: stubRun(captured, async (context) => {
      context.onGoalNotice?.({
        message: "Goal 已暂停",
        goalId: "g1",
        activeWindowId: null,
        eventId: 1,
        createdAt: 1
      })
    })
  })
  assert.equal(text, "Goal 已暂停")
}

async function testARunThatSaysNothingIsAnError(): Promise<void> {
  const captured: Captured = { request: null, context: null }
  await assert.rejects(
    executeRemoteStandardTurnOnDesktopRunBody(baseInput(), {
      getDelivery: () => delivery,
      persistUserMessage: () => undefined,
      startRun: stubRun(captured, async () => undefined)
    }),
    /未产生可回传结果/,
    "an empty run must fail loudly rather than reply with nothing"
  )
}

async function testTheUserMessageReachesTheTranscript(): Promise<void> {
  // On desktop the renderer persists the user's message before invoking, so the
  // run body only persists what the stream produces. An IM turn has no
  // renderer: without the bridge writing it, the message never appears.
  const persisted: Array<{ threadId: string; messageId: string; content: string }> = []
  const captured: Captured = { request: null, context: null }
  await executeRemoteStandardTurnOnDesktopRunBody(baseInput(), {
    getDelivery: () => delivery,
    persistUserMessage: (entry) => persisted.push(entry),
    startRun: stubRun(captured, async (context) => {
      await context.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
    })
  })
  assert.deepEqual(persisted, [
    { threadId: "t1", messageId: "im:42:user", content: "查一下今天的构建" }
  ])
}

async function testANotificationTurnLeavesNoUserBubble(): Promise<void> {
  // A notification turn's marker prompt is plumbing, not user input.
  const persisted: unknown[] = []
  const captured: Captured = { request: null, context: null }
  await executeRemoteStandardTurnOnDesktopRunBody(
    baseInput({ internalNotificationTurn: true, persistUserMessage: false }),
    {
      getDelivery: () => delivery,
      persistUserMessage: (entry) => persisted.push(entry),
      startRun: stubRun(captured, async (context) => {
        await context.onFinalAssistant?.({ messageId: "m1", finalText: "ok" })
      })
    }
  )
  assert.deepEqual(persisted, [], "a notification turn must not create a user bubble")
  assert.equal(captured.request?.coordinatorInternalNotification, true)
}

async function main(): Promise<void> {
  testInboxOnlyRuntimeOptionsTravelOnThePolicy()
  console.log("PASS testInboxOnlyRuntimeOptionsTravelOnThePolicy")

  for (const test of [
    testTheUserMessageReachesTheTranscript,
    testANotificationTurnLeavesNoUserBubble,
    testTurnInputMapsOntoTheRunContext,
    testTheImRunnerKeepsOwningItsLease,
    testCancellationSurfacesAsAnAbort,
    testAGoalNoticeStandsInForAMissingReply,
    testARunThatSaysNothingIsAnError
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
