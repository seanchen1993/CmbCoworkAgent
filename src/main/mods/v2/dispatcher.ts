import type { FunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
import { randomUUID } from "node:crypto"
import { ModError } from "../errors"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCapabilitySource } from "./capability-source"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { normalizeFunctionInput } from "../../../shared/mods/v2/pinned-input"
import { synchronizePromptContext } from "../../../shared/mods/v2/prompt-context"
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
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { hasComposerPreparationActivity, retainComposerPreparationWork } from "./composer-preparation-activity"

export interface FunctionPlugin {
  readonly modelProtocol?: FunctionModelProtocol
  name: string
  root: string
  tier: ModTier
  guest: FunctionGuest
  capabilities: string[]
  environment?: import("./environment-sdk").FunctionEnvironmentDeclaration
}

/** A host-captured handler identity; never a guest-supplied execution option. */
export interface FunctionHookSource {
  plugin: string
  registration: string
}

export interface FunctionDispatchOptions {
  /** Retain the real host effect until its actual finally, even when caller waiting is cut. */
  retainHost?<T>(run: () => Promise<T>): Promise<T>
  beforeHook?(plugin: FunctionPlugin, input: ModObject): void
  /** Read-only notification results never become host facts, including undefined hook returns. */
  observerResult?: ModJson
  validateChain?(plugins: readonly FunctionPlugin[]): void
  /** Explicit Claw actions cannot use optional-hook error recovery for their provider. */
  strictPlugin?: string
  /** A private reload candidate must not adopt an incomplete recovered registration set. */
  strict?: boolean
  onlyPlugin?: string
  /** Config SDK calls bypass all config handlers belonging to their actual caller. */
  excludePlugin?: string
  skip?: { plugin: string; registration: string }
  additionalSkip?: FunctionHookSource
  origin?: ModOrigin
  signal?: AbortSignal
  timeoutMs?: number
  /** End-only shared native cut, inherited by nested dispatch without restarting its clock. */
  dispatchCutNs?: string
  platformUiOpen?: boolean
  platformCleanup?: boolean
  operation?: boolean
  uiGeneration?: string
  capabilities?(plugin: FunctionPlugin): string[]
  normalizeInput?(event: string, input: ModObject): ModObject
  validateInput?(event: string, input: ModObject): void
  validateResult?(event: string, output: ModJson): void
  /** Host-owned parsing after hook normalization and before every result validation. */
  parseResult?(event: string, output: ModJson): ModJson
  normalizeResult?(event: string, output: ModJson, baseline: ModJson): ModJson
  protectInput?(input: ModObject): Promise<ModObject>
  protectResult?(output: ModJson): Promise<ModJson>
  /** Observe only this actual Core result and its corresponding protected publication. */
  observeCorePublication?(original: ModJson, protectedValue: ModJson): void
  propagateDownstreamFailures?: boolean
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
    source: FunctionCapabilitySource
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
    // These are the original host promises, before deadline.wait can stop guest waiting.
    if (hasComposerPreparationActivity()) {
      const original = options, core = original.core
      const protectInput = original.protectInput, protectResult = original.protectResult
      options = {
      ...original,
      core: (name, received, context) => retainComposerPreparationWork(() =>
        Reflect.apply(core, original, [name, received, context])),
      ...(protectInput ? { protectInput: (value: ModObject) =>
        retainComposerPreparationWork(() => Reflect.apply(protectInput, original, [value])) } : {}),
      ...(protectResult ? { protectResult: (value: ModJson) =>
        retainComposerPreparationWork(() => Reflect.apply(protectResult, original, [value])) } : {})
      }
    }
    // A host with no relevant guest retains its original native operation lifetime.
    if (!options.dispatchCutNs && !this.plugins.some((plugin) => plugin.guest.registrations.some((registration) =>
      matchesEventPattern(registration.pattern, event))))
      return this.dispatchWithin(event, input, options)
    const deadline = new FunctionDispatchDeadline(
      options.timeoutMs ?? (event === "session.end" ? 1500 : 120000),
      options.signal, options.dispatchCutNs
    )
    const entered = <T>(run: () => Promise<T>): Promise<T> => {
      deadline.assertLive()
      return options.retainHost ? options.retainHost(run) : run()
    }
    const bounded: FunctionDispatchOptions = {
      ...options,
      ...(event === "session.end" || options.dispatchCutNs ? { dispatchCutNs: deadline.sharedCutNs } : {}),
      signal: deadline.signal,
      core: (name, received, context) => deadline.wait(entered(() => options.core(name, received, context))),
      ...(options.capability ? { capability: (plugin, method, args, signal, source) =>
        deadline.wait(entered(() => options.capability!(plugin, method, args, signal, source))) } : {}),
      ...(options.protectInput ? { protectInput: (value) =>
        deadline.wait(entered(() => options.protectInput!(value))) } : {}),
      ...(options.protectResult ? { protectResult: (value) =>
        deadline.wait(entered(() => options.protectResult!(value))) } : {})
    }
    try {
      return await deadline.wait(this.dispatchWithin(event, input, bounded, deadline))
    } finally {
      deadline.close()
    }
  }

  private async dispatchWithin(
    event: string,
    input: ModObject,
    options: FunctionDispatchOptions,
    deadline?: FunctionDispatchDeadline
  ): Promise<{ value: ModJson; trace: ModTraceEntry[] }> {
    const wait = <T>(actual: Promise<T>): Promise<T> => deadline ? deadline.wait(actual) : actual
    const origin = options.origin ?? { plugin: "engine", tier: "core" }
    // Snapshot the chain: reload cannot change what next() means midway through a dispatch.
    const chain = [...this.plugins]
      .filter((plugin) => !options.onlyPlugin || plugin.name === options.onlyPlugin)
      .filter((plugin) => plugin.name !== options.excludePlugin)
      .sort((a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier))
      .flatMap((plugin) =>
        plugin.guest.registrations
          .filter(
            (registration) =>
              matchesEventPattern(registration.pattern, event) &&
              !(
                options.skip?.plugin === plugin.name &&
                options.skip.registration === registration.id
              ) &&
              !(options.additionalSkip?.plugin === plugin.name &&
                options.additionalSkip.registration === registration.id)
          )
          .map((registration) => ({ plugin, registration }))
      )
    options.validateChain?.(chain.map((link) => link.plugin))
    let requests = 0
    const run = async (
      index: number,
      received: ModObject,
      trace: ModTraceEntry[],
      floor?: ModTier
    ): Promise<ModJson> => {
      deadline?.assertLive()
      if (options.signal?.aborted)
        throw new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
      received = options.normalizeInput?.(event, received) ?? received
      options.validateInput?.(event, received)
      if (options.protectInput) {
        try {
          received = await wait(options.protectInput(received))
          options.validateInput?.(event, received)
        } catch (error) {
          throw new ModFunctionError("MODS_PROMPT_PUBLICATION_FAILED",
            error instanceof Error ? error.message : "MODS_PROMPT_PUBLICATION_FAILED", true)
        }
      }
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
          let result = await wait(options.core(event, received, {
            callId: randomUUID(),
            origin,
            signal: options.signal
          }))
          encodeModJson(result)
          result = options.parseResult?.(event, result) ?? result
          options.validateResult?.(event, result)
          const coreSnapshot = options.observeCorePublication
            ? { value: parseModJson(encodeModJson(result)) as ModJson } : undefined
          if (options.protectResult) {
            result = await wait(options.protectResult(result))
            result = options.parseResult?.(event, result) ?? result
            options.validateResult?.(event, result)
          }
          if (coreSnapshot) options.observeCorePublication!(coreSnapshot.value, result)
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
        if (!(await wait(Promise.resolve(plugin.guest.matches(registration.id, received)))))
          return run(index + 1, received, trace)
      } catch (error) {
        if (options.strict) throw error
        if (plugin.name === options.strictPlugin)
          throw new ModFunctionError(
            "CLAW_ACTION_MATCHER_FAILED",
            "CLAW_ACTION_MATCHER_FAILED",
            true
          )
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
      let lastReturned: ModJson | undefined
      let lastNextFailure: unknown
      let nextCalls = 0
      let recovering = false
      let belowMs = 0
      const belowTrace: ModTraceEntry[] = []
      const start = performance.now()
      const pending = new Set<Promise<FunctionHostReply>>()
      const issued: Promise<FunctionHostReply>[] = []
      const host = async (
        method: string,
        args: ModJson,
        signal: AbortSignal
      ): Promise<FunctionHostReply> => {
        deadline?.assertLive()
        signal.throwIfAborted()
        if (method === "invoke.admitted" && options.beforeHook) {
          signal.throwIfAborted()
          options.signal?.throwIfAborted()
          options.beforeHook(plugin, received)
          return {}
        }
        if (method !== "next") {
          if (
            !(options.capabilities?.(plugin) ?? plugin.capabilities).includes(method) ||
            !options.capability
          )
            throw new ModFunctionError("MODS_CAPABILITY_DENIED")
          const value = await options.capability(plugin, method, args, signal, {
            event,
            registration: registration.id,
            identity: registration
          })
          return value === undefined ? {} : { value }
        }
        // A recovery handler replays the last downstream call; it cannot accidentally repeat writes.
        if ((recovering || event === "prompt.mention") && lastNext) return lastNext
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
        let nextInput = normalizeFunctionInput(
          event,
          parseModJson(encodeModJson(args.input)) as ModObject,
          input
        )
        if (event === "prompt.context")
          nextInput = synchronizePromptContext(nextInput, received)
        const childTrace: ModTraceEntry[] = []
        const issuedIndex = nextCalls
        belowTrace.splice(0, belowTrace.length)
        const began = performance.now()
        // Publish this event's first promise before entering any downstream source.
        const downstream = event === "prompt.mention"
          ? Promise.resolve().then(() => run(index + 1, nextInput, childTrace, target))
          : run(index + 1, nextInput, childTrace, target)
        const operation = downstream.then((value) => {
          if (nextCalls === issuedIndex) {
            lastReturned = value
            lastNextFailure = undefined
          }
          return { value, trace: childTrace }
        }, (error) => {
          if (nextCalls === issuedIndex) lastNextFailure = error
          throw error
        })
        lastNext = operation
        pending.add(operation)
        issued.push(operation)
        void operation
          .finally(() => {
            pending.delete(operation)
            belowMs += performance.now() - began
            if (lastNext === operation) belowTrace.splice(0, belowTrace.length, ...childTrace)
          })
          .catch(() => {})
        return operation
      }
      const invoke = (caught?: { message?: string; called: boolean; kind: "throw" | "timeout"; budget: number }) => {
        deadline?.assertLive()
        return plugin.guest.invoke(registration.id, received, host, {
          event,
          origin,
          capabilities: options.capabilities?.(plugin) ?? plugin.capabilities,
          plugin: { name: plugin.name, root: plugin.root },
          modelProtocol: plugin.modelProtocol ?? "result-v1",
          ownBudgetMs: caught ? 1000 : event === "engine.create" ? 0 : 10000,
          ...(options.dispatchCutNs ? { dispatchCutNs: options.dispatchCutNs } : {}),
          ...(options.platformUiOpen ? { platformUiOpen: true } : {}),
          ...(options.platformCleanup ? { platformCleanup: true } : {}),
          ...(options.operation ? { operation: true } : {}),
          ...(options.uiGeneration ? { uiGeneration: options.uiGeneration } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.beforeHook ? { admission: true } : {}),
          ...(caught ? { caught } : {})
        })
      }
      const validate = (value: ModJson | undefined): ModJson => {
        if (options.observerResult !== undefined) return options.observerResult
        if (value === undefined) throw new ModFunctionError("MODS_RETURN_UNDEFINED")
        encodeModJson(value)
        value = options.normalizeResult?.(event, value, lastReturned ?? received) ?? value
        value = options.parseResult?.(event, value) ?? value
        options.validateResult?.(event, value)
        return value
      }
      try {
        let result: ModJson
        try {
          result = validate((await wait(invoke())).value)
        } catch (error) {
          if (options.strict) throw error
          if (
            error instanceof ModFunctionError &&
            (error.downstream || error.code === "MODS_CANCELLED")
          )
            throw error
          if (plugin.name === options.strictPlugin)
            throw new ModFunctionError("CLAW_ACTION_FAILED", "CLAW_ACTION_FAILED", true)
          // Catch receives a settled latest next, even when the original handler returned early.
          if (lastNext) await wait(lastNext.catch(() => {}))
          recovering = true
          let recovered: ModJson | undefined
          if (registration.hasCatch && !plugin.guest.stats.disposed) {
            try {
              const timedOut = error instanceof ModFunctionError &&
                ["MODS_HOOK_BUDGET_EXCEEDED", "MODS_BUDGET_EXCEEDED"].includes(error.code)
              const answer = await wait(invoke({
                ...(timedOut ? lastNextFailure instanceof Error
                  ? { message: lastNextFailure.message } : {}
                  : { message: error instanceof Error ? error.message : "MODS_HOOK_FAILED" }),
                called: !!lastNext,
                kind: timedOut ? "timeout" : "throw",
                budget: 1000
              }))
              if (!answer.absent) recovered = validate(answer.value)
            } catch (error) {
              if (
                error instanceof ModFunctionError &&
                (error.downstream || error.code === "MODS_CANCELLED")
              )
                throw error
              // Ordinary optional recovery failures retain the skipped/kept fallback.
            }
          }
          if (recovered !== undefined) {
            entry.outcome = "caught"
            result = recovered
          } else if (lastNext) {
            entry.outcome = "kept"
            result = validate((await wait(lastNext)).value)
          } else {
            entry.outcome = "skipped"
            result = await run(index + 1, received, belowTrace)
          }
        }
        // Actual downstream effects settle independently of whether the hook used their result.
        const settled = await wait(Promise.allSettled(options.propagateDownstreamFailures ? issued : [...pending]))
        if (options.propagateDownstreamFailures) {
          for (const answer of settled) {
            if (answer.status === "rejected" && answer.reason instanceof ModFunctionError &&
              (answer.reason.downstream || answer.reason.code === "MODS_CANCELLED"))
              throw answer.reason
          }
        }
        if (options.protectResult) {
          try {
            result = await wait(options.protectResult(result))
            result = options.parseResult?.(event, result) ?? result
            options.validateResult?.(event, result)
          } catch (error) {
            throw new ModFunctionError("MODS_PROMPT_PUBLICATION_FAILED",
              error instanceof Error ? error.message : "MODS_PROMPT_PUBLICATION_FAILED", true)
          }
        }
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
