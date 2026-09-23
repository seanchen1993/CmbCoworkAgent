import { randomUUID } from "node:crypto"
import { ModError } from "../errors"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { normalizeFunctionInput } from "../../../shared/mods/v2/pinned-input"
import {
  MOD_TIERS,
  ModFunctionError,
  isModObject,
  matchesEventPattern,
  type FunctionHostReply,
  type FunctionGuest,
  type FunctionRegistration,
  type ModOrigin,
  type ModTier,
  type ModTraceEntry
} from "../../../shared/mods/v2/contracts"

export interface FunctionPlugin {
  name: string
  root: string
  tier: ModTier
  guest: FunctionGuest
  capabilities: string[]
}

export interface FunctionDispatchOptions {
  onlyPlugin?: string
  skip?: { plugin: string; registration: string }
  origin?: ModOrigin
  signal?: AbortSignal
  timeoutMs?: number
  operation?: boolean
  uiGeneration?: string
  capabilities?(plugin: FunctionPlugin): string[]
  normalizeInput?(event: string, input: ModObject): ModObject
  validateInput?(event: string, input: ModObject): void
  validateResult?(event: string, output: ModJson): void
  core(
    event: string,
    input: ModObject,
    context: {
      callId: string
      origin: ModOrigin
      signal?: AbortSignal
    }
  ): Promise<ModJson>
  capability?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson,
    signal: AbortSignal,
    source: { event: string; registration: string }
  ): Promise<ModJson | undefined>
}

interface ChainLink {
  plugin: FunctionPlugin
  registration: FunctionRegistration
}

/** Claude-compatible optional-hook recovery. Mandatory host policy belongs to core/capability. */
export class FunctionDispatcher {
  constructor(private readonly plugins: readonly FunctionPlugin[]) {}

