import { createMiddleware } from "langchain"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import {
  createModModelBoundary,
  type FunctionModelStreamHost,
  type FunctionStepModelHost
} from "./mods-model-boundary"
import { ModError } from "../mods/errors"

/** Resolved by the host, keyed by the actual provider object, never by a public model name. */
export interface FunctionTaskModel {
  model: string
  effort?: string
  resolve: FunctionStepModelHost["resolve"]
}

export interface FunctionTaskModelHost extends FunctionModelStreamHost {
  functionSharedModelAuthority(root: ModRuntimeAuthority, role: string): ModRuntimeAuthority
}

/** Install last in a known role's stack, after its model and tool policy middleware. */
export function createFunctionTaskModelMiddleware(options: {
  manager: FunctionTaskModelHost
  root: ModRuntimeAuthority
  role: string
  models: WeakMap<object, FunctionTaskModel>
  onFinalPrompt?: (text: string, agentId: string, turnId: string) => void
}) {
  const counters = new WeakMap<ModRuntimeAuthority, { value: number }>()
  return createMiddleware({
    name: "functionTaskModelBoundary",
    wrapModelCall: async (request, handler) => {
      const authority = options.manager.functionSharedModelAuthority(options.root, options.role)
      const model = request.model
      const facts = typeof model === "object" && model !== null && options.models.get(model)
      if (!facts) throw new ModError("MODS_TASK_MODEL_UNAVAILABLE")
      let counter = counters.get(authority)
      if (!counter) {
        counter = { value: 0 }
        counters.set(authority, counter)
      }
      return handler({
        ...request,
        model: createModModelBoundary(
          model as BaseChatModel,
          options.manager,
          authority,
          {
            turnId: authority.turnId,
            agentId: authority.agentId,
            model: facts.model,
            outputStyle: null,
            onFinalPrompt: (text) => {
              authority.assertLive()
              try {
                options.onFinalPrompt?.(text, authority.agentId, authority.turnId)
              } catch {
                /* Read-only observation must not alter the original model execution. */
              }
            },
            ...(facts.effort !== undefined ? { effort: facts.effort } : {})
          },
          { resolve: facts.resolve },
          counter
        )
      })
    }
  })
}
