/**
 * Unit tests for coordinator worker stream parsing.
 *
 * Run:
 *   npx -y tsx tests/coordinator-worker-stream.spec.ts
 */

import {
  createWorkerValuesSnapshotContext,
  extractTextFromUnknownContent,
  extractWorkerFinalText,
  extractWorkerVisibleReasoning,
  extractWorkerTranscriptLine,
  extractWorkerUsage,
  isWorkerFinalTextDelta,
  isWorkerToolCallMessage,
  isWorkerToolResultMessage,
  observeSkillUsageFromStream,
  observeWorkerProgress,
  shouldClearWorkerFinalText,
  summarizeWorkerText,
  WorkerValuesSnapshotAccumulator
} from "../src/main/agent/coordinator-worker-stream.ts"
import type { CoordinatorWorkerProgressEvent } from "../src/main/agent/coordinator-worker-manager.ts"
import { SkillUsageDetector } from "../src/main/agent/skill-evolution/usage-detector.ts"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function aiMessage(content: unknown, toolCalls?: unknown[]): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      content,
      tool_calls: toolCalls
    }
  }
}

function aiMessageWithUsage(content: unknown): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      content,
      usage_metadata: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18
      }
    }
  }
}

function aiMessageWithAdditionalToolCalls(content: unknown): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      content,
      additional_kwargs: {
        tool_calls: [{ id: "call-additional", function: { name: "execute" } }]
      }
    }
  }
}

function aiChunkWithToolCallChunks(content: unknown): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      content,
      tool_call_chunks: [{ index: 0, name: "read_file" }]
    }
  }
}

function aiTextChunk(content: unknown): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      content
    }
  }
}

function toolMessage(name?: string): unknown {
  return {
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: {
      name,
      tool_call_id: name ? `${name}-call` : undefined,
      content: "ok"
    }
  }
}

class CountingSkillUsageDetector extends SkillUsageDetector {
  readonly readPaths: string[] = []

  override onReadFilePath(rawPath: string): boolean {
    this.readPaths.push(rawPath)
    return false
  }
}

