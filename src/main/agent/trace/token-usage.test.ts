import { describe, expect, it } from "vitest"
import { normalizeTraceTokenUsage, summarizeTraceCacheTokens } from "./token-usage"
import type { TraceModelCall } from "./types"

/** Shape emitted by @langchain/anthropic's buildUsageMetadata. */
function langchainUsage(args: {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}): Record<string, unknown> {
  return {
    input_tokens: args.input,
    output_tokens: args.output,
    total_tokens: args.input + args.output,
    input_token_details: {
      cache_read: args.cacheRead ?? 0,
      cache_creation: args.cacheCreation ?? 0
    }
  }
}

function call(tokenUsage: TraceModelCall["tokenUsage"]): TraceModelCall {
  return { tokenUsage } as TraceModelCall
}

describe("normalizeTraceTokenUsage", () => {
  it("reads cache counts from LangChain's nested input_token_details", () => {
    const usage = normalizeTraceTokenUsage(
      langchainUsage({ input: 120_000, output: 800, cacheRead: 100_000, cacheCreation: 5_000 })
    )
    expect(usage).toEqual({
      inputTokens: 120_000,
      outputTokens: 800,
      totalTokens: 120_800,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 5_000
    })
  })

  it("still reads the raw provider shape with top-level cache fields", () => {
    const usage = normalizeTraceTokenUsage({
      input_tokens: 900,
      output_tokens: 100,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 50
    })
    expect(usage?.cacheReadTokens).toBe(700)
    expect(usage?.cacheCreationTokens).toBe(50)
  })

  it("prefers the nested shape when both are present", () => {
    const usage = normalizeTraceTokenUsage({
      input_tokens: 900,
      cache_read_input_tokens: 1,
      input_token_details: { cache_read: 700 }
    })
    expect(usage?.cacheReadTokens).toBe(700)
  })

  it("accepts camelCase variants", () => {
    const usage = normalizeTraceTokenUsage({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 6
    })
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 6 })
  })

  it("returns undefined when no counter is usable", () => {
    expect(normalizeTraceTokenUsage(undefined)).toBeUndefined()
    expect(normalizeTraceTokenUsage(null)).toBeUndefined()
    expect(normalizeTraceTokenUsage({})).toBeUndefined()
    expect(normalizeTraceTokenUsage({ input_tokens: "900" })).toBeUndefined()
    expect(normalizeTraceTokenUsage([1, 2])).toBeUndefined()
  })

  it("keeps a zeroed cache detail rather than dropping it", () => {
    const usage = normalizeTraceTokenUsage(langchainUsage({ input: 5, output: 1 }))
    expect(usage?.cacheReadTokens).toBe(0)
    expect(usage?.cacheCreationTokens).toBe(0)
  })
})

describe("summarizeTraceCacheTokens", () => {
  it("splits input into cached and non-cached parts", () => {
    const summary = summarizeTraceCacheTokens([
      call({
        inputTokens: 120_000,
        outputTokens: 800,
        cacheReadTokens: 100_000,
        cacheCreationTokens: 5_000
      }),
      call({
        inputTokens: 60_000,
        outputTokens: 400,
        cacheReadTokens: 55_000,
        cacheCreationTokens: 0
      })
    ])
    expect(summary).toEqual({ cacheReadTokens: 155_000 })
  })

  it("stays within total input, since cache reads are a subset of it", () => {
    const calls = [
      call({ inputTokens: 1_000, cacheReadTokens: 600, cacheCreationTokens: 100 }),
      call({ inputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 250 })
    ]
    const summary = summarizeTraceCacheTokens(calls)
    const totalInput = calls.reduce((acc, c) => acc + (c.tokenUsage?.inputTokens ?? 0), 0)
    expect(summary.cacheReadTokens).toBeLessThanOrEqual(totalInput)
  })

  it("reports cache reads even when a provider excludes them from input", () => {
    // Nothing to reconcile here — the downstream self-check is what surfaces
    // a provider whose input_tokens does not contain its cache reads.
    const summary = summarizeTraceCacheTokens([call({ inputTokens: 100, cacheReadTokens: 900 })])
    expect(summary.cacheReadTokens).toBe(900)
  })

  it("skips calls without usage and tolerates a missing list", () => {
    expect(summarizeTraceCacheTokens(undefined)).toEqual({ cacheReadTokens: 0 })
    const summary = summarizeTraceCacheTokens([
      call(undefined),
      call({ inputTokens: 10, cacheReadTokens: 4 })
    ])
    expect(summary).toEqual({ cacheReadTokens: 4 })
  })

  it("ignores negative and non-finite counters", () => {
    const summary = summarizeTraceCacheTokens([
      call({ inputTokens: -5, cacheReadTokens: Number.NaN, cacheCreationTokens: -1 })
    ])
    expect(summary).toEqual({ cacheReadTokens: 0 })
  })
})
