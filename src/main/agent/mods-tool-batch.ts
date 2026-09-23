import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"

import type { ClassicToolBatchCall } from "../../shared/mods/v2/classic"
export type FunctionToolBatchCall = ClassicToolBatchCall

export interface FunctionToolBatchOptions {
  signal?: AbortSignal
  enabled(): boolean
  assertLive(): void
  notify(calls: FunctionToolBatchCall[], signal: AbortSignal): Promise<string | undefined>
}

/** Main-runtime only. Observes batches produced here, never replays transcript history. */
export function createFunctionToolBatchMiddleware(options: FunctionToolBatchOptions) {
  let pending:
    | {
        key: string
        calls: FunctionToolBatchCall[]
        result?: Promise<string | undefined>
      }
    | undefined
  return createMiddleware({
    name: "functionToolBatch",
    afterModel(state) {
      if (!options.enabled()) {
        pending = undefined
        return undefined
      }
      const message = state.messages.at(-1)
      if (!message || !AIMessage.isInstance(message)) return undefined
      const calls = message.tool_calls
      if (
        !calls?.length ||
        calls.length > 128 ||
        calls.some((call) => !call.id || !call.name) ||
        new Set(calls.map((call) => call.id)).size !== calls.length
      ) {
        pending = undefined
        return undefined
      }
      const key = JSON.stringify([message.id, calls.map((call) => call.id)])
      if (pending?.key !== key)
        pending = {
          key,
          calls: calls.map((call) => ({
            tool_name: call.name,
            tool_input: call.args,
            tool_use_id: call.id!
          }))
        }
      return undefined
    },
    async wrapModelCall(request, handler) {
      if (!options.enabled() || !pending) return handler(request)
      const current = pending
      const signals = [options.signal, request.runtime.signal].filter((s): s is AbortSignal => !!s)
      const signal = AbortSignal.any(signals)
      signal.throwIfAborted()
      options.assertLive()
      if (!current.result) {
        const outputs = new Map<string, unknown>()
        // Only responses following this observed AI batch belong to it.
        let start = -1
        for (let index = request.state.messages.length - 1; index >= 0; index--) {
          const message = request.state.messages[index]
          if (AIMessage.isInstance(message)) {
            const key = JSON.stringify([message.id, message.tool_calls?.map((call) => call.id)])
            if (key === current.key) start = index + 1
            break
          }
        }
        if (start < 0) return handler(request)
        for (const message of request.state.messages.slice(start))
          if (ToolMessage.isInstance(message)) outputs.set(message.tool_call_id, message.content)
        if (!current.calls.every((call) => outputs.has(call.tool_use_id))) return handler(request)
        const completed = current.calls.map((call) => ({
          ...call,
          tool_response: outputs.get(call.tool_use_id)
        }))
        // Retain the promise, including failures: retries never duplicate hook side effects.
        current.result = Promise.resolve().then(() => {
          signal.throwIfAborted()
          options.assertLive()
          return options.notify(completed, signal)
        })
      }
      const context = await current.result
      signal.throwIfAborted()
      options.assertLive()
      return handler(
        context
          ? { ...request, systemMessage: request.systemMessage.concat(`\n\n${context}`) }
          : request
      )
    }
  })
}