async function testFinalTextExtraction(): Promise<void> {
  assert(
    extractTextFromUnknownContent([{ type: "text", text: "hello" }, { content: " world" }, "!"]) ===
      "hello world!",
    "content extraction should support string, text, and content blocks"
  )

  assert(
    extractWorkerFinalText("messages", [
      aiMessage([{ type: "text", text: " final " }, { content: "answer" }])
    ]) === "final answer",
    "messages mode should extract final AI text"
  )
  assert(
    extractWorkerVisibleReasoning("messages", [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { content: "", reasoning_content: "visible worker reasoning" }
      }
    ])?.text === "visible worker reasoning",
    "messages mode should extract provider-visible worker reasoning"
  )
  assert(
    extractWorkerVisibleReasoning("values", {
      messages: [
        aiMessage("older answer"),
        {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            content: "final answer",
            additional_kwargs: { reasoning_content: "final reasoning summary" }
          }
        }
      ]
    })?.text === "final reasoning summary",
    "values mode should use the latest provider-visible reasoning"
  )

  assert(
    extractWorkerFinalText("messages", { unexpected: "shape" }) === "",
    "messages mode should ignore non-tuple payloads"
  )

  assert(
    extractWorkerFinalText("messages", [
      aiMessage("not final", [{ id: "call-1", name: "read_file" }])
    ]) === "",
    "messages mode should ignore AI messages that still have tool calls"
  )

  assert(
    extractWorkerFinalText("values", {
      messages: [
        aiMessage("first answer"),
        aiMessage("tooling", [{ id: "call-2", name: "execute" }]),
        aiMessage("second answer")
      ]
    }) === "second answer",
    "values mode should pick the last AI message without tool calls"
  )

  assert(
    extractWorkerFinalText("values", {
      messages: [
        aiMessage("pre-tool narration"),
        aiMessage("tooling", [{ id: "call-3", name: "edit_file" }]),
        toolMessage("edit_file")
      ]
    }) === "",
    "values mode should not treat assistant text before a trailing tool result as final handoff"
  )
  assert(
    shouldClearWorkerFinalText("values", {
      messages: [
        aiMessage("pre-tool narration"),
        aiMessage("tooling", [{ id: "call-clear", name: "edit_file" }]),
        toolMessage("edit_file")
      ]
    }),
    "values-only tool tails should clear stale final text from earlier snapshots"
  )

  assert(
    extractWorkerFinalText("messages", [aiMessageWithAdditionalToolCalls("not final")]) === "",
    "messages mode should ignore additional_kwargs tool calls"
  )

  assert(
    extractWorkerFinalText("messages", [aiChunkWithToolCallChunks("not final")]) === "",
    "messages mode should ignore tool_call_chunks"
  )
  assert(
    isWorkerFinalTextDelta("messages", [aiTextChunk("partial")]),
    "messages mode should identify final-text AIMessageChunk deltas"
  )
  assert(
    extractWorkerFinalText("messages", [aiTextChunk("hello ")]) === "hello ",
    "messages mode should preserve whitespace in stream deltas"
  )
  assert(
    !isWorkerFinalTextDelta("messages", [aiMessage("complete")]),
    "full AI messages should not be treated as stream deltas"
  )
  assert(
    !isWorkerFinalTextDelta("messages", [aiChunkWithToolCallChunks("tooling")]),
    "tool-call chunks should not be treated as final-text deltas"
  )
  assert(
    isWorkerToolCallMessage("messages", [aiChunkWithToolCallChunks("")]),
    "messages mode should identify tool-call chunks"
  )
  assert(
    isWorkerToolResultMessage("messages", [toolMessage("edit_file")]),
    "messages mode should identify tool result messages"
  )

  assert(
    extractWorkerFinalText("values", {
      messages: [
        aiMessage("first answer"),
        aiMessageWithAdditionalToolCalls("not final"),
        aiChunkWithToolCallChunks("also not final")
      ]
    }) === "",
    "values mode should require the last assistant step to be a text handoff"
  )

  assert(
    extractWorkerFinalText("messages", [
      new AIMessage({ content: "live final", tool_calls: [] })
    ]) === "live final",
    "messages mode should extract final text from live LangChain AIMessage objects"
  )

  let unusedFinalPayloadAccessed = false
  const finalWithUnusedPayload = aiMessage("shallow final")
  Object.defineProperty(finalWithUnusedPayload as Record<string, unknown>, "unused_large_payload", {
    enumerable: true,
    get() {
      unusedFinalPayloadAccessed = true
      return "z".repeat(50_000)
    }
  })
  assert(
    extractWorkerFinalText("messages", [finalWithUnusedPayload]) === "shallow final",
    "messages mode should extract final text without cloning the full payload"
  )
  assert(
    !unusedFinalPayloadAccessed,
    "final text extraction should not deep-clone or serialize unused message fields"
  )

  assert(
    extractWorkerFinalText(
      "values",
      {
        messages: [
          new HumanMessage("first prompt"),
          new AIMessage({ content: "old answer", tool_calls: [] }),
          new HumanMessage("second prompt"),
          new AIMessage({ content: "current answer", tool_calls: [] })
        ]
      },
      "second prompt"
    ) === "current answer",
    "values mode should extract final text only from the current worker turn"
  )
}

async function testSummaryFallbackAndTruncation(): Promise<void> {
  assert(
    summarizeWorkerText("   ") === "Worker completed without a text summary.",
    "empty worker output should get a stable fallback summary"
  )

  const longText = "x".repeat(2200)
  const summary = summarizeWorkerText(longText)
  assert(summary.length < longText.length, "long summaries should be truncated")
  assert(summary.endsWith("\n...(truncated)"), "truncated summary should include marker")
}

