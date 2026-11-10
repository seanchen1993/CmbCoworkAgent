import type { ToolCall } from "@langchain/core/messages"
import { createMiddleware } from "langchain"

export interface PendingSubagentStop {
  toolCall: ToolCall
  result: unknown
}

export interface SubagentLifecycleCallbacks {
  onStart: (toolCall: ToolCall) => void | Promise<void>
  onStop: (toolCall: ToolCall, result: unknown) => Promise<void>
  /** Owned by the physical invocation, so model/runtime rebuilds retain the gate. */
  pendingStops: Map<string, PendingSubagentStop>
}

/**
 * Stream consumers cannot stop the graph producer from running ahead. Start
 * notifications belong at tool entry; stop decisions belong before the next
 * model dispatch, after the completed task's ToolMessage has been checkpointed.
 * Wrapping the call avoids an extra graph node/checkpoint on every model turn.
 * Keep this middleware on the parent graph, not its shared child middleware.
 */
export function createSubagentLifecycleMiddleware(options: SubagentLifecycleCallbacks) {
  return createMiddleware({
    name: "subagentLifecycleMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolCall = request.toolCall
      if (toolCall.name !== "task") return handler(request)
      await options.onStart(toolCall)
      const result = await handler(request)
      if (toolCall.id) options.pendingStops.set(toolCall.id, { toolCall, result })
      return result
    },
    wrapModelCall: async (request, handler) => {
      for (const [id, pending] of options.pendingStops) {
        await options.onStop(pending.toolCall, pending.result)
        // A callback may rebuild the runtime or replace this task's pending
        // result. Never delete a newer entry, and retain rejected decisions.
        if (options.pendingStops.get(id) === pending) options.pendingStops.delete(id)
      }
      return handler(request)
    }
  })
}
