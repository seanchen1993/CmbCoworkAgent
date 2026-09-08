import { describe, expect, it, vi } from "vitest"
import {
  getSubagentTranscriptHydrationRetrySchedule,
  getSubagentTranscriptPersistRetrySchedule,
  getThreadHistoryHydrationRetrySchedule,
  getThreadHistoryHydrationRetryDisposition,
  getThreadHistoryHydrationRetryDelay,
  resolveConversationPresenceFromPage,
  shouldAwaitCheckpointConversationPresence,
  shouldBootstrapLegacyCheckpointTranscript,
  shouldKeepMainTranscriptLoadingAfterPage
} from "./thread-hydration"

describe("thread history hydration retry", () => {
  it("backs off failed initial pages without growing past 30 seconds", () => {
    expect(getThreadHistoryHydrationRetryDelay(0)).toBe(500)
    expect(getThreadHistoryHydrationRetryDelay(3)).toBe(4_000)
    expect(getThreadHistoryHydrationRetryDelay(99)).toBe(30_000)
    expect(getThreadHistoryHydrationRetryDelay(Number.NaN)).toBe(500)
  })

  it("never lets a background retry supersede a user-selected message window", () => {
    expect(getThreadHistoryHydrationRetryDisposition("hydrate", false)).toBe("wait")
    expect(getThreadHistoryHydrationRetryDisposition("older", false)).toBe("cancel")
    expect(getThreadHistoryHydrationRetryDisposition("target", false)).toBe("cancel")
    expect(getThreadHistoryHydrationRetryDisposition(null, true)).toBe("cancel")
    expect(getThreadHistoryHydrationRetryDisposition(null, false)).toBe("run")
  })

  it("stops a permanently failing hydration after the bounded automatic budget", async () => {
    vi.useFakeTimers()
    try {
      let retryCount = 0
      let failureCount = 1
      const scheduleAfterFailure = (): void => {
        const schedule = getThreadHistoryHydrationRetrySchedule(retryCount)
        retryCount = schedule.nextRetryCount
        if (schedule.exhausted || schedule.delayMs === null) return
        setTimeout(() => {
          failureCount += 1
          scheduleAfterFailure()
        }, schedule.delayMs)
      }

      scheduleAfterFailure()
      await vi.runAllTimersAsync()

      expect(failureCount).toBe(7)
      expect(retryCount).toBe(6)
      expect(vi.getTimerCount()).toBe(0)
      expect(getThreadHistoryHydrationRetrySchedule(retryCount).exhausted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("allows a transient failure to clear its retry budget after success", async () => {
    vi.useFakeTimers()
    try {
      let retryCount = 0
      let succeeded = false
      const schedule = getThreadHistoryHydrationRetrySchedule(retryCount)
      retryCount = schedule.nextRetryCount
      expect(schedule.exhausted).toBe(false)
      setTimeout(() => {
        succeeded = true
        retryCount = 0
      }, schedule.delayMs!)

      await vi.runAllTimersAsync()

      expect(succeeded).toBe(true)
      expect(retryCount).toBe(0)
      expect(getThreadHistoryHydrationRetrySchedule(retryCount).exhausted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("subagent transcript hydration retry", () => {
  it("stops permanent failures after its own six-retry budget", async () => {
    vi.useFakeTimers()
    try {
      let retryCount = 0
      let failureCount = 1
      const scheduleAfterFailure = (): void => {
        const schedule = getSubagentTranscriptHydrationRetrySchedule(retryCount)
        retryCount = schedule.nextRetryCount
        if (schedule.exhausted || schedule.delayMs === null) return
        setTimeout(() => {
          failureCount += 1
          scheduleAfterFailure()
        }, schedule.delayMs)
      }

      scheduleAfterFailure()
      await vi.runAllTimersAsync()

      expect(failureCount).toBe(7)
      expect(retryCount).toBe(6)
      expect(vi.getTimerCount()).toBe(0)
      expect(getSubagentTranscriptHydrationRetrySchedule(retryCount).exhausted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears a transient failure without changing the main-history budget", async () => {
    vi.useFakeTimers()
    try {
      let subagentRetryCount = 0
      const mainHistoryRetryCount = 2
      const schedule = getSubagentTranscriptHydrationRetrySchedule(subagentRetryCount)
      subagentRetryCount = schedule.nextRetryCount
      setTimeout(() => {
        subagentRetryCount = 0
      }, schedule.delayMs!)

      await vi.runAllTimersAsync()

      expect(subagentRetryCount).toBe(0)
      expect(mainHistoryRetryCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("subagent transcript persist retry", () => {
  it("stops permanent write failures after six retries without scheduling another timer", async () => {
    vi.useFakeTimers()
    try {
      let retryCount = 0
      let writeFailureCount = 1
      const scheduleAfterFailure = (): void => {
        const schedule = getSubagentTranscriptPersistRetrySchedule(retryCount)
        retryCount = schedule.nextRetryCount
        if (schedule.exhausted || schedule.delayMs === null) return
        setTimeout(() => {
          writeFailureCount += 1
          scheduleAfterFailure()
        }, schedule.delayMs)
      }

      scheduleAfterFailure()
      await vi.runAllTimersAsync()

      expect(writeFailureCount).toBe(7)
      expect(retryCount).toBe(6)
      expect(vi.getTimerCount()).toBe(0)
      expect(getSubagentTranscriptPersistRetrySchedule(retryCount).exhausted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears a transient write failure without changing either hydration budget", async () => {
    vi.useFakeTimers()
    try {
      let persistRetryCount = 0
      const mainHistoryRetryCount = 2
      const subagentHydrationRetryCount = 3
      const schedule = getSubagentTranscriptPersistRetrySchedule(persistRetryCount)
      persistRetryCount = schedule.nextRetryCount
      setTimeout(() => {
        persistRetryCount = 0
      }, schedule.delayMs!)

      await vi.runAllTimersAsync()

      expect(persistRetryCount).toBe(0)
      expect(mainHistoryRetryCount).toBe(2)
      expect(subagentHydrationRetryCount).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("thread conversation presence hydration", () => {
  it("keeps missing or failed page summaries unknown", () => {
    expect(
      resolveConversationPresenceFromPage(undefined, { legacyFallbackPending: false })
    ).toBe("unknown")
    expect(
      resolveConversationPresenceFromPage(
        { total: 12 },
        { legacyFallbackPending: false }
      )
    ).toBe("unknown")
  })

  it("waits for the legacy checkpoint before confirming an empty new thread", () => {
    expect(
      resolveConversationPresenceFromPage(
        { total: 0, hasVisibleMessages: false },
        { legacyFallbackPending: true }
      )
    ).toBe("unknown")
    expect(
      resolveConversationPresenceFromPage(
        { total: 0, hasVisibleMessages: false },
        { legacyFallbackPending: false }
      )
    ).toBe("empty")
  })

  it("resumes an interrupted migration and skips a completed empty migration", () => {
    const interrupted = {
      total: 3,
      hasVisibleMessages: false,
      legacyCheckpointMigrationStatus: "migrating" as const
    }
    expect(shouldBootstrapLegacyCheckpointTranscript(interrupted)).toBe(true)
    expect(
      shouldKeepMainTranscriptLoadingAfterPage({ succeeded: true, page: interrupted })
    ).toBe(true)
    expect(
      resolveConversationPresenceFromPage(interrupted, { legacyFallbackPending: true })
    ).toBe("unknown")

    const completeEmpty = {
      total: 0,
      hasVisibleMessages: false,
      legacyCheckpointMigrationStatus: "complete" as const
    }
    expect(shouldBootstrapLegacyCheckpointTranscript(completeEmpty)).toBe(false)
    expect(
      shouldKeepMainTranscriptLoadingAfterPage({ succeeded: true, page: completeEmpty })
    ).toBe(false)
    expect(
      resolveConversationPresenceFromPage(completeEmpty, { legacyFallbackPending: false })
    ).toBe("empty")
  })

  it("distinguishes internal-only durable rows from a real conversation", () => {
    expect(
      resolveConversationPresenceFromPage(
        { total: 3, hasVisibleMessages: false },
        { legacyFallbackPending: false }
      )
    ).toBe("empty")
    expect(
      resolveConversationPresenceFromPage(
        { total: 3, hasVisibleMessages: true },
        { legacyFallbackPending: true }
      )
    ).toBe("nonempty")
  })

  it("keeps an unmarked internal-only legacy page unknown until checkpoint restore", () => {
    const ambiguousLegacyPage = {
      total: 3,
      hasVisibleMessages: false,
      legacyCheckpointMigrationStatus: null
    }
    expect(shouldBootstrapLegacyCheckpointTranscript(ambiguousLegacyPage)).toBe(true)
    expect(shouldAwaitCheckpointConversationPresence(ambiguousLegacyPage)).toBe(true)
    expect(
      resolveConversationPresenceFromPage(ambiguousLegacyPage, {
        legacyFallbackPending: true
      })
    ).toBe("unknown")
    expect(
      shouldAwaitCheckpointConversationPresence({
        ...ambiguousLegacyPage,
        legacyCheckpointMigrationStatus: "complete"
      })
    ).toBe(false)
  })

  it("migrates an unmarked checkpoint even when a newer row or goal sidecar is visible", () => {
    const visibleButUnproven = {
      total: 2,
      hasVisibleMessages: true,
      legacyCheckpointMigrationStatus: null
    }
    expect(shouldBootstrapLegacyCheckpointTranscript(visibleButUnproven)).toBe(true)
    expect(shouldAwaitCheckpointConversationPresence(visibleButUnproven)).toBe(true)
    expect(
      shouldKeepMainTranscriptLoadingAfterPage({
        succeeded: true,
        page: visibleButUnproven
      })
    ).toBe(true)
  })
})
