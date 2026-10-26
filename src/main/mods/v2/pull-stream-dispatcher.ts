import { randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCapabilitySource } from "./capability-source"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  MOD_TIERS,
  ModFunctionError,
  isModObject,
  matchesEventPattern,
  type FunctionHostCall,
  type FunctionHostReply,
  type ModOrigin
} from "../../../shared/mods/v2/contracts"
import type { FunctionPlugin } from "./dispatcher"
import type { ModHookStream, FunctionStreamTransport } from "./stream-dispatcher"
import { FunctionStreamCursor, type FunctionStreamOwner } from "./stream-cursor"
import { boundFunctionStream } from "./bounded-stream"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { trackHostStreamTerminal } from "./host-stream-lifetime"

export interface FunctionPullStreamOptions {
  transport?: FunctionStreamTransport
  origin?: ModOrigin
  signal?: AbortSignal
  timeoutMs?: number
  dispatchCutNs?: string
  core(
    input: ModObject,
    context: { signal: AbortSignal; callId: string }
  ): AsyncGenerator<ModJson, ModJson>
  validateInput?(input: ModObject): void
  validateChunk?(chunk: ModJson): void
  capabilities?(plugin: FunctionPlugin): string[]
  sdk?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson,
    signal: AbortSignal,
    source: FunctionCapabilitySource
  ): Promise<FunctionHostReply>
}

