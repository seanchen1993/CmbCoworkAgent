import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import type { RunnableConfig } from "@langchain/core/runnables"
import { types } from "node:util"
import { createHash } from "node:crypto"
import { getDb, withCanonicalThreadMessageReadScope } from "../db"
import type { FunctionConversationProjectionColumns } from "../db/function-conversation-projection-receipt"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS } from "../db/function-conversation-projection-receipt"
import type { FunctionConversationRow, FunctionConversationStore } from "../db/function-conversation-store"
import { functionConversationCanonicalStamp, functionConversationRowDigest } from
  "../checkpointer/function-conversation-checkpoint-membership"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativePolicySource,
  snapshotFunctionNativeDeployment } from "../mods/native-conversation-policy-source"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY, MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY }
  from "../../shared/message-role-collision"
import { bindFunctionConversationNativeInput, captureFunctionConversationNativeInput,
  readFunctionConversationNativeInput,
  type FunctionConversationNativeInputReceipt, type FunctionConversationNativeInputBinding }
  from "./function-conversation-native-input"
import { captureFunctionConversationNativeInputPresentation,
  registerFunctionConversationNativeHumanProtection } from "./function-conversation-native-human-presentation"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"
import type { FunctionConversationNativeKeeperRuntime } from "./function-conversation-native-keeper"
import { FunctionConversationNativeKeeper } from "./function-conversation-native-keeper"
import { FunctionNativeMessageProtector, type FunctionNativeProtectionPolicy } from "./native-message-protector"
import { captureNativeMessage, constructCapturedNativeMessage } from "./native-message-capture"
import { deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { consumeCompletionRevisionInput, isCompletionRevisionInput } from "./skill-lifecycle/completion-hooks"
import { getLocalThreadRunLease } from "./thread-run-lease"

interface Saved {
  readonly policy: FunctionNativeProtectionPolicy
  readonly deployment: string
  readonly target: string
  readonly destination: string
  readonly database: FunctionNativeConversationRuntime["database"]
  readonly row: FunctionConversationRow
  readonly rowDigest: string
  readonly columnsDigest: string
  readonly presentationFingerprint: string
}
interface Once {
  readonly attempt: object
  phase: "processing" | "saved" | "failed"
  violated: boolean
  saved?: Saved
}
interface NativeInputRetention {
  retainInput(actualInput: unknown, config: RunnableConfig): Promise<unknown>
  close(): void
  whenDrained(): Promise<void>
}
const occurrences = new WeakMap<FunctionConversationNativeInputReceipt, Once>()
// Only retainInput creates these closures. A wrapper or another occurrence has no provenance.
const inputWeakGet = WeakMap.prototype.get, inputWeakSet = WeakMap.prototype.set
const inputCurrents = new WeakMap<() => void, {
  runtime: FunctionConversationNativeKeeperRuntime
  producer: object
  occurrence: object
  source: Readonly<{ assertTail(): void }>
}>()
export function readFunctionConversationNativeInputCurrent(current: () => void,
  runtime: FunctionConversationNativeKeeperRuntime, producer: object, occurrence: object):
  Readonly<{ assertTail(): void }> | undefined {
  const original = Reflect.apply(inputWeakGet, inputCurrents, [current]) as
    ReturnType<typeof inputCurrents.get>
  return original?.runtime === runtime && original.producer === producer &&
    original.occurrence === occurrence ? original.source : undefined
}

// Accessor-bearing/inherited config remains on the generic path. The certified final check
// reads descriptors only, so it cannot introduce a callback after the original authority tail.
function captureConfigTail(config: RunnableConfig): (() => void) | undefined {
  if (types.isProxy(config) || Object.getPrototypeOf(config) !== Object.prototype) return undefined
  const field = Object.getOwnPropertyDescriptor(config, "configurable")
  if (!field || !("value" in field) || !field.value || typeof field.value !== "object" ||
    types.isProxy(field.value) || Object.getPrototypeOf(field.value) !== Object.prototype) return undefined
  const value = field.value as object
  const keys = ["thread_id", "checkpoint_ns"] as const
  const fields = keys.map(key => Object.getOwnPropertyDescriptor(value, key))
  if (!fields[0] || fields.some(item => item && !("value" in item)) ||
    keys.some((key, index) => !fields[index] &&
      Object.getOwnPropertyDescriptor(Object.prototype, key))) return undefined
  return () => {
    if (Object.getPrototypeOf(config) !== Object.prototype ||
      Object.getPrototypeOf(value) !== Object.prototype) fail()
    const current = Object.getOwnPropertyDescriptor(config, "configurable")
    if (!current || !("value" in current) || current.value !== value ||
      current.enumerable !== field.enumerable || current.configurable !== field.configurable ||
      current.writable !== field.writable) fail()
    keys.forEach((key, index) => {
      const now = Object.getOwnPropertyDescriptor(value, key), before = fields[index]
      if (!before) {
        if (now || Object.getOwnPropertyDescriptor(Object.prototype, key)) fail()
        return
      }
      if (!now || !("value" in now) || now.value !== before.value ||
        now.enumerable !== before.enumerable || now.configurable !== before.configurable ||
        now.writable !== before.writable) fail()
    })
  }
}


function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_INPUT_RETENTION_INVALID")
}
function own(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !("value" in field)) fail()
  return field.value
}
function columnsDigest(columns: FunctionConversationProjectionColumns): string {
  return createHash("sha256").update(JSON.stringify(
    FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key => columns[key]))).digest("hex")
}
function targetIdentity(runtime: FunctionNativeConversationRuntime): string {
  const ref = runtime.target.ref
  return JSON.stringify([ref.logicalSessionId, ref.conversationId, ref.branchId, ref.threadId,
    ref.workspace, ref.kind, ref.checkpointNamespace, ref.incarnation.token,
    ref.incarnation.legacyCreatedAt, runtime.target.checkpointThreadId,
    runtime.binding.runtimeCheckpointNamespace])
}
function destinationIdentity(runtime: FunctionNativeConversationRuntime): string {
  const value = runtime.destination
  return JSON.stringify([value.threadId, value.incarnation.token, value.incarnation.legacyCreatedAt])
}
function deployment(policy: FunctionNativeProtectionPolicy): string {
  return JSON.stringify(snapshotFunctionNativeDeployment(policy.deployment))
}
function samePolicy(saved: Saved, policy: FunctionNativeProtectionPolicy): boolean {
  const original = saved.policy
  return original.identity === policy.identity && original.epoch === policy.epoch &&
    original.digest === policy.digest && original.protected === policy.protected &&
    saved.deployment === deployment(policy)
}

