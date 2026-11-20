import { describe, expect, it } from "vitest"
import { mergeTranscriptReasoningUpdates } from "./transcript-reasoning"

describe("explicit transcript reasoning authority", () => {
  it("distinguishes missing, partial history and explicit clear", () => {
    const existing = { reasoning: "long reasoning" }
    expect(mergeTranscriptReasoningUpdates(existing, {})).toMatchObject(existing)
    expect(mergeTranscriptReasoningUpdates(existing, { reasoning: "long" })).toMatchObject(existing)
    expect(mergeTranscriptReasoningUpdates(existing, { reasoning_mode: "snapshot" })).toMatchObject(
      existing
    )
    expect(
      mergeTranscriptReasoningUpdates(existing, { reasoning: "", reasoning_mode: "snapshot" })
    ).toEqual({ reasoning: "", reasoning_mode: "snapshot" })
  })

  it("retains clear authority through empty deltas and omitted updates", () => {
    const cleared = { reasoning: "", reasoning_mode: "snapshot" as const }
    expect(mergeTranscriptReasoningUpdates(cleared, {})).toEqual(cleared)
    expect(
      mergeTranscriptReasoningUpdates(cleared, { reasoning: "", reasoning_mode: "delta" })
    ).toEqual(cleared)
    expect(
      mergeTranscriptReasoningUpdates(cleared, { reasoning: "new", reasoning_mode: "delta" })
    ).toEqual({ reasoning: "new", reasoning_mode: "snapshot" })
  })
})