/** Process streams own their lifetime; each middleware pull receives a fresh bounded frame. */
export function dispatchFunctionPullStream(
  plugins: readonly FunctionPlugin[],
  input: ModObject,
  options: FunctionPullStreamOptions
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
        .filter((row) => matchesEventPattern(row.pattern, "process.spawn"))
        .map((registration) => ({ plugin, registration }))
    )
  let coreStarted = false
  const copy = (value: ModObject) => parseModJson(encodeModJson(value)) as ModObject
  const run = async function* (
    index: number,
    received: ModObject
  ): AsyncGenerator<ModJson, ModJson> {
    signal.throwIfAborted()
    options.validateInput?.(received)
    if (index === chain.length) {
      if (coreStarted) throw new ModFunctionError("MODS_PROCESS_ALREADY_STARTED", undefined, true)
      coreStarted = true
      try {
        return yield* options.core(copy(received), { signal, callId: randomUUID() })
      } catch (error) {
        throw new ModFunctionError(
          error instanceof ModFunctionError ? error.code : "MODS_DOWNSTREAM_REJECTED",
          error instanceof Error ? error.message : "MODS_STREAM_ERROR",
          true
        )
      }
    }
    const { plugin, registration } = chain[index]
    let matched = false
    try {
      matched = await plugin.guest.matches(registration.id, received)
    } catch {
      /* Optional matcher failure skips this hook. */
    }
    if (!matched) return yield* run(index + 1, received)
    let downstream: FunctionStreamCursor | undefined
    let downstreamId: string | undefined
    let downstreamDone = false
    let downstreamValue: ModJson | undefined
    let downstreamClosed = false
    let recovering = false
    let cursor: number | undefined
    const closeDownstream = async (): Promise<void> => {
      if (!downstream || downstreamClosed) return
      downstreamClosed = true
      await downstream.close()
    }
    const handleHost =
      (owner: FunctionStreamOwner): FunctionHostCall =>
      async (method, args, pullSignal): Promise<FunctionHostReply> => {
        if (method === "stream.close") {
          if (!isModObject(args) || args.id !== downstreamId)
            throw new ModFunctionError("MODS_STREAM_MISSING")
          // Only the native outer finally closes it. An optional failed hook keeps its input.
          return {}
        }
        signal.throwIfAborted()
        pullSignal.throwIfAborted()
        owner.signal.throwIfAborted()
        if (method === "stream.open") {
          if (!isModObject(args) || !isModObject(args.input))
            throw new ModFunctionError("MODS_NEXT_ARGUMENT")
          if (recovering && downstreamId) return { value: { id: downstreamId } }
          if (downstream) throw new ModFunctionError("MODS_NEXT_ALREADY_CALLED")
          const nextInput = copy(args.input)
          options.validateInput?.(nextInput)
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
          downstream = new FunctionStreamCursor(run(target, nextInput), signal, options.transport)
          downstreamId = randomUUID()
          return { value: { id: downstreamId } }
        }
        if (method === "stream.accept") {
          if (
            !isModObject(args) ||
            args.id !== downstreamId ||
            typeof args.receipt !== "string" ||
            !downstream
          )
            throw new ModFunctionError("MODS_STREAM_RECEIPT_INVALID")
          downstream.accept(owner, args.receipt)
          return {}
        }
        if (method === "stream.pull") {
          if (!isModObject(args) || args.id !== downstreamId || !downstream || downstreamClosed)
            throw new ModFunctionError("MODS_STREAM_MISSING")
          const { item, receipt } = await downstream.read(owner)
          pullSignal.throwIfAborted()
          return {
            value: {
              done: !!item.done,
              receipt,
              ...(item.value === undefined ? {} : { value: item.value })
            }
          }
        }
        if (options.sdk)
          return options.sdk(plugin, method, args, pullSignal, {
            event: "process.spawn",
            registration: registration.id,
            identity: registration
          })
        throw new ModFunctionError("MODS_CAPABILITY_DENIED")
      }
    const host = (owner: FunctionStreamOwner): FunctionHostCall => {
      const handle = handleHost(owner)
      return (method, args, signal) => {
        const actual = () => handle(method, args, signal)
        return options.transport ? options.transport.run(actual) : actual()
      }
    }
    const invoke = async (
      action: "open" | "next" | "return",
      caught?: { message?: string; called: boolean; kind?: "throw" | "timeout"; budget?: number }
    ) => {
      const frameController = new AbortController()
      const owner = { signal: frameController.signal }
      try {
        const answer = await plugin.guest.invoke(
          action === "open" ? registration.id : "",
          received,
          host(owner),
          {
            event: "process.spawn",
            origin,
            plugin: { name: plugin.name, root: plugin.root },
            modelProtocol: plugin.modelProtocol ?? "result-v1",
            capabilities: options.capabilities?.(plugin) ?? [],
            streamCursor: { action, ...(cursor === undefined ? {} : { id: cursor }) },
            ...(action === "return" ? {} : { signal }),
            timeoutMs: action === "return" ? 1000 : (options.timeoutMs ?? 120000),
            ownBudgetMs: action === "return" ? 0 : recovering ? 1000 : 10000,
            ...(options.dispatchCutNs ? { dispatchCutNs: options.dispatchCutNs } : {}),
            ...(caught ? { caught } : {})
          }
        )
        if (!isModObject(answer.value)) throw new ModFunctionError("MODS_STREAM_CURSOR_RESULT")
        // Keep the original receipt until the transformed item is valid for publication.
        if (action === "open") {
          if (typeof answer.value.id !== "number" || !Number.isSafeInteger(answer.value.id))
            throw new ModFunctionError("MODS_STREAM_CURSOR_RESULT")
        } else if (action === "next") {
          if (typeof answer.value.done !== "boolean")
            throw new ModFunctionError("MODS_STREAM_CURSOR_RESULT")
          if (!answer.value.done) {
            if (answer.value.value === undefined) throw new ModFunctionError("MODS_STREAM_CHUNK")
            options.validateChunk?.(answer.value.value)
          }
        }
        downstream?.commit(owner)
        if (downstream?.result !== undefined) {
          downstreamDone = true
          downstreamValue = downstream.result
        }
        return answer.value
      } finally {
        frameController.abort(new ModFunctionError("MODS_INVOCATION_ENDED"))
      }
    }
    const iterate = async function* (caught?: {
      message?: string
      called: boolean
      kind?: "throw" | "timeout"
      budget?: number
    }): AsyncGenerator<ModJson, ModJson | undefined> {
      const opened = await invoke("open", caught)
      cursor = opened.id as number
      try {
        while (true) {
          const item = await invoke("next")
          if (item.done) {
            cursor = undefined
            return item.value
          }
          yield item.value!
        }
      } finally {
        if (cursor !== undefined && !plugin.guest.stats.disposed) {
          try {
            await invoke("return")
          } catch {
            /* Host-owned downstream cleanup is authoritative. */
          } finally {
            if (!plugin.guest.stats.disposed) {
              try {
                await plugin.guest.releaseStreamCursor?.(cursor)
              } catch {
                /* Disposed concurrently. */
              }
            }
          }
          cursor = undefined
        }
      }
    }
    try {
      try {
        return (yield* iterate()) ?? downstreamValue ?? null
      } catch (error) {
        if (signal.aborted || (error instanceof ModFunctionError && error.downstream)) throw error
        recovering = true
        if (registration.hasCatch && !plugin.guest.stats.disposed) {
          try {
            const value = yield* iterate({
              ...(error instanceof ModFunctionError && error.code === "MODS_HOOK_BUDGET_EXCEEDED"
                ? {}
                : { message: error instanceof Error ? error.message : "MODS_HOOK_FAILED" }),
              called: !!downstream,
              kind:
                error instanceof ModFunctionError && error.code === "MODS_HOOK_BUDGET_EXCEEDED"
                  ? "timeout"
                  : "throw",
              budget: 1000
            })
            if (value !== undefined) return value
          } catch (recoveryError) {
            if (
              signal.aborted ||
              (recoveryError instanceof ModFunctionError && recoveryError.downstream)
            )
              throw recoveryError
          }
        }
        if (downstreamDone) return downstreamValue ?? null
        if (downstream && !downstreamClosed) return yield* downstream.remaining()
        // A closing/failed transforming hook must never spawn a replacement process.
        if (downstream || coreStarted) throw error
        return yield* run(index + 1, received)
      }
    } finally {
      await closeDownstream()
    }
  }
  let settle!: (value: ModJson) => void, fail!: (error: unknown) => void
  const result = new Promise<ModJson>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  void result.catch(() => {})
  const output = (async function* (): AsyncGenerator<ModJson, ModJson> {
    let completed = false
    try {
      const value = yield* run(0, copy(input))
      completed = true
      settle(value)
      return value
    } catch (error) {
      fail(error)
      throw error
    } finally {
      controller.abort(new ModFunctionError("MODS_STREAM_CLOSED"))
      if (!completed) fail(new ModFunctionError("MODS_STREAM_CLOSED"))
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
  return boundFunctionStream(output, {
    signal: options.signal,
    deadline: () => {
      const deadline = new FunctionDispatchDeadline(options.timeoutMs ?? 120000, options.signal,
        options.dispatchCutNs, !options.dispatchCutNs)
      signal = AbortSignal.any([controller.signal, deadline.signal])
      return { value: deadline, shared: false }
    },
    cancel: (error) => {
      controller.abort(error)
      fail(error)
    }
  })
}
