import type { BrowserWindow } from "electron"
import type { AgentRunDelivery } from "./agent-run-service"
import { broadcastToRenderers } from "./renderer-stream-mirror"

/**
 * Synthetic window id for runs that no desktop window owns.
 *
 * Electron allocates BrowserWindow ids as positive integers, so a negative id
 * can never collide with a real one. The run body uses `window.id` only as a
 * Map key (coordinator worker restore / update binding / stream focus) and
 * never resolves an id back to a window, so an id that matches no stored entry
 * simply reads as "this run has no focused worker" — which is exactly right for
 * a run with no desktop viewer.
 */
export const HEADLESS_AGENT_RUN_WINDOW_ID = -1

/**
 * The entire BrowserWindow surface the agent run body touches: `id`,
 * `isDestroyed()`, `webContents.send()` and `webContents.isDestroyed()`.
 *
 * The cast in createHeadlessAgentRunDelivery silences the compiler, so nothing
 * here fails to build if agent.ts reaches for a fifth member — it would throw
 * at runtime, on the IM path only. `tests/agent-window-surface.spec.ts` is what
 * actually holds that line: it fails the build on any window member outside
 * this set.
 */
function headlessWindow(broadcast: (channel: string, payload: unknown) => void): unknown {
  return {
    id: HEADLESS_AGENT_RUN_WINDOW_ID,
    isDestroyed: (): boolean => false,
    webContents: {
      send: (channel: string, payload: unknown): void => broadcast(channel, payload),
      isDestroyed: (): boolean => false
    }
  }
}

/**
 * Runs a turn through the authoritative desktop run body when no desktop window
 * owns it — an IM message, a scheduled turn, any managed transport.
 *
 * Stream events are broadcast to whatever renderers happen to be open, which is
 * the delivery IM already uses for its own turns (see renderer-stream-mirror),
 * and reach nobody when none are. `isAvailable()` is therefore always true: the
 * run's ability to proceed does not depend on anyone watching it.
 */
export function createHeadlessAgentRunDelivery(
  /** Injectable so the delivery's own contract stays testable without Electron. */
  broadcast: (channel: string, payload: unknown) => void = broadcastToRenderers
): AgentRunDelivery {
  return {
    window: headlessWindow(broadcast) as BrowserWindow,
    send: (channel, payload) => broadcast(channel, payload),
    isAvailable: () => true
  }
}