async function testProgressObservation(): Promise<void> {
  const seen = new Set<string>()
  const events: CoordinatorWorkerProgressEvent[] = []
  const onProgress = (event: CoordinatorWorkerProgressEvent): void => {
    events.push(event)
  }

  const toolCall = { id: "call-1", name: "read_file" }
  observeWorkerProgress("messages", { unexpected: "shape" }, seen, onProgress)
  assert(events.length === 0, "messages mode should ignore non-tuple progress payloads")

  observeWorkerProgress("messages", [aiMessage("", [toolCall])], seen, onProgress)
  observeWorkerProgress("messages", [aiMessage("", [toolCall])], seen, onProgress)
  assert(events.length === 1, "duplicate tool call ids should be counted once")
  assert(events[0]?.type === "tool_call", "AI tool call should emit tool_call progress")
  assert(events[0]?.toolName === "read_file", "tool_call progress should include tool name")

  const mixedToolCallEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress(
    "messages",
    [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          tool_calls: [{ id: "call-mixed", name: "read_file" }],
          tool_call_chunks: [{ index: 0, name: "read_file" }]
        }
      }
    ],
    new Set<string>(),
    (event) => mixedToolCallEvents.push(event)
  )
  assert(
    mixedToolCallEvents.filter((event) => event.type === "tool_call").length === 1,
    "messages with final tool_calls and streaming chunks should count one tool call"
  )

  observeWorkerProgress(
    "values",
    {
      messages: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            tool_call_chunks: [{ index: 0, name: "execute" }]
          }
        },
        {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            additional_kwargs: {
              tool_calls: [{ id: "call-3", function: { name: "write_file" } }]
            }
          }
        }
      ]
    },
    seen,
    onProgress
  )

  assert(
    events.some((event) => event.toolName === "execute"),
    "values mode should observe tool_call_chunks"
  )
  assert(
    events.some((event) => event.toolName === "write_file"),
    "values mode should observe additional_kwargs tool calls"
  )

  const chunkEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress(
    "values",
    {
      messages: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            tool_call_chunks: [{ index: 0, name: "execute" }]
          }
        },
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            tool_call_chunks: [{ index: 0, name: "execute" }]
          }
        }
      ]
    },
    new Set<string>(),
    (event) => chunkEvents.push(event)
  )
  assert(
    chunkEvents.filter((event) => event.type === "tool_call").length === 1,
    "same index/name chunks without stable ids should be deduplicated conservatively"
  )

  const messageIdEvents: CoordinatorWorkerProgressEvent[] = []
  const messageSeen = new Set<string>()
  observeWorkerProgress(
    "messages",
    [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "msg-a",
          tool_call_chunks: [{ index: 0, name: "execute" }]
        }
      }
    ],
    messageSeen,
    (event) => messageIdEvents.push(event)
  )
  observeWorkerProgress(
    "messages",
    [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "msg-b",
          tool_call_chunks: [{ index: 0, name: "execute" }]
        }
      }
    ],
    messageSeen,
    (event) => messageIdEvents.push(event)
  )
  assert(
    messageIdEvents.length === 1,
    "message ids should not cause duplicate counts for the same no-id streaming chunk"
  )

  const crossModeEvents: CoordinatorWorkerProgressEvent[] = []
  const crossModeSeen = new Set<string>()
  const noIdChunk = {
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      tool_call_chunks: [{ index: 0, name: "read_file" }]
    }
  }
  observeWorkerProgress("messages", [noIdChunk], crossModeSeen, (event) =>
    crossModeEvents.push(event)
  )
  observeWorkerProgress("values", { messages: [noIdChunk] }, crossModeSeen, (event) =>
    crossModeEvents.push(event)
  )
  assert(
    crossModeEvents.length === 1,
    "same no-id tool chunk should not be double-counted across stream modes"
  )

  observeWorkerProgress("messages", [toolMessage("read_file")], seen, onProgress)
  observeWorkerProgress("values", { messages: [toolMessage("read_file")] }, seen, onProgress)
  assert(
    events.filter(
      (event) =>
        event.type === "activity" && event.message === "Worker received tool result: read_file"
    ).length === 1,
    "tool result messages should emit one activity progress event across repeated snapshots"
  )

  const liveEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress(
    "messages",
    [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "live-call", name: "read_file", args: {} }]
      })
    ],
    new Set<string>(),
    (event) => liveEvents.push(event)
  )
  assert(
    liveEvents.some((event) => event.type === "tool_call" && event.toolName === "read_file"),
    "messages mode should observe live LangChain AIMessage tool calls"
  )

  const currentTurnEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress(
    "values",
    {
      messages: [
        new HumanMessage("first prompt"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "old-call", name: "old_tool", args: {} }]
        }),
        new HumanMessage("second prompt"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "new-call", name: "new_tool", args: {} }]
        })
      ]
    },
    new Set<string>(),
    (event) => currentTurnEvents.push(event),
    "second prompt"
  )
  assert(
    currentTurnEvents.some((event) => event.toolName === "new_tool") &&
      !currentTurnEvents.some((event) => event.toolName === "old_tool"),
    "values mode should observe only current-turn worker tools when prompt is provided"
  )

  let unusedProgressPayloadAccessed = false
  const progressWithUnusedPayload = aiMessage("", [
    { id: "call-shallow-progress", name: "read_file", args: { path: "README.md" } }
  ])
  Object.defineProperty(
    progressWithUnusedPayload as Record<string, unknown>,
    "unused_large_payload",
    {
      enumerable: true,
      get() {
        unusedProgressPayloadAccessed = true
        return "z".repeat(50_000)
      }
    }
  )
  const shallowProgressEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress("messages", [progressWithUnusedPayload], new Set<string>(), (event) =>
    shallowProgressEvents.push(event)
  )
  assert(
    shallowProgressEvents.some(
      (event) => event.type === "tool_call" && event.toolName === "read_file"
    ),
    "progress observation should parse needed fields"
  )
  assert(
    !unusedProgressPayloadAccessed,
    "progress observation should not deep-clone or serialize unused message fields"
  )

  let fallbackKeyPayloadAccessed = false
  const fallbackToolCall = { name: "fallback_tool" }
  Object.defineProperty(fallbackToolCall, "unused_large_payload", {
    enumerable: true,
    get() {
      fallbackKeyPayloadAccessed = true
      return "z".repeat(50_000)
    }
  })
  observeWorkerProgress(
    "messages",
    [aiMessage("", [fallbackToolCall])],
    new Set<string>(),
    () => undefined
  )
  assert(
    !fallbackKeyPayloadAccessed,
    "tool-call fallback keys should not stringify whole tool-call payloads"
  )
}

