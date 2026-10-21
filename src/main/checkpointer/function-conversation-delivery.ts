import { createHash } from "node:crypto"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationRef, FunctionConversationStore } from "../db/function-conversation-store"
import { SqlJsSaver, type SqlJsSaverCommittedCheckpointReceipt } from "./sqljs-saver"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import {
  captureCommittedConversationMembership,
  captureConversationCheckpointRead,
  functionConversationMembershipDigest,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCanonicalCut,
  type FunctionConversationCheckpointMembershipProof
} from "./function-conversation-checkpoint-membership"

export const FUNCTION_CONVERSATION_CHANNEL = "cmbFunctionConversation"

export interface FunctionConversationState {
  version: 1
  logicalSessionId: string
  conversationId: string
  branchId: string
  frontier: number
}

export function readFunctionConversationState(value: unknown): FunctionConversationState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModFunctionError("MODS_CONVERSATION_STATE_INVALID")
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => !["version", "logicalSessionId", "conversationId", "branchId", "frontier"].includes(key)) ||
    data.version !== 1 || typeof data.logicalSessionId !== "string" || !data.logicalSessionId ||
    typeof data.conversationId !== "string" || !data.conversationId ||
    typeof data.branchId !== "string" || !data.branchId ||
    typeof data.frontier !== "number" || !Number.isSafeInteger(data.frontier) || data.frontier < 0)
    throw new ModFunctionError("MODS_CONVERSATION_STATE_INVALID")
  return { version: 1, logicalSessionId: data.logicalSessionId,
    conversationId: data.conversationId, branchId: data.branchId, frontier: data.frontier }
}

export function assertFunctionConversationState(target: FunctionConversationRef, state: FunctionConversationState): void {
  if (state.logicalSessionId !== target.logicalSessionId || state.conversationId !== target.conversationId ||
    state.branchId !== target.branchId) throw new ModFunctionError("MODS_CONVERSATION_STATE_CHANGED")
}

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
export interface FunctionConversationPreparedCheckpoint {
  readonly [preparedBrand]: true
}
export interface FunctionConversationCommittedCheckpoint {
  readonly [committedBrand]: true
}

type Capture = (config: RunnableConfig, state: FunctionConversationState) =>
  FunctionConversationDeliveryBinding | undefined

/** Native successful put/read receipts authenticate delivery. Stream values cannot enter this path. */
export class FunctionConversationDeliveryBridge {
  private readonly receipts = new WeakMap<FunctionConversationCommittedCheckpoint, {
    binding: FunctionConversationDeliveryBinding
    state: FunctionConversationState
    checkpointId: string
    generation: string
    membership: FunctionConversationCheckpointMembershipProof
    assertNative?: () => void
  }>()

  constructor(private readonly store: FunctionConversationStore, private readonly capture: Capture) {}

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
  bindSaver(saver: SqlJsSaver): {
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
    const preparations = new WeakMap<FunctionConversationPreparedCheckpoint, {
      binding: FunctionConversationDeliveryBinding
      state: FunctionConversationState
      checkpointId: string
      threadId: string
      namespace: string
      cut: FunctionConversationCanonicalCut
    }>()
    const physicalIncarnation = (binding: FunctionConversationDeliveryBinding): ThreadIncarnation => {
      const incarnation = binding.checkpointIncarnation ??
        (binding.checkpointThreadId === binding.target.threadId ? binding.target.incarnation : undefined)
      if (!incarnation) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      return Object.freeze({ ...incarnation })
    }
    const freezeBinding = (actual: FunctionConversationDeliveryBinding) => Object.freeze({
      target: actual.target, checkpointThreadId: actual.checkpointThreadId,
      checkpointIncarnation: physicalIncarnation(actual), signal: actual.signal,
      assertCurrent: actual.assertCurrent.bind(actual)
    })
    const membershipAdmission = (binding: FunctionConversationDeliveryBinding,
      state: FunctionConversationState, cut: FunctionConversationCanonicalCut) => ({
      target: binding.target, checkpointThreadId: binding.checkpointThreadId,
      checkpointIncarnation: physicalIncarnation(binding), cut, frontier: state.frontier,
      stateDigest: functionConversationMembershipDigest(state),
      assertCurrent: () => { binding.signal.throwIfAborted(); binding.assertCurrent() }
    })
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
      const actual = preparations.get(prepared)
      if (!actual) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_PROOF")
      preparations.delete(prepared)
      if (config.configurable?.checkpoint_id !== actual.checkpointId ||
        config.configurable?.thread_id !== actual.threadId ||
        (config.configurable?.checkpoint_ns ?? "") !== actual.namespace)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
      return actual
    }
    return {
      prepare: (config, checkpoint) => {
        const raw = checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
        if (raw === undefined) return
        const expected = readFunctionConversationState(raw)
        const original = this.capture(config, expected)
        if (!original) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
        const binding = freezeBinding(original)
        this.assertBinding(binding, config, expected)
        const proof = Object.freeze({ [preparedBrand]: true as const })
        const cut = this.store.captureCheckpointCanonicalCut(binding.target, () =>
          this.assertBinding(binding, config, expected))
        preparations.set(proof, { binding, state: expected, checkpointId: checkpoint.id,
          threadId: binding.checkpointThreadId, namespace: binding.target.checkpointNamespace, cut })
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
        const read = () => SqlJsSaver.prototype.readCommittedCheckpoint.call(saver, receipt)
        const tuple = read()
        const actual = consume(prepared, tuple.config)
        const membership = captureCommittedConversationMembership(this.store, saver, receipt,
          membershipAdmission(actual.binding, actual.state, actual.cut))
        const proof = mintTuple(tuple.config, actual.binding, tuple, membership, actual.state, () => {
          if (read() !== tuple) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        })
        if (!proof) throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        this.acknowledge(proof)
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
  }

  acknowledge(proof: FunctionConversationCommittedCheckpoint): void {
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
      this.store.recordCheckpointDelivery(binding.target, delivery, guard, membership)
      guard()
    } finally {
      this.receipts.delete(proof)
    }
  }

  /** Host convenience adapter; only the actual SqlJsSaver implementation performs put. */
  wrap(saver: SqlJsSaver, assertCurrent?: () => void, onCommitted?: () => void): SqlJsSaver {
    const observer = this.bindSaver(saver), methods = new Map<PropertyKey, unknown>()
    const put = async (config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) => {
      const prepared = observer.prepare(config, checkpoint)
      if (!prepared) return SqlJsSaver.prototype.put.call(saver, config, checkpoint, metadata)
      return SqlJsSaver.prototype.putWithCommitObserver.call(saver, config, checkpoint, metadata,
        (receipt) => observer.observed(prepared, receipt), assertCurrent, onCommitted)
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