  async dispatch(
    event: string,
    input: ModObject,
    options: FunctionDispatchOptions
  ): Promise<{
    value: ModJson
    trace: ModTraceEntry[]
  }> {
    const origin = options.origin ?? { plugin: "engine", tier: "core" }
    // Snapshot the chain: reload cannot change what next() means midway through a dispatch.
    const chain = [...this.plugins]
      .filter((plugin) => !options.onlyPlugin || plugin.name === options.onlyPlugin)
      .sort((a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier))
      .flatMap((plugin) =>
        plugin.guest.registrations
          .filter(
            (registration) =>
              matchesEventPattern(registration.pattern, event) &&
              !(
                options.skip?.plugin === plugin.name &&
                options.skip.registration === registration.id
              )
          )
          .map((registration) => ({ plugin, registration }))
      )
    let requests = 0
    const run = async (
      index: number,
      received: ModObject,
      trace: ModTraceEntry[],
      floor?: ModTier
    ): Promise<ModJson> => {
      if (options.signal?.aborted)
        throw new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
      received = options.normalizeInput?.(event, received) ?? received
      options.validateInput?.(event, received)
      if (index === chain.length) {
        if (++requests > 32)
          throw new ModFunctionError("MODS_DISPATCH_LIMIT", "MODS_DISPATCH_LIMIT", true)
        const entry: ModTraceEntry = {
          index,
          plugin: "engine",
          tier: "core",
          event,
          outcome: "returned",
          ms: 0,
          received
        }
        trace.push(entry)
        const start = performance.now()
        try {
          const result = await options.core(event, received, {
            callId: randomUUID(),
            origin,
            signal: options.signal
          })
          encodeModJson(result)
          options.validateResult?.(event, result)
          entry.returned = result
          return result
        } catch (error) {
          entry.outcome = "rejected"
          throw new ModFunctionError(
            error instanceof ModFunctionError || error instanceof ModError
              ? error.code
              : "MODS_DOWNSTREAM_REJECTED",
            error instanceof Error ? error.message : "MODS_CORE_ERROR",
            true
          )
        } finally {
          entry.ms = performance.now() - start
        }
      }
      const link: ChainLink = chain[index]
      const { plugin, registration } = link
      if (floor && MOD_TIERS.indexOf(plugin.tier) < MOD_TIERS.indexOf(floor)) {
        trace.push({
          index,
          plugin: plugin.name,
          tier: plugin.tier,
          event,
          outcome: "skipped",
          ms: 0,
          received,
          reason: "bypassed by next.to"
        })
        return run(index + 1, received, trace, floor)
      }
      try {
        if (!(await plugin.guest.matches(registration.id, received)))
          return run(index + 1, received, trace)
      } catch {
        // Matchers are optional guest code too; a broken matcher cannot block the host.
        trace.push({
          index,
          plugin: plugin.name,
          tier: plugin.tier,
          event,
          outcome: "skipped",
          ms: 0,
          received,
          reason: "matcher failed"
        })
        return run(index + 1, received, trace)
      }
      const entry: ModTraceEntry = {
        index,
        plugin: plugin.name,
        tier: plugin.tier,
        event,
        outcome: "returned",
        ms: 0,
        received
      }
      trace.push(entry)
      let lastNext: Promise<FunctionHostReply> | undefined
      let nextCalls = 0
      let recovering = false
      let belowMs = 0
      const belowTrace: ModTraceEntry[] = []
      const start = performance.now()
      const pending = new Set<Promise<FunctionHostReply>>()
      const host = async (
        method: string,
        args: ModJson,
        signal: AbortSignal
      ): Promise<FunctionHostReply> => {
        if (method !== "next") {
          if (
            !(options.capabilities?.(plugin) ?? plugin.capabilities).includes(method) ||
            !options.capability
          )
            throw new ModFunctionError("MODS_CAPABILITY_DENIED")
          const value = await options.capability(plugin, method, args, signal, {
            event,
            registration: registration.id
          })
          return value === undefined ? {} : { value }
        }
        // A recovery handler replays the last downstream call; it cannot accidentally repeat writes.
        if (recovering && lastNext) return lastNext
        if (!isModObject(args) || !isModObject(args.input))
          throw new ModFunctionError("MODS_NEXT_ARGUMENT")
        if (++nextCalls > 32) throw new ModFunctionError("MODS_NEXT_LIMIT")
        let target: ModTier | undefined
        if (args.tier !== undefined) {
          const allowed =
            plugin.tier === "prepend"
              ? ["append", "builtin", "core"]
              : plugin.tier === "append"
                ? ["core"]
                : []
          if (typeof args.tier !== "string" || !allowed.includes(args.tier))
            throw new ModFunctionError("MODS_TIER_DENIED")
          target = args.tier as ModTier
        }
        const nextInput = normalizeFunctionInput(
          event,
          parseModJson(encodeModJson(args.input)) as ModObject,
          input
        )
        const childTrace: ModTraceEntry[] = []
        belowTrace.splice(0, belowTrace.length)
        const began = performance.now()
        const operation = run(index + 1, nextInput, childTrace, target).then((value) => ({
          value,
          trace: childTrace
        }))
        lastNext = operation
        pending.add(operation)
        void operation
          .finally(() => {
            pending.delete(operation)
            belowMs += performance.now() - began
            if (lastNext === operation) belowTrace.splice(0, belowTrace.length, ...childTrace)
          })
          .catch(() => {})
        return operation
      }
      const invoke = (caught?: { message: string; called: boolean }) =>
        plugin.guest.invoke(registration.id, received, host, {
          event,
          origin,
          capabilities: options.capabilities?.(plugin) ?? plugin.capabilities,
          plugin: { name: plugin.name, root: plugin.root },
          ...(options.operation ? { operation: true } : {}),
          ...(options.uiGeneration ? { uiGeneration: options.uiGeneration } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(caught ? { caught } : {})
        })
      const validate = (value: ModJson | undefined): ModJson => {
        if (value === undefined) throw new ModFunctionError("MODS_RETURN_UNDEFINED")
        encodeModJson(value)
        options.validateResult?.(event, value)
        return value
      }
      try {
        let result: ModJson
        try {
          result = validate((await invoke()).value)
        } catch (error) {
          if (
            error instanceof ModFunctionError &&
            (error.downstream || error.code === "MODS_CANCELLED")
          )
            throw error
          // Catch receives a settled latest next, even when the original handler returned early.
          if (lastNext) await lastNext.catch(() => {})
          recovering = true
          let recovered: ModJson | undefined
          if (registration.hasCatch && !plugin.guest.stats.disposed) {
            try {
              const answer = await invoke({
                message: error instanceof Error ? error.message : "MODS_HOOK_FAILED",
                called: !!lastNext
              })
              if (!answer.absent) recovered = validate(answer.value)
            } catch {
              // Failed recovery has the same skipped/kept fallback as an absent recovery handler.
            }
          }
          if (recovered !== undefined) {
            entry.outcome = "caught"
            result = recovered
          } else if (lastNext) {
            entry.outcome = "kept"
            result = validate((await lastNext).value)
          } else {
            entry.outcome = "skipped"
            result = await run(index + 1, received, belowTrace)
          }
        }
        // Actual downstream effects settle independently of whether the hook used their result.
        await Promise.allSettled([...pending])
        entry.returned = result
        return result
      } catch (error) {
        entry.outcome = "rejected"
        throw error
      } finally {
        entry.ms = Math.max(0, performance.now() - start - belowMs)
        trace.push(...belowTrace)
      }
    }
    const trace: ModTraceEntry[] = []
    const value = await run(0, parseModJson(encodeModJson(input)) as ModObject, trace)
    return { value, trace }
  }
}