async function testUsageAndTranscriptExtraction(): Promise<void> {
  const usage = extractWorkerUsage("messages", [aiMessageWithUsage("done")])
  assert(usage?.total_tokens === 18, "messages mode should extract usage metadata")
  assert(usage?.input_tokens === 11, "messages mode should extract input tokens")

  const valuesUsage = extractWorkerUsage("values", {
    messages: [
      aiMessage("first"),
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          response_metadata: {
            tokenUsage: {
              promptTokens: 3,
              completionTokens: 4,
              totalTokens: 7
            }
          }
        }
      }
    ]
  })
  assert(valuesUsage?.total_tokens === 7, "values mode should extract response token usage")
  assert(valuesUsage?.input_tokens === 3, "token usage aliases should normalize input tokens")

  const tokenUsageMetadata = extractWorkerUsage("messages", [
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        response_metadata: {
          token_usage: {
            prompt_tokens: 9,
            completion_tokens: 5,
            total_tokens: 14
          }
        }
      }
    }
  ])
  assert(
    tokenUsageMetadata?.total_tokens === 14 && tokenUsageMetadata.input_tokens === 9,
    "worker usage should read OpenAI/LangChain response_metadata.token_usage"
  )

  const summedValuesUsage = extractWorkerUsage("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "ai-usage-1",
          usage_metadata: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7
          }
        }
      },
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "ai-usage-2",
          usage_metadata: {
            input_tokens: 8,
            output_tokens: 4,
            total_tokens: 12
          }
        }
      },
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "ai-usage-2",
          usage_metadata: {
            input_tokens: 8,
            output_tokens: 4,
            total_tokens: 12
          }
        }
      }
    ]
  })
  assert(
    summedValuesUsage?.total_tokens === 19 &&
      summedValuesUsage.input_tokens === 13 &&
      summedValuesUsage.output_tokens === 6,
    "values mode should sum unique AI message usage without double-counting snapshots"
  )

  const unstableValuesUsage = extractWorkerUsage("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          usage_metadata: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7
          }
        }
      },
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          usage_metadata: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7
          }
        }
      }
    ]
  })
  assert(
    unstableValuesUsage?.total_tokens === 7 &&
      unstableValuesUsage.input_tokens === 5 &&
      unstableValuesUsage.output_tokens === 2,
    "values mode should not sum repeated usage snapshots without stable message ids"
  )

  const usageEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress("messages", [aiMessageWithUsage("done")], new Set<string>(), (event) =>
    usageEvents.push(event)
  )
  assert(
    usageEvents.some((event) => event.type === "usage" && event.usage?.total_tokens === 18),
    "progress observation should emit usage events"
  )

  const liveUsage = extractWorkerUsage("messages", [
    new AIMessage({
      content: "done",
      response_metadata: {
        token_usage: {
          prompt_tokens: 21,
          completion_tokens: 9,
          total_tokens: 30
        }
      },
      tool_calls: []
    })
  ])
  assert(
    liveUsage?.total_tokens === 30 && liveUsage.input_tokens === 21,
    "messages mode should extract usage from live LangChain AIMessage objects"
  )

  let unusedUsagePayloadAccessed = false
  const usageWithUnusedPayload = aiMessageWithUsage("done")
  Object.defineProperty(usageWithUnusedPayload as Record<string, unknown>, "unused_large_payload", {
    enumerable: true,
    get() {
      unusedUsagePayloadAccessed = true
      return "z".repeat(50_000)
    }
  })
  const shallowUsage = extractWorkerUsage("messages", [usageWithUnusedPayload])
  assert(
    shallowUsage?.total_tokens === 18,
    "messages mode should extract usage without cloning the full payload"
  )
  assert(
    !unusedUsagePayloadAccessed,
    "usage extraction should not deep-clone or serialize unused message fields"
  )

  const currentTurnUsage = extractWorkerUsage(
    "values",
    {
      messages: [
        new HumanMessage("first prompt"),
        new AIMessage({
          content: "old",
          usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          tool_calls: []
        }),
        new HumanMessage("second prompt"),
        new AIMessage({
          content: "new",
          usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
          tool_calls: []
        })
      ]
    },
    "second prompt"
  )
  assert(
    currentTurnUsage?.total_tokens === 10 && currentTurnUsage.input_tokens === 7,
    "values mode should extract usage only from the current worker turn"
  )

  const sharedValuesPayload = {
    skillsMetadata: [{ name: "release-notes", path: "/tmp/release-notes/SKILL.md" }],
    messages: [
      new HumanMessage("first prompt"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "old-call", name: "old_tool", args: {} }]
      }),
      new HumanMessage("second prompt"),
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "usage-shared",
          usage_metadata: {
            input_tokens: 4,
            output_tokens: 3,
            total_tokens: 7
          }
        }
      },
      new AIMessage({
        content: "",
        tool_calls: [{ id: "new-call", name: "new_tool", args: {} }]
      }),
      new AIMessage({ content: "current answer", tool_calls: [] })
    ]
  }
  const sharedValuesContext = createWorkerValuesSnapshotContext(
    "values",
    sharedValuesPayload,
    "second prompt"
  )
  assert(
    sharedValuesContext?.messages.length === 3,
    "shared values context should keep only current-turn post-prompt messages"
  )
  assert(
    sharedValuesContext?.skillsMetadata[0]?.name === "release-notes",
    "shared values context should preserve skills metadata for reuse"
  )
  assert(
    extractWorkerUsage("values", sharedValuesPayload, "second prompt", sharedValuesContext)
      ?.total_tokens === 7,
    "precomputed values context should preserve usage extraction semantics"
  )
  assert(
    extractWorkerFinalText("values", sharedValuesPayload, "second prompt", sharedValuesContext) ===
      "current answer",
    "precomputed values context should preserve final-text extraction semantics"
  )
  const sharedProgressEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress(
    "values",
    sharedValuesPayload,
    new Set<string>(),
    (event) => sharedProgressEvents.push(event),
    "second prompt",
    sharedValuesContext
  )
  assert(
    sharedProgressEvents.some(
      (event) => event.type === "tool_call" && event.toolName === "new_tool"
    ) &&
      !sharedProgressEvents.some(
        (event) => event.type === "tool_call" && event.toolName === "old_tool"
      ),
    "precomputed values context should scope progress observation to the current turn"
  )

  const toolTranscript = extractWorkerTranscriptLine("messages", [
    aiMessage("", [{ id: "call-1", name: "read_file", args: { path: "README.md" } }])
  ])
  assert(toolTranscript.includes('"type":"tool_call"'), "tool call transcript should be JSONL")
  assert(
    toolTranscript.includes('"tool_name":"read_file"'),
    "tool call transcript should include tool name"
  )
  assert(toolTranscript.includes("README.md"), "tool call transcript should include arguments")
  const largeToolTranscript = extractWorkerTranscriptLine("messages", [
    aiMessage("", [{ id: "call-large", name: "write_file", args: { content: "x".repeat(20_000) } }])
  ])
  assert(
    largeToolTranscript.includes("omitted large tool arguments"),
    "large tool arguments should be summarized in transcript"
  )
  const originalJsonParse = JSON.parse
  let largeArgumentsParsed = false
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    largeArgumentsParsed = true
    return originalJsonParse(text, reviver)
  }) as typeof JSON.parse
  try {
    const largeJsonArgumentsTranscript = extractWorkerTranscriptLine("messages", [
      aiMessage("", [
        {
          id: "call-large-json",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ content: "x".repeat(20_000) })
          }
        }
      ])
    ])
    assert(
      largeJsonArgumentsTranscript.includes("omitted large JSON tool arguments"),
      "large OpenAI-style JSON tool arguments should be summarized without parsing"
    )
    assert(!largeArgumentsParsed, "large OpenAI-style tool arguments should not be JSON.parsed")
  } finally {
    JSON.parse = originalJsonParse
  }

  const toolResultTranscript = extractWorkerTranscriptLine("messages", [toolMessage("read_file")])
  assert(
    toolResultTranscript.includes('"type":"tool_result"') &&
      toolResultTranscript.includes('"content":"ok"'),
    "tool result transcript should include result content"
  )
  const largeToolResultTranscript = extractWorkerTranscriptLine("messages", [
    {
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        name: "execute",
        tool_call_id: "execute-call",
        content: "y".repeat(20_000)
      }
    }
  ])
  assert(
    largeToolResultTranscript.includes("...(truncated"),
    "large tool results should be truncated in transcript"
  )

  const assistantTranscript = extractWorkerTranscriptLine("messages", [aiMessage("final answer")])
  assert(
    assistantTranscript.includes('"type":"assistant"') &&
      assistantTranscript.includes("final answer"),
    "assistant transcript should include assistant content"
  )

  let unusedPayloadAccessed = false
  const assistantWithUnusedPayload = aiMessage("shallow transcript")
  Object.defineProperty(
    assistantWithUnusedPayload as Record<string, unknown>,
    "unused_large_payload",
    {
      enumerable: true,
      get() {
        unusedPayloadAccessed = true
        return "z".repeat(50_000)
      }
    }
  )
  const shallowTranscript = extractWorkerTranscriptLine("messages", [assistantWithUnusedPayload])
  assert(shallowTranscript.includes("shallow transcript"), "transcript should parse needed fields")
  assert(
    !unusedPayloadAccessed,
    "transcript extraction should not deep-clone or serialize unused message fields"
  )

  const liveAssistantTranscript = extractWorkerTranscriptLine("messages", [
    new AIMessage({ content: "live transcript", tool_calls: [] })
  ])
  assert(
    liveAssistantTranscript.includes("live transcript"),
    "transcript extraction should support live LangChain AIMessage objects"
  )

  const liveToolTranscript = extractWorkerTranscriptLine("messages", [
    new ToolMessage({
      content: "tool ok",
      name: "read_file",
      tool_call_id: "live-call"
    })
  ])
  assert(
    liveToolTranscript.includes('"type":"tool_result"') && liveToolTranscript.includes("tool ok"),
    "transcript extraction should support live LangChain ToolMessage objects"
  )
}

