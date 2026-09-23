import { createMiddleware } from "langchain"
import { z } from "zod"
import { SummarizationEventSchema } from "./context-summarization-middleware"
import { currentCompactedContextStart } from "./context-usage"
import type { ModsManager } from "../mods/manager"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import type { ModJson } from "../../shared/mods/types"
import type { FunctionSessionContextSources } from "../../shared/mods/v2/session"
import type { FunctionSessionContextSourceResolver } from "./context-sources"

export type FunctionSessionCompactor = (
  instructions: string,
  messages: readonly unknown[],
  state: { _summarizationEvent?: unknown },
  signal: AbortSignal
) => Promise<ModJson>

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
  contextWindow?: number,
  compact?: FunctionSessionCompactor,
  contextSources?: FunctionSessionContextSources | FunctionSessionContextSourceResolver
) {
  if (compact) manager.bindFunctionSession(authority, model, contextWindow, compact)
  else manager.bindFunctionSession(authority, model, contextWindow)
  const capture = (
    state: { messages: readonly unknown[]; _summarizationEvent?: unknown },
    pendingStartIndex?: number
  ) => {
    manager.updateFunctionSessionMessages(authority, state.messages, {
      _summarizationEvent:
        pendingStartIndex === undefined
          ? state._summarizationEvent
          : { ...(state._summarizationEvent ?? {}), usageStartIndex: pendingStartIndex }
    })
  }
  return createMiddleware({
    name: "functionSessionView",
    // LangChain filters each middleware's request.state to its declared keys.
    // This observer follows the loading middleware; the original graph fields
    // and skills reducer remain owned by those earlier middleware definitions.
    stateSchema: z.object({
      _summarizationEvent: SummarizationEventSchema.optional(),
      memoryContents: z.record(z.string(), z.string()).optional(),
      skillsMetadata: z.array(z.unknown()).optional()
    }),
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
      manager.updateFunctionSessionRequest(authority, {
        messages: request.messages,
        systemMessage: request.systemMessage,
        tools: request.tools,
        contextSources: typeof contextSources === "function" ? contextSources(request) : contextSources
      })
      return handler(request)
    },
    wrapToolCall: async (request, handler) => {
      capture(request.state)
      return handler(request)
    }
  })
}