/** Only the original ordinary input address is replaced. Resume/control objects stay native. */
function replaceInput(input: unknown, original: HumanMessage, safe: HumanMessage): unknown {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)) fail()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const properties = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(properties).some(key => typeof key !== "string")) fail()
  for (const field of Object.values(properties)) if (!("value" in field)) fail()
  const messages: unknown = properties.messages?.value
  if (!Array.isArray(messages) || types.isProxy(messages) ||
    Object.getPrototypeOf(messages) !== Array.prototype) fail()
  const length = own(messages, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > 1_000_000 ||
    Reflect.ownKeys(messages).length !== length + 1) fail()
  let count = 0
  const next = Array.from({ length }, (_unused, index) => {
    const message = own(messages, String(index))
    if (message !== original) return message
    count++
    return safe
  })
  if (count !== 1) fail()
  return Object.create(prototype, { ...properties,
    messages: { ...properties.messages, value: next } }) as unknown
}

/** Actual entry once state. A new candidate reads an acknowledged result without replaying it. */
export function createFunctionConversationNativeInputRetention(input: {
  readonly source?: FunctionConversationNativeInputReceipt
  readonly runtime: FunctionNativeConversationRuntime
  readonly store: FunctionConversationStore
  readonly agentId: string
  flush(uuid: string): void | Promise<void>
  register(message: BaseMessage, row: FunctionConversationRow): void
}): NativeInputRetention {
  const { source: receipt, runtime, store } = input
  const attempt = Object.freeze({}), producer = Object.freeze({}), occurrence = Object.freeze({})
  const flush = input.flush.bind(input), register = input.register.bind(input)
  const active = new Set<Promise<unknown>>()
  const keepers = new Set<FunctionConversationNativeKeeper>()
  const continuations = new Set<NativeInputRetention>()
  let closed = false

  const pureTail = (binding: FunctionConversationNativeInputBinding, signal: AbortSignal,
    state: Once, originalDigest: string) => {
    signal.throwIfAborted()
    runtime.signal.throwIfAborted()
    runtime.target.signal.throwIfAborted()
    if (closed || state.violated || state.phase === "failed" || getDb() !== runtime.database ||
      captureNativeMessage(binding.message, () => signal.throwIfAborted()).digest !== originalDigest)
      fail()
  }
  const readSaved = (binding: FunctionConversationNativeInputBinding, expected: FunctionConversationRow,
    guard: () => void) => withCanonicalThreadMessageReadScope(runtime.destination.threadId, reader => {
    reader.runGuard(guard)
    const row = reader.runGuard(() => store.readReceipt(runtime.target.ref, binding.uuid))
    if (!row || functionConversationRowDigest(row) !== functionConversationRowDigest(expected) ||
      row.nativePayload !== expected.nativePayload) fail()
    const columns = reader.readColumns(binding.uuid), snapshot = reader.readSnapshot(binding.uuid)
    const presentation = reader.readPresentation(binding.uuid)
    if (!columns || !snapshot || !presentation || columns.role !== "user" ||
      columns.message_id !== binding.uuid) fail()
    const partition = reader.partition([snapshot])
    if (partition.canonicalCount !== 1 || partition.ordinary.length) fail()
    reader.runGuard(guard)
    return { row, columns, presentation }
  })

  const retainInput = async (actualInput: unknown, config: RunnableConfig): Promise<unknown> => {
    if (closed) fail()
    if (actualInput === null) return actualInput
    if (actualInput && typeof actualInput === "object" && !types.isProxy(actualInput) &&
      Object.getPrototypeOf(actualInput) === Command.prototype) return actualInput
    if (isCompletionRevisionInput(actualInput)) {
      const pending = Promise.withResolvers<unknown>()
      // Drain must observe this occurrence before any original authority callback.
      active.add(pending.promise)
      const work = async () => {
        // Consume before invoking any original source guard: synchronous re-entry
        // must fail this occurrence instead of starting a second protection operation.
        const lease = getLocalThreadRunLease(runtime.target.ref.threadId)
        const revision = consumeCompletionRevisionInput(actualInput, {
          threadId: runtime.target.ref.threadId, runId: lease?.runId ?? "",
          workspace: runtime.target.ref.workspace
        })
        if (!revision) fail()
        const source = receipt ? readFunctionConversationNativeInput(receipt) : undefined
        // A host repair is a new checkpoint-only occurrence, never another submission
        // of the user's address. Keep the original Once intact and reuse the complete
        // protection/keeper/ACK chain with a separate, non-visible transcript intent.
        const assertOriginal = () => {
          const original = receipt ? occurrences.get(receipt) : undefined
          if (receipt && (original?.phase !== "saved" || original.violated)) fail()
        }
        const assertCurrent = () => {
          if (closed) fail()
          assertOriginal()
          runtime.assertCurrent()
          source?.assertCurrent()
          revision.assertCurrent()
          assertOriginal()
        }
        assertCurrent()
        const message = revision.message
        const continuation = createFunctionConversationNativeInputRetention({ ...input,
          source: captureFunctionConversationNativeInput({ message,
            threadId: source?.threadId ?? runtime.target.ref.threadId,
            physicalRunId: source?.physicalRunId ?? lease!.runId,
            workspace: source?.workspace ?? runtime.target.ref.workspace, signal: revision.signal,
            origin: { kind: "hook", event: "completion-revision" },
            transcript: { disposition: "plumbing", write: { id: message.id!, role: "user",
              content: String(message.content), created_at: new Date() } },
            assertCurrent }) })
        continuations.add(continuation)
        try {
          // The private certificate was consumed above. Only this exact original
          // HumanMessage enters the new occurrence's ordinary address validator.
          const retained = await continuation.retainInput({ messages: [message] }, config)
          assertCurrent()
          return retained
        } finally {
          await continuation.whenDrained()
          continuation.close()
          continuations.delete(continuation)
        }
      }
      void work().then(value => {
        active.delete(pending.promise)
        pending.resolve(value)
      }, error => {
        active.delete(pending.promise)
        pending.reject(error)
      })
      return pending.promise
    }
    // Resume/control-only runtimes have no external input receipt. Their ordinary
    // input path is unchanged; only the certified completion occurrence above is new.
    if (!receipt) return actualInput
    const previous = occurrences.get(receipt)
    if (previous?.phase === "failed" || previous?.attempt === attempt) {
      if (previous) previous.violated = true
      fail()
    }
    if (previous?.phase === "processing") { previous.violated = true; fail() }
    const state: Once = { attempt, phase: "processing", violated: false,
      ...(previous?.saved ? { saved: previous.saved } : {}) }
    // Latch before any original source/policy callback can synchronously re-enter.
    occurrences.set(receipt, state)
    const controller = new AbortController()
    const signal = AbortSignal.any([runtime.signal, runtime.target.signal, controller.signal,
      ...(config.signal ? [config.signal] : [])])
    let keeper: FunctionConversationNativeKeeper | undefined
    let resolveWork!: (value: unknown) => void
    let rejectWork!: (reason: unknown) => void
    const pending = new Promise<unknown>((resolve, reject) => {
      resolveWork = resolve
      rejectWork = reject
    })
    // Register actual work before an original source callback can ask for drain or re-enter.
    active.add(pending)
    const work = (async () => {
      try {
        const source = readFunctionConversationNativeInput(receipt)
        // Validate the exact submitted address before protection, flushing or storage.
        replaceInput(actualInput, source.message, source.message)
        const policy = runtime.capturePolicy()
        const certificate = readFunctionConversationNativePolicySource(policy, runtime)
        if (!certificate) fail()
        const binding = bindFunctionConversationNativeInput(receipt, runtime, policy)
        const original = captureNativeMessage(binding.message, () => signal.throwIfAborted())
        const expiresAtNs = process.hrtime.bigint() + 30_000_000_000n
        const boundedWork = () => {
          signal.throwIfAborted()
          if (process.hrtime.bigint() >= expiresAtNs)
            throw new ModFunctionError("MODS_NATIVE_PROTECTION_TIMEOUT")
        }
        const guard = () => {
          pureTail(binding, signal, state, original.digest)
          binding.assertCurrent()
          pureTail(binding, signal, state, original.digest)
          boundedWork()
          if (config.configurable?.thread_id !== runtime.binding.checkpointThreadId ||
            (config.configurable?.checkpoint_ns ?? "") !== runtime.binding.runtimeCheckpointNamespace)
            fail()
        }
        const tail = () => {
          certificate.assertTail()
          pureTail(binding, signal, state, original.digest)
          boundedWork()
        }
        const configTail = captureConfigTail(config)
        if (configTail) Reflect.apply(inputWeakSet, inputCurrents, [guard, { runtime, producer, occurrence,
          source: Object.freeze({ assertTail() { tail(); configTail() } }) }])
        guard()
        let saved = state.saved
        let safe: HumanMessage
        if (saved) {
          if (!samePolicy(saved, policy.value) || saved.database !== runtime.database ||
            saved.target !== targetIdentity(runtime) ||
            saved.destination !== destinationIdentity(runtime)) fail()
          const current = readSaved(binding, saved.row, guard)
          pureTail(binding, signal, state, original.digest)
          if (functionConversationRowDigest(current.row) !== saved.rowDigest ||
            columnsDigest(current.columns) !== saved.columnsDigest ||
            current.presentation.fingerprint !== saved.presentationFingerprint) fail()
          const native = deserializeFunctionConversationNativeMessage(current.row.nativePayload)
          if (Object.getPrototypeOf(native) !== HumanMessage.prototype || native.id !== binding.uuid) fail()
          native.additional_kwargs = { ...native.additional_kwargs,
            function_row: functionConversationCanonicalStamp(runtime.target.ref, current.row) }
          if (serializeFunctionConversationNativeMessage(native) !== current.row.nativePayload) fail()
          safe = native as HumanMessage
        } else {
          const native = constructCapturedNativeMessage(original.type, { ...original.data,
            additional_kwargs: { ...(original.data.additional_kwargs as Record<string, unknown>),
              [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: binding.uuid,
              [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 1 } })
          const protector = new FunctionNativeMessageProtector()
          const presentation = captureFunctionConversationNativeInputPresentation({ source: receipt,
            runtime, policy, producer, occurrence, protector })
          const adoption = createFunctionConversationNativeAdoption({ runtime, store, producer,
            occurrence, assertCurrent: guard, seal: guard, flush: () => flush(binding.uuid),
            nativeHumanPresentation: presentation,
            facts: { uuid: binding.uuid, role: "user", providerSourceId: binding.uuid, providerOccurrence: 1 } })
          keeper = new FunctionConversationNativeKeeper(runtime, protector)
          keepers.add(keeper)
          let held = 0
          const result = await keeper.retain({ producer, occurrence, message: native,
            door: "prompt", origin: binding.origin, agentId: input.agentId, signal,
            policy: policy.value, expiresAtNs, assertCurrent: guard, seal: guard,
            captureProjection: adoption.captureProjection, prepare: adoption.prepare,
            onProtected: value => registerFunctionConversationNativeHumanProtection(presentation, value),
            retainActualWork() {
              held++
              let released = false
              return () => { if (released) fail(); released = true; held-- }
            },
            assertExecutionFacts(raw, protectedMessage) {
              const a = captureNativeMessage(raw, boundedWork)
              const b = captureNativeMessage(protectedMessage, boundedWork)
              if (a.type !== "human" || b.type !== "human" || a.data.id !== b.data.id ||
                a.data.name !== b.data.name) fail()
            },
            inheritPresentation() { /* The actual Human formatter has its own private result proof. */ }
          })
          // Success is publishable only after actual registry/worker/flush work and final ACK.
          await keeper.whenDrained()
          if (held) fail()
          const current = readSaved(binding, result.row, guard)
          pureTail(binding, signal, state, original.digest)
          if (Object.getPrototypeOf(result.message) !== HumanMessage.prototype ||
            result.message.id !== binding.uuid) fail()
          safe = result.message as HumanMessage
          saved = Object.freeze({ policy: policy.value, deployment: deployment(policy.value),
            database: runtime.database, target: targetIdentity(runtime),
            destination: destinationIdentity(runtime), row: current.row,
            rowDigest: functionConversationRowDigest(current.row), columnsDigest: columnsDigest(current.columns),
            presentationFingerprint: current.presentation.fingerprint })
        }
        if (serializeFunctionConversationNativeMessage(safe) !== saved.row.nativePayload) fail()
        const safeDigest = captureNativeMessage(safe, boundedWork).digest
        const safeTail = () => {
          if (captureNativeMessage(safe, boundedWork).digest !== safeDigest ||
            serializeFunctionConversationNativeMessage(safe) !== saved.row.nativePayload) fail()
          tail()
        }
        // register has its own full fresh A/B. No arbitrary callback follows publication.
        register(safe, saved.row)
        safeTail()
        return { saved, finish() {
          // Actual cleanup can yield. Recheck the acknowledged row with a new complete A/B
          // before the once state becomes available to any replacement candidate.
          const current = readSaved(binding, saved.row, guard)
          if (functionConversationRowDigest(current.row) !== saved.rowDigest ||
            columnsDigest(current.columns) !== saved.columnsDigest ||
            current.presentation.fingerprint !== saved.presentationFingerprint) fail()
          safeTail()
          return replaceInput(actualInput, binding.message, safe)
        } }
      } catch (error) {
        state.phase = "failed"
        controller.abort(error)
        throw error
      } finally {
        if (keeper) {
          await keeper.whenDrained()
          keeper.close()
          keepers.delete(keeper)
        }
      }
    })()
    void work.then(value => {
      try {
        const output = value.finish()
        state.saved = value.saved
        state.phase = "saved"
        active.delete(pending)
        resolveWork(output)
      } catch (error) {
        state.phase = "failed"
        controller.abort(error)
        active.delete(pending)
        rejectWork(error)
      }
    }, error => {
      state.phase = "failed"
      controller.abort(error)
      active.delete(pending)
      rejectWork(error)
    })
    return pending
  }
  return Object.freeze({ retainInput,
    close() {
      if (closed) return
      closed = true
      for (const keeper of keepers) keeper.close()
      for (const continuation of continuations) continuation.close()
    },
    async whenDrained() {
      await Promise.allSettled([...active, ...[...continuations].map(value => value.whenDrained())])
    }
  })
}
