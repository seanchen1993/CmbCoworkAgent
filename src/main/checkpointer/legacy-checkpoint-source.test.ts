import { describe, expect, it } from "vitest"
import { coversLegacyOverlap, createLegacyOverlapProof, type LegacyOverlapPayload } from "./legacy-checkpoint-source"

const assistant = (...texts: string[]): LegacyOverlapPayload => ({
  messageId: "reply",
  role: "assistant",
  providerSourceId: null,
  providerOccurrence: null,
  contentJson: JSON.stringify(texts.map((text) => ({ type: "text", text }))),
  reasoning: null,
  toolCallsJson: null
})

describe("legacy search coverage proofs", () => {
  it("finds nonoverlapping old spans even if a longer span can match an earlier block", () => {
    const long = "Previous published content with an INTERMEDIATE MARKER"
    const short = "INTERMEDIATE MARKER END"
    const proof = createLegacyOverlapProof(assistant(long, short))!
    expect(coversLegacyOverlap(assistant(long + " END", long), [], proof)).toBe(true)
    expect(coversLegacyOverlap(assistant(long + " END"), [], proof)).toBe(false)
  })

  it("keeps looking for a nonoverlapping match after repeated text inside a reserved span", () => {
    const short = "repeated visible phrase"
    const long = "[body] " + (short + " then more text ").repeat(70)
    const proof = createLegacyOverlapProof(assistant(long, short))!
    expect(coversLegacyOverlap(assistant(long + short), [], proof)).toBe(true)
  })
})
