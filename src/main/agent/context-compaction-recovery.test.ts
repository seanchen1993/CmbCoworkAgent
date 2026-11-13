import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createCmbSummarizationMiddleware } from "./context-summarization-middleware"
import {
  contextWindowFromError,
  fitSummaryRequestToBytes,
  summaryRequestBytes
} from "./context-compaction-recovery"
import type { CompactionDiagnosticReport } from "../services/context-compaction-diagnostics"

const errorText = (limit = 1_048_576) =>
  `This model's maximum context length is ${limit} tokens. However, you requested 1 output tokens and your prompt contains at least ${limit} input tokens, for a total of at least ${limit + 1} tokens. (parameter=input_tokens, value=${limit})`
const overflow = (limit?: number) => Object.assign(new Error(errorText(limit)), { status: 485 })
const summary = () =>
  new AIMessage(
    "## Goal\nFinish the user's task.\n## Current State\nEarlier evidence is archived.\n## Next Step\nContinue from the latest request."
  )

type Request = { messages: BaseMessage[]; state: Record<string, unknown>; tools: unknown[] }
function middleware(
  invoke: (messages: BaseMessage[]) => Promise<AIMessage>,
  extra: Record<string, unknown> = {}
) {
  return createCmbSummarizationMiddleware({
    model: { invoke, profile: { maxInputTokens: 1_000_000 } } as never,
    backend: { write: async (path: string) => ({ path }), downloadFiles: async () => [] } as never,
    trigger: { type: "tokens", value: 750_000 },
    keep: { type: "tokens", value: 100_000 },
    maxInputTokens: 1_000_000,
    summaryMaxOutputTokens: 20_000,
    trimTokensToSummarize: 650_000,
    ...extra
  }) as unknown as {
    wrapModelCall: (
      request: Request,
      handler: (next: Request) => Promise<AIMessage>
    ) => Promise<unknown>
  }
}

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

it("reads the provider limit from nested and wrapped screenshot errors", () => {
  expect(contextWindowFromError(new Error("outer", { cause: overflow() }))).toBe(1_048_576)
  expect(
    contextWindowFromError({
      responseBody: JSON.stringify({ error: { message: errorText(32_768) } })
    })
  ).toBe(32_768)
  expect(contextWindowFromError(new Error("rate limited"))).toBeUndefined()
})

it("recovers the 139k stale-usage / CJK underestimate scenario and records the cause and real shrink", async () => {
  const reports: CompactionDiagnosticReport[] = []
  const requests: BaseMessage[][] = []
  // A deterministic provider with one token per CJK character, not a live tokenizer.
  const invoke = vi.fn(async (messages: BaseMessage[]) => {
    requests.push(messages)
    if (messages.reduce((n, message) => n + String(message.content).length, 0) > 1_048_576)
      throw overflow()
    return summary()
  })
  const archive = vi.fn(async (path: string, body: string) => {
    void body
    return { path }
  })
  const messages = [
    new HumanMessage("ORIGINAL_TASK"),
    new AIMessage({
      content: "PREVIOUS_REPLY",
      usage_metadata: { input_tokens: 139_000, output_tokens: 100, total_tokens: 139_100 }
    }),
    ...Array.from({ length: 80 }, (_, i) => [
      new HumanMessage(`PART_${i} ${"中".repeat(40_000)}`),
      new AIMessage("recorded")
    ]).flat(),
    new HumanMessage("LATEST_USER_REQUEST")
  ]
  const handler = vi.fn(async () => new AIMessage("recovered"))
  const result = await middleware(invoke, {
    onDiagnostic: (report: CompactionDiagnosticReport) => {
      reports.push(report)
    },
    backend: { write: archive, downloadFiles: async () => [] }
  }).wrapModelCall({ messages, state: {}, tools: [] }, handler)
  expect(result).toBeInstanceOf(Command)
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(summaryRequestBytes(requests[1])).toBeLessThanOrEqual(650_000)
  expect(reports[0]).toMatchObject({
    status: "completed",
    context: { reason: "threshold", reportedTotalTokens: 139_100 }
  })
  const trim = reports[0].events.find((event) => event.event === "summary_retry_trim")!.details
  expect(trim.afterRequestBytes).toBeLessThan(trim.beforeRequestBytes as number)
  expect(trim.observedContextWindow).toBe(1_048_576)
  expect(archive.mock.calls[0][1]).toContain("PART_0")
  expect(messages[2].content).toContain("中".repeat(40_000))
  expect(handler.mock.calls[0]).toBeDefined()
})

