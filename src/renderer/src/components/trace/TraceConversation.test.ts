import { describe, expect, it } from "vitest"
import {
  COORDINATOR_NOTIFICATION_PROMPT,
  INTERNAL_NOTIFICATION_TRIGGER_SOURCE,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../../../../shared/internal-notification-turn"
import {
  buildThreadConversation,
  buildTraceConversation,
  type TraceConversationSource
} from "./TraceConversation"

function traceWithResponse(
  overrides: Partial<TraceConversationSource> = {}
): TraceConversationSource {
  return {
    traceId: "trace-1",
    startedAt: "2026-07-14T15:21:00.000Z",
    executionMode: "normal",
    userMessage: "普通用户请求",
    modelCalls: [{ outputMessage: { content: "已处理完成" } }],
    steps: [
      {
        toolCalls: [{ name: "read_file", args: { path: "README.md" }, result: "ok" }]
      }
    ],
    ...overrides
  }
}

describe("Trace conversation internal notifications", () => {
  it("hides an explicitly marked coordinator notification but keeps its response and tools", () => {
    const result = buildTraceConversation(
      traceWithResponse({
        executionMode: "coordinator",
        triggerSource: INTERNAL_NOTIFICATION_TRIGGER_SOURCE,
        userMessage: "transport-only internal coordinator turn"
      })
    )

    expect(result.internalNotificationKind).toBe("coordinator")
    expect(result.userText).toBe("")
    expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool"])
    expect(result.assistantText).toBe("已处理完成")
    expect(result.toolNames).toEqual(["read_file"])
  })

  it("recognizes historical workflow and coordinator notification traces", () => {
    const workflow = buildTraceConversation(
      traceWithResponse({
        executionMode: "workflow",
        userMessage: WORKFLOW_NOTIFICATION_TURN_PROMPT
      })
    )
    const coordinator = buildTraceConversation(
      traceWithResponse({
        executionMode: "coordinator",
        userMessage: COORDINATOR_NOTIFICATION_PROMPT
      })
    )

    expect(workflow.internalNotificationKind).toBe("workflow")
    expect(workflow.messages.some((message) => message.role === "user")).toBe(false)
    expect(coordinator.internalNotificationKind).toBe("coordinator")
    expect(coordinator.messages.some((message) => message.role === "user")).toBe(false)
  })

  it("uses the root trace input when the top-level user message is absent", () => {
    const result = buildTraceConversation(
      traceWithResponse({
        executionMode: "workflow",
        userMessage: "",
        nodes: [
          {
            type: "trace",
            input: { userMessage: WORKFLOW_NOTIFICATION_TURN_PROMPT }
          }
        ]
      })
    )

    expect(result.internalNotificationKind).toBe("workflow")
    expect(result.userText).toBe("")
  })

  it("keeps user-pasted marker-like text and exact prompts outside the matching mode", () => {
    const pasted = `${WORKFLOW_NOTIFICATION_TURN_PROMPT}\n这是用户粘贴的日志`
    const workflowPaste = buildTraceConversation(
      traceWithResponse({ executionMode: "workflow", userMessage: pasted })
    )
    const normalWorkflowPrompt = buildTraceConversation(
      traceWithResponse({ userMessage: WORKFLOW_NOTIFICATION_TURN_PROMPT })
    )
    const normalCoordinatorPrompt = buildTraceConversation(
      traceWithResponse({ userMessage: COORDINATOR_NOTIFICATION_PROMPT })
    )

    expect(workflowPaste.userText).toBe(pasted)
    expect(normalWorkflowPrompt.userText).toBe(WORKFLOW_NOTIFICATION_TURN_PROMPT)
    expect(normalCoordinatorPrompt.userText).toBe(COORDINATOR_NOTIFICATION_PROMPT)
  })

  it("omits only the synthetic user turn from a reconstructed thread", () => {
    const result = buildThreadConversation([
      traceWithResponse({
        traceId: "trace-user",
        startedAt: "2026-07-14T15:20:00.000Z",
        userMessage: "实现页面",
        modelCalls: [{ outputMessage: { content: "已启动后台任务" } }]
      }),
      traceWithResponse({
        traceId: "trace-notification",
        startedAt: "2026-07-14T15:21:00.000Z",
        executionMode: "workflow",
        triggerSource: INTERNAL_NOTIFICATION_TRIGGER_SOURCE,
        userMessage: WORKFLOW_NOTIFICATION_TURN_PROMPT,
        modelCalls: [{ outputMessage: { content: "后台任务已经完成" } }]
      })
    ])

    expect(result.messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(2)
    expect(result.messages.some((message) => message.content.includes("CMB_WORKFLOW"))).toBe(false)
    expect(result.messages.some((message) => message.content === "后台任务已经完成")).toBe(true)
  })
})
