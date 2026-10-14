import { BaseMessage } from "@langchain/core/messages"
import { copyCheckpoint, type Checkpoint } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { readFunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import { deserializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { functionConversationState } from "../agent/mods-conversation"
import { getDb, getThreadCore, getThreadMessageCanonicalId } from "../db"
import {
  prepareForkImport,
  beginForkImportInTransaction,
  copyForkImportPage,
  readForkImportView,
  readForkImportRow,
  assertForkImportCurrent,
  assertForkImportDataCurrent,
  bindForkImportTranscriptDataTail,
  recordForkImportCheckpoint,
  finishForkImport,
  abortForkImport,
  quarantineForkImport,
  type FunctionConversationForkPlan,
  type FunctionConversationForkSource,
  type FunctionConversationForkTarget,
  type FunctionConversationForkView
} from "../db/function-conversation-fork"
import {
  captureFunctionConversationForkTranscriptAccess,
  captureFunctionConversationForkVisibleSource,
  assertFunctionConversationForkTranscriptDataTail,
  type FunctionConversationForkVisibleSelector
} from "../db/function-conversation-fork-transcript"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { assertStoredProjectionReceipt } from "../db/function-conversation-projection-seal"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type {
  FunctionConversationRef,
  FunctionConversationRow,
  FunctionConversationStore
} from "../db/function-conversation-store"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnationRow
} from "../services/thread-incarnation"
import {
  captureConversationCheckpointRead,
  functionConversationCanonicalStamp,
  functionConversationMembershipDigest,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCheckpointMembershipProof
} from "./function-conversation-checkpoint-membership"
import {
  readFunctionConversationState,
  assertFunctionConversationState
} from "./function-conversation-delivery"
import { functionConversationForkIdentity } from "./function-conversation-fork-identity"
import { SqlJsSaver } from "./sqljs-saver"

function fail(code = "MODS_CONVERSATION_FORK_CHECKPOINT_CONFLICT"): never {
  throw new ModFunctionError(code)
}

/** Keep this object inside the original source Saver borrowing scope until finish/abort. */
export async function prepareFunctionConversationForkNativeImport(input: {
  readonly store: FunctionConversationStore
  readonly saver: SqlJsSaver
  readonly threadId: string
  readonly workspace: string
  readonly originalThread: ThreadIncarnationRow
  readonly checkpoints: readonly Checkpoint[]
  readonly selectedCheckpointId: string
  assertCurrent(): void
}): Promise<FunctionConversationForkNativeImport | undefined> {
  const selected = input.checkpoints.find(
    (checkpoint) => checkpoint.id === input.selectedCheckpointId
  )
  if (!selected) fail()
  const candidates = input.checkpoints.filter(
    (checkpoint) => checkpoint.channel_values.cmbFunctionConversation !== undefined
  )
  if (!candidates.length) return undefined
  if (selected.channel_values.cmbFunctionConversation === undefined) fail()
  const database = getDb(),
    incarnation = captureThreadIncarnation(input.originalThread)
  const sourceLifetime = SqlJsSaver.prototype.captureReadLifetime.call(input.saver)
  const originalMetadata = input.originalThread.metadata
  const guard = () => {
    input.assertCurrent()
    sourceLifetime()
    const row = getThreadCore(input.threadId)
    if (
      getDb() !== database ||
      !matchesThreadIncarnation(row, incarnation) ||
      row?.metadata !== originalMetadata
    )
      fail("MODS_CONVERSATION_THREAD_CHANGED")
  }
  guard()
  const sources: FunctionConversationForkSource[] = []
  for (const expected of candidates) {
    const state = readFunctionConversationState(expected.channel_values.cmbFunctionConversation)
    const root = input.store.findMain(
      {
        threadId: input.threadId,
        workspace: input.workspace,
        incarnation,
        checkpointNamespace: ""
      },
      guard
    )
    if (!root) fail("MODS_CONVERSATION_RECOVERY_REQUIRED")
    const target = input.store.selectBranch(root, state.branchId, guard)
    assertFunctionConversationState(target, state)
    const persisted = input.store.readCheckpointRecoverySnapshot(
      target,
      {
        checkpointThreadId: input.threadId,
        checkpointIncarnation: incarnation,
        checkpointId: expected.id
      },
      guard
    ).snapshot
    const cut = persisted.cut
    const captured = await captureConversationCheckpointRead(
      input.store,
      input.saver,
      {
        configurable: { thread_id: input.threadId, checkpoint_ns: "", checkpoint_id: expected.id }
      },
      (tuple) => {
        // A truncated prefix cannot borrow the original checkpoint's later note frontier.
        if (
          functionConversationForkIdentity(tuple.checkpoint) !==
          functionConversationForkIdentity(expected)
        )
          fail()
        assertFunctionConversationState(
          target,
          readFunctionConversationState(tuple.checkpoint.channel_values.cmbFunctionConversation)
        )
        return {
          target,
          checkpointThreadId: input.threadId,
          checkpointIncarnation: incarnation,
          cut,
          frontier: state.frontier,
          stateDigest: functionConversationMembershipDigest(state),
          assertCurrent: guard
        }
      },
      guard
    )
    if (!captured.proof) fail()
    const actual = readFunctionConversationCheckpointMembership(captured.proof, input.store, target)
    if (
      actual.snapshotDigest !== persisted.snapshotDigest ||
      functionConversationMembershipDigest(actual) !==
        functionConversationMembershipDigest(persisted)
    )
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    sources.push({ target, membership: captured.proof })
  }
  const selectedSourceIndex = candidates.findIndex((checkpoint) => checkpoint.id === selected.id)
  return new FunctionConversationForkNativeImport(
    input.store,
    prepareForkImport(input.store, { sources, selectedSourceIndex, assertSource: guard }),
    sources,
    candidates.map((checkpoint) => checkpoint.id),
    input.threadId,
    guard
  )
}

export class FunctionConversationForkNativeImport {
  private targetGuard?: () => void
  private transcript?: ReturnType<typeof captureFunctionConversationForkTranscriptAccess>
  constructor(
    private readonly store: FunctionConversationStore,
    private readonly plan: FunctionConversationForkPlan,
    private readonly sources: readonly FunctionConversationForkSource[],
    private readonly checkpointIds: readonly string[],
    private readonly sourceThreadId: string,
    private readonly sourceGuard: () => void
  ) {}

  begin(target: FunctionConversationForkTarget, guard: () => void): void {
    this.sourceGuard()
    beginForkImportInTransaction(this.plan, target, guard)
    this.targetGuard = guard
    this.transcript = captureFunctionConversationForkTranscriptAccess({
      source: {
        threadId: this.sourceThreadId,
        incarnation: this.sources[0].target.incarnation,
        assertCurrent: this.sourceGuard
      },
      target: { threadId: target.threadId, incarnation: target.incarnation, assertCurrent: guard }
    })
    bindForkImportTranscriptDataTail(this.plan, this.transcript.dataTail)
  }
  view() {
    return readForkImportView(this.plan)
  }
  abort(): void {
    try {
      quarantineForkImport(this.plan)
    } finally {
      abortForkImport(this.plan)
    }
  }

  preflightVisible(selectors: readonly FunctionConversationForkVisibleSelector[]): void {
    const source = {
      threadId: this.sourceThreadId,
      incarnation: this.sources[0].target.incarnation,
      assertCurrent: this.sourceGuard
    }
    const reader = captureFunctionConversationForkVisibleSource({
      source,
      canonicalMessageId: (id) => getThreadMessageCanonicalId(this.sourceThreadId, id)
    })
    for (const selector of selectors) {
      if (!reader.preflightVisible(selector)) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
      const actual = readFunctionConversationRawProjection(
        getDb(),
        this.sourceThreadId,
        selector.messageId
      )
      if (actual?.function_row_json !== null)
        assertStoredProjectionReceipt(getDb(), {
          ...source,
          messageId: selector.messageId
        })
    }
    this.sourceGuard()
  }

  copyVisiblePage(selectors: readonly FunctionConversationForkVisibleSelector[]): void {
    const view = this.view(),
      transcript = this.transcript,
      database = getDb()
    if (!transcript) fail()
    if (selectors.length > 64) fail("MODS_CONVERSATION_FORK_PAGE_LIMIT")
    this.preflightVisible(selectors)
    // The plan's authenticated read is committed-only. Capture one bounded page before BEGIN;
    // the original raw/canonical receipts and both lifetimes are rechecked inside the transaction.
    const canonical = new Map<string, FunctionConversationRow>()
    for (const selector of selectors) {
      const original = readFunctionConversationRawProjection(
        database,
        this.sourceThreadId,
        selector.messageId
      )
      if (original && original.function_row_json !== null)
        canonical.set(
          selector.messageId,
          readForkImportRow(this.plan, view.selectedSourceIndex, selector.messageId)
        )
    }
    const verify = (writing: boolean) => {
      this.sourceGuard()
      this.targetGuard?.()
      assertForkImportCurrent(this.plan)
      for (const selector of selectors) {
        const original = readFunctionConversationRawProjection(
          database,
          this.sourceThreadId,
          selector.messageId
        )
        if (!original) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
        if (original.function_row_json !== null) {
          const row = canonical.get(selector.messageId)
          if (!row) fail()
          const target = Object.freeze({ ...view.target, branchId: row.branchId })
          this.access(view, target, row).verify(database, target, row)
        } else if (writing) {
          if (!transcript.copyPersistedVisible(database, selector))
            fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
        } else transcript.verifyPersistedVisible(database, selector)
      }
      this.sourceGuard()
      this.targetGuard?.()
      assertForkImportCurrent(this.plan)
      // Every actual source/proof callback is complete. Recheck the whole native page together.
      assertForkImportDataCurrent(this.plan)
      const expected = selectors.map(selector => {
        const row = canonical.get(selector.messageId)
        return { uuid: selector.messageId, ...(row ? { branchId: row.branchId } : {}) }
      })
      assertFunctionConversationForkTranscriptDataTail(transcript.dataTail, database, expected,
        { source: this.sourceThreadId, target: view.target.threadId })
    }
    database.run("BEGIN IMMEDIATE")
    try {
      verify(true)
      database.run("COMMIT")
    } catch (error) {
      if (!database.inTransaction) {
        // An uncertain native COMMIT is adopted only by exact persisted rows, never by replay.
        try {
          verify(false)
          return
        } catch {
          /* Keep the original failure. */
        }
      } else {
        try {
          database.run("ROLLBACK")
        } catch {
          /* Keep the original failure. */
        }
      }
      throw error
    }
    verify(false)
  }

  private access(
    view: FunctionConversationForkView,
    target: FunctionConversationRef,
    row: FunctionConversationRow
  ) {
    this.sourceGuard()
    this.targetGuard?.()
    const sourceBranch = Object.entries(view.branchMap).find(
      ([, branch]) => branch === row.branchId
    )?.[0]
    if (!sourceBranch) fail()
    const source = Object.freeze({ ...this.sources[0].target, branchId: sourceBranch })
    const original = this.store.readReceipt(source, row.uuid)
    if (
      !original ||
      original.nativePayload !== row.nativePayload ||
      original.sequence !== row.sequence ||
      original.createdAt !== row.createdAt
    )
      fail()
    const transcript = this.transcript
    if (!transcript) fail()
    this.store.assertCurrent(target)
    return {
      write: (
        database: NativeSqliteAdapter,
        target: FunctionConversationRef,
        copied: FunctionConversationRow
      ) => transcript.writeCanonical(database, source, original, target, copied),
      verify: (
        database: NativeSqliteAdapter,
        target: FunctionConversationRef,
        copied: FunctionConversationRow
      ) => transcript.verifyCanonical(database, source, original, target, copied)
    }
  }

  copyPage() {
    const view = this.view()
    const transcript = this.transcript
    if (!transcript) fail()
    return copyForkImportPage(
      this.plan,
      (database, target, row) => this.access(view, target, row).write(database, target, row),
      (database, target, row) => this.access(view, target, row).verify(database, target, row),
      transcript.dataTail
    )
  }

  checkpoint(checkpoint: Checkpoint): Checkpoint {
    const sourceIndex = this.checkpointIds.indexOf(checkpoint.id)
    if (sourceIndex < 0) return checkpoint
    const entry = this.view().entries[sourceIndex]
    const copy = copyCheckpoint(checkpoint)
    const messages: unknown = checkpoint.channel_values.messages
    if (!Array.isArray(messages)) fail()
    copy.channel_values.messages = messages.map((message) => {
      if (!BaseMessage.isInstance(message)) fail()
      const stamp = readFunctionConversationTranscriptStamp(message)
      if (!stamp) return message
      const row = readForkImportRow(this.plan, sourceIndex, stamp.uuid)
      const native = deserializeFunctionConversationNativeMessage(row.nativePayload)
      native.additional_kwargs = {
        ...native.additional_kwargs,
        function_row: functionConversationCanonicalStamp(entry.target, row)
      }
      return native
    })
    copy.channel_values.cmbFunctionConversation = functionConversationState(
      entry.target,
      entry.frontier
    )
    return copy
  }

  async recordCheckpoint(saver: SqlJsSaver, checkpoint: Checkpoint): Promise<void> {
    const index = this.checkpointIds.indexOf(checkpoint.id)
    if (index < 0) return
    recordForkImportCheckpoint(this.plan, index, await this.readTargetCheckpoint(saver, index))
  }

  private async readTargetCheckpoint(
    saver: SqlJsSaver,
    index: number
  ): Promise<FunctionConversationCheckpointMembershipProof> {
    const entry = this.view().entries[index]
    const state = functionConversationState(entry.target, entry.frontier)
    const guard = () => {
      this.sourceGuard()
      this.targetGuard?.()
      assertForkImportCurrent(this.plan)
    }
    const captured = await captureConversationCheckpointRead(
      this.store,
      saver,
      {
        configurable: {
          thread_id: entry.target.threadId,
          checkpoint_ns: "",
          checkpoint_id: entry.sourceCheckpointId
        }
      },
      () => ({
        target: entry.target,
        checkpointThreadId: entry.target.threadId,
        checkpointIncarnation: entry.target.incarnation,
        cut: entry.canonicalCut,
        frontier: entry.frontier,
        stateDigest: functionConversationMembershipDigest(state),
        assertCurrent: guard
      }),
      guard
    )
    if (!captured.proof) fail()
    return captured.proof
  }

  async finish(saver: SqlJsSaver): Promise<void> {
    const view = this.view()
    finishForkImport(this.plan, await this.readTargetCheckpoint(saver, view.selectedSourceIndex))
  }
}
