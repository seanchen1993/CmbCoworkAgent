import { describe, expect, it } from "vitest"
import type { UserInputRequest } from "@/types"
import type { BotGroupMessage } from "../../../shared/bots/contracts"
import { CHAT_SEARCH_INPUT_LIMIT } from "../../../shared/chat-search-plan"
import { CHAT_SEARCH_RESULT_LIMIT } from "@/components/chat/ChatSearchOverlay"
import {
  botGroupPendingSearchDocument,
  botGroupSearchDocument,
  botGroupSearchPage
} from "./bot-group-search"
import { findChatSearchMatches, type ChatSearchDocument } from "./chat-search-matches"

const request: UserInputRequest = {
  requestId: "request-public",
  threadId: "private-thread-hidden",
  createdAt: "2026-10-22T00:00:00Z",
  questions: [
    {
      id: "format-hidden-id",
      header: "hidden-header",
      question: "PUBLIC_QUESTION：交付哪种格式？",
      options: [
        { label: "PUBLIC_OPTION", description: "PUBLIC_DESCRIPTION" },
        { label: "其他", description: "HIDDEN_FREEFORM_PLACEHOLDER" }
      ]
    }
  ]
}

const row = (overrides: Partial<BotGroupMessage> = {}): BotGroupMessage => ({
  id: "message-1",
  ordinal: 17,
  groupId: "group-hidden-id",
  authorBotId: "bot-hidden-id",
  text: "PUBLIC_BODY",
  createdAt: 1_792_620_000_000,
  ...overrides
})

const hits = (document: ChatSearchDocument | null, query: string) =>
  findChatSearchMatches(document ? [document] : [], query)

const questionRow = (question: Partial<NonNullable<BotGroupMessage["question"]>> = {}) =>
  row({
    text: "",
    question: { taskId: "task-hidden", request, state: "waiting_user", ...question }
  })

