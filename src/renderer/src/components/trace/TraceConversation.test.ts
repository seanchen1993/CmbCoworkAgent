import { describe, expect, it } from "vitest"
import {
  COORDINATOR_NOTIFICATION_PROMPT,
  INTERNAL_NOTIFICATION_TRIGGER_SOURCE,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../../../../shared/internal-notification-turn"
import {
  buildThreadConversation,
  buildTraceConversation,
  isThreadAwaitingFullLoad,
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

describe("skeleton entries", () => {
  it("marks a tool call whose payload the byte budget could not afford", () => {
    // The collector keeps such a call's name and drops its args and result, so
    // without the flag the panel shows a tool invoked with no arguments that
    // returned nothing — which reads as a failed call, not a recording limit.
    const conversation = buildTraceConversation({
      traceId: "trace-skeleton",
      startedAt: "2026-07-14T15:21:00.000Z",
      executionMode: "normal",
      userMessage: "分析仓库",
      steps: [
        {
          startedAt: "2026-07-14T15:21:01.000Z",
          assistantText: "先读文件",
          toolCalls: [{ name: "read_file", args: { path: "README.md" }, result: "ok" }]
        },
        {
          startedAt: "2026-07-14T15:21:02.000Z",
          assistantText: "",
          truncated: true,
          toolCalls: [{ name: "read_file", args: {}, truncated: true }]
        }
      ]
    } as unknown as TraceConversationSource)

    const tools = conversation.messages.flatMap(
      (message) =>
        (message as unknown as { tools?: Array<{ name: string; truncated?: boolean }> }).tools ?? []
    )
    expect(tools).toHaveLength(2)
    expect(tools[0].truncated).toBeUndefined()
    expect(tools[1].truncated).toBe(true)
    // The name is what the skeleton exists to keep.
    expect(tools[1].name).toBe("read_file")
  })

  it("does not invent an empty assistant reply for a skeleton turn", () => {
    const conversation = buildTraceConversation({
      traceId: "trace-skeleton-2",
      startedAt: "2026-07-14T15:21:00.000Z",
      executionMode: "normal",
      userMessage: "分析仓库",
      modelCalls: [
        { startedAt: "2026-07-14T15:21:01.000Z", outputMessage: { content: "有内容" } },
        { startedAt: "2026-07-14T15:21:02.000Z", outputMessage: { content: "" }, truncated: true }
      ]
    } as unknown as TraceConversationSource)

    const assistants = conversation.messages.filter((message) => message.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(String((assistants[0] as unknown as { content?: string }).content)).toContain("有内容")
  })
})

/**
 * 会话列表改成摘要预览（不含 `_raw`）之后，预览行没有任何对话数据：没有
 * modelCalls、没有 steps、没有 nodes。此前的兜底会拿 outcome 去补一句「本次运行
 * 被取消，trace 中没有记录最终回复」——那是拿缺失的数据下结论，线上实际表现是
 * 加载中的会话满屏「被取消」，加载完成后同一条 trace 明明有完整对话。
 */
describe("摘要预览行不得被当成对话渲染", () => {
  const previewTrace = (
    overrides: Partial<TraceConversationSource> = {}
  ): TraceConversationSource => ({
    traceId: "preview-1",
    startedAt: "2026-09-04T12:08:56.000Z",
    endedAt: "2026-09-04T12:19:39.000Z",
    executionMode: "normal",
    userMessage: "",
    rawPending: true,
    ...overrides
  })

  it("不给预览行编造「被取消」的结论", () => {
    const conversation = buildTraceConversation(previewTrace({ outcome: "cancelled" }))
    expect(conversation.assistantText).toBe("")
    expect(JSON.stringify(conversation.messages)).not.toContain("本次运行被取消")
  })

  it("不给预览行编造「运行失败」的结论", () => {
    const conversation = buildTraceConversation(
      previewTrace({ outcome: "error", errorMessage: "" })
    )
    expect(JSON.stringify(conversation.messages)).not.toContain("本次运行失败")
  })

  it("真正取消 / 失败的 trace 仍然照常说明原因", () => {
    // 兜底本身是对的，只是不该套在「数据还没取回来」的行上。
    const cancelled = buildTraceConversation({
      traceId: "real-1",
      startedAt: "2026-09-04T12:08:56.000Z",
      outcome: "cancelled",
      userMessage: "帮我改一下"
    })
    expect(JSON.stringify(cancelled.messages)).toContain("本次运行被取消")

    const failed = buildTraceConversation({
      traceId: "real-2",
      startedAt: "2026-09-04T12:08:56.000Z",
      outcome: "error",
      errorMessage: "模型服务不可用",
      userMessage: "帮我改一下"
    })
    expect(JSON.stringify(failed.messages)).toContain("模型服务不可用")
  })

  it("预览行仍会保留已索引的用户提问", () => {
    const conversation = buildTraceConversation(
      previewTrace({ userMessage: "需求ID: 6382", outcome: "success" })
    )
    expect(conversation.userText).toContain("6382")
    expect(conversation.assistantText).toBe("")
  })
})

describe("整个 thread 还是摘要预览时不渲染时间线", () => {
  const preview = (id: string): TraceConversationSource => ({
    traceId: id,
    startedAt: "2026-09-04T12:08:56.000Z",
    rawPending: true
  })
  const loaded = (id: string): TraceConversationSource => ({
    traceId: id,
    startedAt: "2026-09-04T12:08:56.000Z",
    userMessage: "帮我改一下",
    modelCalls: [{ outputMessage: { content: "改好了" } }]
  })

  it("全部是预览行 → 显示占位而不是半张脸的时间线", () => {
    expect(isThreadAwaitingFullLoad([preview("a"), preview("b")])).toBe(true)
  })

  it("已经有数据陆续到位就照常渲染", () => {
    expect(isThreadAwaitingFullLoad([preview("a"), loaded("b")])).toBe(false)
    expect(isThreadAwaitingFullLoad([loaded("a")])).toBe(false)
  })

  it("空列表不算「等待加载」，走原来的空态文案", () => {
    expect(isThreadAwaitingFullLoad([])).toBe(false)
  })
})