function cumulativeValuesFixture(stablePrefixSize: number): {
  rawMessages: unknown[]
  messages: unknown[]
  poisonStablePrefix: () => void
} {
  const rawMessages: unknown[] = [
    {
      id: ["langchain_core", "messages", "HumanMessage"],
      kwargs: { content: "current prompt" }
    },
    ...Array.from({ length: stablePrefixSize }, (_, index) => {
      if (index === 0) {
        return {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id: "stable-tool-prefix",
            content: "",
            tool_calls: [
              {
                id: "stable-read-call",
                name: "read_file",
                args: { path: "/tmp/example-skill/SKILL.md" }
              }
            ]
          }
        }
      }
      if (index === 1) {
        return {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id: "stable-reasoning-prefix",
            content: "working",
            additional_kwargs: { reasoning_content: "stable prefix reasoning" }
          }
        }
      }
      return {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: { id: `stable-prefix-${index}`, content: `prefix-${index}` }
      }
    }),
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        id: "stable-tail",
        content: "first",
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
    }
  ]
  let stablePrefixPoisoned = false
  const messages = new Proxy(rawMessages, {
    get(target, property, receiver) {
      if (
        stablePrefixPoisoned &&
        typeof property === "string" &&
        /^\d+$/.test(property) &&
        Number(property) < target.length - 1
      ) {
        throw new Error(`stable values prefix was reread at index ${property}`)
      }
      return Reflect.get(target, property, receiver)
    }
  })
  return {
    rawMessages,
    messages,
    poisonStablePrefix: () => {
      stablePrefixPoisoned = true
    }
  }
}

