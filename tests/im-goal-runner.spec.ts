import assert from "node:assert/strict"
import type {
  AgentRunDelivery,
  AgentRunExecutionContext,
  AgentRunRequest
} from "../src/main/agent/agent-run-service"
import { ImGoalRunBridge } from "../src/main/services/im/goal-runner"

const delivery = {
  window: {} as AgentRunDelivery["window"],
  isAvailable: () => true,
  send: () => undefined
} satisfies AgentRunDelivery

async function main(): Promise<void> {
  let capturedRequest: AgentRunRequest | null = null
  let capturedContext: AgentRunExecutionContext | null = null
  let cancelNextRun = false
  const bridge = new ImGoalRunBridge({
    getDelivery: () => delivery,
    hasActiveGoal: () => false,
    controlGoal: async (request, _delivery, context) => {
      capturedContext = context
      const notice = {
        message: request.message === "/goal pause" ? "Goal 已暂停" : "Goal 状态已刷新",
        goalId: "goal-1",
        activeWindowId: "window-1",
        eventId: 2,
        createdAt: 2
      }
      context.onGoalNotice?.(notice)
      return { handled: true, terminatedCurrentRun: request.message === "/goal pause", notice }
    },
    startRun: async (request, _delivery, context) => {
      capturedRequest = request
      capturedContext = context
      return {
        threadId: request.threadId,
        completion: (async () => {
          context.onGoalNotice?.({
            message: request.message === "/goal pause" ? "Goal 已暂停" : "Goal 已设置",
            goalId: "goal-1",
            activeWindowId: "window-1",
            eventId: 1,
            createdAt: 1
          })
          if (cancelNextRun) {
            cancelNextRun = false
            context.onRunCancelled?.()
          } else if (request.message !== "/goal pause") {
            await context.onFinalAssistant?.({
              messageId: "assistant-1",
              finalText: "Goal 第一轮已完成"
            })
          }
        })()
      }
    }
  })

  assert.equal(bridge.shouldUseGoalPipeline("thread-1", "/goal 完成任务"), true)
  assert.equal(
    bridge.shouldUseGoalPipeline("thread-1", "/goal 作为普通文本", {
      ignoreSlashCommand: true
    }),
    false
  )

  const result = await bridge.run({
    threadId: "thread-1",
    target: {
      kind: "thread",
      targetId: "target-1",
      grantId: "grant-1",
      grantVersion: 1,
      threadId: "thread-1",
      title: "授权会话",
      workspacePath: "/workspace"
    },
    metadata: { workspacePath: "/workspace", agentMode: "normal" },
    prepared: { kind: "ordinary", visibleText: "/goal 完成任务" },
    runId: "im-run-1",
    signal: new AbortController().signal,
    userMessageId: "im:event-1:user",
    agentMode: "normal"
  })
  assert.equal(result, "Goal 第一轮已完成")
  assert.equal(capturedRequest?.message, "/goal 完成任务")
  assert.deepEqual(capturedContext?.localRunLease, {
    owner: "im",
    runId: "im-run-1",
    managedExternally: true
  })
  assert.equal(capturedContext?.source, "im")
  assert.equal(capturedContext?.allowTrustedTransportSkillMarker, true)

  const control = await bridge.runControl({
    threadId: "thread-1",
    message: "/goal pause",
    userMessageId: "im:event-2:goal-control"
  })
  assert.equal(control, "Goal 已暂停")
  assert.equal(capturedContext?.allowForeignOwnerGoalControl, true)

  cancelNextRun = true
  await assert.rejects(
    bridge.run({
      threadId: "thread-1",
      target: {
        kind: "thread",
        targetId: "target-1",
        grantId: "grant-1",
        grantVersion: 1,
        threadId: "thread-1",
        title: "授权会话",
        workspacePath: "/workspace"
      },
      metadata: { workspacePath: "/workspace", agentMode: "normal" },
      prepared: { kind: "ordinary", visibleText: "/goal 会被暂停" },
      runId: "im-run-2",
      signal: new AbortController().signal,
      userMessageId: "im:event-3:user",
      agentMode: "normal"
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  )

  console.log("IM Goal runner tests passed")
}

void main()
