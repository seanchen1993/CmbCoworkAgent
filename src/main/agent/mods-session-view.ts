import { createMiddleware } from "langchain"
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
  runId?: string
) {
  manager.bindFunctionSession(authority, model)
  const capture = (state: { messages: readonly unknown[] }) => {
    manager.updateFunctionSessionMessages(authority, state.messages)
  }
  return createMiddleware({
    name: "functionSessionView",
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
      capture(request.state)
      return handler(request)
    },
    wrapToolCall: async (request, handler) => {
      capture(request.state)
      return handler(request)
    }
  })
}