async function testValuesAccumulatorStableTailFastPath(): Promise<void> {
  const fixture = cumulativeValuesFixture(10_000)
  const accumulator = new WorkerValuesSnapshotAccumulator("current prompt")
  const detector = new CountingSkillUsageDetector()
  const seen = new Set<string>()
  const events: CoordinatorWorkerProgressEvent[] = []
  const firstPayload = { messages: fixture.messages }
  const firstContext = accumulator.createContext("values", firstPayload)
  observeSkillUsageFromStream("values", firstPayload, detector, firstContext)
  observeWorkerProgress(
    "values",
    firstPayload,
    seen,
    (event) => events.push(event),
    "current prompt",
    firstContext
  )
  assert(detector.readPaths.length === 1, "the initial scan should observe the Skill read once")
  assert(
    events.filter((event) => event.type === "tool_call").length === 1,
    "the initial scan should emit the stable-prefix tool call once"
  )

  fixture.rawMessages[fixture.rawMessages.length - 1] = {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: "stable-tail",
      content: "first and second",
      usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
    }
  }
  fixture.poisonStablePrefix()
  const secondPayload = { messages: fixture.messages }
  const secondContext = accumulator.createContext("values", secondPayload)
  assert(
    extractWorkerFinalText("values", secondPayload, "current prompt", secondContext) ===
      "first and second",
    "a same-identity content tail should update final text without reading the 10k prefix"
  )
  assert(
    extractWorkerVisibleReasoning("values", secondPayload, "current prompt", secondContext)?.text ===
      "stable prefix reasoning",
    "the fast path should preserve the latest stable-prefix reasoning"
  )
  assert(
    extractWorkerUsage("values", secondPayload, "current prompt", secondContext)?.total_tokens ===
      3,
    "the fast path should replace the stable tail's usage contribution"
  )
  assert(
    !shouldClearWorkerFinalText("values", secondPayload, "current prompt", secondContext),
    "an ordinary assistant tail should not clear final text"
  )
  observeSkillUsageFromStream("values", secondPayload, detector, secondContext)
  observeWorkerProgress(
    "values",
    secondPayload,
    seen,
    (event) => events.push(event),
    "current prompt",
    secondContext
  )
  assert(
    detector.readPaths.length === 1,
    "a content-only tail should not replay Skill reads from the poisoned stable prefix"
  )
  assert(
    events.filter((event) => event.type === "tool_call").length === 1,
    "a content-only tail should not replay tool progress from the poisoned stable prefix"
  )
}

