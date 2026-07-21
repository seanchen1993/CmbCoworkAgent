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
import { summarizeThreadProjectNodes } from "./trace-project-node-summary"

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

describe("Thread project node summary", () => {
  it("deduplicates visited project nodes regardless of node status", () => {
    const result = summarizeThreadProjectNodes([
      traceWithResponse({
        harnessProjectId: "project-1",
        harnessNodeName: "Dev-代码实现",
        harnessNodeStatus: "已完成"
      }),
      traceWithResponse({
        traceId: "child-trace",
        traceKind: "subagent",
        harnessProjectId: "project-1",
        harnessNodeName: " Dev-代码实现 ",
        harnessNodeStatus: " 已完成 "
      }),
      traceWithResponse({
        traceId: "next-node",
        harnessProjectId: "project-1",
        harnessNodeName: "Dev-单元测试",
        harnessNodeStatus: "已完成"
      }),
      traceWithResponse({
        traceId: "in-progress-node",
        harnessProjectId: "project-1",
        harnessNodeName: "Dev-E2E 测试",
        harnessNodeStatus: "进行中"
      }),
      traceWithResponse({
        traceId: "status-missing-node",
        harnessProjectId: "project-1",
        harnessNodeName: "Ops-发布"
      })
    ])

    expect(result).toEqual({
      isProjectMode: true,
      visitedNodeNames: ["Dev-代码实现", "Dev-单元测试", "Dev-E2E 测试", "Ops-发布"]
    })
  })

  it("does not infer project mode from node-looking fields without a project binding", () => {
    expect(
      summarizeThreadProjectNodes([
        traceWithResponse({
          harnessNodeName: "Dev-代码实现",
          harnessNodeStatus: "已完成"
        })
      ])
    ).toEqual({ isProjectMode: false, visitedNodeNames: [] })
  })

  it("keeps project mode visible when no node attribution has been recorded", () => {
    expect(
      summarizeThreadProjectNodes([
        traceWithResponse({
          harnessProjectId: "project-1"
        })
      ])
    ).toEqual({ isProjectMode: true, visitedNodeNames: [] })
  })
})

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

describe("Trace conversation event timeline", () => {
  it("places a completed child agent before the root agent final reply", () => {
    const result = buildThreadConversation([
      traceWithResponse({
        traceId: "root-trace",
        startedAt: "2026-07-15T14:23:00.000Z",
        endedAt: "2026-07-15T14:26:00.000Z",
        userMessage: "审查项目",
        modelCalls: undefined,
        steps: undefined,
        nodes: [
          {
            id: "root-node",
            type: "trace",
            startedAt: "2026-07-15T14:23:00.000Z",
            input: { userMessage: "审查项目" }
          },
          {
            id: "root-dispatch",
            type: "llm",
            startedAt: "2026-07-15T14:23:05.000Z",
            endedAt: "2026-07-15T14:23:06.000Z",
            output: ""
          },
          {
            id: "task-call",
            parentId: "root-dispatch",
            type: "tool",
            name: "task",
            startedAt: "2026-07-15T14:23:06.000Z",
            input: { description: "执行代码审查" }
          },
          {
            id: "root-final",
            type: "llm",
            startedAt: "2026-07-15T14:25:50.000Z",
            endedAt: "2026-07-15T14:26:00.000Z",
            output: "主 Agent 最终回复"
          }
        ]
      }),
      traceWithResponse({
        traceId: "child-trace",
        traceKind: "subagent",
        subagentKind: "task",
        parentTraceId: "root-trace",
        startedAt: "2026-07-15T14:23:07.000Z",
        endedAt: "2026-07-15T14:25:40.000Z",
        userMessage: "执行代码审查",
        modelCalls: undefined,
        steps: undefined,
        nodes: [
          {
            id: "child-dispatch",
            type: "llm",
            startedAt: "2026-07-15T14:23:08.000Z",
            endedAt: "2026-07-15T14:23:09.000Z",
            output: ""
          },
          {
            id: "child-read",
            parentId: "child-dispatch",
            type: "tool",
            name: "read_file",
            startedAt: "2026-07-15T14:23:09.000Z",
            endedAt: "2026-07-15T14:23:10.000Z"
          },
          {
            id: "child-final",
            type: "llm",
            startedAt: "2026-07-15T14:25:30.000Z",
            endedAt: "2026-07-15T14:25:40.000Z",
            output: "子 Agent 审查结果"
          }
        ]
      })
    ])

    const contents = result.messages.map((message) => message.content)
    const taskToolIndex = contents.findIndex((content) => content.includes("task"))
    const subagentIndex = result.messages.findIndex((message) => message.role === "subagent")
    expect(contents.indexOf("审查项目")).toBeLessThan(taskToolIndex)
    expect(taskToolIndex).toBeLessThan(subagentIndex)
    expect(subagentIndex).toBeLessThan(contents.indexOf("主 Agent 最终回复"))
    expect(result.messages[subagentIndex]?.subagentRun).toMatchObject({
      actorLabel: "Task Agent",
      sourceLabel: "主 Agent",
      instruction: "执行代码审查",
      result: "子 Agent 审查结果",
      tools: [expect.objectContaining({ name: "read_file" })]
    })
    expect(result.toolNames).toEqual(["task", "read_file"])
    expect(
      result.messages.some(
        (message) => message.role === "user" && message.content === "执行代码审查"
      )
    ).toBe(false)
  })

  it("keeps explicit reasoning attached to the matching assistant event", () => {
    const fromNode = buildTraceConversation(
      traceWithResponse({
        modelCalls: undefined,
        steps: undefined,
        nodes: [
          {
            id: "llm-1",
            type: "llm",
            startedAt: "2026-07-14T15:21:01.000Z",
            endedAt: "2026-07-14T15:21:02.000Z",
            output: "节点回答",
            metadata: { reasoning: "节点思考摘要" }
          }
        ]
      })
    )
    const fromModelCall = buildTraceConversation(
      traceWithResponse({
        modelCalls: [
          {
            startedAt: "2026-07-14T15:21:01.000Z",
            outputMessage: { content: "模型回答", reasoning: "模型思考摘要" }
          }
        ],
        steps: []
      })
    )

    expect(fromNode.messages.find((message) => message.role === "assistant")).toMatchObject({
      content: "节点回答",
      reasoning: "节点思考摘要"
    })
    expect(fromModelCall.messages.find((message) => message.role === "assistant")).toMatchObject({
      content: "模型回答",
      reasoning: "模型思考摘要"
    })
  })

  it("keeps identical replies emitted by different model events", () => {
    const result = buildTraceConversation(
      traceWithResponse({
        modelCalls: undefined,
        steps: undefined,
        nodes: [
          {
            id: "llm-1",
            type: "llm",
            endedAt: "2026-07-14T15:21:01.000Z",
            output: "继续处理"
          },
          {
            id: "llm-2",
            type: "llm",
            endedAt: "2026-07-14T15:21:02.000Z",
            output: "继续处理"
          }
        ]
      })
    )

    expect(result.messages.filter((message) => message.content === "继续处理")).toHaveLength(2)
  })
})
