import { ContextOverflowError } from "@langchain/core/errors"
import {
  AIMessage,
  type BaseMessage,
  getBufferString,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { Command, MemorySaver } from "@langchain/langgraph"
import { createAgent, FakeToolCallingModel } from "langchain"
import { describe, expect, it, vi } from "vitest"
import {
  neutralizeWorkflowPlumbingUserText,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../../shared/checkpoint-transcript"
import {
  createCmbSummarizationMiddleware,
  isCmbContextOverflow,
  SUMMARIZATION_STATE_OWNER_KEY
} from "./context-summarization-middleware"

type SummaryRequest = {
  messages: BaseMessage[]
  state: Record<string, unknown>
  runtime?: { signal?: AbortSignal; configurable?: Record<string, unknown> }
  systemMessage?: undefined
  tools: unknown[]
}

type TestSummarizationMiddleware = {
  wrapModelCall: (
    request: SummaryRequest,
    handler: (request: SummaryRequest) => Promise<AIMessage>
  ) => Promise<unknown>
}

type TestBackend = {
  write: (path: string, content?: string) => Promise<{ path?: string; error?: string }>
  writeInternalArtifact?: (path: string, content: string) => Promise<{ error?: string }>
  appendInternalArtifact?: (path: string, content: string) => Promise<{ error?: string }>
  internalArtifactExists?: (path: string) => Promise<boolean>
  downloadFiles?: (
    paths: string[]
  ) => Promise<Array<{ path?: string; content?: Uint8Array; error?: string }>>
  uploadFiles?: (
    files: Array<[string, Uint8Array]>
  ) => Promise<Array<{ path?: string; error?: string }>>
}

function createBackend(): TestBackend {
  return {
    write: async (path) => ({ path }),
    downloadFiles: async () => []
  }
}

function createTestMiddleware(
  invoke: (messages: BaseMessage[], options?: { signal?: AbortSignal }) => Promise<AIMessage>,
  options: {
    keepTokens?: number
    trimTokensToSummarize?: number
    fallbackInvoke?: (messages: BaseMessage[]) => Promise<AIMessage>
    historyPathPrefix?: string
    legacyHistoryPathPrefix?: string
    backend?: TestBackend
    trigger?: { type: "messages" | "tokens" | "fraction"; value: number }
    stateOwnerConfigKey?: string
    maxInputTokens?: number
    postCompactionInputBudgetTokens?: number
    modelProfile?: Record<string, unknown>
    truncateArgsSettings?: {
      trigger?: { type: "messages" | "tokens" | "fraction"; value: number }
      keep?: { type: "messages" | "tokens" | "fraction"; value: number }
      maxLength?: number
    }
  } = {}
): TestSummarizationMiddleware {
  const model = {
    profile: options.modelProfile ?? { maxInputTokens: 32_000 },
    invoke
  }
  const fallbackModel = options.fallbackInvoke
    ? {
        profile: { maxInputTokens: 32_000 },
        invoke: options.fallbackInvoke
      }
    : undefined
  return createCmbSummarizationMiddleware({
    model: model as never,
    ...(fallbackModel ? { fallbackModel: fallbackModel as never } : {}),
    backend: (options.backend ?? createBackend()) as never,
    trigger: options.trigger ?? { type: "tokens", value: 1 },
    keep: { type: "tokens", value: options.keepTokens ?? 4_000 },
    ...(options.maxInputTokens != null && { maxInputTokens: options.maxInputTokens }),
    ...(options.postCompactionInputBudgetTokens != null && {
      postCompactionInputBudgetTokens: options.postCompactionInputBudgetTokens
    }),
    trimTokensToSummarize: options.trimTokensToSummarize ?? 20_800,
    ...(options.truncateArgsSettings && {
      truncateArgsSettings: options.truncateArgsSettings
    }),
    ...(options.stateOwnerConfigKey && { stateOwnerConfigKey: options.stateOwnerConfigKey }),
    ...(options.historyPathPrefix ? { historyPathPrefix: options.historyPathPrefix } : {}),
    ...(options.legacyHistoryPathPrefix
      ? { legacyHistoryPathPrefix: options.legacyHistoryPathPrefix }
      : {})
  }) as unknown as TestSummarizationMiddleware
}

function validSummary(label: string): string {
  return `## Goal
- ${label}: preserve the user's requested engineering outcome and continue without redoing completed work.
## Constraints
- Keep existing behavior compatible and avoid unrelated changes.
## Completed
- Relevant source paths and prior verification have been captured.
## Current State
- The implementation is ready for the next concrete action.
## Blockers
- None currently known.
## Key Decisions
- Preserve structured message roles and exact operational evidence.
## Next Step
- Continue with the latest explicit user request.
## Critical Evidence
- Tests and exact sentinel values from the conversation remain available.`
}

function renderedRequest(messages: BaseMessage[]): string {
  return getBufferString(messages)
}

function renderedSummaryTranscript(messages: BaseMessage[]): string {
  const request = String(messages[1]?.content ?? "")
  return request.match(/<messages>\n([\s\S]*?)\n<\/messages>/)?.[1] ?? request
}

function largeToolResult(start: string, end: string): string {
  return `${start}\n${"x".repeat(23_900)}\n${end}`
}

function realFailureShapeMessages(): SummaryRequest["messages"] {
  const toolCalls = [1, 2, 3, 4].map((index) => ({
    name: "read_file",
    args: { file_path: `/project/file-${index}.ts`, offset: 0, limit: 2_000 },
    id: `read-${index}`,
    type: "tool_call" as const
  }))
  return [
    new HumanMessage("ORIGINAL_TASK_SENTINEL: read four files and produce an architecture summary"),
    new AIMessage({ content: "", tool_calls: toolCalls }),
    new ToolMessage({
      content: largeToolResult("TOOL_ONE_START", "TOOL_ONE_END"),
      tool_call_id: "read-1"
    }),
    new ToolMessage({
      content: largeToolResult("TOOL_TWO_START", "TOOL_TWO_END"),
      tool_call_id: "read-2"
    }),
    new ToolMessage({
      content: largeToolResult("TOOL_THREE_START", "TOOL_THREE_END"),
      tool_call_id: "read-3"
    }),
    new ToolMessage({
      content: largeToolResult("TOOL_FOUR_START", "TOOL_FOUR_END"),
      tool_call_id: "read-4"
    }),
    new HumanMessage("RECENT_MESSAGE_TO_KEEP")
  ]
}

describe("OpenAI-compatible context overflow classification", () => {
  it.each([
    Object.assign(new Error("context window exceeds limit"), { status: 400 }),
    Object.assign(new Error("prompt is too long: 130000 tokens > 128000 maximum"), {
      statusCode: 400
    }),
    Object.assign(new Error("payload rejected"), { status: 413 }),
    Object.assign(new Error("gateway response"), {
      status: 400,
      responseBody: '{"error":{"code":"context_length_exceeded"}}'
    }),
    new Error("outer middleware", {
      cause: Object.assign(new Error("maximum context length is 128000 tokens"), { status: 400 })
    })
  ])("recognises an established overflow shape", (error) => {
    expect(isCmbContextOverflow(error)).toBe(true)
  })

  it.each([
    Object.assign(new Error("tool_calls must be followed by tool messages"), { status: 400 }),
    Object.assign(new Error("invalid API key"), { status: 401 }),
    Object.assign(new Error("rate limit exceeded"), { status: 429 }),
    new Error("maximum retries exceeded")
  ])("does not turn unrelated provider failures into compaction", (error) => {
    expect(isCmbContextOverflow(error)).toBe(false)
  })

  it("retains the native LangChain overflow brand", () => {
    expect(isCmbContextOverflow(new ContextOverflowError("native overflow"))).toBe(true)
  })
})

describe("CmbCowork context compaction middleware", () => {
  it("restores a summarized HumanMessage through MemorySaver on the next invocation", async () => {
    const summaryModel = new FakeListChatModel({
      responses: Array(4).fill(validSummary("MemorySaver restore"))
    })
    const middleware = createCmbSummarizationMiddleware({
      model: summaryModel,
      backend: createBackend() as never,
      trigger: { type: "messages", value: 2 },
      keep: { type: "messages", value: 1 },
      trimTokensToSummarize: 1_000,
      maxInputTokens: 32_000
    })
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [[], [], [], []] }),
      tools: [],
      middleware: [middleware],
      checkpointer: new MemorySaver()
    })
    const config = { configurable: { thread_id: "summarization-memory-restore" } }

    await agent.invoke(
      {
        messages: [
          { role: "user", content: "FIRST_USER_MESSAGE" },
          { role: "assistant", content: "FIRST_ASSISTANT_MESSAGE" },
          { role: "user", content: "SECOND_USER_MESSAGE" }
        ]
      },
      config
    )

    await expect(
      agent.invoke({ messages: [{ role: "user", content: "RESUMED_USER_MESSAGE" }] }, config)
    ).resolves.toBeDefined()
  })

  it("uses the configured context window when a custom model profile has no limit", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("configured context window")))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      modelProfile: {},
      maxInputTokens: 100,
      trigger: { type: "fraction", value: 0.1 },
      keepTokens: 10
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLD_CONTEXT_SENTINEL ${"x".repeat(400)}`),
          new HumanMessage("RECENT_CONTEXT_SENTINEL")
        ],
        state: {},
        tools: []
      },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("uses provider-reported usage as a lower bound for proactive compaction", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("reported usage trigger")))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "tokens", value: 1_000 },
      keepTokens: 1
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("short earlier request"),
          new AIMessage({
            content: "short earlier response",
            usage_metadata: { input_tokens: 1_200, output_tokens: 100, total_tokens: 1_300 }
          }),
          new HumanMessage("continue")
        ],
        state: {},
        tools: []
      },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("compacts CJK history with the Python-aligned 10% keep window", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("CJK usage trigger")))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      maxInputTokens: 32_000,
      trigger: { type: "tokens", value: 22_808 },
      keepTokens: 3_200
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("write a long Chinese design document"),
          new AIMessage({
            content: "中".repeat(13_400),
            usage_metadata: {
              input_tokens: 21_293,
              output_tokens: 7_308,
              total_tokens: 28_601
            }
          }),
          new HumanMessage("state the title")
        ],
        state: {},
        tools: []
      },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("adds messages after the latest reported usage when checking the trigger", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("reported usage tail")))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "tokens", value: 1_000 },
      keepTokens: 1
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("short earlier request"),
          new AIMessage({
            content: "short earlier response",
            response_metadata: {
              usage: { prompt_tokens: 700, completion_tokens: 100 }
            }
          }),
          new HumanMessage(`new content after the response ${"x".repeat(1_600)}`)
        ],
        state: {},
        tools: []
      },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("keeps approximate counting when the provider omits usage metadata", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("unused")))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "tokens", value: 1_000 },
      keepTokens: 1
    })

    await middleware.wrapModelCall(
      {
        messages: [new HumanMessage("short request without usage metadata")],
        state: {},
        tools: []
      },
      handler
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("serializes the tool schema only once when argument truncation changes nothing", async () => {
    let toolSchemaSerializations = 0
    const countingToolSchema = {
      toJSON: () => {
        toolSchemaSerializations += 1
        return {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} }
          }
        }
      }
    }
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("must not run")),
      {
        trigger: { type: "tokens", value: 1_000_000 },
        truncateArgsSettings: {
          trigger: { type: "messages", value: 100 },
          keep: { type: "messages", value: 1 },
          maxLength: 10
        }
      }
    )

    await middleware.wrapModelCall(
      {
        messages: [new HumanMessage("short request")],
        state: {},
        tools: [countingToolSchema]
      },
      handler
    )

    expect(toolSchemaSerializations).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("recounts exactly once when old tool arguments are actually truncated", async () => {
    let toolSchemaSerializations = 0
    const countingToolSchema = {
      toJSON: () => {
        toolSchemaSerializations += 1
        return {
          type: "function",
          function: {
            name: "write_file",
            description: "Write a file",
            parameters: { type: "object", properties: {} }
          }
        }
      }
    }
    const handler = vi.fn(async (request: SummaryRequest) => {
      const toolCallMessage = request.messages[1]
      expect(AIMessage.isInstance(toolCallMessage)).toBe(true)
      expect(String((toolCallMessage as AIMessage).tool_calls?.[0]?.args.content)).toContain(
        "truncated"
      )
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("must not run")),
      {
        trigger: { type: "tokens", value: 1_000_000 },
        truncateArgsSettings: {
          trigger: { type: "messages", value: 1 },
          keep: { type: "messages", value: 1 },
          maxLength: 10
        }
      }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("write a file"),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "write-1",
                name: "write_file",
                args: { content: "x".repeat(100) },
                type: "tool_call"
              }
            ]
          }),
          new ToolMessage({ content: "written", tool_call_id: "write-1" }),
          new HumanMessage("continue")
        ],
        state: {},
        tools: [countingToolSchema]
      },
      handler
    )

    expect(toolSchemaSerializations).toBe(2)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("does not re-summarize a prior summary when the state cutoff cannot advance", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("must not run")))
    const write = vi.fn(async (path: string) => ({ path }))
    const handler = vi.fn(async (request: SummaryRequest) => {
      expect(request.messages).toHaveLength(1)
      expect(String(request.messages[0]?.content)).toContain("PRIOR_SUMMARY_SENTINEL")
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "tokens", value: 1 },
      keepTokens: 1,
      backend: { write, downloadFiles: async () => [] }
    })

    const result = await middleware.wrapModelCall(
      {
        messages: [new HumanMessage("OLD_RAW_MESSAGE_SENTINEL")],
        state: {
          _summarizationSessionId: "existing-session",
          _summarizationEvent: {
            cutoffIndex: 1,
            summaryMessage: new HumanMessage({
              content: `PRIOR_SUMMARY_SENTINEL ${"x".repeat(8_000)}`,
              additional_kwargs: { lc_source: "summarization" }
            }),
            filePath: "/conversation_history/existing-session.md"
          }
        },
        tools: []
      },
      handler
    )

    expect(result).toBeInstanceOf(AIMessage)
    expect(invoke).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("does not replace a prior summary when only the synthetic summary is evictable", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("must not run")))
    const handler = vi.fn(async (request: SummaryRequest) => {
      expect(request.messages).toHaveLength(2)
      expect(String(request.messages[0]?.content)).toContain("PRIOR_SUMMARY_WITH_TAIL_SENTINEL")
      expect(String(request.messages[1]?.content)).toBe("RECENT_RAW_TAIL_SENTINEL")
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "tokens", value: 1 },
      keepTokens: 100
    })

    const result = await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("OLD_RAW_MESSAGE_SENTINEL"),
          new HumanMessage("RECENT_RAW_TAIL_SENTINEL")
        ],
        state: {
          _summarizationSessionId: "existing-session-with-tail",
          _summarizationEvent: {
            cutoffIndex: 1,
            summaryMessage: new HumanMessage({
              content: `PRIOR_SUMMARY_WITH_TAIL_SENTINEL ${"x".repeat(8_000)}`,
              additional_kwargs: { lc_source: "summarization" }
            }),
            filePath: null
          }
        },
        tools: []
      },
      handler
    )

    expect(result).toBeInstanceOf(AIMessage)
    expect(invoke).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("advances a chained cutoff when at least one new raw message is evicted", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("advanced chained cutoff")))
    const handler = vi.fn(async (request: SummaryRequest) => {
      expect(request.messages).toHaveLength(2)
      expect(String(request.messages[1]?.content)).toBe("D")
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "tokens", value: 1 },
      keepTokens: 1
    })

    const result = await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("A"),
          new AIMessage("B"),
          new HumanMessage("C"),
          new AIMessage("D")
        ],
        state: {
          _summarizationSessionId: "advancing-session",
          _summarizationEvent: {
            cutoffIndex: 2,
            summaryMessage: new HumanMessage({
              content: "PRIOR_ADVANCING_SUMMARY_SENTINEL",
              additional_kwargs: { lc_source: "summarization" }
            }),
            filePath: null
          }
        },
        tools: []
      },
      handler
    )

    expect(result).toBeInstanceOf(Command)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
    const update = (result as Command).update as Record<string, unknown>
    expect((update._summarizationEvent as { cutoffIndex: number }).cutoffIndex).toBe(3)
  })

  it("enters compaction when a compatible gateway reports a known unbranded overflow", async () => {
    const invoke = vi.fn(async () => new AIMessage(validSummary("MiniMax overflow recovery")))
    const handler = vi
      .fn<(request: SummaryRequest) => Promise<AIMessage>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("context window exceeds limit"), { status: 400 })
      )
      .mockResolvedValueOnce(new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      trigger: { type: "messages", value: 100 },
      keepTokens: 1
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLD_CONTEXT ${"x".repeat(4_000)}`),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      handler
    )

    expect(handler).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("does not apply a parent cutoff event to an isolated task-subagent prompt", async () => {
    const ownerConfigKey = "cmb_test_subagent_owner"
    const owner = "task-123"
    const handler = vi.fn(async (request: SummaryRequest) => {
      expect(renderedRequest(request.messages)).toContain("SUBAGENT_TASK_SENTINEL")
      expect(renderedRequest(request.messages)).not.toContain("PARENT_SUMMARY_SENTINEL")
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(async () => new AIMessage(validSummary("unused")), {
      trigger: { type: "messages", value: 10 },
      stateOwnerConfigKey: ownerConfigKey
    })

    await middleware.wrapModelCall(
      {
        messages: [new HumanMessage("SUBAGENT_TASK_SENTINEL: inspect the assigned file")],
        state: {
          _summarizationSessionId: "parent-session",
          _summarizationEvent: {
            cutoffIndex: 8,
            summaryMessage: new HumanMessage("PARENT_SUMMARY_SENTINEL"),
            filePath: null
          }
        },
        runtime: { configurable: { [ownerConfigKey]: owner } },
        tools: []
      },
      handler
    )

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("continues a task-subagent's own matching summarization state", async () => {
    const ownerConfigKey = "cmb_test_subagent_owner"
    const owner = "task-123"
    const handler = vi.fn(async (request: SummaryRequest) => {
      expect(renderedRequest(request.messages)).toContain("CHILD_SUMMARY_SENTINEL")
      expect(renderedRequest(request.messages)).toContain("CHILD_RECENT_MESSAGE_SENTINEL")
      expect(renderedRequest(request.messages)).not.toContain("CHILD_OLD_MESSAGE_SENTINEL")
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(async () => new AIMessage(validSummary("unused")), {
      trigger: { type: "messages", value: 10 },
      stateOwnerConfigKey: ownerConfigKey
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("CHILD_OLD_MESSAGE_SENTINEL"),
          new HumanMessage("CHILD_RECENT_MESSAGE_SENTINEL")
        ],
        state: {
          _summarizationSessionId: "child-session",
          [SUMMARIZATION_STATE_OWNER_KEY]: owner,
          _summarizationEvent: {
            cutoffIndex: 1,
            summaryMessage: new HumanMessage("CHILD_SUMMARY_SENTINEL"),
            filePath: null
          }
        },
        runtime: { configurable: { [ownerConfigKey]: owner } },
        tools: []
      },
      handler
    )

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("creates one fresh, consistent session for a task-subagent's first compaction", async () => {
    const ownerConfigKey = "cmb_test_subagent_owner"
    const owner = "task-123"
    const historyPathPrefix =
      "/Users/test/.cmbcoworkagent/projects/project/thread/conversation_history"
    const write = vi.fn(async (path: string) => ({ path }))
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("child-owned compaction")),
      {
        historyPathPrefix,
        stateOwnerConfigKey: ownerConfigKey,
        backend: { write, downloadFiles: async () => [] }
      }
    )

    const result = await middleware.wrapModelCall(
      {
        messages: realFailureShapeMessages(),
        state: {
          _summarizationSessionId: "parent-session",
          _summarizationEvent: {
            cutoffIndex: 4,
            summaryMessage: new HumanMessage("PARENT_SUMMARY_SENTINEL"),
            filePath: null
          }
        },
        runtime: { configurable: { [ownerConfigKey]: owner } },
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(result).toBeInstanceOf(Command)
    const update = (result as Command).update as Record<string, unknown>
    const childSessionId = update._summarizationSessionId
    expect(childSessionId).toMatch(/^session_[a-f0-9]{8}$/)
    expect(childSessionId).not.toBe("parent-session")
    expect(update[SUMMARIZATION_STATE_OWNER_KEY]).toBe(owner)
    expect(write).toHaveBeenCalledWith(
      `${historyPathPrefix}/${childSessionId}.md`,
      expect.any(String)
    )
  })

  it("offloads history beneath the configured absolute user directory", async () => {
    const write = vi.fn(async (path: string) => ({ path }))
    const historyPathPrefix =
      "/Users/test/.cmbcoworkagent/projects/-Users-test-project/thread-123/conversation_history"
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("user-level history path")),
      {
        keepTokens: 100,
        historyPathPrefix,
        backend: {
          write,
          downloadFiles: async () => []
        }
      }
    )

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^${historyPathPrefix}/session_[a-f0-9]{8}\\.md$`)
    )
  })

  it("uses the app-internal artifact channel when the backend provides one", async () => {
    const write = vi.fn(async (path: string) => ({ path }))
    const appendInternalArtifact = vi.fn(async (path: string, content: string) => {
      if (!path || !content) throw new Error("internal artifact write requires a path and content")
      return {}
    })
    const writeInternalArtifact = vi.fn(async (path: string, content: string) => {
      if (!path || !content) throw new Error("internal artifact write requires a path and content")
      return {}
    })
    const internalArtifactExists = vi.fn(async () => true)
    const downloadFiles = vi.fn(async () => {
      throw new Error("managed history must not be downloaded before an internal append")
    })
    const historyPathPrefix =
      "/Users/test/.cmbcoworkagent/projects/-Users-test-project/thread-123/conversation_history"
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("internal history channel")),
      {
        keepTokens: 100,
        historyPathPrefix,
        backend: {
          write,
          appendInternalArtifact,
          writeInternalArtifact,
          internalArtifactExists,
          downloadFiles
        }
      }
    )

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(appendInternalArtifact).toHaveBeenCalledTimes(1)
    expect(internalArtifactExists).toHaveBeenCalledTimes(1)
    expect(downloadFiles).not.toHaveBeenCalled()
    expect(appendInternalArtifact.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^${historyPathPrefix}/session_[a-f0-9]{8}\\.md$`)
    )
    expect(writeInternalArtifact).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it("imports the matching legacy history once before appending the first managed section", async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const historyPathPrefix =
      "/Users/test/.cmbcoworkagent/projects/-Users-test-project/thread-123/conversation_history"
    const legacyHistoryPathPrefix = "/workspace/.cmbdevclaw/conversation_history"
    const sessionId = "session_fixed"
    const managedPath = `${historyPathPrefix}/${sessionId}.md`
    const legacyPath = `${legacyHistoryPathPrefix}/${sessionId}.md`
    const downloadFiles = vi.fn(async ([requestedPath]: string[]) => {
      if (requestedPath === legacyPath) {
        return [{ path: legacyPath, content: encoder.encode("LEGACY_HISTORY\n\n") }]
      }
      return []
    })
    const uploadFiles = vi.fn(async ([[uploadedPath]]: Array<[string, Uint8Array]>) => [
      { path: uploadedPath }
    ])
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("legacy history import")),
      {
        keepTokens: 100,
        historyPathPrefix,
        legacyHistoryPathPrefix,
        backend: {
          write: async (path) => ({ path }),
          downloadFiles,
          uploadFiles
        }
      }
    )

    await middleware.wrapModelCall(
      {
        messages: realFailureShapeMessages(),
        state: { _summarizationSessionId: sessionId },
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(downloadFiles.mock.calls.map(([paths]) => paths[0])).toEqual([managedPath, legacyPath])
    expect(uploadFiles).toHaveBeenCalledTimes(1)
    const [[uploadedPath, uploadedBytes]] = uploadFiles.mock.calls[0]![0]
    expect(uploadedPath).toBe(managedPath)
    const uploadedContent = decoder.decode(uploadedBytes)
    expect(uploadedContent.startsWith("LEGACY_HISTORY\n\n")).toBe(true)
    expect(uploadedContent).toContain("ORIGINAL_TASK_SENTINEL")
  })

  it("does not probe legacy history after the managed file exists", async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const historyPathPrefix =
      "/Users/test/.cmbcoworkagent/projects/-Users-test-project/thread-123/conversation_history"
    const legacyHistoryPathPrefix = "/workspace/.cmbdevclaw/conversation_history"
    const sessionId = "session_fixed"
    const managedPath = `${historyPathPrefix}/${sessionId}.md`
    const downloadFiles = vi.fn(async ([requestedPath]: string[]) => {
      if (requestedPath === managedPath) {
        return [{ path: managedPath, content: encoder.encode("MANAGED_HISTORY\n\n") }]
      }
      throw new Error("legacy history should not be read")
    })
    const uploadFiles = vi.fn(async ([[uploadedPath]]: Array<[string, Uint8Array]>) => [
      { path: uploadedPath }
    ])
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("managed history append")),
      {
        keepTokens: 100,
        historyPathPrefix,
        legacyHistoryPathPrefix,
        backend: {
          write: async (path) => ({ path }),
          downloadFiles,
          uploadFiles
        }
      }
    )

    await middleware.wrapModelCall(
      {
        messages: realFailureShapeMessages(),
        state: { _summarizationSessionId: sessionId },
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(downloadFiles).toHaveBeenCalledTimes(1)
    expect(downloadFiles).toHaveBeenCalledWith([managedPath])
    const [[, uploadedBytes]] = uploadFiles.mock.calls[0]![0]
    expect(decoder.decode(uploadedBytes).startsWith("MANAGED_HISTORY\n\n")).toBe(true)
  })

  it("summarizes the complete old history instead of tail-trimming away the user task", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(async (messages) => {
      requests.push(messages)
      return new AIMessage(validSummary("complete old history"))
    })

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    expect(SystemMessage.isInstance(requests[0]?.[0])).toBe(true)
    expect(HumanMessage.isInstance(requests[0]?.[1])).toBe(true)
    expect(requests[0]).toHaveLength(2)
    const requestText = renderedRequest(requests[0]!)
    expect(requestText).toContain('<message type="human">')
    expect(requestText).toContain('<message type="ai">')
    expect(requestText).toContain('<tool_call id="read-1" name="read_file">')
    expect(requestText).toContain('<message type="tool" tool_call_id="read-1">')
    expect(requestText).toContain("ORIGINAL_TASK_SENTINEL")
    expect(requestText).toContain("TOOL_ONE_START")
    expect(requestText).toContain("TOOL_FOUR_END")
    expect(requestText).toContain("Use these exact headings")
    expect(requestText).toContain("Do not let a later conclusion hide conflicting evidence")
    expect(requestText).toContain("<initial-user-request>")
    expect(requestText).toContain("ORIGINAL_TASK_SENTINEL")
    expect(requestText).not.toContain("<latest-user-request>")
    expect(requestText.length).toBeGreaterThan(20_800 * 4)
  })

  it("serializes tool history as escaped XML text without exposing a provider tool protocol", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("escaped XML transcript"))
      },
      { keepTokens: 1 }
    )
    const assistant = new AIMessage({
      content: "checking <config> & output",
      tool_calls: [
        {
          id: 'call<&"1',
          name: "read_file",
          args: { file_path: 'src/<main>&".ts' },
          type: "tool_call"
        }
      ]
    })

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("Inspect A < B & C"),
          assistant,
          new ToolMessage({
            content: "RESULT <unsafe> & complete",
            tool_call_id: 'call<&"1',
            name: "read_file"
          }),
          new HumanMessage("continue")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    const request = requests[0]!
    expect(request.map((message) => message.getType())).toEqual(["system", "human"])
    const transcript = renderedSummaryTranscript(request)
    expect(transcript).toContain("Inspect A &lt; B &amp; C")
    expect(transcript).toContain("checking &lt;config&gt; &amp; output")
    expect(transcript).toContain('id="call&lt;&amp;&quot;1"')
    expect(transcript).toContain('src/&lt;main&gt;&amp;\\".ts')
    expect(transcript).toContain("RESULT &lt;unsafe&gt; &amp; complete")
    expect(request[1]?.additional_kwargs.cmb_summary_request_format).toBe("xml_text")
  })

  it("ignores a malformed saved summarization event and rebuilds from raw messages", async () => {
    const handler = vi.fn(async (request: SummaryRequest) => {
      expect(renderedRequest(request.messages)).toContain("RAW_MESSAGE_SENTINEL")
      expect(renderedRequest(request.messages)).not.toContain("INVALID_SUMMARY_SENTINEL")
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(async () => new AIMessage(validSummary("unused")), {
      trigger: { type: "messages", value: 10 }
    })

    await middleware.wrapModelCall(
      {
        messages: [new HumanMessage("RAW_MESSAGE_SENTINEL")],
        state: {
          _summarizationEvent: {
            cutoffIndex: -1,
            summaryMessage: new HumanMessage("INVALID_SUMMARY_SENTINEL"),
            filePath: null
          }
        },
        tools: []
      },
      handler
    )

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("normalizes malformed tool-call history only for the summary-model request", async () => {
    const requests: BaseMessage[][] = []
    const poisonedAssistant = new AIMessage({
      content: "I will inspect the file.",
      additional_kwargs: {
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "read_file", arguments: '{"file_path": "src/main.ts' }
          }
        ]
      }
    })
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("malformed history recovery"))
      },
      {
        keepTokens: 1
      }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLDER_CONTEXT ${"x".repeat(4_000)}`),
          poisonedAssistant,
          new ToolMessage({
            content: "partial result",
            tool_call_id: "call_bad",
            name: "read_file"
          }),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    const summaryRequest = renderedRequest(requests[0]!)
    expect(summaryRequest).not.toContain("call_bad")
    expect(summaryRequest).not.toContain("partial result")
    expect(requests[0]!.map((message) => message.getType())).toEqual(["system", "human"])
    // Request cleanup must never rewrite the checkpoint/history source.
    expect(poisonedAssistant.additional_kwargs.tool_calls).toHaveLength(1)
  })

  it("preserves valid mixed tool calls while excluding malformed raw siblings from summary", async () => {
    const requests: BaseMessage[][] = []
    const mixedAssistant = new AIMessage({
      content: "I will inspect both files.",
      tool_calls: [
        { id: "call_good", name: "read_file", args: { file_path: "good.ts" }, type: "tool_call" }
      ],
      additional_kwargs: {
        tool_calls: [
          {
            id: "call_good",
            type: "function",
            function: { name: "read_file", arguments: '{"file_path":"good.ts"}' }
          },
          {
            id: "call_bad",
            type: "function",
            function: { name: "read_file", arguments: '{"file_path":' }
          }
        ]
      }
    })
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("mixed malformed history recovery"))
      },
      {
        keepTokens: 1
      }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLDER_CONTEXT ${"x".repeat(4_000)}`),
          mixedAssistant,
          new ToolMessage({
            content: "good result",
            tool_call_id: "call_good",
            name: "read_file"
          }),
          new ToolMessage({
            content: "bad result",
            tool_call_id: "call_bad",
            name: "read_file"
          }),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    const summaryRequest = renderedRequest(requests[0]!)
    expect(summaryRequest).toContain('<tool_call id="call_good" name="read_file">')
    expect(summaryRequest).toContain("good.ts")
    expect(summaryRequest).toContain("good result")
    expect(summaryRequest).not.toContain("call_bad")
    expect(summaryRequest).not.toContain("bad result")
    expect(mixedAssistant.additional_kwargs.tool_calls).toHaveLength(2)
  })

  it("pairs reused tool-call ids only within their original API round", async () => {
    const requests: BaseMessage[][] = []
    const firstCall = new AIMessage({
      content: "FIRST_CALL_INTERRUPTED",
      tool_calls: [
        {
          id: "call_0",
          name: "read_file",
          args: { file_path: "first.ts" },
          type: "tool_call"
        }
      ]
    })
    const secondCall = new AIMessage({
      content: "SECOND_CALL_COMPLETED",
      tool_calls: [
        {
          id: "call_0",
          name: "read_file",
          args: { file_path: "second.ts" },
          type: "tool_call"
        }
      ]
    })
    const secondResult = new ToolMessage({
      content: "SECOND_RESULT_ONLY",
      tool_call_id: "call_0",
      name: "read_file"
    })
    const sourceMessages: BaseMessage[] = [
      new HumanMessage(`ORIGINAL_REQUEST ${"x".repeat(4_000)}`),
      firstCall,
      new HumanMessage(`INTERRUPTING_USER_REQUEST ${"y".repeat(2_000)}`),
      secondCall,
      secondResult,
      new HumanMessage("RECENT_MESSAGE_TO_KEEP")
    ]
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("round-local tool parity"))
      },
      { keepTokens: 1 }
    )

    await middleware.wrapModelCall(
      { messages: sourceMessages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]!.map((message) => message.getType())).toEqual(["system", "human"])
    const summaryRequest = renderedRequest(requests[0]!)
    expect(summaryRequest).toContain('<tool_call id="call_0" name="read_file">')
    expect(summaryRequest).toContain("first.ts")
    expect(summaryRequest).toContain("was cancelled")
    expect(summaryRequest).toContain("second.ts")
    expect(summaryRequest).toContain("SECOND_RESULT_ONLY")
    expect(summaryRequest).toContain("RECENT_MESSAGE_TO_KEEP")
    // The request-only repair must not rewrite checkpoint/history objects.
    expect(sourceMessages).toHaveLength(6)
    expect(sourceMessages.filter(ToolMessage.isInstance)).toEqual([secondResult])
  })

  it("replaces MCP media payloads only in the transient summary request", async () => {
    const requests: BaseMessage[][] = []
    let archivedContent = ""
    const write = vi.fn(async (path: string, content?: string) => {
      archivedContent = content ?? ""
      return { path }
    })
    const mediaResult = new ToolMessage({
      content: [
        { type: "text", text: "MCP_TEXT_SENTINEL" },
        {
          type: "image",
          source_type: "base64",
          data: "RAW_IMAGE_BASE64_SENTINEL",
          mime_type: "image/png"
        },
        {
          type: "audio",
          source_type: "base64",
          data: "RAW_AUDIO_BASE64_SENTINEL",
          mime_type: "audio/wav"
        },
        {
          type: "file",
          source_type: "url",
          url: "https://files.invalid/RAW_FILE_URL_SENTINEL"
        },
        {
          type: "file",
          source_type: "text",
          text: "TEXT_BACKED_FILE_SENTINEL"
        }
      ] as never,
      tool_call_id: "mcp-media",
      name: "mcp_media_tool"
    })
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("media-safe compaction"))
      },
      {
        keepTokens: 1,
        backend: {
          write,
          downloadFiles: async () => []
        }
      }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`ANALYZE_MCP_MEDIA ${"x".repeat(4_000)}`),
          new AIMessage({
            content: "MCP_MEDIA_CALL",
            tool_calls: [{ id: "mcp-media", name: "mcp_media_tool", args: {}, type: "tool_call" }]
          }),
          mediaResult,
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]!.map((message) => message.getType())).toEqual(["system", "human"])
    const requestContent = renderedRequest(requests[0]!)
    expect(requestContent).toContain('tool_call_id="mcp-media"')
    expect(requestContent).toContain("MCP_TEXT_SENTINEL")
    expect(requestContent).toContain("[image]")
    expect(requestContent).toContain("[audio]")
    expect(requestContent).toContain("[file]")
    expect(requestContent).toContain("TEXT_BACKED_FILE_SENTINEL")
    expect(requestContent).not.toContain("RAW_IMAGE_BASE64_SENTINEL")
    expect(requestContent).not.toContain("RAW_AUDIO_BASE64_SENTINEL")
    expect(requestContent).not.toContain("RAW_FILE_URL_SENTINEL")

    // Summary request sanitation must not mutate checkpoint/history messages.
    const originalContent = JSON.stringify(mediaResult.content)
    expect(originalContent).toContain("RAW_IMAGE_BASE64_SENTINEL")
    expect(originalContent).toContain("RAW_AUDIO_BASE64_SENTINEL")
    expect(originalContent).toContain("RAW_FILE_URL_SENTINEL")

    expect(write).toHaveBeenCalledTimes(1)
    expect(archivedContent).toContain("MCP_TEXT_SENTINEL")
    expect(archivedContent).toContain("[file]\nTEXT_BACKED_FILE_SENTINEL\n[/file]")
    expect(archivedContent).toContain("[image]")
    expect(archivedContent).toContain("[audio]")
    expect(archivedContent).not.toContain("RAW_IMAGE_BASE64_SENTINEL")
    expect(archivedContent).not.toContain("RAW_AUDIO_BASE64_SENTINEL")
    expect(archivedContent).not.toContain("RAW_FILE_URL_SENTINEL")
  })

  it("repairs partial parallel results and removes duplicate or orphan tool messages", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("parallel tool parity"))
      },
      { keepTokens: 1 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`ORIGINAL_REQUEST ${"x".repeat(4_000)}`),
          new AIMessage({
            content: "PARALLEL_CALLS",
            tool_calls: [
              { id: "call_a", name: "read_file", args: {}, type: "tool_call" },
              { id: "call_b", name: "read_file", args: {}, type: "tool_call" }
            ]
          }),
          new ToolMessage({ content: "RESULT_A", tool_call_id: "call_a" }),
          new ToolMessage({ content: "DUPLICATE_A", tool_call_id: "call_a" }),
          new ToolMessage({ content: "ORPHAN_Z", tool_call_id: "call_z" }),
          new HumanMessage("NEXT_USER_BOUNDARY"),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests[0]!.map((message) => message.getType())).toEqual(["system", "human"])
    const summaryRequest = renderedRequest(requests[0]!)
    expect(summaryRequest).toContain('tool_call_id="call_a"')
    expect(summaryRequest).toContain("RESULT_A")
    expect(summaryRequest).toContain('tool_call_id="call_b"')
    expect(summaryRequest).toContain("was cancelled")
    expect(summaryRequest).not.toContain("DUPLICATE_A")
    expect(summaryRequest).not.toContain("ORPHAN_Z")
  })

  it("aborts the in-flight summary request without retrying or archiving", async () => {
    const controller = new AbortController()
    const write = vi.fn(async (path: string) => ({ path }))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const invoke = vi.fn(
      async (_messages: BaseMessage[], options?: { signal?: AbortSignal }) =>
        new Promise<AIMessage>((_resolve, reject) => {
          const signal = options?.signal
          if (!signal) {
            reject(new Error("missing summary abort signal"))
            return
          }
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
    )
    const middleware = createTestMiddleware(invoke, {
      keepTokens: 1,
      backend: { write, downloadFiles: async () => [] }
    })

    const run = middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLD_CONTEXT ${"x".repeat(4_000)}`),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        runtime: { signal: controller.signal },
        tools: []
      },
      handler
    )

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    controller.abort()

    await expect(run).rejects.toMatchObject({ name: "AbortError" })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("does not call the outer model when cancellation arrives during history archival", async () => {
    const controller = new AbortController()
    let releaseArchive!: () => void
    const archiveRelease = new Promise<void>((resolve) => {
      releaseArchive = resolve
    })
    let markArchiveStarted!: () => void
    const archiveStarted = new Promise<void>((resolve) => {
      markArchiveStarted = resolve
    })
    const write = vi.fn(async (path: string) => {
      markArchiveStarted()
      await archiveRelease
      return { path }
    })
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("archive cancellation")),
      {
        keepTokens: 1,
        backend: { write, downloadFiles: async () => [] }
      }
    )

    const run = middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLD_CONTEXT ${"x".repeat(4_000)}`),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: [],
        runtime: { signal: controller.signal }
      },
      handler
    )

    await archiveStarted
    controller.abort()
    releaseArchive()

    await expect(run).rejects.toMatchObject({ name: "AbortError" })
    expect(write).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
  })

  it("uses the active fallback model context window for overflow recovery", async () => {
    const profileReads: string[] = []
    const primaryModel = {
      get profile() {
        profileReads.push("primary")
        return { maxInputTokens: 32_000 }
      },
      invoke: async () => new AIMessage("")
    }
    const fallbackModel = {
      get profile() {
        profileReads.push("fallback")
        return { maxInputTokens: 1_000 }
      },
      invoke: async () => {
        throw new ContextOverflowError("fallback context window exceeded")
      }
    }
    const middleware = createCmbSummarizationMiddleware({
      model: primaryModel as never,
      fallbackModel: fallbackModel as never,
      backend: createBackend() as never,
      trigger: { type: "messages", value: 1 },
      keep: { type: "messages", value: 1 },
      trimTokensToSummarize: 100_000
    }) as unknown as TestSummarizationMiddleware

    await expect(
      middleware.wrapModelCall(
        {
          messages: [
            new HumanMessage(`OLD_CONTEXT ${"x".repeat(8_000)}`),
            new HumanMessage("RECENT_MESSAGE_TO_KEEP")
          ],
          state: {},
          tools: []
        },
        async () => new AIMessage("handled")
      )
    ).rejects.toThrow()

    expect(profileReads).toContain("fallback")
  })

  it("retries a true summary context overflow by removing complete oldest API rounds", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length === 1) throw new ContextOverflowError("summary prompt too long")
      return new AIMessage(validSummary("safe round truncation"))
    })
    const middleware = createTestMiddleware(invoke, {
      keepTokens: 100,
      trimTokensToSummarize: 100_000
    })
    const messages: SummaryRequest["messages"] = [
      new HumanMessage("EARLIEST_USER_PREAMBLE"),
      new AIMessage({
        content: "ROUND_ONE_AI",
        tool_calls: [{ name: "read_file", args: {}, id: "round-1", type: "tool_call" }]
      }),
      new ToolMessage({
        content: `ROUND_ONE_TOOL\n${"x".repeat(2_000)}`,
        tool_call_id: "round-1"
      }),
      new AIMessage({
        content: "ROUND_TWO_AI",
        tool_calls: [{ name: "read_file", args: {}, id: "round-2", type: "tool_call" }]
      }),
      new ToolMessage({
        content: `ROUND_TWO_TOOL\n${"x".repeat(2_000)}`,
        tool_call_id: "round-2"
      }),
      new HumanMessage("RECENT_MESSAGE_TO_KEEP")
    ]

    await middleware.wrapModelCall(
      { messages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(renderedRequest(requests[0]!)).toContain("EARLIEST_USER_PREAMBLE")
    expect(renderedRequest(requests[1]!)).toContain(
      "[earlier conversation truncated for compaction retry]"
    )
    expect(renderedRequest(requests[1]!)).toContain(
      "<initial-user-request>\nEARLIEST_USER_PREAMBLE\n</initial-user-request>"
    )
    expect(renderedRequest(requests[1]!)).toContain("ROUND_ONE_AI")
    expect(renderedRequest(requests[1]!)).toContain("ROUND_ONE_TOOL")
    expect(renderedRequest(requests[1]!)).toContain("ROUND_TWO_AI")
    expect(renderedRequest(requests[1]!)).toContain("ROUND_TWO_TOOL")
  })

  it("shrinks consecutive HumanMessages after a real summary overflow", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length === 1) throw new ContextOverflowError("summary prompt too long")
      return new AIMessage(validSummary("consecutive user-message recovery"))
    })
    const middleware = createTestMiddleware(invoke, {
      keepTokens: 1,
      trimTokensToSummarize: 8_000
    })
    const messages = Array.from(
      { length: 80 },
      (_, index) =>
        new HumanMessage(`CONSECUTIVE_HUMAN_${String(index).padStart(2, "0")} ${"x".repeat(800)}`)
    )

    await middleware.wrapModelCall(
      { messages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    const firstRequest = renderedSummaryTranscript(requests[0]!)
    const retryRequest = renderedSummaryTranscript(requests[1]!)
    const firstMessageCount = firstRequest.match(/<message type="human">/g)?.length ?? 0
    const retryMessageCount = retryRequest.match(/<message type="human">/g)?.length ?? 0
    expect(firstMessageCount).toBe(80)
    expect(retryMessageCount).toBeLessThan(firstMessageCount)
    expect(retryRequest).toContain("[earlier conversation truncated for compaction retry]")
    expect(retryRequest).not.toContain("CONSECUTIVE_HUMAN_00")
    expect(retryRequest).toContain("CONSECUTIVE_HUMAN_79")
  })

  it("shrinks sanitized HumanMessages when malformed history contains an orphan tool result", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length === 1) throw new ContextOverflowError("summary prompt too long")
      return new AIMessage(validSummary("sanitized user-message recovery"))
    })
    const middleware = createTestMiddleware(invoke, {
      keepTokens: 1,
      trimTokensToSummarize: 8_000
    })
    const orphanResult = new ToolMessage({
      content: "ORPHAN_TOOL_RESULT",
      tool_call_id: "missing-call"
    })
    const messages: BaseMessage[] = Array.from(
      { length: 80 },
      (_, index) =>
        new HumanMessage(`SANITIZED_HUMAN_${String(index).padStart(2, "0")} ${"x".repeat(800)}`)
    )
    messages.splice(40, 0, orphanResult)

    await middleware.wrapModelCall(
      { messages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    const firstRequest = renderedSummaryTranscript(requests[0]!)
    const retryRequest = renderedSummaryTranscript(requests[1]!)
    const firstMessageCount = firstRequest.match(/<message type="human">/g)?.length ?? 0
    const retryMessageCount = retryRequest.match(/<message type="human">/g)?.length ?? 0
    expect(firstRequest).not.toContain("ORPHAN_TOOL_RESULT")
    expect(retryRequest).not.toContain("ORPHAN_TOOL_RESULT")
    expect(retryMessageCount).toBeLessThan(firstMessageCount)
    expect(retryRequest).not.toContain("SANITIZED_HUMAN_00")
    expect(retryRequest).toContain("SANITIZED_HUMAN_79")
    // Request-only recovery must leave checkpoint/history objects untouched.
    expect(messages).toContain(orphanResult)
  })

  it("compacts tool results when one oversized API round is the only retry input", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length < 3) throw new ContextOverflowError("summary prompt too long")
      return new AIMessage(validSummary("oversized round compaction"))
    })
    const middleware = createTestMiddleware(invoke, {
      keepTokens: 100,
      trimTokensToSummarize: 100_000
    })
    const oversizedToolResult = `OVERSIZED_TOOL_START\n${"x".repeat(180_000)}\nOVERSIZED_TOOL_END`
    const messages: SummaryRequest["messages"] = [
      new HumanMessage("OLD_PREAMBLE_DROPPED_ON_FIRST_RETRY"),
      new AIMessage({
        content: "OVERSIZED_ROUND_AI",
        tool_calls: [{ name: "read_file", args: {}, id: "oversized", type: "tool_call" }]
      }),
      new ToolMessage({ content: oversizedToolResult, tool_call_id: "oversized" }),
      new HumanMessage("RECENT_MESSAGE_TO_KEEP")
    ]

    await middleware.wrapModelCall(
      { messages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(renderedRequest(requests[0]!)).toContain("OLD_PREAMBLE_DROPPED_ON_FIRST_RETRY")
    expect(renderedRequest(requests[0]!)).toContain("OVERSIZED_TOOL_END")
    expect(renderedRequest(requests[1]!)).toContain(
      "<initial-user-request>\nOLD_PREAMBLE_DROPPED_ON_FIRST_RETRY\n</initial-user-request>"
    )
    expect(renderedRequest(requests[1]!)).toContain("OVERSIZED_TOOL_END")
    expect(renderedRequest(requests[2]!)).toContain("OVERSIZED_TOOL_START")
    expect(renderedRequest(requests[2]!)).toContain("...(result truncated)")
    expect(renderedRequest(requests[2]!)).not.toContain("OVERSIZED_TOOL_END")
  })

  it("accepts a concise nonempty handoff without wasting retries", async () => {
    const invoke = vi.fn(async () => new AIMessage("Continue from the verified implementation."))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke)

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("accepts a substantive handoff without requiring exact headings", async () => {
    const invoke = vi.fn(
      async () =>
        new AIMessage(`Primary request and intent:
Preserve the user's requested engineering outcome and continue from the verified implementation without redoing completed work or changing unrelated behavior.

Work completed and current status:
The relevant source paths, decisions, compatibility constraints, commands, and verification evidence have been retained. The implementation is ready for the next concrete action, with no currently known blocker. Existing behavior must remain compatible, structured message roles must be preserved, and unresolved contradictions must remain visible instead of being hidden by a later conclusion.

Continuation guidance:
Continue with the latest explicit user request. Reuse the recorded file paths, sentinel values, test results, and operational evidence when they matter. Do not repeat already completed investigation, and verify any new change proportionally before reporting the result.`)
    )
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke)

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("retries DSML without echoing it while keeping the XML-text protocol", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length === 1) {
        return new AIMessage(`\`\`\`xml
<｜DSML｜tool_calls>
<｜DSML｜invoke name="BAD_DSML_ATTEMPT_1">
</｜DSML｜invoke>
</｜DSML｜tool_calls>
\`\`\``)
      }
      if (requests.length === 2) {
        return new AIMessage(`I will inspect one more file before summarizing.

<|DSML|tool_calls>
<|DSML|invoke name="BAD_DSML_ATTEMPT_2">
</|DSML|invoke>
</|DSML|tool_calls>`)
      }
      return new AIMessage(validSummary("plain-text DSML recovery"))
    })
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke)

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(requests[0]!.map((message) => message.getType())).toEqual(["system", "human"])
    expect(requests[1]!.map((message) => message.getType())).toEqual(["system", "human"])
    expect(renderedRequest(requests[1]!)).not.toContain("BAD_DSML_ATTEMPT_1")
    expect(requests[2]!.map((message) => message.getType())).toEqual(["system", "human"])
    expect(renderedRequest(requests[2]!)).toContain("ORIGINAL_TASK_SENTINEL")
    expect(renderedRequest(requests[2]!)).toContain("XML conversation transcript above")
    expect(renderedRequest(requests[2]!)).not.toContain("BAD_DSML_ATTEMPT_2")
    expect(requests[2]![1]?.additional_kwargs.cmb_summary_request_format).toBe("xml_text")
  })

  it("treats structured summary tool calls as invalid output", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length < 3) {
        return new AIMessage({
          content: "I will inspect another file before returning the handoff.",
          tool_calls: [
            {
              id: `bad-summary-${requests.length}`,
              name: `BAD_STRUCTURED_SUMMARY_TOOL_${requests.length}`,
              args: {},
              type: "tool_call"
            }
          ]
        })
      }
      return new AIMessage(validSummary("structured tool-call recovery"))
    })
    const middleware = createTestMiddleware(invoke)

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(renderedRequest(requests[1]!)).not.toContain("BAD_STRUCTURED_SUMMARY_TOOL_1")
    expect(requests[2]!.map((message) => message.getType())).toEqual(["system", "human"])
    expect(renderedRequest(requests[2]!)).not.toContain("BAD_STRUCTURED_SUMMARY_TOOL_2")
  })

  it("accepts DSML quoted as evidence inside a fenced block", async () => {
    const summary = `${validSummary("fenced DSML evidence")}

\`\`\`xml
<｜DSML｜tool_calls>
<｜DSML｜invoke name="read_file">
</｜DSML｜invoke>
</｜DSML｜tool_calls>
\`\`\``
    const invoke = vi.fn(async () => new AIMessage(summary))
    const middleware = createTestMiddleware(invoke)

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("retries a truncated DSML tool-call opening marker", async () => {
    const invoke = vi
      .fn<() => Promise<AIMessage>>()
      .mockResolvedValueOnce(new AIMessage("<｜DSML｜tool_calls>"))
      .mockResolvedValueOnce(new AIMessage(validSummary("truncated DSML recovery")))
    const middleware = createTestMiddleware(invoke)

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it("does not archive or commit after three DSML responses", async () => {
    const write = vi.fn(async (path: string) => ({ path }))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const invoke = vi.fn(
      async () =>
        new AIMessage(`<｜DSML｜tool_calls>
<｜DSML｜invoke name="read_file">
</｜DSML｜invoke>
</｜DSML｜tool_calls>`)
    )
    const middleware = createTestMiddleware(invoke, {
      backend: { write, downloadFiles: async () => [] }
    })

    await expect(
      middleware.wrapModelCall(
        { messages: realFailureShapeMessages(), state: {}, tools: [] },
        handler
      )
    ).rejects.toThrow("Summary model returned an invalid handoff")

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(handler).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it("switches to the no-thinking fallback after an empty final response", async () => {
    const primaryInvoke = vi.fn(
      async () => new AIMessage("<think>private summary reasoning without final content</think>")
    )
    const fallbackRequests: BaseMessage[][] = []
    const fallbackInvoke = vi.fn(async (messages: BaseMessage[]) => {
      fallbackRequests.push(messages)
      return new AIMessage(validSummary("no-thinking fallback"))
    })
    const middleware = createTestMiddleware(primaryInvoke, { fallbackInvoke })

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    expect(primaryInvoke).toHaveBeenCalledTimes(1)
    expect(fallbackInvoke).toHaveBeenCalledTimes(1)
    expect(renderedRequest(fallbackRequests[0]!)).toContain(
      "Return the complete handoff in the final content field, not as reasoning-only output"
    )
  })

  it("rejects three empty summaries before they can replace valid conversation state", async () => {
    const handler = vi.fn(async () => new AIMessage("handled"))
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      return new AIMessage("   ")
    })
    const write = vi.fn(async (path: string) => ({ path }))
    const middleware = createTestMiddleware(invoke, {
      backend: { write, downloadFiles: async () => [] }
    })

    await expect(
      middleware.wrapModelCall(
        { messages: realFailureShapeMessages(), state: {}, tools: [] },
        handler
      )
    ).rejects.toThrow("Summary model returned an invalid handoff")

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(requests[2]!.map((message) => message.getType())).toEqual(["system", "human"])
    expect(handler).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it("skips a predictably overflowing handler call and summarizes the whole conversation", async () => {
    const summaryRequests: BaseMessage[][] = []
    const handlerRequests: SummaryRequest[] = []
    const invoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockImplementationOnce(async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(`OVERSIZED_FIRST_SUMMARY\n${"x".repeat(20_000)}`)
      })
      .mockImplementationOnce(async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary("budgeted whole-conversation retry"))
      })
    const handler = vi.fn(async (request: SummaryRequest) => {
      handlerRequests.push(request)
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(invoke, {
      postCompactionInputBudgetTokens: 1_000
    })

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(summaryRequests).toHaveLength(2)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(renderedRequest(handlerRequests[0]!.messages)).toContain(
      "budgeted whole-conversation retry"
    )
    expect(renderedRequest(handlerRequests[0]!.messages)).not.toContain("OVERSIZED_FIRST_SUMMARY")
  })

  it("rechecks a whole-conversation summary and requests one bounded shorter handoff", async () => {
    const summaryRequests: BaseMessage[][] = []
    const handlerRequests: SummaryRequest[] = []
    const invoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockImplementationOnce(async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(`OVERSIZED_FIRST_SUMMARY\n${"x".repeat(20_000)}`)
      })
      .mockImplementationOnce(async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(`OVERSIZED_WHOLE_CONVERSATION_SUMMARY\n${"y".repeat(20_000)}`)
      })
      .mockImplementationOnce(async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary("bounded final handoff"))
      })
    const handler = vi.fn(async (request: SummaryRequest) => {
      handlerRequests.push(request)
      return new AIMessage("handled")
    })
    const middleware = createTestMiddleware(invoke, {
      postCompactionInputBudgetTokens: 1_000
    })

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(summaryRequests).toHaveLength(3)
    expect(renderedRequest(summaryRequests[2]!)).toContain(
      "previous whole-conversation handoff is still too large"
    )
    expect(renderedRequest(summaryRequests[2]!)).toContain("OVERSIZED_WHOLE_CONVERSATION_SUMMARY")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(renderedRequest(handlerRequests[0]!.messages)).toContain("bounded final handoff")
    expect(renderedRequest(handlerRequests[0]!.messages)).not.toContain(
      "OVERSIZED_WHOLE_CONVERSATION_SUMMARY"
    )
  })

  it("does not invoke the outer model when the bounded shorter handoff still exceeds budget", async () => {
    const invoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockResolvedValueOnce(new AIMessage(`OVERSIZED_FIRST_SUMMARY\n${"x".repeat(20_000)}`))
      .mockResolvedValueOnce(
        new AIMessage(`OVERSIZED_WHOLE_CONVERSATION_SUMMARY\n${"y".repeat(20_000)}`)
      )
      .mockResolvedValueOnce(new AIMessage(`OVERSIZED_SHORTENED_SUMMARY\n${"z".repeat(20_000)}`))
    const handler = vi.fn(async () => new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      postCompactionInputBudgetTokens: 1_000
    })

    await expect(
      middleware.wrapModelCall(
        { messages: realFailureShapeMessages(), state: {}, tools: [] },
        handler
      )
    ).rejects.toThrow("Shortened whole-conversation summary still exceeds")

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(handler).not.toHaveBeenCalled()
  })

  it("does not append an already archived head during whole-conversation retry", async () => {
    const summaryRequests: BaseMessage[][] = []
    const write = vi.fn(async (path: string, content?: string) => {
      void content
      return { path }
    })
    const handler = vi
      .fn<(request: SummaryRequest) => Promise<AIMessage>>()
      .mockRejectedValueOnce(new ContextOverflowError("summary plus retained tail is too large"))
      .mockResolvedValueOnce(new AIMessage("handled"))
    const middleware = createTestMiddleware(
      async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary("whole-conversation retry"))
      },
      { backend: { write, downloadFiles: async () => [] } }
    )

    await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(handler).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(2)
    const firstArchive = write.mock.calls[0]?.[1] ?? ""
    const retryArchive = write.mock.calls[1]?.[1] ?? ""
    expect(firstArchive).toContain("ORIGINAL_TASK_SENTINEL")
    expect(retryArchive).toContain("RECENT_MESSAGE_TO_KEEP")
    expect(retryArchive).not.toContain("ORIGINAL_TASK_SENTINEL")
    expect(summaryRequests).toHaveLength(2)
    expect(renderedRequest(summaryRequests[1]!)).toContain("RECENT_MESSAGE_TO_KEEP")
    expect(String(summaryRequests[1]!.at(-1)?.content)).not.toContain("<latest-user-request>")
  })

  it("retains the first archive path when the whole-conversation tail append fails", async () => {
    const write = vi
      .fn<(path: string, content?: string) => Promise<{ path?: string; error?: string }>>()
      .mockImplementationOnce(async (path) => ({ path }))
      .mockResolvedValueOnce({ error: "simulated tail append failure" })
    const invoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockResolvedValueOnce(new AIMessage(validSummary("first archived head")))
      .mockResolvedValueOnce(new AIMessage(validSummary("whole-conversation retry")))
    const handler = vi
      .fn<(request: SummaryRequest) => Promise<AIMessage>>()
      .mockRejectedValueOnce(new ContextOverflowError("summary plus retained tail is too large"))
      .mockResolvedValueOnce(new AIMessage("handled"))
    const middleware = createTestMiddleware(invoke, {
      backend: { write, downloadFiles: async () => [] }
    })

    const result = await middleware.wrapModelCall(
      { messages: realFailureShapeMessages(), state: {}, tools: [] },
      handler
    )

    expect(write).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledTimes(2)
    const firstArchivePath = write.mock.calls[0]?.[0]
    expect(firstArchivePath).toBeTruthy()
    const update = (result as Command).update as Record<string, unknown>
    const event = update._summarizationEvent as {
      filePath: string | null
      summaryMessage: HumanMessage
    }
    expect(event.filePath).toBe(firstArchivePath)
    expect(String(event.summaryMessage.content)).toContain(firstArchivePath)
    expect(String(event.summaryMessage.content)).toContain("whole-conversation retry")
  })

  it("does not repeat an oversized latest-user anchor during whole-conversation retry", async () => {
    const summaryRequests: BaseMessage[][] = []
    const handlerRequests: SummaryRequest[] = []
    const oversizedLatestUserRequest = `LATEST_USER_HEAD\n${"x".repeat(50_000)}\nLATEST_USER_MIDDLE_SENTINEL\n${"y".repeat(50_000)}\nLATEST_USER_TAIL`
    const handler = vi
      .fn<(request: SummaryRequest) => Promise<AIMessage>>()
      .mockImplementationOnce(async (request) => {
        handlerRequests.push(request)
        throw new ContextOverflowError("summary plus retained AI/tool tail is too large")
      })
      .mockImplementationOnce(async (request) => {
        handlerRequests.push(request)
        return new AIMessage("handled")
      })
    const middleware = createTestMiddleware(
      async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary("oversized latest-user retry"))
      },
      { keepTokens: 100 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(oversizedLatestUserRequest),
          new AIMessage({
            content: "RECENT_ASSISTANT_TAIL",
            tool_calls: [
              {
                name: "read_file",
                args: { file_path: "/project/recent.ts" },
                id: "recent-read",
                type: "tool_call"
              }
            ]
          }),
          new ToolMessage({
            content: "RECENT_TOOL_TAIL",
            tool_call_id: "recent-read"
          })
        ],
        state: {},
        tools: []
      },
      handler
    )

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handlerRequests[0]!.messages.slice(1)).toHaveLength(2)
    expect(handlerRequests[0]!.messages.slice(1).every((message) => message.type !== "human")).toBe(
      true
    )
    expect(summaryRequests).toHaveLength(2)

    const firstInstruction = String(summaryRequests[0]!.at(-1)?.content)
    expect(firstInstruction).toContain("<latest-user-request>")
    const firstLatestAnchor = firstInstruction.match(
      /<latest-user-request>\n([\s\S]*?)\n<\/latest-user-request>/
    )?.[1]
    expect(firstLatestAnchor).toContain("LATEST_USER_HEAD")
    expect(firstLatestAnchor).toContain("LATEST_USER_TAIL")
    expect(firstLatestAnchor).not.toContain("LATEST_USER_MIDDLE_SENTINEL")
    expect(Array.from(firstLatestAnchor ?? "").length).toBeLessThan(3_100)

    const retryInstruction = String(summaryRequests[1]!.at(-1)?.content)
    expect(retryInstruction).not.toContain("<latest-user-request>")
  })

  it("caps mixed quality and overflow recovery at four total model calls", async () => {
    const handler = vi.fn(async () => new AIMessage("handled"))
    const primaryInvoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockRejectedValueOnce(new ContextOverflowError("summary prompt too long"))
      .mockResolvedValueOnce(new AIMessage("   "))
    const fallbackInvoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockResolvedValue(new AIMessage("   "))
    const middleware = createTestMiddleware(primaryInvoke, {
      fallbackInvoke,
      trimTokensToSummarize: 100_000
    })

    await expect(
      middleware.wrapModelCall(
        { messages: realFailureShapeMessages(), state: {}, tools: [] },
        handler
      )
    ).rejects.toThrow("Summary model returned an invalid handoff")

    expect(primaryInvoke).toHaveBeenCalledTimes(2)
    expect(fallbackInvoke).toHaveBeenCalledTimes(2)
    expect(primaryInvoke.mock.calls.length + fallbackInvoke.mock.calls.length).toBe(4)
    expect(handler).not.toHaveBeenCalled()
  })

  it("shares the four-call budget with whole-conversation emergency summarization", async () => {
    const invoke = vi
      .fn<(messages: BaseMessage[]) => Promise<AIMessage>>()
      .mockResolvedValueOnce(new AIMessage(validSummary("first summary")))
      .mockResolvedValueOnce(new AIMessage("   "))
    const fallbackInvoke = vi.fn(async () => new AIMessage("   "))
    const handler = vi.fn(async () => {
      throw new ContextOverflowError("summary plus preserved tail is still too large")
    })
    const middleware = createTestMiddleware(invoke, { fallbackInvoke })

    await expect(
      middleware.wrapModelCall(
        { messages: realFailureShapeMessages(), state: {}, tools: [] },
        handler
      )
    ).rejects.toThrow("Summary model returned an invalid handoff")

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(fallbackInvoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.length + fallbackInvoke.mock.calls.length).toBe(4)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("recovers a summary overflow from a single oversized HumanMessage", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length === 1) throw new ContextOverflowError("summary prompt too long")
      return new AIMessage(validSummary("oversized user content compaction"))
    })
    const middleware = createTestMiddleware(invoke, { keepTokens: 100 })
    const hugeUserMessage = `HUGE_USER_START\n${"x".repeat(180_000)}\nHUGE_USER_END`

    await middleware.wrapModelCall(
      {
        messages: [new HumanMessage(hugeUserMessage), new HumanMessage("RECENT_MESSAGE_TO_KEEP")],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    const retryText = renderedRequest(requests[1]!)
    expect(retryText).toContain("HUGE_USER_START")
    expect(retryText).toContain("HUGE_USER_END")
    expect(retryText).toContain("...[initial user request middle truncated]...")
    expect(retryText).toContain("[... truncated to fit the compaction window ...]")
  })

  it("recovers a summary overflow from structured HumanMessage text blocks", async () => {
    const requests: BaseMessage[][] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(messages)
      if (requests.length === 1) throw new ContextOverflowError("summary prompt too long")
      return new AIMessage(validSummary("structured user content compaction"))
    })
    const middleware = createTestMiddleware(invoke, { keepTokens: 100 })
    const hugeText = `STRUCTURED_USER_START\n${"x".repeat(180_000)}\nSTRUCTURED_USER_END`
    const structuredMessage = new HumanMessage({
      content: [{ type: "text", text: hugeText }]
    })

    await middleware.wrapModelCall(
      {
        messages: [structuredMessage, new HumanMessage("RECENT_MESSAGE_TO_KEEP")],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(typeof requests[0]?.[1]?.content).toBe("string")
    expect(typeof requests[1]?.[1]?.content).toBe("string")
    expect(String(requests[1]?.[1]?.content)).toContain("STRUCTURED_USER_START")
    expect(String(requests[1]?.[1]?.content)).toContain(
      "[... truncated to fit the compaction window ...]"
    )
    expect(structuredMessage.content).toEqual([{ type: "text", text: hugeText }])
  })

  it("archives original tool arguments even when summary input truncates them", async () => {
    const write = vi.fn(async (path: string, content?: string) => {
      void content
      return { path }
    })
    const rawFileBody = `RAW_WRITE_BODY_START\n${"x".repeat(10_000)}\nRAW_WRITE_BODY_END`
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("raw tool argument archive")),
      {
        keepTokens: 100,
        backend: { write, downloadFiles: async () => [] },
        truncateArgsSettings: {
          trigger: { type: "messages", value: 1 },
          keep: { type: "messages", value: 1 },
          maxLength: 20
        }
      }
    )
    const messages: SummaryRequest["messages"] = [
      new HumanMessage("ORIGINAL_TASK_SENTINEL"),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "write_file",
            args: { file_path: "/project/output.txt", content: rawFileBody },
            id: "write-1",
            type: "tool_call"
          }
        ]
      }),
      new ToolMessage({
        content: `WRITE_RESULT_START\n${"y".repeat(10_000)}\nWRITE_RESULT_END`,
        tool_call_id: "write-1"
      }),
      new HumanMessage("RECENT_MESSAGE_TO_KEEP")
    ]

    await middleware.wrapModelCall(
      { messages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )

    const archived = write.mock.calls[0]?.[1] ?? ""
    expect(archived).toContain("RAW_WRITE_BODY_START")
    expect(archived).toContain("RAW_WRITE_BODY_END")
    expect(archived).not.toContain("...(argument truncated)")
  })

  it("marks a previous summary as authoritative structured context", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("previous summary update"))
      },
      { keepTokens: 100 }
    )
    const previousSummary = new HumanMessage({
      content: "PREVIOUS_SUMMARY_SENTINEL: original intent and completed work",
      additional_kwargs: { lc_source: "summarization" }
    })

    await middleware.wrapModelCall(
      {
        messages: [
          previousSummary,
          new AIMessage(`continued work\n${"x".repeat(2_000)}`),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.[1]?.content)).toContain("<previous-summary>")
    expect(String(requests[0]?.[1]?.content)).toContain("PREVIOUS_SUMMARY_SENTINEL")
    expect(String(requests[0]?.[1]?.content)).toContain("</previous-summary>")
  })

  it("anchors the latest real user request when it is inside the summarized head", async () => {
    const requests: BaseMessage[][] = []
    const latestUserRequest = `LATEST_USER_REQUEST_HEAD\n${"x".repeat(4_000)}\nLATEST_USER_REQUEST_MIDDLE_SENTINEL\n${"y".repeat(4_000)}\nLATEST_USER_REQUEST_TAIL`
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("latest user anchor"))
      },
      { keepTokens: 100 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(latestUserRequest),
          new AIMessage(`completed work\n${"x".repeat(3_000)}`),
          new AIMessage("RECENT_ASSISTANT_TAIL_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    const instruction = String(requests[0]?.at(-1)?.content)
    expect(instruction).toContain("<latest-user-request>")
    const latestAnchor = instruction.match(
      /<latest-user-request>\n([\s\S]*?)\n<\/latest-user-request>/
    )?.[1]
    expect(latestAnchor).toBeDefined()
    expect(latestAnchor).toContain("LATEST_USER_REQUEST_HEAD")
    expect(latestAnchor).toContain("LATEST_USER_REQUEST_TAIL")
    expect(latestAnchor).toContain("...[latest user request middle truncated]...")
    expect(latestAnchor).not.toContain("LATEST_USER_REQUEST_MIDDLE_SENTINEL")
    expect(Array.from(latestAnchor ?? "").length).toBeLessThan(3_100)
    expect(instruction).toContain("do not treat it as a new request")
  })

  it("deterministically carries the initial user request ahead of later corrections", async () => {
    const summaryRequests: BaseMessage[][] = []
    const handlerRequests: SummaryRequest[] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary("model output intentionally omits the initial sentinel"))
      },
      { keepTokens: 100 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("INITIAL_PROJECT_SENTINEL: implement the original migration"),
          new AIMessage(`older implementation work\n${"x".repeat(3_000)}`),
          new HumanMessage("LATER_CORRECTION_SENTINEL: keep compatibility mode enabled"),
          new AIMessage("RECENT_ASSISTANT_TAIL_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async (request) => {
        handlerRequests.push(request)
        return new AIMessage("handled")
      }
    )

    expect(summaryRequests).toHaveLength(1)
    const instruction = String(summaryRequests[0]?.at(-1)?.content)
    expect(instruction).toContain("<initial-user-request>")
    expect(instruction).toContain("INITIAL_PROJECT_SENTINEL")
    expect(instruction).toContain("later request takes precedence")

    expect(handlerRequests).toHaveLength(1)
    const delivered = renderedRequest(handlerRequests[0]!.messages)
    expect(delivered).toContain("<initial-user-request>")
    expect(delivered).toContain("INITIAL_PROJECT_SENTINEL")
    expect(delivered).toContain("LATER_CORRECTION_SENTINEL")
    expect(delivered.indexOf("INITIAL_PROJECT_SENTINEL")).toBeLessThan(
      delivered.indexOf("LATER_CORRECTION_SENTINEL")
    )
  })

  it("middle-truncates an oversized initial user request to a bounded anchor", async () => {
    const handlerRequests: SummaryRequest[] = []
    const initialRequest = `INITIAL_START\n${"A".repeat(1_700)}MIDDLE_SHOULD_BE_REMOVED${"B".repeat(1_700)}\nINITIAL_END`
    const middleware = createTestMiddleware(
      async () => new AIMessage(validSummary("bounded initial request")),
      { keepTokens: 100 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(initialRequest),
          new AIMessage(`older work\n${"x".repeat(3_000)}`),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async (request) => {
        handlerRequests.push(request)
        return new AIMessage("handled")
      }
    )

    const delivered = String(handlerRequests[0]?.messages[0]?.content)
    const anchor = delivered.match(
      /<initial-user-request>\n([\s\S]*?)\n<\/initial-user-request>/
    )?.[1]
    expect(anchor).toBeDefined()
    expect(anchor).toContain("INITIAL_START")
    expect(anchor).toContain("INITIAL_END")
    expect(anchor).toContain("[initial user request middle truncated]")
    expect(anchor).not.toContain("MIDDLE_SHOULD_BE_REMOVED")
    expect(
      Array.from(anchor!.replace("\n...[initial user request middle truncated]...\n", ""))
    ).toHaveLength(3_000)
  })

  it("reuses the same initial user anchor across subsequent compactions", async () => {
    const summaryRequests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary(`compaction ${summaryRequests.length}`))
      },
      { keepTokens: 100 }
    )
    const originalMessages = [
      new HumanMessage("PERSISTENT_INITIAL_SENTINEL: preserve this project identity"),
      new AIMessage(`first phase\n${"x".repeat(3_000)}`),
      new HumanMessage("FIRST_RECENT_MESSAGE")
    ]

    const firstResult = await middleware.wrapModelCall(
      { messages: originalMessages, state: {}, tools: [] },
      async () => new AIMessage("handled")
    )
    const firstUpdate = (firstResult as Command).update as Record<string, unknown>

    const secondResult = await middleware.wrapModelCall(
      {
        messages: [
          ...originalMessages,
          new AIMessage(`second phase\n${"y".repeat(3_000)}`),
          new HumanMessage("SECOND_RECENT_MESSAGE")
        ],
        state: firstUpdate,
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(summaryRequests).toHaveLength(2)
    const secondInstruction = String(summaryRequests[1]?.at(-1)?.content)
    expect(secondInstruction).toContain("<initial-user-request>")
    expect(secondInstruction).toContain("PERSISTENT_INITIAL_SENTINEL")
    expect(secondInstruction).not.toContain("FIRST_RECENT_MESSAGE\n</initial-user-request>")
    const repeatedInitialAnchor = renderedRequest(summaryRequests[1]!).match(
      /PERSISTENT_INITIAL_SENTINEL/g
    )
    expect(repeatedInitialAnchor).toHaveLength(1)

    const secondUpdate = (secondResult as Command).update as Record<string, unknown>
    const secondEvent = secondUpdate._summarizationEvent as {
      summaryMessage: HumanMessage
    }
    expect(String(secondEvent.summaryMessage.content)).toContain("PERSISTENT_INITIAL_SENTINEL")
    expect(secondEvent.summaryMessage.additional_kwargs.cmb_initial_user_request).toContain(
      "PERSISTENT_INITIAL_SENTINEL"
    )
  })

  it("recovers the original initial request when recompacting a legacy summary", async () => {
    const summaryRequests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        summaryRequests.push(messages)
        return new AIMessage(validSummary("legacy summary upgrade"))
      },
      { keepTokens: 100 }
    )
    const messages = [
      new HumanMessage("LEGACY_ORIGINAL_REQUEST_SENTINEL: implement the first task"),
      new AIMessage("LEGACY_ALREADY_SUMMARIZED_WORK"),
      new HumanMessage("POST_CUTOFF_CORRECTION_SENTINEL: retain compatibility"),
      new AIMessage(`new work that triggers another compaction\n${"x".repeat(3_000)}`),
      new HumanMessage("RECENT_USER_TAIL_TO_KEEP")
    ]

    await middleware.wrapModelCall(
      {
        messages,
        state: {
          _summarizationSessionId: "session_legacy",
          _summarizationEvent: {
            cutoffIndex: 2,
            summaryMessage: new HumanMessage({
              content: "Here is a summary of the conversation to date:\n\nLEGACY_SUMMARY_BODY",
              additional_kwargs: { lc_source: "summarization" }
            }),
            filePath: "/conversation_history/session_legacy.md"
          }
        },
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(summaryRequests).toHaveLength(1)
    const instruction = String(summaryRequests[0]?.at(-1)?.content)
    expect(instruction).toContain(
      "<initial-user-request>\nLEGACY_ORIGINAL_REQUEST_SENTINEL: implement the first task\n</initial-user-request>"
    )
    expect(instruction).not.toContain("<initial-user-request>\nPOST_CUTOFF_CORRECTION_SENTINEL")
  })

  it("does not let an internal coordinator notification replace the user-request anchor", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("coordinator notification"))
      },
      { keepTokens: 100 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("REAL_USER_REQUEST_SENTINEL: preserve the original task"),
          new AIMessage(`completed work\n${"x".repeat(3_000)}`),
          new HumanMessage({
            content: "INTERNAL_WORKER_NOTIFICATION_SENTINEL: worker evidence only",
            additional_kwargs: { cmb_internal_coordinator_notification: true }
          })
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    const instruction = String(requests[0]?.at(-1)?.content)
    expect(instruction).toContain("<initial-user-request>")
    expect(instruction).toContain("<latest-user-request>")
    expect(instruction).toContain("REAL_USER_REQUEST_SENTINEL")
    expect(instruction).not.toContain("INTERNAL_WORKER_NOTIFICATION_SENTINEL")
  })

  it("does not let a workflow notification replace the user-request anchor", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("workflow notification"))
      },
      { keepTokens: 100 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("REAL_WORKFLOW_USER_REQUEST_SENTINEL: finish the workflow task"),
          new AIMessage(`completed workflow work\n${"x".repeat(3_000)}`),
          new HumanMessage(WORKFLOW_NOTIFICATION_TURN_PROMPT)
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    const instruction = String(requests[0]?.at(-1)?.content)
    expect(instruction).toContain("<initial-user-request>")
    expect(instruction).toContain("<latest-user-request>")
    expect(instruction).toContain("REAL_WORKFLOW_USER_REQUEST_SENTINEL")
    expect(instruction).not.toContain(WORKFLOW_NOTIFICATION_TURN_PROMPT)
  })

  it("keeps neutralized user-supplied workflow marker text as a real request", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("literal workflow marker"))
      },
      { keepTokens: 1 }
    )
    const literalUserRequest = neutralizeWorkflowPlumbingUserText(WORKFLOW_NOTIFICATION_TURN_PROMPT)

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage("EARLIER_REAL_REQUEST_SENTINEL"),
          new AIMessage(`older work\n${"x".repeat(3_000)}`),
          new HumanMessage(literalUserRequest),
          new AIMessage("RECENT_ASSISTANT_TAIL_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    const instruction = String(requests[0]?.at(-1)?.content)
    const latestAnchor = instruction.match(
      /<latest-user-request>\n([\s\S]*?)\n<\/latest-user-request>/
    )?.[1]
    expect(latestAnchor).toContain("User supplied literal text")
    expect(latestAnchor).toContain(WORKFLOW_NOTIFICATION_TURN_PROMPT)
  })

  it("anchors visible user text while retaining the augmented model input as history", async () => {
    const requests: BaseMessage[][] = []
    const middleware = createTestMiddleware(
      async (messages) => {
        requests.push(messages)
        return new AIMessage(validSummary("visible user anchors"))
      },
      { keepTokens: 1 }
    )

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage({
            content: "AUGMENTED_INITIAL_PROMPT_SENTINEL: internal skill and hook scaffolding",
            additional_kwargs: {
              cmb_coordinator_augmented_user_message: true,
              cmb_visible_user_message: "VISIBLE_INITIAL_REQUEST_SENTINEL: implement the feature"
            }
          }),
          new AIMessage(`older work\n${"x".repeat(3_000)}`),
          new HumanMessage({
            content: "AUGMENTED_LATEST_PROMPT_SENTINEL: internal coordinator routing scaffolding",
            additional_kwargs: {
              cmb_coordinator_augmented_user_message: true,
              cmb_visible_user_message:
                "VISIBLE_LATEST_REQUEST_SENTINEL: keep backward compatibility"
            }
          }),
          new AIMessage("RECENT_ASSISTANT_TAIL_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requests).toHaveLength(1)
    const requestText = renderedRequest(requests[0]!)
    expect(requestText).toContain("AUGMENTED_INITIAL_PROMPT_SENTINEL")
    expect(requestText).toContain("AUGMENTED_LATEST_PROMPT_SENTINEL")

    const instruction = String(requests[0]!.at(-1)?.content)
    expect(instruction).toContain(
      "<initial-user-request>\nVISIBLE_INITIAL_REQUEST_SENTINEL: implement the feature\n</initial-user-request>"
    )
    expect(instruction).toContain(
      "<latest-user-request>\nVISIBLE_LATEST_REQUEST_SENTINEL: keep backward compatibility\n</latest-user-request>"
    )
    const initialAnchor = instruction.match(
      /<initial-user-request>([\s\S]*?)<\/initial-user-request>/
    )?.[1]
    const latestAnchor = instruction.match(
      /<latest-user-request>([\s\S]*?)<\/latest-user-request>/
    )?.[1]
    expect(initialAnchor).not.toContain("AUGMENTED_INITIAL_PROMPT_SENTINEL")
    expect(latestAnchor).not.toContain("AUGMENTED_LATEST_PROMPT_SENTINEL")
  })
})
