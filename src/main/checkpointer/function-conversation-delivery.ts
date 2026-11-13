import { createHash } from "node:crypto"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata, CheckpointTuple, PendingWrite } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationRef, FunctionConversationStore } from "../db/function-conversation-store"
import { persistPreparedFunctionConversationMembership } from "../db/function-conversation-store"
import { SqlJsSaver, type SqlJsSaverCommittedCheckpointReceipt,
  type SqlJsSaverPreparedCheckpointObserver } from "./sqljs-saver"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { isFunctionConversationNativeMainRuntime } from "../mods/native-conversation-policy-source"
import { createNativeCommittedMembershipAdmission } from "./committed-checkpoint-native-capture"
import { nativeConversationFairness } from "../utils/native-conversation-fairness"
import {
  captureCommittedConversationMembership,
  capturePreparedConversationMembership,
  captureConversationCheckpointRead,
  functionConversationMembershipDigest,
  isNativeCommittedConversationMembership,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCanonicalCut,
  type FunctionConversationCheckpointMembershipProof
} from "./function-conversation-checkpoint-membership"

import { FUNCTION_CONVERSATION_CHANNEL, assertFunctionConversationState,
  readFunctionConversationState, type FunctionConversationState } from "./function-conversation-state"
export { FUNCTION_CONVERSATION_CHANNEL, assertFunctionConversationState,
  readFunctionConversationState, type FunctionConversationState } from "./function-conversation-state"

export interface FunctionConversationDeliveryBinding {
  readonly target: FunctionConversationRef
  readonly checkpointThreadId: string
  /** Independent children must supply their actual physical DB incarnation. */
  readonly checkpointIncarnation?: ThreadIncarnation
  readonly signal: AbortSignal
  assertCurrent(): void
}

const committedBrand = Symbol("function-conversation-committed-checkpoint")
const preparedBrand = Symbol("function-conversation-prepared-checkpoint")
const receiptDelete = WeakMap.prototype.delete, receiptApply = Reflect.apply
const persistPreparedData = persistPreparedFunctionConversationMembership
const deliveryFreeze = Object.freeze, deliveryWeakMap = WeakMap
export interface FunctionConversationPreparedCheckpoint {
  readonly [preparedBrand]: true
}
export interface FunctionConversationCommittedCheckpoint {
  readonly [committedBrand]: true
}

type Capture = (config: RunnableConfig, state: FunctionConversationState) =>
  FunctionConversationDeliveryBinding | undefined

/** Fixed host-local compaction hooks. Never accepted from a guest or renderer payload. */
export interface FunctionConversationCheckpointCommitHooks {
  readonly canonicalCut?: () => FunctionConversationCanonicalCut
  readonly prepared?: SqlJsSaverPreparedCheckpointObserver
  readonly observed?: (receipt: SqlJsSaverCommittedCheckpointReceipt) => void | Promise<void>
  readonly acknowledgement?: (database: NativeSqliteAdapter, checkpointId: string) => void
  readonly stageWrites?: (config: RunnableConfig, writes: PendingWrite[], taskId: string) => Promise<void>
  readonly assertReadable?: () => void
  readonly assertWriteCurrent?: () => void
}

interface CooperativeObserver {
    saver: SqlJsSaver
    readPreparation: (prepared: FunctionConversationPreparedCheckpoint) => {
      store: FunctionConversationStore
      binding: FunctionConversationDeliveryBinding
      state: FunctionConversationState
      cut: FunctionConversationCanonicalCut
      admission: import("./function-conversation-checkpoint-membership").FunctionConversationMembershipAdmission
    }
    sealPreparation: (prepared: FunctionConversationPreparedCheckpoint, seal: () => void) => void
    assertPreparation: (prepared: FunctionConversationPreparedCheckpoint) => void
    observed: (prepared: FunctionConversationPreparedCheckpoint, receipt: SqlJsSaverCommittedCheckpointReceipt) => void
    cooperate: (prepared: FunctionConversationPreparedCheckpoint, receipt: SqlJsSaverCommittedCheckpointReceipt) =>
      void | Promise<void>
  }

/** Native successful put/read receipts authenticate delivery. Stream values cannot enter this path. */
export class FunctionConversationDeliveryBridge {
  readonly #cooperativeObservers = new deliveryWeakMap<object, CooperativeObserver>()
  private readonly receipts = new WeakMap<FunctionConversationCommittedCheckpoint, {
    binding: FunctionConversationDeliveryBinding
    state: FunctionConversationState
    checkpointId: string
    generation: string
    membership: FunctionConversationCheckpointMembershipProof
    assertNative?: () => void
  }>()

