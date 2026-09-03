import { describe, expect, it } from "vitest"
import {
  classifyApiError,
  extractErrorDetail,
  isEmptyModelResponseError,
  isResumableStreamFailure,
  isRetryableApiError
} from "./failover"

// The exact sentence LangChain's BaseChatModel throws when a streaming call
// aggregated no chunk at all (see @langchain/core chat_models: `aggregated ===
// undefined`). Kept verbatim so a wording change upstream fails this test
// rather than silently disabling the retry.
const LANGCHAIN_EMPTY = "Received empty response from chat model call."

describe("empty model response", () => {
  it("recognises the LangChain empty-response error", () => {
    expect(isEmptyModelResponseError(new Error(LANGCHAIN_EMPTY))).toBe(true)
  })

  it("recognises it through a wrapper's cause chain", () => {
    const wrapped = new Error("graph execution failed", {
      cause: new Error(LANGCHAIN_EMPTY)
    })
    expect(isEmptyModelResponseError(wrapped)).toBe(true)
  })

  it("is retryable, so an exhausted retry budget still reaches model failover", () => {
    expect(isRetryableApiError(new Error(LANGCHAIN_EMPTY))).toBe(true)
  })

  it("is resumable, so the retry runs from the checkpoint rather than the whole turn", () => {
    expect(isResumableStreamFailure(new Error(LANGCHAIN_EMPTY))).toBe(true)
  })

  it("gets its own bucket instead of being lumped in with network errors", () => {
    expect(classifyApiError(new Error(LANGCHAIN_EMPTY))).toBe("empty_response")
  })

  it("reports an actionable detail instead of unknown", () => {
    const detail = extractErrorDetail(new Error(LANGCHAIN_EMPTY))
    expect(detail.code).toBe("empty_response")
    expect(detail.statusLabel).toBe("模型返回空响应")
    expect(detail.reason).toContain("没有任何可用内容")
  })

  it("never overrides user cancellation", () => {
    // A provider can surface a cancelled turn wrapped in an empty-looking error.
    // Retrying that would restart work the user just stopped.
    const cancelled = new Error(LANGCHAIN_EMPTY, {
      cause: Object.assign(new Error("aborted"), { name: "AbortError" })
    })
    expect(isEmptyModelResponseError(cancelled)).toBe(false)
    expect(isRetryableApiError(cancelled)).toBe(false)
  })

  it("does not reclassify tool output that merely quotes the sentence", () => {
    // classifyApiError also runs over arbitrary tool results (hooks/tool-failure.ts),
    // which arrive as plain objects rather than Error instances.
    expect(isEmptyModelResponseError({ message: LANGCHAIN_EMPTY })).toBe(false)
    expect(classifyApiError({ message: LANGCHAIN_EMPTY } as Error)).toBe("unknown")
  })

  it("leaves a normal finished turn alone", () => {
    // LangChain only throws when nothing aggregated; a turn that ended with a
    // legitimate empty message and a stop reason never reaches this path.
    expect(isEmptyModelResponseError(new Error("stop"))).toBe(false)
    expect(isResumableStreamFailure(new Error("stop"))).toBe(false)
  })
})
