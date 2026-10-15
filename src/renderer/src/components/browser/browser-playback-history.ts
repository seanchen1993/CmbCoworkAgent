import type { BrowserScriptExecutionState } from "../../../../shared/browser-types"

export const BROWSER_PLAYBACK_HISTORY_STORAGE_KEY = "browser-script-playback-history-v2"
export const MAX_BROWSER_PLAYBACK_HISTORY_ENTRIES = 100

export interface BrowserPlaybackHistoryEntry {
  id: string
  scriptName: string
  fileName: string
  runAt: string
  status: Exclude<BrowserScriptExecutionState["status"], "idle" | "running">
  progressPercent: number
  completedSteps: number
  totalSteps: number
  durationMs: number
  error?: string
}

function isPlaybackHistoryEntry(value: unknown): value is BrowserPlaybackHistoryEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<BrowserPlaybackHistoryEntry>
  return (
    typeof entry.id === "string" &&
    typeof entry.scriptName === "string" &&
    typeof entry.fileName === "string" &&
    typeof entry.runAt === "string" &&
    ["completed", "error", "cancelled"].includes(entry.status ?? "") &&
    typeof entry.progressPercent === "number" &&
    typeof entry.completedSteps === "number" &&
    typeof entry.totalSteps === "number" &&
    typeof entry.durationMs === "number" &&
    (entry.error === undefined || typeof entry.error === "string")
  )
}

export function readBrowserPlaybackHistory(): BrowserPlaybackHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(BROWSER_PLAYBACK_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isPlaybackHistoryEntry) : []
  } catch (error) {
    console.warn("[BrowserPlaybackHistory] Failed to read playback history:", error)
    return []
  }
}

export function createBrowserPlaybackHistoryEntry(
  state: BrowserScriptExecutionState
): BrowserPlaybackHistoryEntry | null {
  if (state.status === "idle" || state.status === "running") return null

  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : Number.NaN
  const endedAtMs = state.endedAt ? Date.parse(state.endedAt) : Number.NaN
  const runAt = Number.isFinite(startedAtMs)
    ? state.startedAt!
    : (state.endedAt ?? new Date().toISOString())
  const durationMs =
    Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
      ? Math.max(0, endedAtMs - startedAtMs)
      : 0
  const progressPercent = Number.isFinite(state.progressPercent)
    ? Math.max(0, Math.min(100, Math.round(state.progressPercent!)))
    : state.status === "completed"
      ? 100
      : 0

  return {
    id: [runAt, state.fileName ?? "", state.label ?? ""].join("::"),
    scriptName: state.label?.trim() || state.fileName?.trim() || "当前脚本",
    fileName: state.fileName?.trim() || state.label?.trim() || "当前脚本",
    runAt,
    status: state.status,
    progressPercent,
    completedSteps: Math.max(0, state.completedSteps ?? 0),
    totalSteps: Math.max(0, state.totalSteps ?? 0),
    durationMs,
    error: state.status === "error" ? state.error?.trim() || undefined : undefined
  }
}

export function clearBrowserPlaybackHistory(): boolean {
  try {
    window.localStorage.removeItem(BROWSER_PLAYBACK_HISTORY_STORAGE_KEY)
    return true
  } catch (error) {
    console.warn("[BrowserPlaybackHistory] Failed to clear playback history:", error)
    return false
  }
}

export function saveBrowserPlaybackHistoryEntry(
  state: BrowserScriptExecutionState
): BrowserPlaybackHistoryEntry[] {
  const entry = createBrowserPlaybackHistoryEntry(state)
  if (!entry) return readBrowserPlaybackHistory()

  const nextEntries = [
    entry,
    ...readBrowserPlaybackHistory().filter((item) => item.id !== entry.id)
  ].slice(0, MAX_BROWSER_PLAYBACK_HISTORY_ENTRIES)
  try {
    window.localStorage.setItem(BROWSER_PLAYBACK_HISTORY_STORAGE_KEY, JSON.stringify(nextEntries))
  } catch (error) {
    console.warn("[BrowserPlaybackHistory] Failed to save playback history:", error)
  }
  return nextEntries
}

export function formatPlaybackDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0s"
  return `${Math.floor(durationMs / 1000)}s`
}
