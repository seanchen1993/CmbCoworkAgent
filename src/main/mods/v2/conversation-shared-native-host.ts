import type { RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"
import { FunctionConversationDeliveryBridge, readFunctionConversationState } from
  "../../checkpointer/function-conversation-delivery"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { createThread, getDb, getThreadCore } from "../../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../../services/thread-incarnation"
import { randomUUID } from "node:crypto"
import type { ModRuntimeAuthority } from "../runtime-instance"
import type { FunctionConversationChildParent } from "./conversation-child-family"
import type { FunctionConversationCoordinator } from "./conversation-coordinator"
import { FunctionConversationSharedCheckpointScope, readFunctionConversationSharedNativeRead } from
  "./conversation-shared-checkpointer"
import type { FunctionConversationSharedCheckpointHost } from "./conversation-shared-checkpointer"
import { createFunctionConversationSharedSourceCurrent,
  createFunctionConversationSharedFamilySourceCurrents } from "./conversation-shared-source-current"
import { captureFunctionConversationSharedActive, completeFunctionConversationSharedActive,
  prepareFunctionConversationSharedRestore, readFunctionConversationSharedRestore,
  retireFunctionConversationSharedActive, retireFunctionConversationSharedRestore,
  type FunctionConversationSharedActive, type FunctionConversationSharedRestore,
  type FunctionConversationSharedProducer } from
  "./conversation-shared-restore"

export interface FunctionConversationNativeTask {
  readonly invocation: object
  readonly config: RunnableConfig
  readonly saver: SqlJsSaver
}

/** Called by the known native factory after its actual child authority has been created. */
export function createFunctionConversationSharedNativeHost(input: {
  readonly task: FunctionConversationNativeTask
  readonly coordinator: FunctionConversationCoordinator
  readonly parent: FunctionConversationChildParent
  readonly parentBinding: FunctionConversationGraphBinding
  readonly authority: ModRuntimeAuthority
  readonly signal: AbortSignal
  assertCurrent(): void
  admitted(binding: FunctionConversationGraphBinding, producer: FunctionConversationSharedProducer): void
}): { scope: FunctionConversationSharedCheckpointScope; close(): void } {
  const incarnation = input.parentBinding.checkpointIncarnation
  if (!incarnation || !(input.task.saver instanceof SqlJsSaver))
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  const guard = createFunctionConversationSharedSourceCurrent(input)
  guard()
  let retire: (() => void) | undefined
  let restore: FunctionConversationSharedRestore | undefined
  let active: FunctionConversationSharedActive | undefined
  const scopeHost: FunctionConversationSharedCheckpointHost = {
    saver: input.task.saver, authority: input.authority, parentConfig: input.task.config,
    parentGraphNamespace: input.parentBinding.target.checkpointNamespace,
    signal: input.signal, assertCurrent: guard,
    admit: async proof => {
      try {
      guard()
      const read = readFunctionConversationSharedNativeRead(proof, input.task.saver, input.authority)
      active = captureFunctionConversationSharedActive({ nativeRead: proof, saver: input.task.saver,
        authority: input.authority, invocation: input.task.invocation, scope,
        checkpointIncarnation: incarnation, signal: input.signal, assertCurrent: read.assertCurrent })
      if (read.tuple) restore = await prepareFunctionConversationSharedRestore({
        nativeRead: proof, saver: input.task.saver, authority: input.authority,
        invocation: input.task.invocation, scope, active, parentBinding: input.parentBinding,
        store: input.coordinator.store, checkpointIncarnation: incarnation,
        signal: input.signal, assertCurrent: guard })
      guard()
      const restored = restore ? readFunctionConversationSharedRestore(restore, {
        nativeRead: proof, saver: input.task.saver, authority: input.authority,
        invocation: input.task.invocation, parent: input.parentBinding.target }) : undefined
      const threadId = restored?.destination.destinationThreadId ?? randomUUID()
      const thread = restored ? getThreadCore(threadId) : createThread(threadId, { workspacePath: input.authority.workspace,
        isInternalFlowRuntime: true, isFunctionConversationProjection: true,
        parentThreadId: input.authority.threadId, modsAgentRunId: input.authority.turnId })
      if (!thread) throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
      const destinationIncarnation = restored?.destination.destinationIncarnation ?? captureThreadIncarnation(thread)
      const familyCurrents = restored ? undefined : createFunctionConversationSharedFamilySourceCurrents({
        current: read.assertCurrent, scope, saver: input.task.saver, authority: input.authority,
        invocation: input.task.invocation, database: getDb(), destinationThreadId: threadId,
        destinationIncarnation, originalMetadata: thread.metadata ?? null })
      const destinationGuard = familyCurrents?.assertDestinationCurrent ?? (() => {
        guard()
        const current = getThreadCore(threadId)
        if (!matchesThreadIncarnation(current, destinationIncarnation) ||
          current?.metadata !== thread.metadata)
          throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
      })
      destinationGuard()
      const registered = input.coordinator.registerSharedChild(input.parent, {
        invocation: input.task.invocation, authority: input.authority,
        checkpointThreadId: input.authority.threadId, checkpointIncarnation: incarnation,
            checkpointNamespace: read.namespace,
        destination: { threadId, incarnation: destinationIncarnation,
          assertCurrent: destinationGuard }, signal: input.signal,
        assertCurrent: familyCurrents?.assertCurrent ?? (() => { guard(); read.assertCurrent() }),
        saver: input.task.saver, nativeRead: proof,
        ...(restore ? { restore } : {}),
        readCheckpoint: async (signal, assertCurrent) => {
          const tuple = await scope.readCurrent(signal, assertCurrent)
          if (!tuple) return null
          const messages = tuple.checkpoint.channel_values.messages
          if (!Array.isArray(messages))
            throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
          const raw = tuple.checkpoint.channel_values.cmbFunctionConversation
          return { checkpointId: tuple.checkpoint.id,
            ...(raw !== undefined ? { state: readFunctionConversationState(raw) } : {}),
            messages }
        }
      })
      retire = registered.close
      const producer = completeFunctionConversationSharedActive(active, {
        nativeRead: proof, saver: input.task.saver,
        authority: input.authority, invocation: input.task.invocation, scope,
        target: registered.binding.target, parent: input.parentBinding.target,
        ...(restore ? { restore } : {}),
        producer: { coordinator: input.coordinator, registration: registered.registration } })
      if (!producer) throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
      try { input.admitted(registered.binding, producer); return registered.binding }
      catch (error) { registered.close(); throw error }
      } catch (error) {
        scope.close()
        try { retire?.() }
        finally {
          if (active) retireFunctionConversationSharedActive(active, scope)
          if (restore) retireFunctionConversationSharedRestore(restore, scope)
        }
        throw error
      }
    },
    delivery: (saver, binding) => new FunctionConversationDeliveryBridge(input.coordinator.store,
      () => binding).wrap(saver)
  }
  const scope = new FunctionConversationSharedCheckpointScope(scopeHost)
  return { scope, close: () => {
    scope.close()
    try { retire?.() }
    finally {
      if (active) retireFunctionConversationSharedActive(active, scope)
      if (restore) retireFunctionConversationSharedRestore(restore, scope)
    }
  } }
}
