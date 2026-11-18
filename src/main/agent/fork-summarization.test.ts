import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  AIMessage,
  FunctionMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { describe, expect, it, vi } from "vitest"
import { summaryRequestBytes } from "./context-compaction-recovery"
import {
  buildSummaryMessage,
  createCmbSummarizationMiddleware,
  findInitialUserRequestInHistory,
  INITIAL_USER_REQUEST_KEY,
  shortenInitialPromptAnchor,
  SummarizationEventSchema
} from "./context-summarization-middleware"
import { inheritForkSummarization } from "./fork-summarization"

vi.mock("./context-history-path", () => ({
  getConversationHistoryDirectory: async (workspacePath: string) => workspacePath
}))

const SOURCE_PATH = "/source/never-read-this/conversation_history/session_old.md"

function estimateCjkProviderTokens(messages: BaseMessage[]): number {
  return messages.reduce((tokens, message) => {
    const content = String(message.content)
    let ascii = 0
    let nonAscii = 0
    for (const character of content) {
      if (character.charCodeAt(0) < 128) ascii += 1
      else nonAscii += 1
    }
    return tokens + nonAscii + Math.ceil(ascii / 4)
  }, 0)
}

function checkpoint(messages: BaseMessage[], cutoffIndex: number): Checkpoint {
  return {
    v: 1,
    id: "fork-summary-test",
    ts: "2026-11-18T00:00:00.000Z",
    channel_versions: {},
    versions_seen: {},
    channel_values: {
      messages,
      _summarizationSessionId: "session_old",
      _summarizationEvent: {
        cutoffIndex,
        summaryMessage: buildSummaryMessage("completed prior work", SOURCE_PATH, null),
        filePath: SOURCE_PATH
      }
    }
  }
}

