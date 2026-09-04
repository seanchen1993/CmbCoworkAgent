import type { BrowserWindow } from "electron"
import type { AgentRunDelivery } from "./agent-run-service"
import {
  broadcastToRenderers,
  mirrorStandardTurnStreamToRenderer
} from "./renderer-stream-mirror"
import { StreamConverter, type SchedulerRendererEvent } from "./stream-converter"

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
export const MANAGED_TRANSPORT_WINDOW_ID = -1

const AGENT_STREAM_PREFIX = "agent:stream:"

/**
 * The run body publishes on `agent:stream:<threadId>`, whose only subscribers
 * are the per-request listeners the renderer opens when *it* invokes. A managed
 * transport's run has no such listener, so its stream would reach nobody.
 *
 * Thread ids are `[A-Za-z0-9_-]+`, so a colon after the id marks a narrower
 * sub-channel (request-scoped, coordinator-internal). Those belong to a
 * specific renderer subscription and are forwarded untouched.
 */
function baseStreamThreadId(channel: string): string | null {
  if (!channel.startsWith(AGENT_STREAM_PREFIX)) return null
  const threadId = channel.slice(AGENT_STREAM_PREFIX.length)
  if (!threadId || threadId.includes(":")) return null
  return threadId
}

interface DesktopStreamEnvelope {
  type?: string
  mode?: string
  data?: unknown
  error?: unknown
  valuesSnapshotKind?: "full" | "append" | "tail"
}

/**
 * Desktop stream events carry raw LangGraph frames; the standing renderer
 * listener for background runs consumes converted SchedulerRendererEvents. The
 * `values` frames have already been projected to the current turn by
 * sanitizeStreamDataForRenderer, so they are converted as a turn scope — the
 * renderer merges those instead of replacing durable history with one turn.
 */
function toRendererEvents(
  converter: StreamConverter,
  payload: unknown
): SchedulerRendererEvent[] {
  if (!payload || typeof payload !== "object") return []
  const envelope = payload as DesktopStreamEnvelope

  if (envelope.type === "stream" && typeof envelope.mode === "string") {
    return converter.processChunk(envelope.mode, envelope.data, {
      valuesSnapshotScope: "turn",
      ...(envelope.valuesSnapshotKind ? { valuesSnapshotKind: envelope.valuesSnapshotKind } : {})
    })
  }
  if (envelope.type === "done") return [{ type: "done" }]
  if (envelope.type === "error") {
    return [{ type: "error", error: String(envelope.error ?? "Agent run failed") }]
  }
  if (envelope.type === "custom") {
    return [{ type: "custom", data: (envelope.data ?? {}) as Record<string, unknown> }]
  }
  return []
}

/**
 * Last line of defence behind tests/agent-window-surface.spec.ts.
 *
 * That guard reads agent.ts for `window.<member>`, so an aliased access
 * (`const w = delivery.window; w.focus()`) slips past it. Without this the
 * failure would surface in production as "w.focus is not a function", on the
 * managed path only, with nothing pointing at why this window is different.
 *
 * Symbols and inherited object keys are left alone: Node probes objects with
 * `Symbol.toPrimitive`, `util.inspect.custom` and `then`, and throwing on those
 * would break logging and awaiting rather than reveal a real mistake.
 */
function explainUnsupportedWindowMembers<T extends object>(shim: T): T {
  return new Proxy(shim, {
    get(target, property, receiver) {
      if (typeof property !== "string" || property in target || property === "then") {
        return Reflect.get(target, property, receiver)
      }
      throw new Error(
        `A managed transport run reached BrowserWindow.${property}, which its window shim does ` +
          `not implement (it has ${Object.keys(target).join(", ")}). Route the call through ` +
          `AgentRunDelivery.send / AgentRunExecutionContext, or add the member in ` +
          `src/main/agent/managed-transport-delivery.ts if a managed run can genuinely serve it.`
      )
    }
  })
}

export interface ManagedTransportDeliveryDependencies {
  mirror: typeof mirrorStandardTurnStreamToRenderer
  broadcast: typeof broadcastToRenderers
}

/**
 * Delivery for runs that no desktop window owns — an IM message, a scheduled
 * turn, any managed transport.
 *
 * It is used whether or not a window happens to be open: targeting one window
 * would tie a transport's run to whoever had the app focused, and the standing
 * renderer subscription for these runs is thread-scoped, not window-scoped.
 * `isAvailable()` is therefore always true — a run's ability to proceed does
 * not depend on anyone watching it.
 */
export function createManagedTransportAgentRunDelivery(
  dependencies: Partial<ManagedTransportDeliveryDependencies> = {}
): AgentRunDelivery {
  const mirror = dependencies.mirror ?? mirrorStandardTurnStreamToRenderer
  const broadcast = dependencies.broadcast ?? broadcastToRenderers
  // One converter per run: it carries per-turn state across frames.
  const converter = new StreamConverter()
  const startedThreads = new Set<string>()

  const forward = (channel: string, payload: unknown): void => {
    const threadId = baseStreamThreadId(channel)
    if (threadId === null) {
      broadcast(channel, payload)
      return
    }
    if (!startedThreads.has(threadId)) {
      startedThreads.add(threadId)
      // Opens the renderer's loading state before the runtime exists, matching
      // what the transport used to emit for itself.
      mirror(threadId, { type: "started" })
    }
    for (const event of toRendererEvents(converter, payload)) mirror(threadId, event)
  }

  const managedWindow = explainUnsupportedWindowMembers({
    id: MANAGED_TRANSPORT_WINDOW_ID,
    isDestroyed: (): boolean => false,
    webContents: explainUnsupportedWindowMembers({
      send: (channel: string, payload: unknown): void => forward(channel, payload),
      isDestroyed: (): boolean => false
    })
  })

  return {
    window: managedWindow as BrowserWindow,
    send: (channel, payload) => forward(channel, payload),
    isAvailable: () => true
  }
}
