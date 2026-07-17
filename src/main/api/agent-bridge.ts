/**
 * Bridge between the HTTP API gateway and the in-process agent runtime.
 *
 * Responsibilities:
 *  - create threads (reusing the same rules as the renderer's threads:create);
 *  - drive an agent turn headlessly against a "carrier" window;
 *  - relay the run's stream to a per-thread sink (the SSE writer).
 *
 * Carrier window: the agent run loop is coupled to a BrowserWindow (it sends
 * `agent:stream:<id>` to a webContents). We prefer an existing visible window so
 * API-driven runs also show up live in the app UI (the new thread appears in the
 * list, and opening it streams live — Plan B). When no window exists (tray/no UI)
 * we fall back to a hidden blank window so runs still work headlessly; the SSE
 * client always receives the full stream regardless, via the stream-sink tap.
 */

import { BrowserWindow } from "electron"
import { v4 as uuid } from "uuid"
import { createThreadCore } from "../ipc/threads"
import { invokeAgentForApi, abortAgentRunForApi } from "../ipc/agent"
import { setThreadYoloOverride, setThreadSandboxDisabled } from "../agent/api-run-flags"
import { getThread, getThreadMessages } from "../db"
import type { Thread } from "../types"

let hiddenCarrier: BrowserWindow | null = null

/** Broadcast a channel (with optional payload) to every renderer. */
function notifyRenderer(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** A live app window that hosts the renderer (not the hidden carrier), or null. */
function findRendererWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && win !== hiddenCarrier
    ) ?? null
  )
}

/** Prefer a live visible window (Plan B: visible in UI); else a hidden carrier. */
async function ensureCarrierWindow(): Promise<BrowserWindow> {
  const visible = findRendererWindow()
  if (visible) return visible

  if (hiddenCarrier && !hiddenCarrier.isDestroyed()) return hiddenCarrier

  hiddenCarrier = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  await hiddenCarrier.loadURL("about:blank")
  return hiddenCarrier
}

/** Close the hidden carrier window, if one was created. */
export function disposeApiCarrierWindow(): void {
  if (hiddenCarrier && !hiddenCarrier.isDestroyed()) {
    hiddenCarrier.destroy()
  }
  hiddenCarrier = null
}

/**
 * Create an API-driven thread. Marks it force-yolo (all tool approvals bypassed)
 * and nudges the UI to refresh its thread list so the new thread appears.
 */
export function apiCreateThread(metadata?: Record<string, unknown>): Thread {
  const thread = createThreadCore(metadata)
  // yolo/sandbox overrides are applied from metadata at run time (applyThreadRunOverrides).
  notifyRenderer("threads:changed")
  return thread
}

/**
 * Apply this thread's per-run overrides (yolo, sandbox) from its persisted
 * metadata, so the runtime honors them. Called before each API-driven turn, so
 * the overrides are correct even after an app restart.
 *
 * Defaults for API threads: yolo OFF (approvals surface in the app); on Windows,
 * the sandbox is OFF (it's flaky there). Callers override via `yolo`/`sandbox`.
 */
function applyThreadRunOverrides(threadId: string): void {
  const row = getThread(threadId)
  let meta: Record<string, unknown> = {}
  try {
    meta = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}
  } catch {
    meta = {}
  }
  const yolo = typeof meta.yolo === "boolean" ? meta.yolo : false
  setThreadYoloOverride(threadId, yolo)

  const isWindows = process.platform === "win32"
  const sandboxDisabled =
    meta.sandbox === true ? false : meta.sandbox === false ? true : isWindows
  setThreadSandboxDisabled(threadId, sandboxDisabled)
}

/** Fetch a thread's public shape, or null if it doesn't exist. */
export function apiGetThread(threadId: string): Thread | null {
  const row = getThread(threadId)
  if (!row) return null
  return {
    thread_id: row.thread_id,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    status: row.status as Thread["status"],
    thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
    title: row.title
  } as Thread
}

/**
 * Fetch a thread's persisted messages in true chronological order.
 *
 * The thread_messages table is ordered by write-sequence (ordinal), which groups
 * tool results after the assistant messages rather than in execution order. We
 * re-sort by created_at here so external HTTP consumers get the real conversation
 * timeline. (The app itself restores from the langgraph checkpoint, so this only
 * affects the HTTP read endpoint.)
 */
export function apiGetThreadMessages(threadId: string): unknown {
  const messages = getThreadMessages(threadId)
  return [...messages].sort((a, b) => {
    const ta = new Date(a.created_at).getTime()
    const tb = new Date(b.created_at).getTime()
    if (ta !== tb) return ta - tb
    return String(a.id ?? "").localeCompare(String(b.id ?? ""))
  })
}

/**
 * Drive one agent turn for a thread headlessly. Resolves after the turn settles.
 *
 * The caller is responsible for registering a stream sink (via
 * registerAgentStreamSink) BEFORE calling this, so no early chunk is missed —
 * this function's first `await` (carrier window) yields, but the sink must
 * already be in place. Stream payloads reach the sink through the tap in the
 * agent run loop, not through this call's return value.
 */
export async function runApiAgentTurn(
  threadId: string,
  message: string,
  modelId?: string
): Promise<void> {
  // Apply this thread's yolo/sandbox overrides (from metadata) before the run.
  applyThreadRunOverrides(threadId)

  const rendererWindow = findRendererWindow()
  if (rendererWindow) {
    // Drive the message through the renderer's normal submit path so it behaves
    // exactly like typing in the input box (live streaming + UI rendering). The
    // renderer sends agent:invoke; the SSE tap still forwards every chunk to the
    // HTTP client. Returns immediately — the turn runs via renderer→main IPC.
    rendererWindow.webContents.send("api:submit-message", { threadId, message })
    return
  }

  // No app window (tray/headless): fall back to an in-process run so the SSE
  // client still gets the full stream, just with no UI to render into.
  const window = await ensureCarrierWindow()
  await invokeAgentForApi(window, {
    threadId,
    message,
    modelId,
    userMessageId: uuid()
  })
}

/** Abort a thread's active run. Returns true if a run was aborted. */
export function apiCancelThread(threadId: string): boolean {
  const aborted = abortAgentRunForApi(threadId)
  // Mirror the UI stop button's client-side half: the backend abort alone doesn't
  // unwind the renderer's useStream, so tell the renderer to stop its stream and
  // clear the input-box loading indicator.
  notifyRenderer("api:cancel-thread", { threadId })
  return aborted
}
