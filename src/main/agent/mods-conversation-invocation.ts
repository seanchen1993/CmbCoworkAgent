import { BaseMessage } from "@langchain/core/messages"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import type { RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import { FUNCTION_CONVERSATION_CHANNEL, readFunctionConversationState } from
  "../checkpointer/function-conversation-delivery"
import { prepareFunctionConversationIntake, type FunctionConversationGraphBinding } from
  "./mods-conversation"
import type { FunctionConversationIntakePublication } from "./mods-conversation"
import { captureNativeMessageForOccurrence } from "./native-message-capture"
import { preflightFunctionConversationMessage } from "./function-conversation-message-preflight"
import { captureConversationCheckpointRead, readFunctionConversationCheckpointMembership,
  type FunctionConversationCheckpointMembershipProof } from
  "../checkpointer/function-conversation-checkpoint-membership"
import { createNativeEventStream } from "./native-event-stream"
import { readFunctionConversationNativeAgentDerivation,
  type FunctionNativeAgentDerivation } from "./native-agent-factory"

const derivations = new WeakMap<object, FunctionNativeAgentDerivation>()
const derivationWeakGet = WeakMap.prototype.get, derivationWeakSet = WeakMap.prototype.set
export function readFunctionConversationInvocationDerivation(
  invocation: object
): FunctionNativeAgentDerivation | undefined {
  return Reflect.apply(derivationWeakGet, derivations, [invocation]) as
    FunctionNativeAgentDerivation | undefined
}

interface Host {
  readonly store: FunctionConversationStore
  readonly binding: FunctionConversationGraphBinding
  readonly history?: {
    readonly saver: SqlJsSaver
    assertCurrent(): void
    register(messages: readonly BaseMessage[], proof: FunctionConversationCheckpointMembershipProof): void
  }
  onIntakeNotes?(publication: FunctionConversationIntakePublication): void
}

/** Native graph input only. Command and null resume keep their original graph semantics. */
export function wrapFunctionConversationInvocation<T extends object>(graph: T, host: Host): T {
  const actual = graph as T & { graph?: object }
  const nativeDerivation = readFunctionConversationNativeAgentDerivation(graph)
  const nativeGraph = nativeDerivation?.graph ?? actual.graph ?? actual
  const readState = Reflect.get(nativeGraph, "getState")
  if (typeof readState !== "function")
    throw new ModFunctionError("MODS_CONVERSATION_GRAPH_REQUIRED")
  const getState = readState.bind(nativeGraph) as
    (config: RunnableConfig) => Promise<{ values: unknown; config?: RunnableConfig }>
  const methods = new Map<PropertyKey, unknown>()
  let deriving: { failed: boolean } | undefined
  const derive = (config: RunnableConfig, originalMethod?: (...args: unknown[]) => unknown,
    cancellation = false) => {
    if (deriving) {
      deriving.failed = true
      throw new ModFunctionError("MODS_CONVERSATION_GRAPH_REQUIRED")
    }
    const operation = { failed: false }
    deriving = operation
    try {
      host.binding.assertCurrent()
      const derived = nativeDerivation ? cancellation
        ? nativeDerivation.deriveCancellation(config) : nativeDerivation.derive(config)
        : Reflect.apply(originalMethod!, graph, [config]) as object
      host.binding.assertCurrent()
      nativeDerivation?.assertStructure()
      if (operation.failed || deriving !== operation)
        throw new ModFunctionError("MODS_CONVERSATION_GRAPH_REQUIRED")
      const wrapped = wrapFunctionConversationInvocation(derived, host)
      if (operation.failed || deriving !== operation)
        throw new ModFunctionError("MODS_CONVERSATION_GRAPH_REQUIRED")
      return wrapped
    } finally { deriving = undefined }
  }
  const prepare = async (input: unknown, config: RunnableConfig) => {
    const messages = input && typeof input === "object" && !Array.isArray(input) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(input))
      ? Object.getOwnPropertyDescriptor(input, "messages") : undefined
    const ordinaryInput = !!messages && "value" in messages && Array.isArray(messages.value) &&
      messages.value.every(message => host.history
        ? !!message && typeof message === "object" && Object.hasOwn(message, "lc_kwargs") &&
          BaseMessage.isInstance(preflightFunctionConversationMessage(message,
            () => config.signal?.throwIfAborted())) : BaseMessage.isInstance(message))
    if (!ordinaryInput && !host.history) return input
    const submitted: BaseMessage[] = ordinaryInput ? [...messages!.value] : []
    const admitted = ordinaryInput ? { ...input as object } : undefined
    const binding = host.binding
    const signal = config.signal ? AbortSignal.any([config.signal, binding.signal]) : binding.signal
    const assertCurrent = () => {
      signal.throwIfAborted()
      host.history?.assertCurrent()
      binding.assertCurrent()
      if (config.configurable?.thread_id !== binding.checkpointThreadId ||
        (config.configurable?.checkpoint_ns ?? "") !== binding.runtimeCheckpointNamespace)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    }
    assertCurrent()
    const snapshot = await getState(config)
    assertCurrent()
    const values = snapshot.values
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new ModFunctionError("MODS_CONVERSATION_STATE_INVALID")
    const channels = values as Record<string, unknown>
    const previous = channels[FUNCTION_CONVERSATION_CHANNEL]
    if (previous === undefined && config.configurable?.checkpoint_id)
      throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
    const state = previous === undefined ? binding.initialState : readFunctionConversationState(previous)
    if (!state) throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
    const existing = channels.messages
    if (existing !== undefined && (!Array.isArray(existing) ||
      !existing.every(message => host.history
        ? BaseMessage.isInstance(preflightFunctionConversationMessage(message,
            () => signal.throwIfAborted())) : BaseMessage.isInstance(message))))
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    if (host.history && Array.isArray(existing) && existing.length) {
      const marked = existing.some(message => {
        const captured = captureNativeMessageForOccurrence(message, "history-marker-copy",
          () => signal.throwIfAborted())
        const additional = captured.snapshot.data.additional_kwargs
        return !!additional && typeof additional === "object" &&
          (Object.hasOwn(additional, "function_row") || Object.hasOwn(additional, "function_row_invalid"))
      })
      if (marked) {
        const point = snapshot.config?.configurable
        if (point?.thread_id !== binding.checkpointThreadId ||
          (point?.checkpoint_ns ?? "") !== binding.runtimeCheckpointNamespace ||
          typeof point?.checkpoint_id !== "string" || !point.checkpoint_id ||
          !binding.checkpointIncarnation)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
        const recovery = host.store.readCheckpointRecoverySnapshot(binding.target, {
          checkpointThreadId: binding.checkpointThreadId,
          checkpointIncarnation: binding.checkpointIncarnation, checkpointId: point.checkpoint_id
        }, assertCurrent).snapshot
        const exact = { ...config, configurable: { ...config.configurable,
          checkpoint_id: point.checkpoint_id } }
        const captured = await captureConversationCheckpointRead(host.store, host.history.saver,
          exact, () => ({ target: binding.target, checkpointThreadId: binding.checkpointThreadId,
            checkpointIncarnation: binding.checkpointIncarnation!, cut: recovery.cut,
            frontier: state.frontier, stateDigest: recovery.stateDigest, assertCurrent }), assertCurrent)
        assertCurrent()
        if (!captured.proof || readFunctionConversationCheckpointMembership(captured.proof,
          host.store, binding.target).snapshotDigest !== recovery.snapshotDigest)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
        host.history.register(existing, captured.proof)
        assertCurrent()
      }
    }
    // Resume input belongs to the graph. Only its exact saved history is registered above.
    if (!ordinaryInput) return input
    const intake = await prepareFunctionConversationIntake({ store: host.store,
      target: binding.target, state, signal, assertCurrent,
      highWater: binding.admission?.highWater,
      publish: host.onIntakeNotes !== undefined,
      notAfterCreatedAt: binding.admission?.notAfterCreatedAt }, existing ?? [])
    assertCurrent()
    if (intake.publication) host.onIntakeNotes?.(intake.publication)
    assertCurrent()
    return { ...admitted, messages: [...intake.notes, ...submitted],
      [FUNCTION_CONVERSATION_CHANNEL]: intake.state }
  }
  const wrapped = new Proxy(graph, {
    get(target, key) {
      if (key === "withConfig" && nativeDerivation) return derive
      const value = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      if (!methods.has(key)) {
        if (key === "withConfig") {
          const originalMethod = value as (...args: unknown[]) => unknown
          methods.set(key, (config: RunnableConfig) => derive(config, originalMethod))
        } else if (key === "streamEvents") {
          const call = value.bind(target)
          methods.set(key, (input: unknown, config: RunnableConfig = {}, ...rest: unknown[]) => {
            const cut = new AbortController()
            const signals = [cut.signal, host.binding.signal]
            if (config.signal) signals.push(config.signal)
            const signal = AbortSignal.any(signals)
            const resolved = nativeDerivation?.resolve(config) ?? config
            const fixed = { ...resolved, configurable: { ...resolved.configurable }, signal }
            const prepared = prepare(input, fixed)
            return createNativeEventStream({ prepared, cut, signal,
              assertCurrent: host.binding.assertCurrent.bind(host.binding),
              open: admitted => call(admitted, fixed, ...rest) })
          })
        } else if (key === "invoke" || key === "stream") {
          const call = value.bind(target)
          methods.set(key, async (input: unknown, config: RunnableConfig = {}, ...rest: unknown[]) => {
            const resolved = nativeDerivation?.resolve(config) ?? config
            const fixed = { ...resolved, configurable: { ...resolved.configurable } }
            return call(await prepare(input, fixed), fixed, ...rest)
          })
        } else methods.set(key, value.bind(target))
      }
      return methods.get(key)
    }
  })
  if (nativeDerivation) Reflect.apply(derivationWeakSet, derivations, [wrapped, Object.freeze({ graph: nativeGraph,
    hasDefaultCancellation: nativeDerivation.hasDefaultCancellation,
    assertStructure: nativeDerivation.assertStructure,
    derive, deriveCancellation: (config: RunnableConfig) => derive(config, undefined, true),
    resolve: nativeDerivation.resolve, resolveCancellation: nativeDerivation.resolveCancellation })])
  return wrapped
}
