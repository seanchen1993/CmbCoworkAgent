import { randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCapabilitySource } from "./capability-source"
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
import type { FunctionHookSource, FunctionPlugin } from "./dispatcher"
import { ModPullChannel } from "./pull-channel"
import { FunctionStreamCursor } from "./stream-cursor"
import { boundFunctionStream } from "./bounded-stream"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { trackHostStreamTerminal } from "./host-stream-lifetime"

export type ModHookStream = AsyncGenerator<ModJson, ModJson> & { result: Promise<ModJson> }
/** Captured by the native model owner, never supplied or selected by a guest. */
export interface FunctionStreamTransport {
  run<T>(operation: () => Promise<T>): Promise<T>
  cleanup<T>(operation: () => Promise<T>): Promise<T>
}
export interface FunctionStreamOptions {
  transport?: FunctionStreamTransport
  skip?: FunctionHookSource
  capabilities?(plugin: FunctionPlugin): string[]
  sdk?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson[],
    signal: AbortSignal,
    source: FunctionCapabilitySource
  ): Promise<FunctionHostReply>
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

async function closeFunctionCursors(streams: Map<string, FunctionStreamCursor>): Promise<void> {
  // Start every real cleanup before waiting for a provider that ignores cancellation.
  const closed = await Promise.allSettled([...streams.values()].map((stream) => stream.close()))
  streams.clear()
  const failed = closed.find((item): item is PromiseRejectedResult => item.status === "rejected")
  if (failed) throw failed.reason
}

/** Chunks and generator return values travel separately; no whole-response buffering in the bridge. */
export function dispatchFunctionStream(
  plugins: readonly FunctionPlugin[],
  input: ModObject,
  options: FunctionStreamOptions
): ModHookStream {
  const controller = new AbortController()
  let signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const origin = options.origin ?? { plugin: "engine", tier: "core" }
  const chain = [...plugins]
    .sort((a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier))
    .flatMap((plugin) =>
      plugin.guest.registrations
        .filter((r) => matchesEventPattern(r.pattern, "turn.step") &&
          !(options.skip?.plugin === plugin.name && options.skip.registration === r.id))
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
          error instanceof ModFunctionError ? error.code : "MODS_DOWNSTREAM_REJECTED",
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
    const streams = new Map<string, FunctionStreamCursor>()
    let last: { id: string; stream: FunctionStreamCursor; value?: ModJson } | undefined
    let recovering = false
    const invoke = async function* (caught?: {
      message?: string
      called: boolean
      kind?: "throw" | "timeout"
      budget?: number
    }): AsyncGenerator<ModJson, ModJson | undefined> {
      const channel = new ModPullChannel()
      const frameController = new AbortController()
      const owner = { signal: frameController.signal }
      let returned: ModJson | undefined
      const abort = (): void => channel.end(new ModFunctionError("MODS_CANCELLED"))
      signal.addEventListener("abort", abort, { once: true })
      const host = async (
        method: string, args: ModJson, callSignal: AbortSignal = signal
      ): Promise<FunctionHostReply> => {
        signal.throwIfAborted()
        callSignal.throwIfAborted()
        owner.signal.throwIfAborted()
        const operation = () => handleHost(method, args, callSignal)
        return options.transport ? options.transport.run(operation) : operation()
      }
      const handleHost = async (
        method: string, args: ModJson, callSignal: AbortSignal
      ): Promise<FunctionHostReply> => {
        signal.throwIfAborted()
        callSignal.throwIfAborted()
        if (Array.isArray(args) && options.sdk)
          return options.sdk(plugin, method, args, AbortSignal.any([signal, callSignal]), {
            event: "turn.step", registration: registration.id, identity: registration
          })
        if (!isModObject(args)) throw new ModFunctionError("MODS_STREAM_ARGUMENT")
        if (method === "stream.yield") {
          if (args.chunk === undefined) throw new ModFunctionError("MODS_STREAM_CHUNK")
          options.validateChunk?.(args.chunk)
          await channel.send(args.chunk)
          for (const cursor of streams.values()) cursor.commit(owner)
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
          const stream = new FunctionStreamCursor(run(
            target,
            normalizeFunctionInput(
              "turn.step",
              parseModJson(encodeModJson(args.input)) as ModObject,
              input
            )
          ), signal, options.transport)
          streams.set(id, stream)
          last = { id, stream }
          return { value: { id } }
        }
        if (
          (method === "stream.pull" || method === "stream.close" || method === "stream.accept") &&
          typeof args.id === "string"
        ) {
          const stream = streams.get(args.id)
          if (!stream) throw new ModFunctionError("MODS_STREAM_MISSING")
          // Keep the host cursor until the hook settles: a failed transforming hook
          // must be able to continue the remaining downstream stream without replay.
          if (method === "stream.close") return {}
          if (method === "stream.accept") {
            if (typeof args.receipt !== "string") throw new ModFunctionError("MODS_STREAM_RECEIPT_INVALID")
            stream.accept(owner, args.receipt)
            return {}
          }
          const { item, receipt } = await stream.read(owner)
          callSignal.throwIfAborted()
          return {
            value:
              item.value === undefined
                ? { done: !!item.done, receipt }
                : { done: !!item.done, value: item.value, receipt }
          }
        }
        throw new ModFunctionError("MODS_CAPABILITY_DENIED")
      }
      const running = plugin.guest
        .invoke(registration.id, received, host, {
          event: "turn.step",
          origin,
          plugin: { name: plugin.name, root: plugin.root },
          modelProtocol: plugin.modelProtocol ?? "result-v1",
          capabilities: options.capabilities?.(plugin) ?? [],
          streaming: true,
          signal,
          ownBudgetMs: caught ? 1000 : 10000,
          timeoutMs: options.timeoutMs ?? 120000,
          ...(caught ? { caught } : {})
        })
        .then(
          (answer) => {
            for (const cursor of streams.values()) cursor.commit(owner)
            if (last) last.value = last.stream.result
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
        frameController.abort(new ModFunctionError("MODS_INVOCATION_ENDED"))
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
              ...(error instanceof ModFunctionError && error.code === "MODS_HOOK_BUDGET_EXCEEDED"
                ? {} : { message: error instanceof Error ? error.message : "MODS_HOOK_FAILED" }),
              called: !!last,
              kind: error instanceof ModFunctionError && error.code === "MODS_HOOK_BUDGET_EXCEEDED" ? "timeout" : "throw",
              budget: 1000
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
        if (last) return yield* last.stream.remaining()
        return yield* run(index + 1, received)
      }
    } finally {
      await closeFunctionCursors(streams)
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
  if (!chain.length) return trackHostStreamTerminal(output)
  let sharedDeadline: FunctionDispatchDeadline | undefined
  return boundFunctionStream(output, {
    signal: options.signal,
    deadline: () => {
      sharedDeadline ??= new FunctionDispatchDeadline(options.timeoutMs ?? 120000, options.signal, undefined, true)
      signal = AbortSignal.any([controller.signal, sharedDeadline.signal])
      return { value: sharedDeadline, shared: true }
    },
    cancel: (error) => { controller.abort(error); fail(error) }
  })
}