it("forces recovery when actual overflow occurs below both the trigger and keep budget", async () => {
  const invoke = vi.fn(async () => summary())
  const handler = vi
    .fn()
    .mockRejectedValueOnce(overflow())
    .mockResolvedValue(new AIMessage("recovered"))
  const result = await middleware(invoke).wrapModelCall(
    { messages: [new HumanMessage("short request")], state: {}, tools: [] },
    handler
  )
  expect(result).toBeInstanceOf(Command)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledTimes(2)
})

it("uses a smaller output reservation and the provider limit when the configured window is wrong", async () => {
  const recovery = vi.fn(async (messages: BaseMessage[]) => {
    expect(summaryRequestBytes(messages)).toBeLessThanOrEqual(32_768 - 1_024 - 1_000)
    return summary()
  })
  const invoke = vi.fn(async () => {
    throw overflow(32_768)
  })
  await middleware(invoke, {
    trigger: { type: "messages", value: 1 },
    keep: { type: "messages", value: 1 },
    overflowModel: { invoke: recovery },
    overflowMaxOutputTokens: 1_024
  }).wrapModelCall(
    {
      messages: [new HumanMessage("中".repeat(100_000)), new HumanMessage("latest")],
      state: {},
      tools: []
    },
    async () => new AIMessage("ok")
  )
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(recovery).toHaveBeenCalledTimes(1)
})

it("shrinks a single oversized tool call and result, preserving original checkpoint data", async () => {
  const original = new AIMessage({
    content: "DO_WORK",
    tool_calls: [{ id: "tool", name: "write_file", args: { content: "<&中".repeat(100_000) } }]
  })
  const messages = [
    original,
    new ToolMessage({ content: "<&中".repeat(100_000), tool_call_id: "tool" }),
    new HumanMessage("latest")
  ]
  const requests: BaseMessage[][] = []
  const invoke = vi.fn(async (request: BaseMessage[]) => {
    requests.push(request)
    if (requests.length === 1) throw overflow()
    expect(summaryRequestBytes(request)).toBeLessThanOrEqual(650_000)
    return summary()
  })
  await middleware(invoke, {
    trigger: { type: "messages", value: 1 },
    keep: { type: "messages", value: 1 }
  }).wrapModelCall({ messages, state: {}, tools: [] }, async () => new AIMessage("ok"))
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(original.tool_calls![0].args.content).toBe("<&中".repeat(100_000))
})

it("bounds persistent provider failures, monotonically shrinks requests, and saves a failed diagnostic", async () => {
  const reports: CompactionDiagnosticReport[] = []
  const sizes: number[] = []
  const invoke = vi.fn(async (messages: BaseMessage[]) => {
    sizes.push(summaryRequestBytes(messages))
    throw overflow()
  })
  const state = {}
  await expect(
    middleware(invoke, {
      trigger: { type: "messages", value: 1 },
      keep: { type: "messages", value: 1 },
      onDiagnostic: (report: CompactionDiagnosticReport) => {
        reports.push(report)
      }
    }).wrapModelCall(
      {
        messages: [new HumanMessage("中".repeat(1_000_000)), new HumanMessage("latest")],
        state,
        tools: []
      },
      async () => new AIMessage("never")
    )
  ).rejects.toThrow("maximum context length")
  expect(invoke).toHaveBeenCalledTimes(4)
  expect(sizes.every((size, index) => index === 0 || size < sizes[index - 1])).toBe(true)
  expect(sizes.at(-1)).toBeLessThanOrEqual(16_000)
  expect(reports[0].status).toBe("failed")
  expect(state).toEqual({})
})

it("fits XML/JSON escaping and oversized instructions inside the full request byte budget", () => {
  const build = (text: string, compact: boolean) => [
    new SystemMessage("summarize"),
    new HumanMessage(
      `${compact ? "short instructions" : "long instructions".repeat(2_000)}\n${text}`
    )
  ]
  const result = fitSummaryRequestToBytes("<中&😀>".repeat(10_000), 4_000, build)
  expect(summaryRequestBytes(result)).toBeLessThanOrEqual(4_000)
  expect(String(result[1].content)).toContain("short instructions")
  expect(String(result[1].content)).not.toContain("\uFFFD")
})
