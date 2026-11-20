import { describe, expect, it, vi } from "vitest"
import type { BrowserScriptExecutionState } from "../../src/shared/browser-types"
import {
  getPlaybackStatusDetail,
  shouldShowPlaybackSummary
} from "../../src/renderer/src/components/browser/BrowserPlaybackControl"
import {
  clearBrowserPlaybackHistory,
  createBrowserPlaybackHistoryEntry,
  formatPlaybackDuration
} from "../../src/renderer/src/components/browser/browser-playback-history"

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

  it("builds a completed playback history entry with duration and progress", () => {
    expect(
      createBrowserPlaybackHistoryEntry({
        status: "completed",
        label: "登录验证",
        fileName: "login.spec.ts",
        startedAt: "2026-10-15T08:00:00.000Z",
        endedAt: "2026-10-15T08:00:02.000Z",
        progressPercent: 100,
        completedSteps: 5,
        totalSteps: 5
      })
    ).toMatchObject({
      scriptName: "登录验证",
      fileName: "login.spec.ts",
      runAt: "2026-10-15T08:00:00.000Z",
      status: "completed",
      progressPercent: 100,
      completedSteps: 5,
      totalSteps: 5,
      durationMs: 2000
    })
  })

  it("formats playback duration for the status line", () => {
    expect(formatPlaybackDuration(2000)).toBe("2s")
    expect(formatPlaybackDuration(1500)).toBe("1s")
    expect(formatPlaybackDuration(999)).toBe("0s")
  })

  it("keeps playback error details in history", () => {
    expect(
      createBrowserPlaybackHistoryEntry({
        status: "error",
        fileName: "checkout.spec.ts",
        startedAt: "2026-10-15T08:00:00.000Z",
        endedAt: "2026-10-15T08:00:01.000Z",
        error: "提交按钮不可见"
      })
    ).toMatchObject({
      fileName: "checkout.spec.ts",
      scriptName: "checkout.spec.ts",
      status: "error",
      error: "提交按钮不可见"
    })
  })

  it("reports local storage clear failures", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("window", {
      localStorage: {
        removeItem: vi.fn(() => {
          throw new Error("storage unavailable")
        })
      }
    })

    expect(clearBrowserPlaybackHistory()).toBe(false)
    warn.mockRestore()
    vi.unstubAllGlobals()
  })
})
