import { createMiddleware } from "langchain"
import { z } from "zod"
import { SummarizationEventSchema } from "./context-summarization-middleware"
import { currentCompactedContextStart } from "./context-usage"
import type { ModsManager } from "../mods/manager"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"

/** A shared graph resolves its own private invocation; concurrent children never borrow main state. */
export function createFunctionChildTurnMiddleware(manager: ModsManager) {
  return createMiddleware({
    name: "functionChildTurn",
    afterModel: (state) => {
      manager.observeSharedAgentTurn(state.messages.at(-1))
      return undefined
    }
  })
}

/** Observe actual main-graph state without changing its messages or routing decisions. */
export function createFunctionSessionViewMiddleware(
  manager: ModsManager,
  authority: ModRuntimeAuthority,
  model: string,
  runId?: string,
  contextWindow?: number
) {
  manager.bindFunctionSession(authority, model, contextWindow)
  const capture = (
    state: { messages: readonly unknown[]; _summarizationEvent?: unknown },
    pendingStartIndex?: number
  ) => {
    manager.updateFunctionSessionMessages(authority, state.messages, {
      _summarizationEvent:
        pendingStartIndex === undefined
          ? state._summarizationEvent
          : { usageStartIndex: pendingStartIndex }
    })
  }
  return createMiddleware({
    name: "functionSessionView",
    stateSchema: z.object({ _summarizationEvent: SummarizationEventSchema.optional() }),
    beforeAgent: (state) => {
      capture(state)
      return undefined
    },
    afterAgent: (state) => {
      capture(state)
      return undefined
    },
    afterModel: (state) => {
      capture(state)
      if (runId) manager.functionTurns.observe(authority.threadId, runId, state.messages.at(-1))
      return undefined
    },
    wrapModelCall: async (request, handler) => {
      capture(request.state, currentCompactedContextStart())
      return handler(request)
    },
    wrapToolCall: async (request, handler) => {
      capture(request.state)
      return handler(request)
    }
  })
}
