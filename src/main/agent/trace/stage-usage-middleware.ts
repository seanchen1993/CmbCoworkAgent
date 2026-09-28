import { createMiddleware } from "langchain"
import type { TraceContext } from "./types"
import {
  getTraceStageUsage,
  settleTraceCallStage,
  startTraceCallStage
} from "./stage-usage-registry"

/**
 * Attribute each call to the stage it started in. The lookup starts with the call and runs
 * alongside it, so it never delays the call; values snapshots may arrive much later.
 */
export function createStageUsageMiddleware(context: TraceContext) {
  return createMiddleware({
    name: "traceStageUsage",
    wrapModelCall: async (request, handler) => {
      const counter = getTraceStageUsage(context.traceId)
      if (!counter) return handler(request)
      const pendingStage = startTraceCallStage(context)
      const response = await handler(request)
      const stage = await settleTraceCallStage(pendingStage)
      try {
        counter.bindModel(typeof response.id === "string" ? response.id : "", stage)
        // Some models have no ID here; the graph may also replace provider IDs.
        // Keep our stamp alongside response metadata without altering content or identity.
        response.response_metadata = {
          ...response.response_metadata,
          cmbTraceStage: { version: 1, traceId: context.traceId, ...stage }
        }
      } catch {
        // A provider can return a frozen message. Attribution must not fail its call.
      }
      return response
    },
    wrapToolCall: async (request, handler) => {
      const counter = getTraceStageUsage(context.traceId)
      if (counter && request.toolCall.id) {
        counter.bindToolLater(`call:${request.toolCall.id}`, startTraceCallStage(context))
      }
      return handler(request)
    }
  })
}
