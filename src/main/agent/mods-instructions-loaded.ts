import { createMiddleware } from "langchain"

import type { LoadedInstructionSource } from "./agents-md"

export interface InstructionsLoadedOptions {
  sources: readonly LoadedInstructionSource[]
  signal?: AbortSignal
  enabled(): boolean
  assertLive(): void
  failed(error: unknown): void
  notify(
    source: LoadedInstructionSource & { load_reason: "session_start" },
    signal: AbortSignal
  ): Promise<void>
}

/** Observational notification: no output or error may gate the original model. */
export function createInstructionsLoadedMiddleware(options: InstructionsLoadedOptions) {
  const sources = options.sources.map((source) => ({ ...source }))
  const lifetime = new AbortController()
  let started = false
  return createMiddleware({
    name: "instructionsLoaded",
    beforeModel(_state, runtime) {
      void _state
      if (started || !options.enabled() || !sources.length) return undefined
      started = true
      const signal = AbortSignal.any(
        [lifetime.signal, options.signal, runtime.signal, AbortSignal.timeout(10_000)].filter(
          (value): value is AbortSignal => !!value
        )
      )
      void (async () => {
        for (const source of sources) {
          signal.throwIfAborted()
          options.assertLive()
          await options.notify({ ...source, load_reason: "session_start" }, signal)
          signal.throwIfAborted()
          options.assertLive()
        }
      })().catch((error: unknown) => {
        if (!signal.aborted) options.failed(error)
      })
      return undefined
    },
    afterAgent() {
      lifetime.abort()
      return undefined
    },
    async wrapModelCall(request, handler) {
      try {
        return await handler(request)
      } catch (error) {
        lifetime.abort(error)
        throw error
      }
    }
  })
}
