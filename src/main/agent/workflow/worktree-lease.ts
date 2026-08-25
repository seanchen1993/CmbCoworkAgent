import {
  assertWorkflowWorktreeDeliverableDescendsFromBase,
  assertWorkflowWorktreeDeliverablePathsInScope,
  createWorkflowWorktree,
  deleteWorkflowWorktreeRecord,
  inspectWorkflowWorktree,
  isWorktreePristine,
  persistWorkflowWorktreeRecord,
  prepareWorkflowWorktreeSource,
  removeWorkflowWorktree,
  type WorkflowWorktreeInfo,
  type WorkflowWorktreeSource
} from "../../services/git-worktree"
import type { WorkflowWorktreeRecord, WorkflowWorktreeStatus } from "./types"
import { getWorkflowWorktreeTimeoutMs } from "../../../shared/agent-runtime-limits"

interface OwnedWorktree {
  info: WorkflowWorktreeInfo
  record: WorkflowWorktreeRecord
}

export class WorkflowWorktreeLedger {
  private readonly pending = new Map<string, OwnedWorktree>()
  private sourcePromise: Promise<WorkflowWorktreeSource> | undefined
  private disposed = false

  constructor(
    private readonly options: {
      workspacePath: string
      runId: string
      threadId?: string
      create?: typeof createWorkflowWorktree
      pristine?: typeof isWorktreePristine
      appDataRoot?: string
      signal?: AbortSignal
      onRecordChange?: (record: WorkflowWorktreeRecord) => void
      onRecordDelete?: (record: WorkflowWorktreeRecord) => void
    }
  ) {}

  /** Freeze the actual source checkout once. All fan-out agents await this same
   * promise, so a later branch switch cannot split one run across baselines. */
  private source(): Promise<WorkflowWorktreeSource> {
    if (!this.sourcePromise) {
      const pending = prepareWorkflowWorktreeSource(this.options.workspacePath, this.options.signal)
      this.sourcePromise = pending
      // A transient dirty/read failure happened before any base was frozen or
      // checkout was created. Let a later isolated call retry after the user
      // fixes the source; successful preparation remains frozen for the fan-out.
      void pending.catch(() => {
        if (this.sourcePromise === pending) this.sourcePromise = undefined
      })
    }
    return this.sourcePromise
  }

  async acquire(label: string): Promise<WorkflowWorktreeInfo> {
    if (this.disposed) throw new Error("workflow run is shutting down — no new isolated worktree")
    const source = await this.source()
    if (this.disposed) throw new Error("workflow run was cancelled before worktree creation")

    const create = this.options.create ?? createWorkflowWorktree
    // Production launches always provide the real thread id. The run id keeps
    // direct/test callers deterministic without permitting ownerless manifests.
    const threadId = this.options.threadId ?? this.options.runId
    const info = await create({
      workspacePath: this.options.workspacePath,
      runId: this.options.runId,
      threadId,
      label,
      appDataRoot: this.options.appDataRoot,
      source,
      persistOwnership: true,
      signal: this.options.signal
    })
    const now = new Date().toISOString()
    let record: WorkflowWorktreeRecord = {
      id: info.name,
      runId: this.options.runId,
      threadId,
      branch: info.branch,
      directory: info.directory,
      workspaceDirectory: info.workspaceDirectory,
      sourceRoot: info.sourceRoot,
      sourceRelativePath: info.sourceRelativePath,
      sourceBranch: info.sourceBranch,
      gitRoot: info.gitRoot,
      commonDir: info.commonDir,
      baseCommit: info.baseCommit,
      headCommit: info.baseCommit,
      dirty: false,
      status: "provisioning",
      updatedAt: now
    }

    try {
      this.options.onRecordChange?.(record)
      record = await this.transition(record, "running", { dirty: false })
    } catch (error) {
      await this.retainRecoverable({ info, record }, error)
      throw error
    }

    // Cancellation can land during checkout creation. Since no agent ran yet,
    // a pristine tree is disposable.
    if (this.disposed) {
      await this.recoverOrRemove({ info, record }, new Error("cancelled during provisioning"))
      throw new Error("workflow run was cancelled while its isolated worktree was being created")
    }
    this.pending.set(info.directory, { info, record })
    this.options.onRecordChange?.(record)
    return info
  }

