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
  extractWorkerTranscriptLine,
  extractWorkerUsage,
  observeWorkerProgress,
  summarizeWorkerText
} from "../src/main/agent/coordinator-worker-stream.ts"
import type { CoordinatorWorkerProgressEvent } from "../src/main/agent/coordinator-worker-manager.ts"
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
    extractWorkerFinalText("messages", [aiMessageWithAdditionalToolCalls("not final")]) === "",
    "messages mode should ignore additional_kwargs tool calls"
  )

  assert(
    extractWorkerFinalText("messages", [aiChunkWithToolCallChunks("not final")]) === "",
    "messages mode should ignore tool_call_chunks"
  )

  assert(
    extractWorkerFinalText("values", {
      messages: [
        aiMessage("first answer"),
        aiMessageWithAdditionalToolCalls("not final"),
        aiChunkWithToolCallChunks("also not final")
      ]
    }) === "first answer",
    "values mode should ignore all AI messages that still contain tool call forms"
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
  Object.defineProperty(progressWithUnusedPayload as Record<string, unknown>, "unused_large_payload", {
    enumerable: true,
    get() {
      unusedProgressPayloadAccessed = true
      return "z".repeat(50_000)
    }
  })
  const shallowProgressEvents: CoordinatorWorkerProgressEvent[] = []
  observeWorkerProgress("messages", [progressWithUnusedPayload], new Set<string>(), (event) =>
    shallowProgressEvents.push(event)
  )
  assert(
    shallowProgressEvents.some((event) => event.type === "tool_call" && event.toolName === "read_file"),
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
    sharedProgressEvents.some((event) => event.type === "tool_call" && event.toolName === "new_tool") &&
      !sharedProgressEvents.some((event) => event.type === "tool_call" && event.toolName === "old_tool"),
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
  Object.defineProperty(assistantWithUnusedPayload as Record<string, unknown>, "unused_large_payload", {
    enumerable: true,
    get() {
      unusedPayloadAccessed = true
      return "z".repeat(50_000)
    }
  })
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
    liveToolTranscript.includes('"type":"tool_result"') &&
      liveToolTranscript.includes("tool ok"),
    "transcript extraction should support live LangChain ToolMessage objects"
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
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
