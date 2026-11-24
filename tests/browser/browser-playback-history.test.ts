import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserScriptExecutionState } from "../../src/shared/browser-types"
import {
  BROWSER_PLAYBACK_HISTORY_STORAGE_KEY,
  MAX_BROWSER_PLAYBACK_HISTORY_ENTRIES,
  readBrowserPlaybackHistory,
  saveBrowserPlaybackHistoryEntry,
  type BrowserPlaybackHistoryEntry
} from "../../src/renderer/src/components/browser/browser-playback-history"

function createEntry(index: number): BrowserPlaybackHistoryEntry {
  return {
    id: `entry-${index}`,
    scriptName: `操作 ${index}`,
    fileName: `recording-${index}.spec.ts`,
    runAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    status: "completed",
    progressPercent: 100,
    completedSteps: 1,
    totalSteps: 1,
    durationMs: 1000
  }
}

describe("browser playback history", () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it("keeps only the 100 most recent stored entries when loading existing history", () => {
    const entries = Array.from({ length: 105 }, (_, index) => createEntry(index))
    storage.set(BROWSER_PLAYBACK_HISTORY_STORAGE_KEY, JSON.stringify(entries))

    const loaded = readBrowserPlaybackHistory()

    expect(loaded).toHaveLength(MAX_BROWSER_PLAYBACK_HISTORY_ENTRIES)
    expect(loaded[0]?.id).toBe("entry-0")
    expect(loaded.at(-1)?.id).toBe("entry-99")
    expect(JSON.parse(storage.get(BROWSER_PLAYBACK_HISTORY_STORAGE_KEY) ?? "[]")).toHaveLength(
      MAX_BROWSER_PLAYBACK_HISTORY_ENTRIES
    )
  })

  it("drops the oldest entry when a new completed playback is saved", () => {
    const entries = Array.from({ length: 100 }, (_, index) => createEntry(index))
    storage.set(BROWSER_PLAYBACK_HISTORY_STORAGE_KEY, JSON.stringify(entries))
    const state: BrowserScriptExecutionState = {
      status: "completed",
      fileName: "new-recording.spec.ts",
      label: "最新操作",
      startedAt: "2026-01-02T00:00:00.000Z",
      endedAt: "2026-01-02T00:00:01.000Z",
      progressPercent: 100,
      completedSteps: 1,
      totalSteps: 1
    }

    const saved = saveBrowserPlaybackHistoryEntry(state)

    expect(saved).toHaveLength(MAX_BROWSER_PLAYBACK_HISTORY_ENTRIES)
    expect(saved[0]?.scriptName).toBe("最新操作")
    expect(saved.some((entry) => entry.id === "entry-99")).toBe(false)
  })
})