describe("fork summary state", () => {
  it("keeps exact Unicode edges for a large initial request", () => {
    const desiredHead = "a" + "𐐷".repeat(1_499)
    const desiredTail = "𐐷".repeat(1_499) + "b"
    const content = desiredHead + "middle".repeat(200_000) + desiredTail
    expect(findInitialUserRequestInHistory([new HumanMessage(content)])).toBe(
      desiredHead + "\n...[initial user request middle truncated]...\n" + desiredTail
    )
  })

  it.each([
    [
      "C:\\Users\\测试\\conversation_history/session_old.md",
      "file:///C:/Users/%e6%b5%8b%e8%af%95/conversation_history/session_old.md"
    ],
    [
      "/Users/amy/Cowork Data#/conversation_history/session_old.md",
      "FILE:///Users/amy/Cowork%20Data%23/conversation_history/session_old.md"
    ]
  ])("rebases percent-encoded file URLs for %s", async (source, url) => {
    const directory = await mkdtemp(join(tmpdir(), "fork-summary-file-url-"))
    try {
      const value = checkpoint([new HumanMessage("original"), new AIMessage("answer")], 1)
      value.channel_values._summarizationEvent = {
        cutoffIndex: 1,
        summaryMessage: buildSummaryMessage("[detail](" + url + ")", source, null),
        filePath: source
      }
      await inheritForkSummarization({
        checkpoint: value,
        persistedMessageCount: 2,
        archiveTarget: { threadId: "child", workspacePath: directory }
      })
      const event = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      expect(event.summaryMessage.content).not.toContain(url)
      expect(event.summaryMessage.content).toContain(
        "[detail](" + pathToFileURL(event.filePath!).href + ")"
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects an old repaired suffix that no longer matches its original user anchor", async () => {
    const value = checkpoint(
      [new HumanMessage("retained later request"), new AIMessage("answer")],
      1
    )
    value.channel_values._summarizationEvent = {
      cutoffIndex: 1,
      summaryMessage: buildSummaryMessage("earlier work", SOURCE_PATH, "original request"),
      filePath: SOURCE_PATH
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: 2 })
    expect(value.channel_values._summarizationEvent).toBeUndefined()
  })

  it.each([true, false])("rebases Windows source aliases with archive=%s", async (withArchive) => {
    const directory = await mkdtemp(join(tmpdir(), "fork-summary-alias-"))
    try {
      const source = "C:\\Local\\Some Project\\conversation_history/session_old.md"
      const alias = "c:/LOCAL/Some%20Project/conversation_history/session_old.md"
      const initial = "Use the evidence in " + alias
      const value = checkpoint([new HumanMessage(initial), new AIMessage("answer")], 1)
      value.channel_values._summarizationEvent = {
        cutoffIndex: 1,
        summaryMessage: buildSummaryMessage("[old detail](" + alias + ")", source, initial),
        filePath: source
      }
      await inheritForkSummarization({
        checkpoint: value,
        persistedMessageCount: 2,
        ...(withArchive && { archiveTarget: { threadId: "child", workspacePath: directory } })
      })
      const event = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      const replacement =
        event.filePath?.replaceAll("\\", "/").replaceAll(" ", "%20") ??
        "[fork history archive unavailable]"
      expect(event.summaryMessage.content).not.toContain(alias)
      expect(event.summaryMessage.content).toContain("[old detail](" + replacement + ")")
      expect(event.summaryMessage.additional_kwargs.cmb_initial_user_request).toBe(
        "Use the evidence in " + replacement
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { source: "C:\\C# + Projects\\conversation_history\\session_old.md", withArchive: true },
    { source: "C:\\C# + Projects\\conversation_history\\session_old.md", withArchive: false },
    { source: "\\\\测试\\Compartir\\session_old.md", withArchive: false }
  ])(
    "rebases native Windows file URLs for $source with archive=$withArchive",
    async ({ source, withArchive }) => {
      const directory = await mkdtemp(join(tmpdir(), "fork-summary-native-file-url-"))
      try {
        const url = pathToFileURL(source, { windows: true }).href
        const value = checkpoint([new HumanMessage("original"), new AIMessage("answer")], 1)
        value.channel_values._summarizationEvent = {
          cutoffIndex: 1,
          summaryMessage: buildSummaryMessage("[detail](" + url + ")", source, null),
          filePath: source
        }
        await inheritForkSummarization({
          checkpoint: value,
          persistedMessageCount: 2,
          ...(withArchive && { archiveTarget: { threadId: "child", workspacePath: directory } })
        })
        const event = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
        const replacement = event.filePath
          ? pathToFileURL(event.filePath).href
          : "[fork history archive unavailable]"
        expect(event.summaryMessage.content).not.toContain(url)
        expect(event.summaryMessage.content).toContain("[detail](" + replacement + ")")
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each([
    { body: "Long archived decision. ".repeat(700), window: 1_000, providerLimit: 3_000 },
    { body: "界".repeat(30_000), window: 8_000, providerLimit: 7_000 },
    { body: "界".repeat(30_000), window: 8_000, providerLimit: 2_100 },
    { body: "界".repeat(30_000), window: 8_000, providerLimit: 1_200 }
  ])(
    "shortens an oversized inherited handoff for a $providerLimit-character provider",
    async ({ body, window, providerLimit }) => {
      const raw = [new HumanMessage("original request"), new AIMessage("earlier answer")]
      const value = checkpoint(raw, raw.length)
      value.channel_values._summarizationEvent = {
        cutoffIndex: raw.length,
        summaryMessage: buildSummaryMessage(body, null, null),
        filePath: null
      }
      await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
      const invoke = vi.fn(async (messages: BaseMessage[]) => {
        const length = messages.reduce(
          (total, message) => total + String(message.content).length,
          0
        )
        if (length > providerLimit) throw new Error("maximum context length")
        return new AIMessage("Short handoff with the earlier decision.")
      })
      const write = vi.fn()
      const middleware = createCmbSummarizationMiddleware({
        model: { invoke } as never,
        backend: { write } as never,
        maxInputTokens: window,
        trigger: { type: "tokens", value: 500 },
        keep: { type: "messages", value: 1 }
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
        ) => Promise<{ update: { _summarizationEvent: unknown } }>
      }
      const freshInput = new HumanMessage("What now?")
      const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
        if (String(messages[0].content).length > providerLimit)
          throw new Error("maximum context length")
        expect(messages.slice(1)).toEqual([freshInput])
        return new AIMessage("done")
      })
      const messages = [...raw, freshInput]
      const result = await middleware.wrapModelCall(
        { messages, state: { ...value.channel_values, messages }, tools: [] },
        handler
      )
      const summary = SummarizationEventSchema.parse(result.update._summarizationEvent)
      expect(summary.cutoffIndex).toBe(raw.length)
      expect(summary.summaryMessage.content).toContain("Short handoff")
      expect(summary.usageStartIndex).toBe(raw.length + 1)
      const requestLengths = invoke.mock.calls.map(([requestMessages]) =>
        requestMessages.reduce((total, message) => total + String(message.content).length, 0)
      )
      if (providerLimit <= 2_100) {
        expect(requestLengths.length).toBeGreaterThan(1)
        expect(requestLengths.length).toBeLessThanOrEqual(4)
        expect(
          requestLengths.every((length, index) => index === 0 || length < requestLengths[index - 1])
        ).toBe(true)
      } else {
        expect(invoke).toHaveBeenCalledTimes(1)
      }
      expect(handler).toHaveBeenCalledTimes(2)
      expect(write).not.toHaveBeenCalled()
    }
  )

  it("preserves the inherited handoff and archive pointer during chained compaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fork-summary-chained-"))
    try {
      const initialRequest = "Implement <details><summary>Show more</summary></details>"
      const raw = [
        new HumanMessage(initialRequest),
        new AIMessage("old answer"),
        new HumanMessage("retained clarification"),
        new AIMessage("retained reply " + "&<>".repeat(20_000))
      ]
      const value = checkpoint(raw, 2)
      value.channel_values._summarizationEvent = {
        cutoffIndex: 2,
        summaryMessage: buildSummaryMessage(
          "MIGRATION_DECISION\n" +
            "界".repeat(30_000) +
            "\nLiteral </previous-summary> KEEP_DECISION_7",
          null,
          initialRequest
        ),
        filePath: null
      }
      await inheritForkSummarization({
        checkpoint: value,
        persistedMessageCount: raw.length,
        archiveTarget: { threadId: "child", workspacePath: directory }
      })
      const inheritedFile = SummarizationEventSchema.parse(
        value.channel_values._summarizationEvent
      ).filePath
      expect(inheritedFile).toBeTruthy()
      const inheritedUrl = pathToFileURL(inheritedFile!).href
      const invoke = vi.fn(async (messages: BaseMessage[]) => {
        const input = messages.map((message) => String(message.content)).join("\n")
        if (Math.ceil(input.length / 4) + 13_000 > 16_000) {
          throw new Error("maximum context length")
        }
        expect(input).toMatch(/<previous-summary>\s*MIGRATION_DECISION/)
        expect(input).toContain("&lt;/previous-summary&gt; KEEP_DECISION_7")
        expect(input).toContain("retained clarification")
        expect(input).toContain("retained reply")
        return new AIMessage("MIGRATION_DECISION and [archived evidence](" + inheritedUrl + ")")
      })
      const write = vi.fn(async () => ({ error: "simulated append failure" }))
      const middleware = createCmbSummarizationMiddleware({
        model: { invoke } as never,
        backend: { write } as never,
        maxInputTokens: 16_000,
        summaryModelInputBudgetTokens: 2_000,
        trigger: { type: "messages", value: 3 },
        keep: { type: "messages", value: 1 }
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
        ) => Promise<{ update: { _summarizationEvent: unknown } }>
      }
      const fresh = new HumanMessage("What is next?")
      const messages = [...raw, fresh]
      const result = await middleware.wrapModelCall(
        { messages, state: { ...value.channel_values, messages }, tools: [] },
        async (request) => {
          expect(request.messages[0].content).toContain("MIGRATION_DECISION")
          expect(request.messages.slice(1)).toEqual([fresh])
          return new AIMessage("done")
        }
      )
      const chained = SummarizationEventSchema.parse(result.update._summarizationEvent)
      expect(chained.cutoffIndex).toBe(raw.length)
      expect(chained.filePath).toBe(inheritedFile)
      expect(chained.archiveIncomplete).toBe(true)
      expect(write).toHaveBeenCalledOnce()
      value.channel_values._summarizationEvent = chained
      value.channel_values.messages = messages
      await inheritForkSummarization({ checkpoint: value, persistedMessageCount: messages.length })
      const nested = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      expect(nested.summaryMessage.content).toContain("[fork history archive unavailable]")
      expect(nested.summaryMessage.content).not.toContain(inheritedUrl)
      await inheritForkSummarization({
        checkpoint: value,
        persistedMessageCount: messages.length,
        archiveTarget: { threadId: "grandchild", workspacePath: directory }
      })
      const withArchive = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      expect(withArchive.summaryMessage.content).toContain(
        "[archived evidence](" + pathToFileURL(withArchive.filePath!).href + ")"
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("tightens an inherited handoff again when the outer provider rejects the first rewrite", async () => {
    const raw = [new HumanMessage("original"), new AIMessage("previous reply")]
    const value = checkpoint(raw, 2)
    value.channel_values._summarizationEvent = {
      cutoffIndex: 2,
      summaryMessage: buildSummaryMessage("history ".repeat(3_000), null, null),
      filePath: null
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: 2 })
    const fresh = new HumanMessage("Continue with the original task")
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      const target = Number(String(messages[1].content).match(/approximately (\d+) tokens/)?.[1])
      expect(target).toBeGreaterThan(0)
      return new AIMessage("active decision ".repeat(Math.ceil(target / 8)))
    })
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write: vi.fn() } as never,
      maxInputTokens: 2_500,
      postCompactionInputBudgetTokens: 2_500,
      trigger: { type: "messages", value: 2 },
      keep: { type: "messages", value: 1 }
    }) as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
      ) => Promise<{ update: { _summarizationEvent: unknown } }>
    }
    const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
      expect(messages.slice(1)).toEqual([fresh])
      if (String(messages[0].content).length > 3_000) throw new Error("maximum context length")
      return new AIMessage("done")
    })
    const messages = [...raw, fresh]
    const result = await middleware.wrapModelCall(
      { messages, state: { ...value.channel_values, messages }, tools: [] },
      handler
    )
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledTimes(3)
    expect(SummarizationEventSchema.parse(result.update._summarizationEvent).cutoffIndex).toBe(2)
  })

  it("sanitizes structured media before fitting the inherited compaction request", async () => {
    const attachment = new HumanMessage({
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(500_000) } },
        { type: "text", text: "IMPORTANT_ASK_AFTER_IMAGE" }
      ]
    })
    const raw = [
      new HumanMessage("original"),
      new AIMessage("earlier reply"),
      attachment,
      new AIMessage("answer to the follow-up")
    ]
    const value = checkpoint(raw, 2)
    value.channel_values._summarizationEvent = {
      cutoffIndex: 2,
      summaryMessage: buildSummaryMessage("HANDOFF_FACT\n" + "界".repeat(30_000), null, null),
      filePath: null
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      const input = messages.map((message) => String(message.content)).join("\n")
      expect(input).toContain("[image]")
      expect(input).toContain("IMPORTANT_ASK_AFTER_IMAGE")
      expect(input).toContain("HANDOFF_FACT")
      expect(input).not.toContain("data:image/png;base64,")
      return new AIMessage("HANDOFF_FACT and follow-up preserved")
    })
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write: vi.fn(async () => ({ error: "test archive is unavailable" })) } as never,
      summaryModelInputBudgetTokens: 3_500,
      maxInputTokens: 8_000,
      trigger: { type: "messages", value: 3 },
      keep: { type: "messages", value: 1 }
    }) as unknown as {
      wrapModelCall: (request: unknown, handler: () => Promise<AIMessage>) => Promise<unknown>
    }
    const messages = [...raw, new HumanMessage("Continue")]
    await middleware.wrapModelCall(
      { messages, state: { ...value.channel_values, messages }, tools: [] },
      async () => new AIMessage("done")
    )
    expect(invoke).toHaveBeenCalledOnce()
    expect(JSON.stringify(attachment.content)).toContain("data:image/png;base64,")
  })

  it("keeps short completed turns when the resized retry request already fits", async () => {
    const raw = [new HumanMessage("original"), new AIMessage("original reply")]
    const value = checkpoint(raw, raw.length)
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const constraint = "Never rename the existing Foo API. REQUIRED_AFTER_FORK"
    const fresh = new HumanMessage("continue")
    const messages = [
      ...raw,
      new HumanMessage(constraint),
      new AIMessage("Acknowledged"),
      new HumanMessage("Please review " + "evidence ".repeat(1_000)),
      new AIMessage("LAST_RAW_TURN"),
      fresh
    ]
    const invoke = vi.fn(async (request: BaseMessage[]) => {
      if (summaryRequestBytes(request) > 4_000) throw new Error("maximum context length")
      expect(request[1].content).toContain(constraint)
      expect(request[1].content).toContain("LAST_RAW_TURN")
      return new AIMessage(constraint)
    })
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write: vi.fn(async () => ({ error: "archive unavailable" })) } as never,
      maxInputTokens: 8_000,
      summaryModelInputBudgetTokens: 8_000,
      trimTokensToSummarize: 4_000,
      trigger: { type: "tokens", value: 500 },
      keep: { type: "messages", value: 1 }
    }) as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
      ) => Promise<unknown>
    }
    const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
      expect(messages[0].content).toContain(constraint)
      expect(messages.slice(1)).toEqual([fresh])
      return new AIMessage("done")
    })
    await middleware.wrapModelCall(
      { messages, state: { ...value.channel_values, messages }, tools: [] },
      handler
    )
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    "fits ordinary turns and inherited handoff after overflow (dedicated recovery model: %s)",
    async (dedicatedRecoveryModel) => {
      const raw = [new HumanMessage("original"), new AIMessage("original reply")]
      const value = checkpoint(raw, 2)
      value.channel_values._summarizationEvent = {
        cutoffIndex: 2,
        summaryMessage: buildSummaryMessage(
          "INHERITED_DECISION " + "history fact ".repeat(770) + " HANDOFF_END",
          null,
          null
        ),
        filePath: null
      }
      await inheritForkSummarization({ checkpoint: value, persistedMessageCount: 2 })
      const followups = Array.from({ length: 50 }, (_, index) => [
        new HumanMessage("follow-up " + index + " " + "question ".repeat(10)),
        new AIMessage((index === 49 ? "LAST_RAW_TURN " : "reply ") + "context ".repeat(10))
      ]).flat()
      const fresh = new HumanMessage("finish")
      const messages = [...raw, ...followups, fresh]
      const invoke = vi.fn(async (summaryMessages: BaseMessage[]) => {
        const input = summaryMessages.map((message) => String(message.content)).join("\n")
        if (input.length > 4_500) throw new Error("maximum context length")
        expect(input).toContain("INHERITED_DECISION")
        expect(input).toContain("HANDOFF_END")
        expect(input).toContain("LAST_RAW_TURN")
        return new AIMessage("INHERITED_DECISION and the last follow-up")
      })
      const primary = dedicatedRecoveryModel
        ? vi.fn(async () => {
            throw Object.assign(new Error("任务上下文超过最大限度"), { status: 485 })
          })
        : invoke
      const onDiagnostic = vi.fn()
      const middleware = createCmbSummarizationMiddleware({
        model: { invoke: primary } as never,
        ...(dedicatedRecoveryModel && { overflowModel: { invoke } as never }),
        summaryMaxOutputTokens: 2_048,
        overflowMaxOutputTokens: 1_024,
        onDiagnostic,
        backend: { write: vi.fn(async () => ({ error: "test archive is unavailable" })) } as never,
        maxInputTokens: 8_000,
        summaryModelInputBudgetTokens: 8_000,
        trigger: { type: "tokens", value: 500 },
        keep: { type: "messages", value: 1 }
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
        ) => Promise<unknown>
      }
      await middleware.wrapModelCall(
        { messages, state: { ...value.channel_values, messages }, tools: [] },
        async (request) => {
          expect(request.messages[0].content).toContain("INHERITED_DECISION")
          expect(request.messages.slice(1)).toEqual([fresh])
          return new AIMessage("done")
        }
      )
      expect(primary.mock.calls.length + (dedicatedRecoveryModel ? invoke.mock.calls.length : 0))
        .toBeLessThanOrEqual(4)
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        status: "completed",
        events: expect.arrayContaining([expect.objectContaining({
          event: "summary_retry_trim",
          details: expect.objectContaining({
            reservedOutputTokens: dedicatedRecoveryModel ? 1_024 : 2_048
          })
        })])
      }))
      if (dedicatedRecoveryModel) {
        expect(primary).toHaveBeenCalledOnce()
      } else {
        expect(primary.mock.calls.length).toBeGreaterThan(1)
      }
      expect(invoke).toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    "rebases an older archive alias with current pointer=%s",
    async (hasPointer) => {
      const directory = await mkdtemp(join(tmpdir(), "fork-source-archive-"))
      try {
        const source = join(directory, "session_old.md")
        const summary = "prior decision [detail](" + pathToFileURL(source).href + ")"
        const initial = "original request"
        const raw = [
          new HumanMessage(initial),
          new AIMessage("old reply"),
          new HumanMessage("follow-up"),
          new AIMessage("new reply")
        ]
        const value = checkpoint(raw, 2)
        value.channel_values._summarizationEvent = {
          cutoffIndex: 2,
          summaryMessage: buildSummaryMessage(summary, source, initial),
          filePath: source
        }
        const middleware = createCmbSummarizationMiddleware({
          model: { invoke: async () => new AIMessage(summary) } as never,
          backend: { write: async () => ({ error: "archive append failed" }) } as never,
          trigger: { type: "messages", value: 3 },
          keep: { type: "messages", value: 1 }
        }) as unknown as {
          wrapModelCall: (
            request: unknown,
            handler: () => Promise<AIMessage>
          ) => Promise<{ update: { _summarizationEvent: unknown } }>
        }
        const messages = [...raw, new HumanMessage("continue")]
        const result = await middleware.wrapModelCall(
          { messages, state: { ...value.channel_values, messages }, tools: [] },
          async () => new AIMessage("done")
        )
        const native = SummarizationEventSchema.parse(result.update._summarizationEvent)
        expect(native.filePath).toBe(source)
        expect(native.archiveIncomplete).toBe(true)
        const currentArchive = hasPointer ? join(directory, "managed", "session_old.md") : null
        value.channel_values.messages = messages
        value.channel_values._summarizationEvent = {
          ...native,
          filePath: currentArchive,
          summaryMessage: buildSummaryMessage(
            summary,
            currentArchive,
            initial,
            native.archiveIncomplete
          )
        }
        await inheritForkSummarization({
          checkpoint: value,
          persistedMessageCount: messages.length,
          readSourceArchiveDirectories: async () => [directory]
        })
        const inherited = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
        expect(inherited.summaryMessage.content).not.toContain(pathToFileURL(source).href)
        expect(inherited.summaryMessage.content).toContain(
          "[detail]([fork history archive unavailable])"
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each([false, true])(
    "fits retained tool arguments with legacy function call=%s",
    async (legacy) => {
      const args = { file: "report.txt", payload: "x".repeat(60_000) }
      const name = "mcp__report__save"
      const call = new AIMessage(
        legacy
          ? {
              content: "",
              additional_kwargs: { function_call: { name, arguments: JSON.stringify(args) } }
            }
          : { content: "", tool_calls: [{ id: "large-mcp-call", name, args }] }
      )
      const result = legacy
        ? new FunctionMessage({ name, content: "report saved" })
        : new ToolMessage({ content: "report saved", tool_call_id: "large-mcp-call" })
      const raw = [
        new HumanMessage("original"),
        new AIMessage("first answer"),
        new HumanMessage("save the report"),
        call,
        result,
        new AIMessage("the report is ready")
      ]
      const value = checkpoint(raw, 2)
      await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
      const invoke = vi.fn(async (messages: BaseMessage[]) => {
        const input = messages.map((message) => String(message.content)).join("\n")
        if (input.length > 8_000) throw new Error("maximum context length")
        expect(input).toContain(legacy ? "function_call" : "large-mcp-call")
        expect(input).toContain("report.txt")
        expect(input).toContain("report saved")
        return new AIMessage("Earlier decisions and report preserved")
      })
      const write = vi.fn(async (path: string, content: string) => ({ path, content }))
      const middleware = createCmbSummarizationMiddleware({
        model: { invoke } as never,
        backend: { write } as never,
        summaryModelInputBudgetTokens: 8_000,
        maxInputTokens: 8_000,
        trigger: { type: "messages", value: 3 },
        keep: { type: "messages", value: 2 }
      }) as unknown as {
        wrapModelCall: (request: unknown, handler: () => Promise<AIMessage>) => Promise<unknown>
      }
      const messages = [...raw, new HumanMessage("continue")]
      await middleware.wrapModelCall(
        { messages, state: { ...value.channel_values, messages }, tools: [] },
        async () => new AIMessage("done")
      )
      expect(invoke).toHaveBeenCalled()
      if (legacy) {
        expect(call.additional_kwargs.function_call?.arguments.includes(args.payload)).toBe(true)
      } else {
        expect(call.tool_calls?.[0]?.args.payload).toHaveLength(60_000)
      }
      expect(write.mock.calls[0]?.[1].includes(args.payload)).toBe(true)
    }
  )

  it("fits the bounded shortening request after whole-conversation compaction in a fork", async () => {
    const raw = [new HumanMessage("original request"), new AIMessage("original reply")]
    const value = checkpoint(raw, 2)
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const messages = [
      ...raw,
      new HumanMessage("follow-up"),
      new AIMessage("answer"),
      new HumanMessage("continue")
    ]
    const oversized = "FIRST_DECISION\n" + "history fact ".repeat(1_000) + "\nLAST_DECISION"
    let requests = 0
    const invoke = vi.fn(async (request: BaseMessage[]) => {
      const input = request.map((message) => String(message.content)).join("\n")
      if (input.length > 8_000) throw new Error("maximum context length")
      requests += 1
      if (requests < 3) return new AIMessage(oversized)
      expect(input).toContain("previous whole-conversation handoff is still too large")
      expect(input).toContain("FIRST_DECISION")
      expect(input).toContain("LAST_DECISION")
      return new AIMessage("Shortened final handoff")
    })
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write: vi.fn(async () => ({ error: "test archive is unavailable" })) } as never,
      summaryModelInputBudgetTokens: 2_000,
      postCompactionInputBudgetTokens: 1_500,
      maxInputTokens: 8_000,
      trigger: { type: "messages", value: 3 },
      keep: { type: "messages", value: 1 }
    }) as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
      ) => Promise<unknown>
    }
    const handler = vi.fn(async (request: { messages: BaseMessage[] }) => {
      expect(request.messages).toHaveLength(1)
      expect(request.messages[0].content).toContain("Shortened final handoff")
      return new AIMessage("done")
    })
    await middleware.wrapModelCall(
      { messages, state: { ...value.channel_values, messages }, tools: [] },
      handler
    )
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(handler).toHaveBeenCalledOnce()
  })

  it("shortens an inherited handoff after a below-trigger provider overflow", async () => {
    const raw = [new HumanMessage("original request"), new AIMessage("original reply")]
    const value = checkpoint(raw, 2)
    value.channel_values._summarizationEvent = {
      cutoffIndex: 2,
      summaryMessage: buildSummaryMessage("Inherited decision: " + "x".repeat(4_800), null, null),
      filePath: null
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const fresh = new HumanMessage("continue the work")
    const messages = [...raw, fresh]
    const systemMessage = new SystemMessage("s".repeat(13_500))
    const invoke = vi.fn(async () => new AIMessage("Inherited decision preserved"))
    const write = vi.fn()
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write } as never,
      maxInputTokens: 32_000,
      postCompactionInputBudgetTokens: 24_000,
      trigger: { type: "tokens", value: 24_000 },
      keep: { type: "tokens", value: 3_200 }
    }) as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { messages: BaseMessage[]; systemMessage: SystemMessage }) => Promise<AIMessage>
      ) => Promise<unknown>
    }
    const handler = vi.fn(async (request: { messages: BaseMessage[]; systemMessage: SystemMessage }) => {
      expect(request.systemMessage).toBe(systemMessage)
      expect(request.messages.slice(1)).toEqual([fresh])
      const bytes = String(request.systemMessage.content).length +
        request.messages.reduce((total, message) => total + String(message.content).length, 0)
      if (bytes > 16_000) throw new Error("maximum context length")
      expect(request.messages[0].content).toContain("Inherited decision preserved")
      return new AIMessage("done")
    })
    await middleware.wrapModelCall({
      messages,
      systemMessage,
      state: { ...value.channel_values, messages },
      tools: []
    }, handler)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  it.each([false, true])("compacts an overflowing fork tail (whole summary overflows: %s)", async (
    wholeOverflow
  ) => {
    const raw = [
      new HumanMessage("original request"),
      new AIMessage("covered history ".repeat(400) + "COVERED_ONLY")
    ]
    const value = checkpoint(raw, raw.length)
    value.channel_values._summarizationEvent = {
      cutoffIndex: raw.length,
      summaryMessage: buildSummaryMessage("Inherited decision: " + "x".repeat(4_800), null, null),
      filePath: null
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const recent = new AIMessage("RECENT_EVIDENCE " + "界".repeat(2_000))
    const latest = new HumanMessage("continue this work")
    const messages = [...raw, new HumanMessage("review evidence"), recent, latest]
    const systemMessage = new SystemMessage("界".repeat(14_500))
    const invoke = vi.fn(async (request: BaseMessage[]) => {
      const prompt = String(request[1].content)
      expect(prompt).toContain("Inherited decision")
      expect(prompt).not.toContain("COVERED_ONLY")
      if (prompt.includes("RECENT_EVIDENCE")) {
        if (prompt.includes("continue this work")) {
          return new AIMessage(
            "Inherited decision and RECENT_EVIDENCE" + (wholeOverflow ? "界".repeat(1_600) : "")
          )
        }
        return new AIMessage("Inherited decision and RECENT_EVIDENCE")
      }
      return new AIMessage("Inherited decision")
    })
    const write = vi.fn(async () => ({}))
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write } as never,
      maxInputTokens: 32_000,
      postCompactionInputBudgetTokens: 27_000,
      trigger: { type: "tokens", value: 24_000 },
      keep: { type: "tokens", value: 3_200 }
    }) as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
      ) => Promise<{ update: { _summarizationEvent: unknown } }>
    }
    const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
      if (estimateCjkProviderTokens([systemMessage, ...messages]) > 16_000) {
        throw new Error("maximum context length is 16000 tokens")
      }
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toContain("Inherited decision and RECENT_EVIDENCE")
      return new AIMessage("done")
    })
    const result = await middleware.wrapModelCall({
      messages, systemMessage, state: { ...value.channel_values, messages }, tools: []
    }, handler)
    const event = SummarizationEventSchema.parse(result.update._summarizationEvent)
    expect(event.cutoffIndex).toBe(messages.length)
    expect(event.usageStartIndex).toBe(messages.length)
    expect(invoke).toHaveBeenCalledTimes(wholeOverflow ? 4 : 3)
    expect(write).toHaveBeenCalledOnce()
  })

  it.each([1_200, 1_250])(
    "reuses the accepted %s-character recovery budget when the fork's raw tail also overflows",
    async (summaryLimit) => {
      const raw = [new HumanMessage("original request"), new AIMessage("original answer")]
      const value = checkpoint(raw, raw.length)
      value.channel_values._summarizationEvent = {
        cutoffIndex: raw.length,
        filePath: null,
        summaryMessage: buildSummaryMessage("界".repeat(30_000), null, null)
      }
      await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
      const messages = [
        ...raw,
        new HumanMessage("review evidence"),
        new AIMessage("界".repeat(1_000)),
        new HumanMessage("Continue")
      ]
      const systemMessage = new SystemMessage("界".repeat(15_400))
      const invoke = vi.fn(async (request: BaseMessage[]) => {
        const length = request.reduce((total, message) => total + String(message.content).length, 0)
        if (length > summaryLimit) throw new Error("maximum context length")
        return new AIMessage("Earlier decision and next step")
      })
      const middleware = createCmbSummarizationMiddleware({
        model: { invoke } as never,
        backend: { write: vi.fn(async () => ({})) } as never,
        maxInputTokens: 32_000,
        postCompactionInputBudgetTokens: 27_000,
        trigger: { type: "tokens", value: 500 },
        keep: { type: "tokens", value: 3_200 }
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
        ) => Promise<{ update: { _summarizationEvent: unknown } }>
      }
      const result = await middleware.wrapModelCall({
        messages, systemMessage, state: { ...value.channel_values, messages }, tools: []
      }, async ({ messages }) => {
        if (estimateCjkProviderTokens([systemMessage, ...messages]) > 16_000) {
          throw new Error("maximum context length")
        }
        expect(messages).toHaveLength(1)
        expect(messages[0].content).toContain("Earlier decision and next step")
        return new AIMessage("done")
      })
      expect(SummarizationEventSchema.parse(result.update._summarizationEvent).cutoffIndex)
        .toBe(messages.length)
      expect(invoke).toHaveBeenCalledTimes(5)
    }
  )

  it("keeps the gateway recovery model when a fork must compact its raw tail", async () => {
    const raw = [
      new HumanMessage("original request"),
      new AIMessage("domain evidence ".repeat(750) + "COVERED_ONLY")
    ]
    const value = checkpoint(raw, raw.length)
    value.channel_values._summarizationEvent = {
      cutoffIndex: raw.length,
      filePath: null,
      summaryMessage: buildSummaryMessage("Inherited decision: " + "界".repeat(18_400), null, null)
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const messages = [
      ...raw,
      new HumanMessage("review evidence"),
      new AIMessage("RECENT_EVIDENCE " + "界".repeat(1_000)),
      new HumanMessage("continue this work")
    ]
    const systemMessage = new SystemMessage("界".repeat(3_400))
    const overflow = () => Object.assign(new Error("任务上下文超过最大限度"), { status: 485 })
    const modelWithReserve = (reserve: number) => vi.fn(async (request: BaseMessage[]) => {
      if (estimateCjkProviderTokens(request) + reserve > 8_000) throw overflow()
      return new AIMessage("Inherited decision and RECENT_EVIDENCE")
    })
    const invoke = modelWithReserve(4_000)
    const recover = modelWithReserve(1_024)
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      overflowModel: { invoke: recover } as never,
      backend: { write: vi.fn(async () => ({})) } as never,
      maxInputTokens: 128_000,
      summaryModelInputBudgetTokens: 123_000,
      postCompactionInputBudgetTokens: 123_000,
      trimTokensToSummarize: 83_200,
      summaryMaxOutputTokens: 4_000,
      overflowMaxOutputTokens: 1_024,
      trigger: { type: "tokens", value: 96_000 },
      keep: { type: "tokens", value: 12_000 }
    }) as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
      ) => Promise<{ update: { _summarizationEvent: unknown } }>
    }
    const result = await middleware.wrapModelCall({
      messages, systemMessage, state: { ...value.channel_values, messages }, tools: []
    }, async ({ messages }) => {
      if (estimateCjkProviderTokens([systemMessage, ...messages]) + 4_000 > 8_000) throw overflow()
      expect(messages).toHaveLength(1)
      return new AIMessage("done")
    })
    expect(SummarizationEventSchema.parse(result.update._summarizationEvent).cutoffIndex)
      .toBe(messages.length)
    expect(invoke).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledTimes(3)
    const lastRequest = recover.mock.calls.at(-1)![0]
    expect(lastRequest[1].content).toContain("RECENT_EVIDENCE")
    expect(lastRequest[1].content).toContain("Inherited decision")
    expect(lastRequest[1].content).not.toContain("COVERED_ONLY")
    expect(summaryRequestBytes(lastRequest)).toBeLessThanOrEqual(
      summaryRequestBytes(recover.mock.calls[1][0])
    )
  })

  it.each([
    { first: "decision ".repeat(700), whole: "decision ".repeat(280), budget: 7_000, limit: 250 },
    { first: "decision ".repeat(1_200), whole: "界".repeat(3_400), budget: 2_300, limit: 3_300 }
  ])("shortens a whole-conversation handoff rejected by the provider with budget $budget", async (
    { first, whole, budget, limit }
  ) => {
    const raw = [new HumanMessage("original request"), new AIMessage("original reply")]
    const value = checkpoint(raw, 2)
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const messages = [...raw, new HumanMessage("follow-up"), new AIMessage("answer"), new HumanMessage("continue")]
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage(first))
      .mockResolvedValueOnce(new AIMessage(whole))
      .mockResolvedValueOnce(new AIMessage("Earlier decision preserved"))
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write: vi.fn(async () => ({ error: "archive unavailable" })) } as never,
      summaryModelInputBudgetTokens: 6_000,
      postCompactionInputBudgetTokens: budget,
      maxInputTokens: 8_000,
      trigger: { type: "messages", value: 3 },
      keep: { type: "messages", value: 1 }
    }) as unknown as {
      wrapModelCall: (request: unknown, handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>) => Promise<unknown>
    }
    const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
      if (estimateCjkProviderTokens(messages) > limit) throw new Error("maximum context length")
      expect(messages[0].content).toContain("Earlier decision preserved")
      return new AIMessage("done")
    })
    await middleware.wrapModelCall({ messages, state: { ...value.channel_values, messages }, tools: [] }, handler)
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(handler).toHaveBeenCalledTimes(budget === 7_000 ? 3 : 2)
  })

  it("fits historical anchors inside the inherited summarizer budget", async () => {
    const anchor = "界".repeat(3_000)
    const raw = [new HumanMessage(anchor), new AIMessage("original reply")]
    const value = checkpoint(raw, 2)
    value.channel_values._summarizationEvent = {
      cutoffIndex: 2,
      summaryMessage: buildSummaryMessage("prior decision", null, anchor),
      filePath: null
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const messages = [...raw, new AIMessage("old turn ".repeat(800)), new HumanMessage("continue")]
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      if (estimateCjkProviderTokens(messages) > 3_300) throw new Error("maximum context length")
      const prompt = messages.map((message) => String(message.content)).join("\n")
      expect(prompt).toContain("[initial user request middle truncated]")
      expect(prompt).not.toContain(anchor)
      return new AIMessage("Earlier decision preserved")
    })
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write: vi.fn(async () => ({ error: "archive unavailable" })) } as never,
      summaryModelInputBudgetTokens: 2_300,
      postCompactionInputBudgetTokens: 2_300,
      maxInputTokens: 8_000,
      trigger: { type: "messages", value: 3 },
      keep: { type: "tokens", value: 800 }
    }) as unknown as {
      wrapModelCall: (request: unknown, handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>) => Promise<unknown>
    }
    const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
      expect(estimateCjkProviderTokens(messages)).toBeLessThanOrEqual(3_300)
      expect(messages[0].content).toContain(anchor)
      return new AIMessage("done")
    })
    await middleware.wrapModelCall({ messages, state: { ...value.channel_values, messages }, tools: [] }, handler)
    expect(invoke).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each([
    { tight: false, whole: false, fixedCjk: false },
    { tight: true, whole: false, fixedCjk: false },
    { tight: true, whole: true, fixedCjk: false },
    { tight: true, whole: false, fixedCjk: true },
    { tight: true, whole: true, fixedCjk: true }
  ])("fits the outer historical anchor (tight=$tight, whole=$whole, CJK system=$fixedCjk)", async (
    { tight, whole, fixedCjk }
  ) => {
    const anchor = "界".repeat(3_000)
    const raw = [new HumanMessage(anchor), new AIMessage("original reply")]
    const value = checkpoint(raw, 2)
    value.channel_values._summarizationEvent = {
      cutoffIndex: 2,
      summaryMessage: buildSummaryMessage("界".repeat(2_000), null, anchor),
      filePath: null
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: raw.length })
    const fresh = new HumanMessage("continue this task")
    const followups = whole
      ? [new HumanMessage("retained " + "r".repeat(2_000)), new AIMessage("earlier reply")]
      : []
    const messages = [...raw, ...followups, fresh]
    const systemMessage = new SystemMessage(fixedCjk
      ? "界".repeat(whole ? 2_500 : 3_100)
      : "s".repeat(tight ? 9_775 : 1_800))
    const invoke = vi.fn(async () => new AIMessage("Keep the prior decision"))
    if (fixedCjk && whole) {
      invoke.mockResolvedValueOnce(new AIMessage("界".repeat(1_700)))
        .mockResolvedValueOnce(new AIMessage("界".repeat(1_700)))
    }
    const write = vi.fn(async () => ({ error: "archive unavailable" }))
    const inputBudget = fixedCjk ? 2_584 : tight ? 2_800 : 2_300
    const middleware = createCmbSummarizationMiddleware({
      model: { invoke } as never,
      backend: { write } as never,
      summaryModelInputBudgetTokens: inputBudget,
      postCompactionInputBudgetTokens: inputBudget,
      maxInputTokens: tight ? 4_096 : 8_000,
      trigger: { type: "messages", value: 3 },
      keep: { type: "messages", value: 1 }
    }) as unknown as {
      wrapModelCall: (request: unknown, handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>) =>
        Promise<{ update: { _summarizationEvent: unknown } }>
    }
    const handler = vi.fn(async ({ messages }: { messages: BaseMessage[] }) => {
      if (!whole) expect(messages.slice(1)).toEqual([fresh])
      if (estimateCjkProviderTokens([systemMessage, ...messages]) > (fixedCjk ? 3_584 : tight ? 3_500 : 3_300)) {
        throw new Error("maximum context length")
      }
      if (fixedCjk) expect(messages[0].content).not.toContain("<initial-user-request>")
      else expect(messages[0].content).toContain("[initial user request middle truncated]")
      expect(messages[0].content).toContain("Keep the prior decision")
      return new AIMessage("done")
    })
    const result = await middleware.wrapModelCall({
      messages, systemMessage, state: { ...value.channel_values, messages }, tools: []
    }, handler)
    const event = SummarizationEventSchema.parse(result.update._summarizationEvent)
    expect(event.summaryMessage.additional_kwargs[INITIAL_USER_REQUEST_KEY]).toBe(anchor)
    expect(event.summaryMessage.content).not.toContain(anchor)
    expect(event.cutoffIndex).toBe(whole ? messages.length : 2)
    expect(handler.mock.calls.length).toBeLessThanOrEqual(4)
    expect(invoke.mock.calls.length).toBeLessThanOrEqual(3)
    if (!whole) expect(write).not.toHaveBeenCalled()
    if (fixedCjk) {
      value.channel_values.messages = messages
      value.channel_values._summarizationEvent = event
      await inheritForkSummarization({ checkpoint: value, persistedMessageCount: messages.length })
      const nested = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      expect(nested.summaryMessage.content).toContain("Keep the prior decision")
      expect(nested.summaryMessage.content).not.toContain("<initial-user-request>")
      expect(nested.summaryMessage.additional_kwargs[INITIAL_USER_REQUEST_KEY]).toBe(anchor)
    }
  })

  it.each([
    { archived: false, oldFormat: false },
    { archived: true, oldFormat: false },
    { archived: false, oldFormat: true },
    { archived: true, oldFormat: true }
  ])("inherits a shortened prompt on nested fork (archive=$archived, old format=$oldFormat)", async (
    { archived, oldFormat }
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "nested-fork-prompt-anchor-"))
    try {
      const source = archived ? join(directory, "session_old.md") : null
      const original = `Keep the project in focus. ${source ?? ""}\n` + "界".repeat(2_500)
      const visible = shortenInitialPromptAnchor(original)!
      const body = "Selected handoff with exact prior decisions"
      const raw = [new HumanMessage(original), new AIMessage("original response")]
      const value = checkpoint(raw, 2)
      const generated = buildSummaryMessage(body, source, original, false, visible)
      value.channel_values._summarizationEvent = {
        cutoffIndex: 2,
        filePath: source,
        usageStartIndex: 2,
        summaryMessage: oldFormat ? new HumanMessage({
          content: generated.content,
          additional_kwargs: { lc_source: "summarization", [INITIAL_USER_REQUEST_KEY]: original }
        }) : generated
      }
      await inheritForkSummarization({
        checkpoint: value,
        persistedMessageCount: raw.length,
        ...(archived && { archiveTarget: { workspacePath: directory, threadId: "nested-child" } })
      })
      const event = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      expect(event.cutoffIndex).toBe(2)
      if (source) {
        expect(event.filePath).toBeTruthy()
        expect(event.filePath).not.toBe(source)
      } else {
        expect(event.filePath).toBeNull()
      }
      const rebase = (text: string) => source && event.filePath ? text.replace(source, event.filePath) : text
      const expected = buildSummaryMessage(body, event.filePath, rebase(original), false, rebase(visible))
      expect(event.summaryMessage.content).toBe(expected.content)
      expect(event.summaryMessage.additional_kwargs[INITIAL_USER_REQUEST_KEY]).toBe(rebase(original))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("does not let a replayed durable tail validate a bad saved cutoff", async () => {
    const value = checkpoint([new HumanMessage("raw"), new AIMessage("replayed answer")], 2)
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: 1 })
    expect(value.channel_values._summarizationEvent).toBeUndefined()
    expect(value.channel_values._summarizationSessionId).toBeUndefined()
  })

  it("rejects an event that would orphan a retained tool result", async () => {
    const value = checkpoint(
      [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call-id", name: "read", args: {} }]
        }),
        new ToolMessage({ content: "result", tool_call_id: "call-id" })
      ],
      1
    )
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: 2 })
    expect(value.channel_values._summarizationEvent).toBeUndefined()
  })

  it("retains an older unlinked summary with a stale archive path", async () => {
    const value = checkpoint([new HumanMessage("raw"), new AIMessage("answer")], 1)
    value.channel_values._summarizationEvent = {
      cutoffIndex: 1,
      summaryMessage: new HumanMessage({
        content: "Here is a summary of the conversation to date:\n\nLEGACY_BODY",
        additional_kwargs: { lc_source: "summarization" }
      }),
      filePath: SOURCE_PATH
    }
    await inheritForkSummarization({ checkpoint: value, persistedMessageCount: 2 })
    const event = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
    expect(event.summaryMessage.content).toContain("LEGACY_BODY")
    expect(event.summaryMessage.content).not.toContain(SOURCE_PATH)
    expect(event.filePath).toBeNull()
  })

  it.each([
    "missing workspace",
    "write failure",
    "archive byte limit",
    "large file resource",
    "XML escape expansion",
    "large tool arguments"
  ] as const)("keeps the summary and records a partial archive after %s", async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), "fork-summary-fallback-"))
    try {
      const blockedDirectory = join(directory, "not-a-directory")
      await writeFile(blockedDirectory, "blocked")
      const prefix: BaseMessage[] = []
      if (reason === "archive byte limit") {
        prefix.push(...Array.from({ length: 30 }, () => new HumanMessage("界".repeat(100_000))))
      } else if (reason === "large file resource") {
        prefix.push(
          new HumanMessage({
            content: [{ type: "file", source_type: "text", text: "x".repeat(1_000_000) }]
          })
        )
      } else if (reason === "XML escape expansion") {
        prefix.push(new HumanMessage("&".repeat(120_000)))
      } else if (reason === "large tool arguments") {
        prefix.push(
          new AIMessage({
            content: "",
            tool_calls: [
              { name: "write_file", args: { body: "x".repeat(1_000_000) }, id: "call-1" }
            ]
          })
        )
      } else {
        prefix.push(new HumanMessage("old input"))
      }
      const messages = [
        ...prefix,
        new AIMessage("old output"),
        new HumanMessage("retained input"),
        new AIMessage("retained output")
      ]
      const value = checkpoint(messages, messages.length - 2)
      await inheritForkSummarization({
        checkpoint: value,
        persistedMessageCount: messages.length,
        ...(reason !== "missing workspace" && {
          archiveTarget: {
            threadId: "forked-thread",
            workspacePath: reason === "write failure" ? blockedDirectory : directory
          }
        })
      })
      expect(await readdir(directory)).toEqual(["not-a-directory"])
      const event = SummarizationEventSchema.parse(value.channel_values._summarizationEvent)
      expect(event.filePath).toBeNull()
      expect(event.archiveIncomplete).toBe(true)
      expect(event.summaryMessage.content).toContain("completed prior work")
      expect(event.summaryMessage.content).not.toContain(SOURCE_PATH)

      const laterArchive = vi.fn(async (path: string, content: string) => ({ path, content }))
      const next = new HumanMessage("new request")
      const middleware = createCmbSummarizationMiddleware({
        model: { invoke: async () => new AIMessage("updated handoff") } as never,
        backend: { write: laterArchive } as never,
        trigger: { type: "messages", value: 2 },
        keep: { type: "messages", value: 1 }
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: { messages: BaseMessage[] }) => Promise<AIMessage>
        ) => Promise<{ update: { _summarizationEvent: unknown } }>
      }
      const result = await middleware.wrapModelCall(
        { messages: [...messages, next], state: value.channel_values, tools: [] },
        async (request) => {
          expect(request.messages[0].content).toContain("partial text transcript")
          return new AIMessage("done")
        }
      )
      const updated = SummarizationEventSchema.parse(result.update._summarizationEvent)
      expect(updated.archiveIncomplete).toBe(true)
      expect(updated.usageStartIndex).toBeGreaterThanOrEqual(messages.length)
      expect(laterArchive.mock.calls[0][1]).toContain("retained input")
      expect(laterArchive.mock.calls[0][1]).not.toContain("old output")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
