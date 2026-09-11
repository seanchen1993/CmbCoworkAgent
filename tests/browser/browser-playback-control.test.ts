import { describe, expect, it } from "vitest"
import type { BrowserScriptExecutionState } from "../../src/shared/browser-types"
import {
  getPlaybackStatusDetail,
  shouldShowPlaybackSummary
} from "../../src/renderer/src/components/browser/BrowserPlaybackControl"

describe("browser playback control", () => {
  it("suppresses inactive playback summaries while a recording session is active", () => {
    const cancelledPlayback: BrowserScriptExecutionState = {
      status: "cancelled",
      label: "11"
    }

    expect(shouldShowPlaybackSummary(cancelledPlayback, true)).toBe(false)
  })

  it("still shows running playback even when recording status should otherwise be preferred", () => {
    const runningPlayback: BrowserScriptExecutionState = {
      status: "running",
      label: "11"
    }

    expect(shouldShowPlaybackSummary(runningPlayback, true)).toBe(true)
  })

  it("replaces inactive playback summaries with recording controls when preferred", () => {
    const completedPlayback: BrowserScriptExecutionState = {
      status: "completed",
      label: "11",
      progressPercent: 100
    }

    expect(shouldShowPlaybackSummary(completedPlayback, true)).toBe(false)
  })

  it("keeps showing the last playback summary when no recording is active", () => {
    const completedPlayback: BrowserScriptExecutionState = {
      status: "completed",
      label: "11"
    }

    expect(shouldShowPlaybackSummary(completedPlayback, false)).toBe(true)
  })

  it("prefers playback progress percent over the label when available", () => {
    const runningPlayback: BrowserScriptExecutionState = {
      status: "running",
      label: "12",
      progressPercent: 67
    }

    expect(getPlaybackStatusDetail(runningPlayback)).toBe("67%")
  })
})