  async settle(info: WorkflowWorktreeInfo, outcome: { succeeded: boolean }): Promise<void> {
    const owned = this.pending.get(info.directory)
    if (!owned) return
    this.pending.delete(info.directory)

    const state = await this.inspect(info)
    if (state.pristine) {
      try {
        await this.removeAndForget(owned)
      } catch (error) {
        const record = await this.transition(owned.record, "recoverable", {
          dirty: false,
          error: `pristine cleanup failed; retained conservatively: ${error instanceof Error ? error.message : String(error)}`
        }).catch(() => ({
          ...owned.record,
          status: "recoverable" as const,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString()
        }))
        this.options.onRecordChange?.(record)
      }
      return
    }

    // A successful agent result only makes a worktree actionable when its Git
    // checkout can still be read. Missing/damaged checkouts have no valid HEAD
    // to Merge or Diff, so retain them as recovery state instead of advertising
    // a false ready deliverable.
    const hasReadableHead = Boolean(state.headCommit)
    let deliveryError: string | undefined
    if (outcome.succeeded && hasReadableHead && state.headCommit !== info.baseCommit) {
      try {
        await assertWorkflowWorktreeDeliverableDescendsFromBase(
          info.directory,
          info.baseCommit,
          state.headCommit,
          getWorkflowWorktreeTimeoutMs(),
          this.options.signal
        )
        await assertWorkflowWorktreeDeliverablePathsInScope(
          info.directory,
          info.baseCommit,
          state.headCommit,
          info.sourceRelativePath,
          getWorkflowWorktreeTimeoutMs(),
          this.options.signal
        )
      } catch (error) {
        deliveryError = `agent committed a deliverable that cannot be merged automatically: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const status: WorkflowWorktreeStatus =
      outcome.succeeded && hasReadableHead && !deliveryError ? "ready" : "recoverable"
    const patch: Partial<WorkflowWorktreeRecord> = {
      headCommit: state.headCommit || undefined,
      dirty: state.dirty,
      ...(outcome.succeeded
        ? hasReadableHead
          ? deliveryError
            ? { error: deliveryError }
            : {}
          : { error: "agent completed but its worktree is unreadable; retained for recovery" }
        : { error: "agent failed or was cancelled; changes retained for recovery" })
    }
    const record = await this.transition(owned.record, status, patch).catch((error) => ({
      ...owned.record,
      ...patch,
      status: "recoverable" as const,
      error: `failed to persist settled state; worktree retained: ${error instanceof Error ? error.message : String(error)}`,
      updatedAt: new Date().toISOString()
    }))
    this.options.onRecordChange?.(record)
  }

  /** Outstanding entries represent abnormal termination. Never force-delete them:
   * even a currently clean tree can still be owned by a process that ignored abort.
   * Persist recovery state and let an explicit discard or a later verified-pristine
   * maintenance pass remove it. */
  async reclaimAll(): Promise<void> {
    this.disposed = true
    const outstanding = [...this.pending.values()]
    // Every Git probe is itself time-bounded. Await the actual recovery tasks so
    // no detached promise can mutate run history after the manager's final flush.
    await Promise.allSettled(
      outstanding.map(async (owned) => {
        try {
          await this.retainOutstanding(owned)
        } finally {
          this.pending.delete(owned.info.directory)
        }
      })
    )
  }

  private async retainOutstanding(owned: OwnedWorktree): Promise<void> {
    const state = await this.inspect(owned.info)
    const record = await this.transition(owned.record, "recoverable", {
      headCommit: state.headCommit || undefined,
      dirty: state.dirty,
      error: "workflow stopped before the agent settled; worktree retained for recovery"
    })
    this.options.onRecordChange?.(record)
  }

  private async retainRecoverable(
    owned: OwnedWorktree,
    error: unknown,
    inspected?: { dirty: boolean; headCommit: string }
  ): Promise<void> {
    const state = inspected ?? (await this.inspect(owned.info))
    const recoveryPatch: Partial<WorkflowWorktreeRecord> = {
      headCommit: state.headCommit || undefined,
      dirty: state.dirty,
      error: error instanceof Error ? error.message : String(error)
    }
    const record = await this.transition(owned.record, "recoverable", recoveryPatch).catch(
      (persistError) => ({
        ...owned.record,
        ...recoveryPatch,
        status: "recoverable" as const,
        error: `${recoveryPatch.error}; recovery record persist failed: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        updatedAt: new Date().toISOString()
      })
    )
    this.options.onRecordChange?.(record)
  }

  private async recoverOrRemove(owned: OwnedWorktree, error: unknown): Promise<void> {
    const state = await this.inspect(owned.info)
    if (state.pristine) {
      try {
        await this.removeAndForget(owned)
        return
      } catch (cleanupError) {
        const record = await this.transition(owned.record, "recoverable", {
          dirty: false,
          error: `provisioning failed and safe cleanup could not finish: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        }).catch(() => ({
          ...owned.record,
          status: "recoverable" as const,
          error: `provisioning failed; worktree retained at ${owned.info.directory}`,
          updatedAt: new Date().toISOString()
        }))
        this.options.onRecordChange?.(record)
        return
      }
    }
    await this.retainRecoverable(owned, error, state)
  }

  private async inspect(info: WorkflowWorktreeInfo): Promise<{
    pristine: boolean
    dirty: boolean
    headCommit: string
  }> {
    const inspected = await inspectWorkflowWorktree(info.directory, info.baseCommit).catch(() => ({
      pristine: false,
      dirty: true,
      headCommit: ""
    }))
    if (!this.options.pristine) {
      return {
        pristine: inspected.pristine,
        dirty: inspected.dirty,
        headCommit: inspected.headCommit
      }
    }
    // Preserve test injection of a custom pristine predicate without making the
    // production path run a duplicate status + rev-parse pair.
    let pristine = false
    try {
      pristine = await this.options.pristine(info.directory, info.baseCommit)
    } catch {
      pristine = false
    }
    return { pristine, dirty: inspected.dirty, headCommit: inspected.headCommit }
  }

  private async transition(
    record: WorkflowWorktreeRecord,
    status: WorkflowWorktreeStatus,
    patch: Partial<WorkflowWorktreeRecord>
  ): Promise<WorkflowWorktreeRecord> {
    const next = { ...record, ...patch, status, updatedAt: new Date().toISOString() }
    await this.persist(next)
    return next
  }

  private async persist(record: WorkflowWorktreeRecord): Promise<void> {
    await persistWorkflowWorktreeRecord(record, this.options.appDataRoot)
  }

  private async removeAndForget(owned: OwnedWorktree): Promise<void> {
    await removeWorkflowWorktree({
      directory: owned.info.directory,
      gitRoot: owned.info.gitRoot,
      branch: owned.info.branch,
      expectedBranchHead: owned.info.baseCommit,
      preserveChanges: true
    })
    try {
      await deleteWorkflowWorktreeRecord(
        owned.record.commonDir,
        owned.record.id,
        this.options.appDataRoot
      )
    } catch (error) {
      // Git already removed the pristine checkout and its branch. Do not erase
      // its UI record while the durable ownership tombstone remains: record a
      // terminal cleanup retry instead of resurrecting a fictitious worktree
      // during later manifest reconciliation.
      const record = await this.transition(owned.record, "discarded", {
        dirty: false,
        cleanupPending: true,
        error: `pristine worktree was removed; ownership cleanup is pending: ${error instanceof Error ? error.message : String(error)}`
      }).catch(() => ({
        ...owned.record,
        status: "discarded" as const,
        dirty: false,
        cleanupPending: true,
        error: `pristine worktree was removed; ownership cleanup is pending: ${error instanceof Error ? error.message : String(error)}`,
        updatedAt: new Date().toISOString()
      }))
      this.options.onRecordChange?.(record)
      return
    }
    this.options.onRecordDelete?.(owned.record)
  }
}
