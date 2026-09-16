import { randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { normalizeFunctionInput } from "../../../shared/mods/v2/pinned-input"
import {
  MOD_TIERS,
  ModFunctionError,
  isModObject,
  matchesEventPattern,
  type ModOrigin,
  type FunctionHostReply
} from "../../../shared/mods/v2/contracts"
import type { FunctionPlugin } from "./dispatcher"
import { ModPullChannel } from "./pull-channel"

export type ModHookStream = AsyncGenerator<ModJson, ModJson> & { result: Promise<ModJson> }
export interface FunctionStreamOptions {
  origin?: ModOrigin
  signal?: AbortSignal
  timeoutMs?: number
  core(
    input: ModObject,
    context: { callId: string; signal: AbortSignal }
  ): AsyncGenerator<ModJson, ModJson>
  validateChunk?(chunk: ModJson): void
  validateInput?(input: ModObject): void
}

/** Chunks and generator return values travel separately; no whole-response buffering in the bridge. */
export function dispatchFunctionStream(
  plugins: readonly FunctionPlugin[],
  input: ModObject,
  options: FunctionStreamOptions
): ModHookStream {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const origin = options.origin ?? { plugin: "engine", tier: "core" }
  const chain = [...plugins]
    .sort((a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier))
    .flatMap((plugin) =>
      plugin.guest.registrations
        .filter((r) => matchesEventPattern(r.pattern, "turn.step"))
        .map((registration) => ({ plugin, registration }))
    )
  let requests = 0
  const run = async function* (
    index: number,
    received: ModObject
  ): AsyncGenerator<ModJson, ModJson> {
    signal.throwIfAborted()
    options.validateInput?.(received)
    if (index === chain.length) {
      if (++requests > 32)
        throw new ModFunctionError("MODS_MODEL_REQUEST_LIMIT", "MODS_MODEL_REQUEST_LIMIT", true)
      try {
        return yield* options.core(received, { callId: randomUUID(), signal })
      } catch (error) {
        throw new ModFunctionError(
          "MODS_DOWNSTREAM_REJECTED",
          error instanceof Error ? error.message : "MODS_STREAM_ERROR",
          true
        )
      }
    }
    const { plugin, registration } = chain[index]
    let matches = false
    try {
      matches = await plugin.guest.matches(registration.id, received)
    } catch {
      // A failing matcher skips only this optional hook, never catches downstream errors.
    }
    if (!matches) return yield* run(index + 1, received)
    const streams = new Map<string, AsyncGenerator<ModJson, ModJson>>()
    let last: { id: string; stream: AsyncGenerator<ModJson, ModJson>; value?: ModJson } | undefined
    let recovering = false
    const invoke = async function* (caught?: {
      message: string
      called: boolean
    }): AsyncGenerator<ModJson, ModJson | undefined> {
      const channel = new ModPullChannel()
      let returned: ModJson | undefined
      const abort = (): void => channel.end(new ModFunctionError("MODS_CANCELLED"))
      signal.addEventListener("abort", abort, { once: true })
      const host = async (method: string, args: ModJson): Promise<FunctionHostReply> => {
        signal.throwIfAborted()
        if (!isModObject(args)) throw new ModFunctionError("MODS_STREAM_ARGUMENT")
        if (method === "stream.yield") {
          if (args.chunk === undefined) throw new ModFunctionError("MODS_STREAM_CHUNK")
          options.validateChunk?.(args.chunk)
          await channel.send(args.chunk)
          return {}
        }
        if (method === "stream.open") {
          if (recovering && last) return { value: { id: last.id } }
          if (!isModObject(args.input)) throw new ModFunctionError("MODS_NEXT_ARGUMENT")
          if (streams.size >= 32) throw new ModFunctionError("MODS_STREAM_LIMIT")
          let target = index + 1
          if (args.tier !== undefined) {
            const allowed =
              plugin.tier === "prepend"
                ? ["append", "builtin", "core"]
                : plugin.tier === "append"
                  ? ["core"]
                  : []
            if (typeof args.tier !== "string" || !allowed.includes(args.tier))
              throw new ModFunctionError("MODS_TIER_DENIED")
            while (
              target < chain.length &&
              MOD_TIERS.indexOf(chain[target].plugin.tier) <
                MOD_TIERS.indexOf(args.tier as typeof plugin.tier)
            )
              target++
          }
          const id = randomUUID()
          const stream = run(
            target,
            normalizeFunctionInput(
              "turn.step",
              parseModJson(encodeModJson(args.input)) as ModObject,
              input
            )
          )
          streams.set(id, stream)
          last = { id, stream }
          return { value: { id } }
        }
        if (
          (method === "stream.pull" || method === "stream.close") &&
          typeof args.id === "string"
        ) {
          const stream = streams.get(args.id)
          if (!stream) throw new ModFunctionError("MODS_STREAM_MISSING")
          // Keep the host cursor until the hook settles: a failed transforming hook
          // must be able to continue the remaining downstream stream without replay.
          if (method === "stream.close") return {}
          if (last?.id === args.id && last.value !== undefined)
            return { value: { done: true, value: last.value } }
          const item = await stream.next()
          if (item.done && last?.id === args.id) last.value = item.value
          return {
            value:
              item.value === undefined
                ? { done: !!item.done }
                : { done: !!item.done, value: item.value }
          }
        }
        throw new ModFunctionError("MODS_CAPABILITY_DENIED")
      }
      const running = plugin.guest
        .invoke(registration.id, received, host, {
          event: "turn.step",
          origin,
          plugin: { name: plugin.name, root: plugin.root },
          capabilities: [],
          streaming: true,
          signal,
          timeoutMs: options.timeoutMs ?? 120000,
          ...(caught ? { caught } : {})
        })
        .then(
          (answer) => {
            returned = answer.value
            channel.end()
          },
          (error) =>
            channel.end(error instanceof Error ? error : new ModFunctionError("MODS_STREAM_ERROR"))
        )
      try {
        while (true) {
          const item = await channel.next()
          if (item.done) break
          yield item.value
        }
        await running
        return returned
      } finally {
        signal.removeEventListener("abort", abort)
        channel.end(new ModFunctionError("MODS_STREAM_CLOSED"))
      }
    }
    try {
      try {
        const returned = yield* invoke()
        if (returned !== undefined) return returned
        if (last?.value !== undefined) return last.value
        return null
      } catch (error) {
        if (signal.aborted || (error instanceof ModFunctionError && error.downstream)) throw error
        recovering = true
        if (registration.hasCatch && !plugin.guest.stats.disposed) {
          try {
            const recovered = yield* invoke({
              message: error instanceof Error ? error.message : "MODS_HOOK_FAILED",
              called: !!last
            })
            if (recovered !== undefined) return recovered
          } catch (recoveryError) {
            if (
              signal.aborted ||
              (recoveryError instanceof ModFunctionError && recoveryError.downstream)
            )
              throw recoveryError
          }
        }
        if (last?.value !== undefined) return last.value
        if (last) return yield* last.stream
        return yield* run(index + 1, received)
      }
    } finally {
      for (const stream of streams.values()) await stream.return(null)
      streams.clear()
    }
  }
  let settle!: (value: ModJson) => void
  let fail!: (error: unknown) => void
  const result = new Promise<ModJson>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  void result.catch(() => {})
  const output = (async function* (): AsyncGenerator<ModJson, ModJson> {
    let complete = false
    try {
      const value = yield* run(0, parseModJson(encodeModJson(input)) as ModObject)
      complete = true
      settle(value)
      return value
    } catch (error) {
      fail(error)
      throw error
    } finally {
      controller.abort(new ModFunctionError("MODS_STREAM_CLOSED"))
      if (!complete) fail(new ModFunctionError("MODS_STREAM_CLOSED"))
    }
  })() as ModHookStream
  const close = output.return.bind(output)
  Object.defineProperty(output, "return", {
    value: (value: ModJson) => {
      controller.abort(new ModFunctionError("MODS_STREAM_CLOSED"))
      fail(new ModFunctionError("MODS_STREAM_CLOSED"))
      return close(value)
    }
  })
  Object.defineProperty(output, "result", { value: result })
  return output
}