describe("public Bot group search projection", () => {
  it("indexes visible Markdown while excluding reasoning, quote and peer identity", () => {
    const document = botGroupSearchDocument(
      row({
        text: "<think>HIDDEN_THINK /private/tool-path</think>\n**PUBLIC_BODY**",
        replyTo: { id: "quote-id", ordinal: 3, authorBotId: null, text: "HIDDEN_QUOTE" },
        exchange: { taskId: "HIDDEN_EXCHANGE", botId: "peer-hidden-id" }
      })
    )
    expect(hits(document, "public_body")).toHaveLength(1)
    for (const hidden of [
      "HIDDEN_THINK",
      "/private/tool-path",
      "HIDDEN_QUOTE",
      "HIDDEN_EXCHANGE",
      "peer-hidden-id",
      "bot-hidden-id",
      "group-hidden-id"
    ])
      expect(hits(document, hidden)).toHaveLength(0)
    expect(document).toMatchObject({
      messageId: "message-1",
      sortIndex: 17,
      durableAuthoritative: true
    })
  })

  it("uses the existing attachment display but never indexes hidden bytes or file-card metadata", () => {
    const document = botGroupSearchDocument(
      row({
        authorBotId: null,
        text: '<attachment filename="visible.csv" path="/private/hidden/path">HIDDEN_BYTES</attachment>\nPUBLIC_USER',
        files: [{ name: "HIDDEN_FILE_CARD.csv", filePath: "/private/file-card", size: 24 }]
      })
    )
    expect(hits(document, "PUBLIC_USER")).toHaveLength(1)
    expect(hits(document, "visible.csv")).toHaveLength(1)
    for (const hidden of [
      "HIDDEN_BYTES",
      "/private/hidden/path",
      "HIDDEN_FILE_CARD",
      "/private/file-card"
    ])
      expect(hits(document, hidden)).toHaveLength(0)
  })

  it("indexes an actual receipt answer once, with non-body control coordinates", () => {
    const document = botGroupSearchDocument(
      questionRow({
        state: "completed",
        result: {
          content: JSON.stringify({
            status: "submitted",
            answers: {
              "format-hidden-id": {
                type: "other",
                questionId: "format-hidden-id",
                text: "GENUINE_ANSWER"
              }
            },
            submittedAt: "2026-10-22T00:01:00Z",
            internal: "HIDDEN_RECEIPT_METADATA"
          })
        }
      })
    )
    expect(hits(document, "PUBLIC_QUESTION")).toHaveLength(1)
    expect(hits(document, "GENUINE_ANSWER")).toHaveLength(1)
    expect(hits(document, "GENUINE_ANSWER")[0].location).toMatchObject({
      kind: "summary",
      blockIndex: -1
    })
    for (const hidden of [
      "PUBLIC_OPTION",
      "HIDDEN_RECEIPT_METADATA",
      "format-hidden-id",
      "private-thread-hidden"
    ])
      expect(hits(document, hidden)).toHaveLength(0)
  })

  it("never turns completed, default choices, malformed or error receipts into answers", () => {
    for (const question of [
      { state: "completed" as const },
      { state: "cancelled" as const },
      { state: "interrupted" as const },
      { state: "completed" as const, result: { content: "FAKE_ANSWER" } },
      { result: { content: JSON.stringify({ status: "submitted", answers: {} }) } },
      {
        result: {
          content: JSON.stringify({
            status: "ignored",
            answers: {
              "format-hidden-id": {
                type: "other",
                questionId: "format-hidden-id",
                text: "FAKE_ANSWER"
              }
            }
          })
        }
      },
      { result: { content: "FAKE_ANSWER", is_error: true } }
    ]) {
      const document = botGroupSearchDocument(questionRow(question))
      expect(hits(document, "PUBLIC_QUESTION")).toHaveLength(1)
      expect(hits(document, "FAKE_ANSWER")).toHaveLength(0)
      expect(hits(document, "PUBLIC_OPTION")).toHaveLength(0)
    }
  })

  it("includes actually displayed ignored options without indexing the freeform placeholder", () => {
    const document = botGroupSearchDocument(
      questionRow({
        result: { content: JSON.stringify({ status: "ignored", answers: {} }) }
      })
    )
    expect(hits(document, "PUBLIC_OPTION")).toHaveLength(1)
    expect(hits(document, "PUBLIC_DESCRIPTION")).toHaveLength(1)
    expect(hits(document, "HIDDEN_FREEFORM_PLACEHOLDER")).toHaveLength(0)
  })

  it("keeps pending card identity and searches its public question and options only", () => {
    const document = botGroupPendingSearchDocument(request, 122)
    expect(document).toMatchObject({
      messageId: "question-request-public",
      sortIndex: 122,
      durableAuthoritative: true
    })
    for (const visible of ["PUBLIC_QUESTION", "PUBLIC_OPTION", "PUBLIC_DESCRIPTION"])
      expect(hits(document, visible)).toHaveLength(1)
    for (const hidden of [
      "hidden-header",
      "format-hidden-id",
      "private-thread-hidden",
      "HIDDEN_FREEFORM_PLACEHOLDER"
    ])
      expect(hits(document, hidden)).toHaveLength(0)
  })

  it("uses the actual mounted pending card while running, without guessing from task state", () => {
    const message = questionRow({ state: "running" })
    expect(hits(botGroupSearchDocument(message, request), "PUBLIC_OPTION")).toHaveLength(1)
    expect(hits(botGroupSearchDocument(message), "PUBLIC_OPTION")).toHaveLength(0)
    expect(
      hits(
        botGroupSearchDocument(message, { ...request, requestId: "replacement" }),
        "PUBLIC_OPTION"
      )
    ).toHaveLength(0)
    const stopped = questionRow({ state: "cancelled" })
    expect(hits(botGroupSearchDocument(stopped, request), "PUBLIC_OPTION")).toHaveLength(0)
  })

  it("does not fabricate empty or reasoning-only documents and respects the original text budget", () => {
    expect(botGroupSearchDocument(row({ text: "" }))).toBeNull()
    expect(botGroupSearchDocument(row({ text: "<think>HIDDEN_UNFINISHED" }))).toBeNull()
    const huge = botGroupPendingSearchDocument(
      {
        ...request,
        questions: [{ ...request.questions[0], question: "x".repeat(CHAT_SEARCH_INPUT_LIMIT * 2) }]
      },
      1
    )!
    expect(huge.truncated).toBe(true)
    expect(huge.textUnits).toBeLessThanOrEqual(CHAT_SEARCH_INPUT_LIMIT)
    expect(
      huge.plan!.segments.reduce((sum, segment) => sum + segment.raw.length, 0)
    ).toBeLessThanOrEqual(CHAT_SEARCH_INPUT_LIMIT)
    const transport = botGroupSearchDocument(
      row({
        authorBotId: null,
        text: `<attachment filename="visible.csv">${"HIDDEN_BYTES".repeat(CHAT_SEARCH_INPUT_LIMIT)}</attachment>PUBLIC_TAIL`
      })
    )!
    expect(transport.truncated).toBe(true)
    expect(transport.textUnits).toBe(0)
    expect(hits(transport, "HIDDEN_BYTES")).toHaveLength(0)
  })
})