async function testWorkflowSkillAccumulatorStableTailFastPath(): Promise<void> {
  const fixture = cumulativeValuesFixture(2_000)
  const accumulator = new WorkerValuesSnapshotAccumulator("current prompt", {
    deriveWorkerState: false
  })
  const detector = new CountingSkillUsageDetector()
  const firstPayload = { messages: fixture.messages }
  const firstContext = accumulator.createContext("values", firstPayload)
  observeSkillUsageFromStream("values", firstPayload, detector, firstContext)

  fixture.rawMessages[fixture.rawMessages.length - 1] = {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id: "stable-tail", content: "first and workflow second" }
  }
  fixture.poisonStablePrefix()
  const secondPayload = { messages: fixture.messages }
  const secondContext = accumulator.createContext("values", secondPayload)
  observeSkillUsageFromStream("values", secondPayload, detector, secondContext)
  assert(
    detector.readPaths.length === 1,
    "workflow Skill observation should not reread a stable 2k prefix on the second frame"
  )
}

async function testValuesAccumulatorBoundaryFallbacks(): Promise<void> {
  let prefixReads = 0
  const prefixKwargs = { id: "prefix", content: "prefix" }
  const prefix = {
    id: ["langchain_core", "messages", "AIMessage"]
  } as Record<string, unknown>
  Object.defineProperty(prefix, "kwargs", {
    enumerable: true,
    get() {
      prefixReads += 1
      return prefixKwargs
    }
  })
  const prompt = {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: { content: "boundary prompt" }
  }
  const rawMessages = [
    prompt,
    prefix,
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { id: "tail-a", content: "answer a" }
    }
  ]
  const accumulator = new WorkerValuesSnapshotAccumulator("boundary prompt")
  accumulator.createContext("values", { messages: rawMessages })

  prefixReads = 0
  rawMessages[2] = {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id: "tail-b", content: "answer b" }
  }
  const identityContext = accumulator.createContext("values", { messages: rawMessages })
  assert(prefixReads > 0, "an assistant identity change should force a complete fallback scan")
  assert(
    extractWorkerFinalText("values", { messages: rawMessages }, "boundary prompt", identityContext) ===
      "answer b",
    "identity fallback should keep the new assistant answer"
  )

  prefixReads = 0
  rawMessages[2] = {
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: { name: "execute", tool_call_id: "boundary-call", content: "ok" }
  }
  const toolContext = accumulator.createContext("values", { messages: rawMessages })
  assert(prefixReads > 0, "a tool boundary should force a complete fallback scan")
  assert(
    shouldClearWorkerFinalText("values", { messages: rawMessages }, "boundary prompt", toolContext),
    "tool-boundary fallback should clear stale assistant text"
  )

  prefixReads = 0
  const reorderedMessages = [
    prompt,
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { id: "tail-c", content: "answer c" }
    },
    prefix
  ]
  const reorderedContext = accumulator.createContext("values", { messages: reorderedMessages })
  assert(prefixReads > 0, "a replacement/reordered messages array should force a full scan")
  assert(
    extractWorkerFinalText(
      "values",
      { messages: reorderedMessages },
      "boundary prompt",
      reorderedContext
    ) === "prefix",
    "reorder fallback should derive final text from the actual new order"
  )
}

async function run(): Promise<void> {
  await testFinalTextExtraction()
  console.log("PASS coordinator worker stream final text extraction")
  await testSummaryFallbackAndTruncation()
  console.log("PASS coordinator worker stream summary handling")
  await testProgressObservation()
  console.log("PASS coordinator worker stream progress observation")
  await testUsageAndTranscriptExtraction()
  console.log("PASS coordinator worker stream usage and transcript extraction")
  await testValuesAccumulatorStableTailFastPath()
  console.log("PASS coordinator worker values 10k stable-tail fast path")
  await testWorkflowSkillAccumulatorStableTailFastPath()
  console.log("PASS workflow values 2k stable-tail fast path")
  await testValuesAccumulatorBoundaryFallbacks()
  console.log("PASS coordinator worker values boundary fallbacks")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
