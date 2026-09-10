/**
 * A value can be cut twice: once by the collection budget, then again by the
 * uploader. They used to do it independently — collection kept only the head,
 * so the "tail" the uploader produced came from the middle of the original and
 * was presented as its end, with an omitted count describing the wrong string.
 * Both sides now share one marker and narrow the halves separately.
 */
import { describe, expect, it } from "vitest"
import { TraceCollectionBudget, splitTruncatedText, truncateKeepingEnds } from "./bounds"

const HEAD = "开始标记-BEGIN-"
const TAIL = "-END-结束标记"

function longValue(chars: number): string {
  return HEAD + "x".repeat(chars) + TAIL
}

describe("two-stage truncation keeps real ends", () => {
  it("keeps both ends and reports what it dropped", () => {
    const value = longValue(100_000)
    const cut = truncateKeepingEnds(value, 16 * 1024)

    expect(cut.length).toBeLessThan(value.length)
    expect(cut.startsWith(HEAD)).toBe(true)
    expect(cut.endsWith(TAIL)).toBe(true)

    const parts = splitTruncatedText(cut)
    expect(parts).toBeDefined()
    expect(parts!.head.length + parts!.tail.length + parts!.omitted).toBe(value.length)
  })

  it("survives a second, narrower pass with the real tail intact", async () => {
    const { sanitizeTraceForCloudUpload } = await import("./sanitizer")
    const value = longValue(100_000)

    // Stage one: the collection budget.
    const collected = truncateKeepingEnds(value, 16 * 1024)
    // Stage two: the uploader, which is far narrower.
    const trace = {
      traceId: "t",
      threadId: "th",
      startedAt: "0",
      endedAt: "0",
      durationMs: 0,
      userMessage: "hi",
      modelId: "m",
      steps: [{ index: 0, startedAt: "0", assistantText: collected, toolCalls: [] }],
      totalToolCalls: 0,
      outcome: "success",
      usedSkills: [],
      evolvedSkills: [],
      triggerSource: "chat"
    } as unknown as Parameters<typeof sanitizeTraceForCloudUpload>[0]

    const uploaded = sanitizeTraceForCloudUpload(trace)
    const text = uploaded.steps[0].assistantText

    // The end a reader sees is the real end of the original value.
    expect(text.endsWith(TAIL)).toBe(true)
    expect(text.startsWith(HEAD)).toBe(true)

    // And the count describes the original, not the already-cut copy.
    const parts = splitTruncatedText(text)
    expect(parts).toBeDefined()
    expect(parts!.head.length + parts!.tail.length + parts!.omitted).toBe(value.length)
  })

  it("fits inside the caller's own limit, marker included", () => {
    // takeText hands the result to boundTelemetryValue, which enforces the same
    // maxChars with a head-only cut. If the marker pushed the value even a few
    // characters over, that cut landed past it and took the tail off again —
    // undoing the whole point. Exercised through takeText, not the helper
    // alone, because the helper on its own never sees that second cut.
    const value = longValue(100_000)
    for (const limit of [512, 4096, 16 * 1024]) {
      expect(truncateKeepingEnds(value, limit).length).toBeLessThanOrEqual(limit)
    }

    const budget = new TraceCollectionBudget()
    const stored = budget.takeText(value, 16 * 1024, true)
    expect(stored.length).toBeLessThanOrEqual(16 * 1024)
    expect(stored.endsWith(TAIL)).toBe(true)
    expect(stored.startsWith(HEAD)).toBe(true)
  })

  it("leaves short values untouched", () => {
    expect(truncateKeepingEnds("short", 1024)).toBe("short")
    expect(splitTruncatedText("short")).toBeUndefined()
  })
})