  constructor(private readonly store: FunctionConversationStore, private readonly capture: Capture,
    private readonly nativeRuntime?: FunctionNativeConversationRuntime,
    private readonly writeAcknowledgement?: FunctionConversationCheckpointCommitHooks["acknowledgement"]) {}

  private assertBinding(binding: FunctionConversationDeliveryBinding, config: RunnableConfig,
    state: FunctionConversationState): void {
    binding.signal.throwIfAborted()
    binding.assertCurrent()
    this.store.assertCurrent(binding.target)
    assertFunctionConversationState(binding.target, state)
    if (config.configurable?.thread_id !== binding.checkpointThreadId ||
      (config.configurable?.checkpoint_ns ?? "") !== binding.target.checkpointNamespace)
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  }

  /** Returned callback belongs to this actual saver and is suitable for its post-COMMIT hook. */
  bindSaver(saver: SqlJsSaver, fixedCanonicalCut?: () => FunctionConversationCanonicalCut): {
    prepare(config: RunnableConfig, checkpoint: Checkpoint): FunctionConversationPreparedCheckpoint | undefined
    committed(prepared: FunctionConversationPreparedCheckpoint | undefined, result: RunnableConfig): Promise<void>
    observed(prepared: FunctionConversationPreparedCheckpoint, receipt: SqlJsSaverCommittedCheckpointReceipt): void
    recover(config: RunnableConfig, binding: FunctionConversationDeliveryBinding): Promise<void>
    captureRecovery(config: RunnableConfig, binding: FunctionConversationDeliveryBinding):
      Promise<FunctionConversationCheckpointMembershipProof>
    readVerifiedRecovery(config: RunnableConfig, binding: FunctionConversationDeliveryBinding):
      Promise<CheckpointTuple>
  } {
    if (!(saver instanceof SqlJsSaver)) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINTER_REQUIRED")
    const preparations = new deliveryWeakMap<FunctionConversationPreparedCheckpoint, {
      binding: FunctionConversationDeliveryBinding
      state: FunctionConversationState
      checkpointId: string
      threadId: string
      namespace: string
      cut: FunctionConversationCanonicalCut
      dataSeal?: () => void
    }>()
    const physicalIncarnation = (binding: FunctionConversationDeliveryBinding): ThreadIncarnation => {
      const incarnation = binding.checkpointIncarnation ??
        (binding.checkpointThreadId === binding.target.threadId ? binding.target.incarnation : undefined)
      if (!incarnation) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      return deliveryFreeze({ ...incarnation })
    }
    const nativeBindings = new WeakMap<FunctionConversationDeliveryBinding, FunctionConversationDeliveryBinding>()
    const freezeBinding = (actual: FunctionConversationDeliveryBinding) => {
      const frozen = deliveryFreeze({ target: actual.target, checkpointThreadId: actual.checkpointThreadId,
        checkpointIncarnation: physicalIncarnation(actual), signal: actual.signal,
        assertCurrent: actual.assertCurrent.bind(actual) })
      const runtime = this.nativeRuntime
      if (runtime && isFunctionConversationNativeMainRuntime(runtime) && runtime.binding === actual)
        receiptApply(originalObserverSet, nativeBindings, [frozen, actual])
      return frozen
    }
    const membershipAdmission = (binding: FunctionConversationDeliveryBinding,
      state: FunctionConversationState, cut: FunctionConversationCanonicalCut) => {
      const data = { target: binding.target, checkpointThreadId: binding.checkpointThreadId,
        checkpointIncarnation: physicalIncarnation(binding), cut, frontier: state.frontier,
        stateDigest: functionConversationMembershipDigest(state) }
      const original = receiptApply(originalObserverGet, nativeBindings, [binding]) as
        FunctionConversationDeliveryBinding | undefined, runtime = this.nativeRuntime
      const native = original && runtime && createNativeCommittedMembershipAdmission(runtime, original, data)
      return native ?? { ...data,
        assertCurrent: () => { binding.signal.throwIfAborted(); binding.assertCurrent() } }
    }
    const mintTuple = (config: RunnableConfig, actual: FunctionConversationDeliveryBinding,
      tuple: CheckpointTuple | undefined, membership: FunctionConversationCheckpointMembershipProof,
      expected?: FunctionConversationState,
      assertNative?: () => void) => {
      const binding = freezeBinding(actual)
      assertNative?.()
      binding.signal.throwIfAborted()
      binding.assertCurrent()
      this.store.assertCurrent(binding.target)
      if (config.configurable?.thread_id !== binding.checkpointThreadId ||
        (config.configurable?.checkpoint_ns ?? "") !== binding.target.checkpointNamespace)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      const checkpointId = config.configurable?.checkpoint_id
      if (typeof checkpointId !== "string" || !checkpointId)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_REQUIRED")
      if (!tuple || tuple.checkpoint.id !== checkpointId ||
        tuple.config.configurable?.thread_id !== config.configurable?.thread_id ||
        (tuple.config.configurable?.checkpoint_ns ?? "") !== (config.configurable?.checkpoint_ns ?? ""))
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_NOT_COMMITTED")
      const raw = tuple.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
      if (raw === undefined) return undefined
      const state = readFunctionConversationState(raw)
      if (expected && JSON.stringify(state) !== JSON.stringify(expected))
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      this.assertBinding(binding, config, state)
      const generation = createHash("sha256").update(JSON.stringify({
        id: tuple.checkpoint.id, ts: tuple.checkpoint.ts, state,
        thread: binding.checkpointThreadId, namespace: binding.target.checkpointNamespace,
        membership: readFunctionConversationCheckpointMembership(membership, this.store,
          binding.target).snapshotDigest
      })).digest("hex")
      const proof = Object.freeze({ [committedBrand]: true as const })
      assertNative?.()
      this.receipts.set(proof, { binding, state, checkpointId, generation, membership, assertNative })
      return proof
    }
    const mint = async (config: RunnableConfig, actual: FunctionConversationDeliveryBinding,
      expected?: FunctionConversationState, preparedCut?: FunctionConversationCanonicalCut) => {
      const fixed = { ...config, configurable: { ...config.configurable } }
      const binding = freezeBinding(actual)
      binding.signal.throwIfAborted()
      binding.assertCurrent()
      this.store.assertCurrent(binding.target)
      if (fixed.configurable.thread_id !== binding.checkpointThreadId ||
        (fixed.configurable.checkpoint_ns ?? "") !== binding.target.checkpointNamespace)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      if (typeof fixed.configurable.checkpoint_id !== "string" || !fixed.configurable.checkpoint_id)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_REQUIRED")
      const guard = () => { binding.signal.throwIfAborted(); binding.assertCurrent();
        this.store.assertCurrent(binding.target) }
      const cut = preparedCut ?? this.store.readCheckpointCanonicalCut(binding.target, {
        checkpointThreadId: binding.checkpointThreadId,
        checkpointIncarnation: binding.checkpointIncarnation,
        checkpointId: fixed.configurable.checkpoint_id
      }, guard) ?? this.store.captureCheckpointCanonicalCut(binding.target, guard)
      // External recovery reads this exact retained checkpoint once, never latest.
      const captured = await captureConversationCheckpointRead(this.store, saver, fixed, (tuple) => {
        const raw = tuple.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
        if (raw === undefined) return undefined
        const state = readFunctionConversationState(raw)
        if (expected && JSON.stringify(state) !== JSON.stringify(expected))
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        this.assertBinding(binding, fixed, state)
        return membershipAdmission(binding, state, cut)
      }, guard)
      if (!captured.proof) return undefined
      return { tuple: captured.tuple,
        committed: mintTuple(fixed, binding, captured.tuple, captured.proof, expected),
        membership: captured.proof }
    }
    const consume = (prepared: FunctionConversationPreparedCheckpoint, config: RunnableConfig) => {
      const actual = receiptApply(originalObserverGet, preparations, [prepared]) as ReturnType<typeof preparations.get>
      if (!actual) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
      receiptApply(originalObserverDelete, preparations, [prepared])
      if (config.configurable?.checkpoint_id !== actual.checkpointId ||
        config.configurable?.thread_id !== actual.threadId ||
        (config.configurable?.checkpoint_ns ?? "") !== actual.namespace)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      return actual
    }
    const prepareObserved = (prepared: FunctionConversationPreparedCheckpoint,
      receipt: SqlJsSaverCommittedCheckpointReceipt) => {
      const read = () => SqlJsSaver.prototype.readCommittedCheckpoint.call(saver, receipt)
      const tuple = read()
      const actual = consume(prepared, tuple.config)
      const membership = captureCommittedConversationMembership(this.store, saver, receipt,
        membershipAdmission(actual.binding, actual.state, actual.cut))
      const proof = mintTuple(tuple.config, actual.binding, tuple, membership, actual.state, () => {
        if (read() !== tuple) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      })
      if (!proof) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      return { proof, membership, target: actual.binding.target }
    }
    const observer: ReturnType<FunctionConversationDeliveryBridge["bindSaver"]> = {
      prepare: (config, checkpoint) => {
        const raw = checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
        if (raw === undefined) return
        const expected = readFunctionConversationState(raw)
        const original = this.capture(config, expected)
        if (!original) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
        const binding = freezeBinding(original)
        this.assertBinding(binding, config, expected)
        const proof = deliveryFreeze({ [preparedBrand]: true as const })
        const cut = fixedCanonicalCut ? fixedCanonicalCut() :
          this.store.captureCheckpointCanonicalCut(binding.target, () =>
            this.assertBinding(binding, config, expected))
        if (fixedCanonicalCut) {
          this.store.assertCheckpointCanonicalCut(binding.target, cut)
          this.assertBinding(binding, config, expected)
        }
        receiptApply(originalObserverSet, preparations, [proof, { binding, state: expected, checkpointId: checkpoint.id,
          threadId: binding.checkpointThreadId, namespace: binding.target.checkpointNamespace, cut, dataSeal: undefined }])
        return proof
      },
      committed: async (prepared, result) => {
        if (!prepared) return
        const actual = consume(prepared, result)
        const captured = await mint(result, actual.binding, actual.state, actual.cut)
        if (!captured?.committed) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        this.acknowledge(captured.committed)
      },
      observed: (prepared, receipt) => {
        this.acknowledge(prepareObserved(prepared, receipt).proof, this.writeAcknowledgement)
      },
      recover: async (config, binding) => {
        // Ordinary checkpoints without this host channel have no conversation delivery.
        const fixed = { ...config, configurable: { ...config.configurable } }
        if (typeof fixed.configurable.checkpoint_id !== "string" || !fixed.configurable.checkpoint_id)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_REQUIRED")
        const captured = await mint(fixed, binding)
        if (captured?.committed) this.acknowledge(captured.committed)
      },
      captureRecovery: async (config, binding) => {
        const captured = await mint(config, binding)
        if (!captured?.committed) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        this.acknowledge(captured.committed)
        return captured.membership
      },
      readVerifiedRecovery: async (config, binding) => {
        const captured = await mint(config, binding)
        if (!captured?.committed || !captured.tuple)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        this.acknowledge(captured.committed)
        return captured.tuple
      }
    }
    const readPreparation = (prepared: FunctionConversationPreparedCheckpoint) => {
      const actual = receiptApply(originalObserverGet, preparations, [prepared]) as ReturnType<typeof preparations.get>
      if (!actual) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
      return { store: this.store, binding: actual.binding, state: actual.state, cut: actual.cut,
        admission: membershipAdmission(actual.binding, actual.state, actual.cut) }
    }
    const cooperative: CooperativeObserver = { saver, readPreparation,
      sealPreparation: (prepared, seal) => {
        const actual = receiptApply(originalObserverGet, preparations, [prepared]) as ReturnType<typeof preparations.get>
        if (!actual) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
        actual.dataSeal = seal
      },
      assertPreparation: prepared => {
        const actual = receiptApply(originalObserverGet, preparations, [prepared]) as ReturnType<typeof preparations.get>
        if (!actual) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
        actual.binding.signal.throwIfAborted()
        actual.binding.assertCurrent()
        this.store.assertCurrent(actual.binding.target)
        // No authority callback is allowed after this native-only AppDB data seal.
        actual.dataSeal?.()
      }, observed: observer.observed, cooperate: (prepared, receipt) => {
      const actual = prepareObserved(prepared, receipt)
      if (!isNativeCommittedConversationMembership(actual.membership, this.store, actual.target)) {
        // Keep custom/unsupported observers synchronous, including their return/throw behavior.
        this.acknowledge(actual.proof, this.writeAcknowledgement)
        return
      }
      const settle = async () => {
        try {
          const current = () => {
            if (!this.receipts.has(actual.proof))
              throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
            readFunctionConversationCheckpointMembership(actual.membership, this.store, actual.target)
          }
          // Capture/mint is finished and ACK has not started. Saver awaits this promise while
          // retaining the namespace gate and COMMIT receipt; no transaction/read scope is open.
          await nativeConversationFairness(undefined, current)(true)
          this.acknowledge(actual.proof, this.writeAcknowledgement)
        } finally {
          // acknowledge also deletes it, but an abort/close/mutation at the pause can fail first.
          receiptApply(receiptDelete, this.receipts, [actual.proof])
        }
      }
      return settle()
    } }
    receiptApply(originalObserverSet, this.#cooperativeObservers, [observer, cooperative])
    return observer
  }

  /** Only an original observer's still-live lexical preparation can supply candidate facts. */
  readPreparedDataPreparation(observer: object, prepared: FunctionConversationPreparedCheckpoint,
    saver: SqlJsSaver) {
    const actual = receiptApply(originalObserverGet, this.#cooperativeObservers, [observer]) as
      CooperativeObserver | undefined
    if (!actual || actual.saver !== saver)
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
    return actual.readPreparation(prepared)
  }

  acknowledge(proof: FunctionConversationCommittedCheckpoint,
    writeAcknowledgement?: FunctionConversationCheckpointCommitHooks["acknowledgement"]): void {
    const actual = this.receipts.get(proof)
    if (!actual) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
    const { binding, state, checkpointId, generation, membership, assertNative } = actual
    const guard = () => {
      assertNative?.()
      binding.signal.throwIfAborted()
      binding.assertCurrent()
      this.store.assertCurrent(binding.target)
      assertFunctionConversationState(binding.target, state)
      assertNative?.()
    }
    try {
      guard()
      const delivery = this.store.captureCheckpointDelivery(binding.target,
        { checkpointId, generation, frontier: state.frontier }, guard)
      this.store.recordCheckpointDelivery(binding.target, delivery, guard, membership,
        writeAcknowledgement ? database => writeAcknowledgement(database, checkpointId) : undefined)
      guard()
    } finally {
      this.receipts.delete(proof)
    }
  }

  /** Host convenience adapter; only the actual SqlJsSaver implementation performs put. */
  wrap(saver: SqlJsSaver, assertCurrent?: () => void, onCommitted?: () => void,
    hooks?: FunctionConversationCheckpointCommitHooks): SqlJsSaver {
    const observer = this.bindSaver(saver, hooks?.canonicalCut), methods = new Map<PropertyKey, unknown>()
    const observe = (prepared: FunctionConversationPreparedCheckpoint,
      receipt: SqlJsSaverCommittedCheckpointReceipt) => {
      const native = receiptApply(originalObserverGet, this.#cooperativeObservers, [observer]) as CooperativeObserver | undefined
      const field = Object.getOwnPropertyDescriptor(observer, "observed")
      return native && field && "value" in field && field.value === native.observed
        ? native.cooperate(prepared, receipt) : observer.observed(prepared, receipt)
    }
    const put = async (config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) => {
      const prepared = observer.prepare(config, checkpoint)
      if (!prepared) return SqlJsSaver.prototype.put.call(saver, config, checkpoint, metadata)
      const native = receiptApply(originalObserverGet, this.#cooperativeObservers, [observer]) as CooperativeObserver
      const current = () => { assertCurrent?.(); native.assertPreparation(prepared) }
      return SqlJsSaver.prototype.putWithCommitObserver.call(saver, config, checkpoint, metadata,
        hooks?.observed ? async receipt => { await hooks.observed!(receipt); return observe(prepared, receipt) }
          : receipt => observe(prepared, receipt), current, onCommitted, hooks?.prepared,
        async receipt => {
          await capturePreparedConversationMembership(this, observer, prepared, saver, receipt)
          const actual = native.readPreparation(prepared)
          const seal = persistPreparedData(this.store, actual.binding.target, receipt, current)
          native.sealPreparation(prepared, seal)
          current()
        })
    }
    return new Proxy(saver, { get(target, key) {
      if (key === "put") return put
      const value = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      if (!methods.has(key)) methods.set(key, value.bind(target))
      return methods.get(key)
    } })
  }
}

const originalObserverGet = WeakMap.prototype.get, originalObserverSet = WeakMap.prototype.set,
  originalObserverDelete = WeakMap.prototype.delete
const originalPreparationReader = FunctionConversationDeliveryBridge.prototype.readPreparedDataPreparation
/** A hoisted function permits the existing Delivery/Membership cycle without a mutable export dispatch. */
export function readFunctionConversationBridgePreparation(bridge: FunctionConversationDeliveryBridge,
  observer: object, prepared: FunctionConversationPreparedCheckpoint, saver: SqlJsSaver) {
  return receiptApply(originalPreparationReader, bridge, [observer, prepared, saver]) as
    ReturnType<FunctionConversationDeliveryBridge["readPreparedDataPreparation"]>
}