describe("Bot group durable search pages", () => {
  it("uses actual sparse page rows for the cursor even when only a later row matches", () => {
    const page = Array.from({ length: 50 }, (_, index) =>
      row({
        id: `m-${index}`,
        ordinal: 100 + index * 7,
        text: index === 32 ? "needle needle" : "body",
        authorBotId: index === 32 ? null : "bot",
        createdAt: 10_000 + index
      })
    )
    const matches = findChatSearchMatches(
      page.map((message) => botGroupSearchDocument(message)!),
      "needle"
    )
    const result = botGroupSearchPage(page, [
      ...matches,
      matches[0],
      {
        messageId: "unknown",
        occurrenceIndex: 0,
        sortIndex: -999
      }
    ])
    expect(result).toMatchObject({
      beforeOrdinal: 100,
      beforeMessageId: "m-0",
      hasMore: true,
      scanned: 50,
      truncated: false,
      matches: [
        { messageId: "m-32", ordinal: 324, role: "user", createdAt: 10_032, occurrenceCount: 2 }
      ]
    })
    expect(result.matches[0].locations).toHaveLength(2)
  })

  it("returns real newest-first author/time and public context, never hidden transport previews", () => {
    const first = row({ id: "old", ordinal: 9, text: "needle", createdAt: 70 })
    const last = row({ id: "new", ordinal: 400, authorBotId: null, text: "needle", createdAt: 80 })
    const matches = findChatSearchMatches(
      [botGroupSearchDocument(first)!, botGroupSearchDocument(last)!],
      "needle"
    )
    const result = botGroupSearchPage([last, first], matches)
    expect(
      result.matches.map(({ messageId, role, createdAt }) => ({ messageId, role, createdAt }))
    ).toEqual([
      { messageId: "new", role: "user", createdAt: 80 },
      { messageId: "old", role: "assistant", createdAt: 70 }
    ])
    expect(result.matches[0].preview).toBe("needle")
    expect(result.beforeMessageId).toBe("old")
    expect(result.hasMore).toBe(false)
  })

  it("keeps no-hit and empty cursors honest and never invents rows for unknown matches", () => {
    expect(botGroupSearchPage([], [{ messageId: "forged", occurrenceIndex: 0 }])).toEqual({
      matches: [],
      beforeOrdinal: null,
      beforeMessageId: null,
      hasMore: false,
      scanned: 0,
      truncated: false
    })
    expect(botGroupSearchPage([row()], [])).toMatchObject({
      matches: [],
      beforeOrdinal: 17,
      beforeMessageId: "message-1",
      scanned: 1,
      hasMore: false
    })
  })

  it("retains the original occurrence cap and propagates a genuinely truncated scan", () => {
    const message = row({ text: "needle ".repeat(CHAT_SEARCH_RESULT_LIMIT + 1) })
    const matches = findChatSearchMatches([botGroupSearchDocument(message)!], "needle")
    const result = botGroupSearchPage([message], matches)
    expect(result.truncated).toBe(true)
    expect(result.matches[0].occurrenceCount).toBe(CHAT_SEARCH_RESULT_LIMIT)
    expect(result.matches[0].locations).toHaveLength(CHAT_SEARCH_RESULT_LIMIT)
    expect(result.matches[0].preview.length).toBeLessThanOrEqual(240)
    expect(botGroupSearchPage([], [], true).truncated).toBe(true)
  })
})
