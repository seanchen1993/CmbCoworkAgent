import { describe, expect, it } from "vitest"
import {
  extractReasoningText,
  extractVisibleReasoning,
  isTraceReasoningTruncated,
  mergeStreamingReasoning,
  TRACE_REASONING_MAX_CHARS,
  truncateReasoningForTrace
} from "./model-reasoning"

describe("model reasoning extraction", () => {
  it("extracts provider-visible reasoning across serialized message shapes", () => {
    expect(
      extractVisibleReasoning({
        kwargs: {
          additional_kwargs: {
            reasoning_details: [{ type: "summary", text: "先检查依赖" }, { text: "再执行修改" }]
          }
        }
      })
    ).toBe("先检查依赖再执行修改")
  })

  it("falls through empty reasoning fields to the next explicit field", () => {
    expect(
      extractVisibleReasoning({
        reasoning: "",
        additional_kwargs: { reasoning_content: "显式思考摘要" }
      })
    ).toBe("显式思考摘要")
  })

  it("prefers a direct provider reasoning field over nested fallback fields", () => {
    expect(
      extractVisibleReasoning({
        summary: "direct summary",
        additional_kwargs: { reasoning_content: "nested fallback" }
      })
    ).toBe("direct summary")
  })

  it("never treats ordinary assistant content as reasoning", () => {
    expect(extractVisibleReasoning({ content: "这是最终回答" })).toBe("")
    expect(extractReasoningText({ content: "reasoning payload content" })).toBe(
      "reasoning payload content"
    )
  })

  it("stays telemetry-safe when a provider object has a throwing getter", () => {
    const message: Record<string, unknown> = {}
    Object.defineProperty(message, "reasoning", {
      enumerable: true,
      get() {
        throw new Error("broken provider payload")
      }
    })
    expect(extractVisibleReasoning(message)).toBe("")
  })

  it("merges both reasoning deltas and cumulative snapshots without duplication", () => {
    expect(mergeStreamingReasoning("先检查", "先检查依赖")).toBe("先检查依赖")
    expect(mergeStreamingReasoning("先检查依赖", "依赖后修改")).toBe("先检查依赖后修改")
    expect(mergeStreamingReasoning("先检查依赖", "依赖")).toBe("先检查依赖")
  })

  it("bounds trace reasoning and marks the truncated value", () => {
    const extracted = extractVisibleReasoning(
      { reasoning: "r".repeat(5000) },
      TRACE_REASONING_MAX_CHARS + 1
    )
    const result = truncateReasoningForTrace(extracted)
    expect(extracted).toHaveLength(TRACE_REASONING_MAX_CHARS + 1)
    expect(result).toHaveLength(TRACE_REASONING_MAX_CHARS)
    expect(isTraceReasoningTruncated(result)).toBe(true)
  })
})
