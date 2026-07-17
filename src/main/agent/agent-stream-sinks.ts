/**
 * Per-thread agent-stream sink registry.
 *
 * The agent run loop delivers streamed chunks to a renderer window via
 * `window.webContents.send("agent:stream:<threadId>", payload)`. The HTTP API
 * gateway needs the SAME payloads to relay them to a remote SSE client, but it
 * has no window.
 *
 * This registry is a display-only tap: the agent code forwards a copy of every
 * stream payload here (keyed by thread id), and any registered sink — e.g. an
 * SSE response writer — receives it. When no sink is registered for a thread
 * (the normal renderer-only path), forwarding is a cheap no-op, so the tap has
 * zero impact on local usage.
 *
 * Kept dependency-free on purpose: both the core agent runtime and the API
 * feature import it, so it must never import back into either (no cycles).
 */

/** A sink receives the raw stream channel and payload for a thread. */
export type AgentStreamSink = (channel: string, payload: unknown) => void

const sinksByThread = new Map<string, Set<AgentStreamSink>>()

/**
 * Register a sink for a thread. Returns an unsubscribe function that removes
 * exactly this sink (safe to call multiple times).
 */
export function registerAgentStreamSink(threadId: string, sink: AgentStreamSink): () => void {
  let set = sinksByThread.get(threadId)
  if (!set) {
    set = new Set<AgentStreamSink>()
    sinksByThread.set(threadId, set)
  }
  set.add(sink)

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    const current = sinksByThread.get(threadId)
    if (!current) return
    current.delete(sink)
    if (current.size === 0) sinksByThread.delete(threadId)
  }
}

/** True when at least one sink is listening for this thread's stream. */
export function hasAgentStreamSink(threadId: string): boolean {
  return (sinksByThread.get(threadId)?.size ?? 0) > 0
}

/**
 * Forward one stream payload to every sink registered for the thread.
 * No-op when there are no sinks. A throwing sink never breaks delivery to the
 * window or to the other sinks.
 */
export function forwardAgentStreamToSinks(
  threadId: string,
  channel: string,
  payload: unknown
): void {
  const set = sinksByThread.get(threadId)
  if (!set || set.size === 0) return
  for (const sink of set) {
    try {
      sink(channel, payload)
    } catch (error) {
      console.warn("[ApiStream] stream sink threw:", error)
    }
  }
}
