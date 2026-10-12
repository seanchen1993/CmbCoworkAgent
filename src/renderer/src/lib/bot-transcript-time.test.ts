import { describe, expect, it } from "vitest"
import { botTranscriptTimeLabel } from "./bot-transcript-time"

describe("Bot transcript timestamp boundaries", () => {
  const first = new Date(2026, 9, 4, 9, 0).getTime()
  it("separates the first visible message and each 15-minute gap", () => {
    expect(botTranscriptTimeLabel(first)).toBe("2026-10-04 09:00")
    expect(botTranscriptTimeLabel(first + 899_999, first)).toBeNull()
    expect(botTranscriptTimeLabel(first + 900_000, first)).toBe("2026-10-04 09:15")
  })
  it("marks a local midnight even when messages are only a second apart", () => {
    const midnight = new Date(2026, 9, 5).getTime()
    expect(botTranscriptTimeLabel(midnight, midnight - 1000)).toBe("2026-10-05 00:00")
  })
  it("retains the original absolute-gap behavior when timestamps go backwards", () => {
    expect(botTranscriptTimeLabel(first, first + 900_000)).toBe("2026-10-04 09:00")
  })
  it("removes a page-edge marker when older same-session history is prepended", () => {
    expect(botTranscriptTimeLabel(first)).not.toBeNull()
    expect(botTranscriptTimeLabel(first, first - 1000)).toBeNull()
    expect(botTranscriptTimeLabel(first, first - 900_000)).not.toBeNull()
  })
  it("does not render a malformed date, or hide the first valid date after one", () => {
    expect(botTranscriptTimeLabel(Number.NaN, first)).toBeNull()
    expect(botTranscriptTimeLabel(first, Number.NaN)).toBe("2026-10-04 09:00")
  })
})
