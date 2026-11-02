import { extractSubagentStartToolCallsFromStreamPayload } from "./subagent-context"

export interface SubagentLifecycleState {
  firedStartIds: Set<string>
  firedStopIds: Set<string>
  subagentTypes: Map<string, string>
}

/**
 * The first values snapshot is the checkpoint before this invocation. Remember
 * its completed tasks without replaying hooks, and retain pending task names
 * for resume. Later append/tail projections visit only changed messages; full
 * snapshots (including retry replays) share the same tool-call dedupe state.
 */
export function createSubagentValuesTracker(state: SubagentLifecycleState) {
  let initialized = false
  return (payload: unknown): unknown[] => {
    const messages = (payload as { messages?: unknown[] } | null)?.messages
    if (!Array.isArray(messages)) return []
    const candidates: unknown[] = []
    for (const message of messages) {
      const tuple = [message]
      const calls = extractSubagentStartToolCallsFromStreamPayload(tuple)
      let hasNewStart = false
      for (const call of calls) {
        if (typeof call.id !== "string" || !call.id) continue
        const name = call.args?.subagent_type
        if (typeof name === "string") state.subagentTypes.set(call.id, name)
        if (!initialized) state.firedStartIds.add(call.id)
        else if (!state.firedStartIds.has(call.id)) hasNewStart = true
      }
      if (hasNewStart) candidates.push(tuple)

      const msg = message as { id?: unknown; kwargs?: Record<string, unknown> } | null
      const kwargs = msg?.kwargs
      const className = Array.isArray(msg?.id) ? msg.id.at(-1) : undefined
      const isTool =
        (typeof className === "string" && className.includes("Tool")) || kwargs?.type === "tool"
      const id = kwargs?.tool_call_id
      if (!isTool || kwargs?.name !== "task" || typeof id !== "string" || !id) continue
      if (!initialized) state.firedStopIds.add(id)
      else if (!state.firedStopIds.has(id)) candidates.push(tuple)
    }
    initialized = true
    return candidates
  }
}
