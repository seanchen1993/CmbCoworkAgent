import type { ModJson } from "../../../shared/mods/types"
import { resolve, join } from "path"
import { randomUUID } from "node:crypto"
import {
  assertWorkflowWorktreeDeliverableDescendsFromBase,
  assertWorkflowWorktreeDeliverablePathsInScope,
  createWorkflowWorktree,
  commitWorkflowWorktreeChanges,
  deleteWorkflowWorktreeRecord,
  inspectWorkflowWorktree,
  listWorkflowWorktreeRecordsForPrune,
  mergeWorkflowWorktree,
  discardWorkflowWorktree,
  diffWorkflowWorktree,
  recoverInterruptedWorkflowWorktree,
  resolveWorkflowWorktreeIsolationBoundary,
  isWorktreePristine,
  persistWorkflowWorktreeRecord,
  prepareWorkflowWorktreeSource,
  verifyWorkflowPromotedSource,
  removeWorkflowWorktree,
  type WorkflowWorktreeInfo,
  type WorkflowWorktreeSource
} from "../../services/git-worktree"
import type {
  WorkflowWorktreeRecord,
  WorkflowWorktreeStatus,
  WorkflowResourceJournalCheckpoint
} from "./types"
import { getWorkflowWorktreeTimeoutMs } from "../../../shared/agent-runtime-limits"
import type { WorkflowVerificationResource } from "./worktree-action-scope"
import { withWorkflowResourceDeadline, validWorkflowDeadlines } from "./resource-deadline"
import type { WorkflowResourceDeadline } from "./types"

function worktreeDirectoryKey(directory: string): string {
  const normalized = resolve(directory).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

interface OwnedWorktree {
  info: WorkflowWorktreeInfo
  record: WorkflowWorktreeRecord
  busy?: boolean
}

export interface WorkflowWorktreeMergePlan {
  targetResource?: { id: string; generation: number; handle: string }
  runId: string
  resourceId: string
  generation: number
  headCommit: string
  baseCommit: string
  sourceCommit: string
  sourceBranch: string
  sourceRoot: string
}

export class WorkflowWorktreeLedger {
  private readonly pending = new Map<string, OwnedWorktree>()
  private readonly sourcePromises = new Map<string, Promise<WorkflowWorktreeSource>>()
  private disposed = false

  constructor(
    private readonly options: {
      workspacePath: string
      executionResources?: import("../../plugins/runtime-source-scope").RuntimeExecutionResources
      runId: string
      threadId?: string
      create?: typeof createWorkflowWorktree
      pristine?: typeof isWorktreePristine
      appDataRoot?: string
      signal?: AbortSignal
      parentIdentity?: string
      existingWorktrees?: WorkflowWorktreeRecord[]
      integrate?<T>(sourceRoot: string, task: () => Promise<T>): Promise<T>
      approveMerge?(plan: WorkflowWorktreeMergePlan): Promise<boolean>
      onRecordChange?: (record: WorkflowWorktreeRecord) => void
      onRecordDelete?: (record: WorkflowWorktreeRecord) => void
    }
  ) {}

  /** Synchronous in-memory guard used immediately before manual deletion. */
  ownsWorktreeDirectory(directory: string): boolean {
    const targetKey = worktreeDirectoryKey(directory)
    for (const owned of this.pending.values()) {
      if (worktreeDirectoryKey(owned.info.directory) === targetKey) return true
    }
    return false
  }

  /** Freeze the actual source checkout once. All fan-out agents await this same
   * promise, so a later branch switch cannot split one run across baselines. */
  private workspace(workspaceRef?: string): string {
    if (workspaceRef === undefined) return this.options.workspacePath
    const authorized = this.options.executionResources?.workspaces.find(
      (item) => item.id === workspaceRef
    )
    if (!authorized) throw Error("WORKTREE_WORKSPACE_REF_UNAUTHORIZED")
    return authorized.path
  }
  private recordWorkspace(record: WorkflowWorktreeRecord): string {
    const selected = this.workspace(record.resource?.workspaceRef)
    if (
      record.resource?.executionResourcesFingerprint !==
        this.options.executionResources?.fingerprint ||
      worktreeDirectoryKey(join(record.sourceRoot, record.sourceRelativePath)) !==
        worktreeDirectoryKey(selected)
    )
      throw Error("WORKTREE_WORKSPACE_BINDING_CHANGED")
    return selected
  }
  private source(workspaceRef?: string): Promise<WorkflowWorktreeSource> {
    const workspace = this.workspace(workspaceRef)
    if (!this.sourcePromises.has(workspace)) {
      const pending = prepareWorkflowWorktreeSource(workspace, this.options.signal)
      this.sourcePromises.set(workspace, pending)
      // A transient dirty/read failure happened before any base was frozen or
      // checkout was created. Let a later isolated call retry after the user
      // fixes the source; successful preparation remains frozen for the fan-out.
      void pending.catch(() => {
        if (this.sourcePromises.get(workspace) === pending) this.sourcePromises.delete(workspace)
      })
    }
    return this.sourcePromises.get(workspace)!
  }

  async acquire(
    label: string,
    agentIndex?: number,
    resource?: WorkflowWorktreeRecord["resource"]
  ): Promise<WorkflowWorktreeInfo> {
    if (agentIndex !== undefined && (!Number.isSafeInteger(agentIndex) || agentIndex < 0))
      throw new Error("invalid workflow agent index")
    if (this.disposed) throw new Error("workflow run is shutting down — no new isolated worktree")
    const source = await this.source(resource?.workspaceRef)
    if (this.disposed) throw new Error("workflow run was cancelled before worktree creation")

    const create = this.options.create ?? createWorkflowWorktree
    // Production launches always provide the real thread id. The run id keeps
    // direct/test callers deterministic without permitting ownerless manifests.
    const threadId = this.options.threadId ?? this.options.runId
    const info = await create({
      workspacePath: this.workspace(resource?.workspaceRef),
      runId: this.options.runId,
      threadId,
      label,
      appDataRoot: this.options.appDataRoot,
      source,
      persistOwnership: true,
      signal: this.options.signal,
      resource
    })
    const now = new Date().toISOString()
    let record: WorkflowWorktreeRecord = {
      ...(resource ? { resource } : {}),
      ...(agentIndex === undefined ? {} : { agentIndex }),
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

  private readonly resourceAdmissions = new Set<string>()

  private assertResourceCurrent(): void {
    this.options.signal?.throwIfAborted()
    if (this.disposed) throw Error("WORKTREE_RESOURCE_OWNER_RETIRED")
  }

  private resourceView(owned: OwnedWorktree) {
    const record = owned.record,
      resource = record.resource!
    return {
      handle: resource.ownerToken,
      resourceId: resource.id,
      runId: record.runId,
      generation: resource.generation,
      state: resource.state,
      status: record.status,
      baseCommit: record.baseCommit,
      headCommit: record.headCommit ?? null,
      dirty: record.dirty,
      budgets: JSON.parse(JSON.stringify(resource.budgets ?? [])) as ModJson,
      sealedCommit: resource.sealedCommit ?? null,
      integrationCommit: record.integrationCommit ?? null,
      workspaceRef: resource.workspaceRef ?? null,
      integrationTarget: record.integrationTarget
        ? {
            resourceId: record.integrationTarget.worktreeId,
            generation: record.integrationTarget.generation
          }
        : null
    }
  }

  /** Restore only this original run's manifests. A running lease after restart is unknown. */
  private async namedResource(
    id: string,
    sourceIdentity: string,
    workspaceRef?: string
  ): Promise<OwnedWorktree | undefined> {
    this.assertResourceCurrent()
    this.workspace(workspaceRef)
    const live = [...this.pending.values()].find((value) => value.record.resource?.id === id)
    if (live) {
      if (live.record.resource!.sourceIdentity !== sourceIdentity)
        throw Error("WORKTREE_RESOURCE_SOURCE_CHANGED")
      if (live.record.resource!.workspaceRef !== workspaceRef)
        throw Error("WORKTREE_WORKSPACE_BINDING_CHANGED")
      this.recordWorkspace(live.record)
      return live
    }
    const source = await this.source(workspaceRef)
    const manifests = await listWorkflowWorktreeRecordsForPrune(
      source.commonDir,
      this.options.appDataRoot
    )
    this.assertResourceCurrent()
    if (!manifests.reliable) throw Error("WORKTREE_RESOURCE_MANIFEST_UNCONFIRMED")
    const records = new Map(
      (this.options.existingWorktrees ?? []).map((record) => [record.id, record])
    )
    for (const record of manifests.records) records.set(record.id, record)
    const own = [...records.values()].filter(
      (record) =>
        record.runId === this.options.runId &&
        record.threadId === (this.options.threadId ?? this.options.runId) &&
        record.resource
    )
    if (own.some((record) => record.resource!.parentIdentity !== this.options.parentIdentity))
      throw Error("WORKTREE_RESOURCE_SOURCE_CHANGED")
    const found = own.filter((record) => record.resource!.id === id)
    if (found.length > 1) throw Error("WORKTREE_RESOURCE_MANIFEST_UNCONFIRMED")
    if (!found.length) return undefined
    let record = found[0]
    if (record.resource!.workspaceRef !== workspaceRef)
      throw Error("WORKTREE_WORKSPACE_BINDING_CHANGED")
    this.recordWorkspace(record)
    if (record.resource!.sourceIdentity !== sourceIdentity)
      throw Error("WORKTREE_RESOURCE_SOURCE_CHANGED")
    if (record.resource!.state === "leased") {
      record = await this.transition(record, "recoverable", {
        resource: { ...record.resource!, state: "unknown" },
        error: "named resource outlived its original process; explicit reconciliation is required"
      })
      this.options.onRecordChange?.(record)
    }
    const info: WorkflowWorktreeInfo = { ...record, name: record.id }
    const owned = { info, record }
    this.pending.set(info.directory, owned)
    return owned
  }

  async acquireResource(id: string, sourceIdentity: string, workspaceRef?: string) {
    this.assertResourceCurrent()
    if (!this.options.parentIdentity) throw Error("WORKTREE_RESOURCE_PARENT_UNBOUND")
    if (this.resourceAdmissions.has(id)) throw Error("WORKTREE_RESOURCE_BUSY")
    this.resourceAdmissions.add(id)
    try {
      let owned = await this.namedResource(id, sourceIdentity, workspaceRef)
      if (!owned) {
        const info = await this.acquire(`resource-${id.slice(0, 16)}`, undefined, {
          id,
          sourceIdentity,
          parentIdentity: this.options.parentIdentity,
          ...(workspaceRef ? { workspaceRef } : {}),
          ...(this.options.executionResources
            ? { executionResourcesFingerprint: this.options.executionResources.fingerprint }
            : {}),
          ownerToken: randomUUID(),
          generation: 1,
          state: "leased"
        })
        owned = this.pending.get(info.directory)!
      }
      this.assertResourceCurrent()
      return this.resourceView(owned)
    } finally {
      this.resourceAdmissions.delete(id)
    }
  }

  async inspectResource(id: string, sourceIdentity: string, workspaceRef?: string) {
    const owned = await this.namedResource(id, sourceIdentity, workspaceRef)
    if (!owned) throw Error("WORKTREE_RESOURCE_NOT_FOUND")
    if (owned.busy) throw Error("WORKTREE_RESOURCE_BUSY")
    if (owned.record.status === "merged" || owned.record.status === "discarded")
      return this.resourceView(owned)
    owned.busy = true
    try {
      // The original service checks the manifest, registry, checkout and source ownership.
      const result = await diffWorkflowWorktree({
        workspacePath: this.recordWorkspace(owned.record),
        record: owned.record,
        appDataRoot: this.options.appDataRoot
      })
      this.assertResourceCurrent()
      owned.record = result.record
      this.options.onRecordChange?.(owned.record)
      return this.resourceView(owned)
    } finally {
      owned.busy = false
    }
  }

  private byResourceHandle(handle: string): OwnedWorktree {
    this.assertResourceCurrent()
    const owned = [...this.pending.values()].find(
      (value) => value.record.resource?.ownerToken === handle
    )
    if (!owned) throw Error("WORKTREE_RESOURCE_HANDLE_INVALID")
    this.recordWorkspace(owned.record)
    if (owned.busy) throw Error("WORKTREE_RESOURCE_BUSY")
    return owned
  }

  async deadlineCommand(
    handle: string,
    budgetId: string,
    sourceIdentity: string,
    command: { op: "begin"; policy: WorkflowResourceDeadline["policy"] } |
      { op: "command"; commandId: string; argv: string[] } |
      { op: "settle"; outcome: "succeeded" | "failed"; executionId?: string },
    assertCurrent: () => void,
    verifyReceipt: (executionId: string) => boolean
  ) {
    const owned = this.byResourceHandle(handle)
    if (owned.record.resource!.sourceIdentity !== sourceIdentity)
      throw Error("WORKTREE_RESOURCE_SOURCE_CHANGED")
    if (!validWorkflowDeadlines(owned.record.resource!.budgets))
      throw Error("WORKTREE_DEADLINE_FACTS_INVALID")
    const budgets = structuredClone(owned.record.resource!.budgets ?? [])
    let budget = budgets.find(item => item.budgetId === budgetId)
    const now = Date.now()
    if (command.op === "begin") {
      if (budget) {
        if (JSON.stringify(budget.policy) !== JSON.stringify(command.policy))
          throw Error("WORKTREE_DEADLINE_POLICY_CHANGED")
        return this.resourceView(owned)
      }
      if (budgets.length >= 32) throw Error("WORKTREE_DEADLINE_HISTORY_LIMIT")
      if (budgets.some(item => item.status !== "succeeded"))
        throw Error("WORKTREE_DEADLINE_UNSETTLED")
      if (owned.record.status !== "running" || owned.record.resource!.state !== "leased")
        throw Error("WORKTREE_RESOURCE_NOT_WRITABLE")
      budget = { budgetId, generation: owned.record.resource!.generation, policy: command.policy, startedAt: now,
        firstDeadlineAt: now + command.policy.firstExecutionMs,
        deadlineAt: now + command.policy.totalMs, status: "active", commands: [] }
      budgets.push(budget)
    } else {
      if (!budget) throw Error("WORKTREE_DEADLINE_UNKNOWN")
      if (command.op === "command") {
        const previous = budget.commands.find(item => item.commandId === command.commandId)
        if (previous) {
          if (JSON.stringify(previous.argv) !== JSON.stringify(command.argv))
            throw Error("WORKTREE_DEADLINE_COMMAND_CHANGED")
          return this.resourceView(owned)
        }
        if (budget.generation !== owned.record.resource!.generation) throw Error("WORKTREE_DEADLINE_GENERATION_CHANGED")
        this.assertDeadlineActive(budget)
        if (budget.commands.length >= 64) throw Error("WORKTREE_DEADLINE_COMMAND_LIMIT")
        budget.commands.push({ commandId: command.commandId, argv: command.argv, status: "prepared" })
      } else {
        if (budget.status !== "active") {
          if (budget.status !== command.outcome || budget.executionId !== command.executionId)
            throw Error("WORKTREE_DEADLINE_SETTLEMENT_CHANGED")
          return this.resourceView(owned)
        }
        if (command.outcome === "succeeded") {
          if (budget.generation !== owned.record.resource!.generation) throw Error("WORKTREE_DEADLINE_GENERATION_CHANGED")
          this.assertDeadlineActive(budget)
          const completed = budget.commands.find(item => item.executionId === command.executionId)
          if (!command.executionId || !completed || completed.status !== "finished" ||
              completed.exitCode !== 0 || completed.startedAt === undefined ||
              completed.finishedAt === undefined || budget.firstCommandAt === undefined ||
              budget.firstCommandAt >= budget.firstDeadlineAt ||
              completed.finishedAt >= budget.deadlineAt ||
              completed.finishedAt - completed.startedAt > budget.policy.commandMs ||
              budget.commands.some(item => item.status !== "finished") ||
              !verifyReceipt(command.executionId))
            throw Error("WORKTREE_DEADLINE_RECEIPT_UNCONFIRMED")
          budget.executionId = command.executionId
        }
        budget.status = command.outcome
        budget.settledAt = now
      }
    }
    owned.busy = true
    try {
      assertCurrent()
      owned.record = await this.transition(owned.record, owned.record.status, {
        resource: { ...owned.record.resource!, budgets }
      }, () => {
        assertCurrent()
        if (command.op !== "settle" || command.outcome === "succeeded") {
          if (Date.now() >= Math.min(budget!.deadlineAt, budget!.firstCommandAt === undefined ? budget!.firstDeadlineAt : Infinity))
            throw Error("WORKTREE_DEADLINE_EXPIRED")
        }
      })
      this.options.onRecordChange?.(owned.record)
      assertCurrent()
      return this.resourceView(owned)
    } finally { owned.busy = false }
  }

  private assertDeadlineActive(budget: WorkflowResourceDeadline) {
    if (budget.status !== "active") throw Error("WORKTREE_DEADLINE_SETTLED")
    if (Date.now() >= Math.min(budget.deadlineAt,
      budget.firstCommandAt === undefined ? budget.firstDeadlineAt : Infinity))
      throw Error("WORKTREE_DEADLINE_EXPIRED")
  }

  /** The same original ledger retains ownership across agent steps. */
  async commitResourceChanges(handle: string, expectedParent: string, budgetId?: string): Promise<void> {
    const owned = this.byResourceHandle(handle)
    await this.useResource(handle, async () => {
      owned.record = await commitWorkflowWorktreeChanges({
        workspacePath: this.recordWorkspace(owned.record),
        record: owned.record,
        expectedParent,
        appDataRoot: this.options.appDataRoot,
        signal: this.options.signal
      })
      this.options.onRecordChange?.(owned.record)
    }, budgetId)
  }

  async captureResourceJournalCheckpoint(
    handle: string
  ): Promise<WorkflowResourceJournalCheckpoint> {
    const owned = this.byResourceHandle(handle)
    const resource = owned.record.resource!
    const checkpoint = {
      handle,
      generation: resource.generation,
      resourceId: resource.id,
      sourceIdentity: resource.sourceIdentity,
      headCommit: owned.record.headCommit ?? ""
    }
    await this.validateResourceJournalCheckpoint(handle, checkpoint)
    return checkpoint
  }

  private async mergedEvidence(
    record: WorkflowWorktreeRecord,
    visited = new Set<string>()
  ): Promise<{ directory: string; head: string }> {
    if (visited.has(record.id)) throw Error("WORKTREE_RESOURCE_TARGET_CYCLE")
    visited.add(record.id)
    const bound = record.integrationTarget
    if (!bound) {
      const source = await prepareWorkflowWorktreeSource(
        this.recordWorkspace(record),
        this.options.signal
      )
      if (source.sourceBranch !== record.sourceBranch)
        throw Error("WORKTREE_RESOURCE_JOURNAL_SOURCE_CHANGED")
      return { directory: source.sourceRoot, head: source.baseCommit }
    }
    let target = [...this.pending.values()].find((item) => item.record.id === bound.worktreeId)
    if (!target) {
      const old = this.options.existingWorktrees?.find((item) => item.id === bound.worktreeId)
      if (!old?.resource) throw Error("WORKTREE_RESOURCE_JOURNAL_TARGET_MISSING")
      target = await this.namedResource(
        old.resource.id,
        old.resource.sourceIdentity,
        old.resource.workspaceRef
      )
    }
    if (
      !target ||
      target.record.resource?.ownerToken !== bound.ownerToken ||
      target.record.resource.generation !== bound.generation ||
      target.record.resource.state === "unknown"
    )
      throw Error("WORKTREE_RESOURCE_JOURNAL_TARGET_CHANGED")
    if (target.record.status === "merged") return this.mergedEvidence(target.record, visited)
    if (target.record.status === "discarded")
      throw Error("WORKTREE_RESOURCE_JOURNAL_TARGET_DISCARDED")
    const actual = await diffWorkflowWorktree({
      workspacePath: this.recordWorkspace(target.record),
      record: target.record,
      appDataRoot: this.options.appDataRoot
    })
    if (
      actual.record.dirty ||
      actual.record.headCommit !== target.record.headCommit ||
      !actual.record.headCommit
    )
      throw Error("WORKTREE_RESOURCE_JOURNAL_TARGET_CHANGED")
    return { directory: target.record.directory, head: actual.record.headCommit }
  }

  async validateResourceJournalCheckpoint(
    handle: string,
    checkpoint: WorkflowResourceJournalCheckpoint
  ): Promise<void> {
    const owned = this.byResourceHandle(handle),
      resource = owned.record.resource!
    if (
      resource.state === "unknown" ||
      handle !== checkpoint.handle ||
      resource.generation !== checkpoint.generation ||
      resource.id !== checkpoint.resourceId ||
      resource.sourceIdentity !== checkpoint.sourceIdentity ||
      !/^[a-f0-9]{40,64}$/i.test(checkpoint.headCommit)
    )
      throw Error("WORKTREE_RESOURCE_JOURNAL_UNCONFIRMED")
    owned.busy = true
    try {
      let directory: string, head: string
      if (owned.record.status === "merged") {
        const evidence = await this.mergedEvidence(owned.record)
        directory = evidence.directory
        head = evidence.head
        await assertWorkflowWorktreeDeliverableDescendsFromBase(
          directory,
          owned.record.headCommit!,
          head,
          getWorkflowWorktreeTimeoutMs(),
          this.options.signal
        )
      } else {
        if (owned.record.status === "discarded") throw Error("WORKTREE_RESOURCE_JOURNAL_DISCARDED")
        const actual = await diffWorkflowWorktree({
          workspacePath: this.recordWorkspace(owned.record),
          record: owned.record,
          appDataRoot: this.options.appDataRoot
        })
        if (
          actual.record.dirty ||
          !actual.record.headCommit ||
          actual.record.headCommit !== owned.record.headCommit ||
          JSON.stringify(actual.record.resource) !== JSON.stringify(resource)
        )
          throw Error("WORKTREE_RESOURCE_JOURNAL_CHANGED")
        directory = owned.info.directory
        head = actual.record.headCommit
      }
      await assertWorkflowWorktreeDeliverableDescendsFromBase(
        directory,
        checkpoint.headCommit,
        head,
        getWorkflowWorktreeTimeoutMs(),
        this.options.signal
      )
      this.assertResourceCurrent()
    } finally {
      owned.busy = false
    }
  }

  /** Original merged receipt admits only verification against its declared source.
   * This never rotates a handle or returns the resource to a writable agent lease.
   */
  async useVerificationResource<T>(
    handle: string,
    expectedCommit: string,
    assertOwner: () => void,
    work: (scope: {
      boundary: import("./types").WorkflowWorktreeIsolationBoundary
      verification: WorkflowVerificationResource
      assertCurrent(): void
      verifyCurrent(): Promise<void>
    }) => Promise<T>
  ): Promise<T> {
    assertOwner()
    const owned = this.byResourceHandle(handle), record = owned.record, resource = record.resource!
    if (!/^[a-f0-9]{40,64}$/.test(expectedCommit) || record.status !== "merged" ||
        resource.state !== "sealed" || record.integrationTarget ||
        !resource.sealedCommit || resource.sealedCommit !== record.headCommit || !record.integrationParent ||
        record.integrationCommit !== expectedCommit || resource.parentIdentity !== this.options.parentIdentity ||
        record.runId !== this.options.runId || record.threadId !== (this.options.threadId ?? this.options.runId))
      throw Error("WORKTREE_VERIFICATION_NOT_PROMOTED")
    const workspace = this.recordWorkspace(record)
    if (!this.options.integrate) throw Error("WORKTREE_RESOURCE_INTEGRATION_UNAVAILABLE")
    owned.busy = true
    let active = true
    const assertCurrent = () => {
      assertOwner()
      this.assertResourceCurrent()
      if (!active || owned.record !== record || !owned.busy ||
          this.recordWorkspace(record) !== workspace) throw Error("WORKTREE_VERIFICATION_SCOPE_CHANGED")
    }
    const verifyCurrent = async () => {
      assertCurrent()
      await verifyWorkflowPromotedSource(workspace, record, expectedCommit, this.options.signal)
      assertCurrent()
    }
    try {
      return await this.options.integrate(record.sourceRoot, async () => {
        assertCurrent()
        const boundary = await verifyWorkflowPromotedSource(workspace, record, expectedCommit, this.options.signal)
        assertCurrent()
        const result = await work({ boundary, assertCurrent, verifyCurrent,
          verification: { handle, expectedCommit, resourceId: resource.id,
            generation: resource.generation, workspaceRef: resource.workspaceRef ?? null } })
        await verifyCurrent()
        return result
      })
    } finally {
      active = false
      owned.busy = false
    }
  }

  async useResource<T>(
    handle: string,
    work: (info: WorkflowWorktreeInfo) => Promise<T>,
    budgetId?: string
  ): Promise<T> {
    const owned = this.byResourceHandle(handle)
    if (owned.record.resource!.state !== "leased" || owned.record.status !== "running")
      throw Error("WORKTREE_RESOURCE_NOT_WRITABLE")
    owned.busy = true
    try {
      await resolveWorkflowWorktreeIsolationBoundary(owned.info, this.options.appDataRoot)
      this.assertResourceCurrent()
      const budgets = owned.record.resource!.budgets ?? []
      if (!validWorkflowDeadlines(budgets)) throw Error("WORKTREE_DEADLINE_FACTS_INVALID")
      const budget = budgets.find(item => item.budgetId === budgetId)
      if ((budgetId && !budget) || (!budgetId && budgets.some(item => item.status !== "succeeded")))
        throw Error("WORKTREE_DEADLINE_BINDING_REQUIRED")
      const identity = JSON.stringify([owned.record.runId, owned.record.resource!.ownerToken,
        owned.record.resource!.generation, owned.record.resource!.sourceIdentity, budgetId])
      const read = () => {
        const currentIdentity = JSON.stringify([owned.record.runId, owned.record.resource!.ownerToken,
          owned.record.resource!.generation, owned.record.resource!.sourceIdentity, budgetId])
        if (currentIdentity !== identity) throw Error("WORKTREE_DEADLINE_OWNER_CHANGED")
        const current = owned.record.resource!.budgets?.find(item => item.budgetId === budgetId)
        if (!current) throw Error("WORKTREE_DEADLINE_UNKNOWN")
        if (current.generation !== owned.record.resource!.generation) throw Error("WORKTREE_DEADLINE_GENERATION_CHANGED")
        return current
      }
      const result = budget ? await withWorkflowResourceDeadline({ identity, read,
        assertCurrent: () => { this.assertResourceCurrent(); this.recordWorkspace(owned.record) },
        save: async value => {
          read()
          owned.record = await this.transition(owned.record, owned.record.status, {
            resource: { ...owned.record.resource!, budgets: owned.record.resource!.budgets!
              .map(item => item.budgetId === budgetId ? value : item) }
          }, () => { this.assertResourceCurrent(); read() })
          this.options.onRecordChange?.(owned.record)
        }
      }, () => work(owned.info)) : await work(owned.info)
      this.assertResourceCurrent()
      const state = await inspectWorkflowWorktree(owned.info.directory, owned.info.baseCommit)
      this.assertResourceCurrent()
      if (!state.headCommit) throw Error("WORKTREE_RESOURCE_RESULT_UNCONFIRMED")
      owned.record = await this.transition(owned.record, "running", {
        headCommit: state.headCommit,
        dirty: state.dirty
      })
      this.options.onRecordChange?.(owned.record)
      return result
    } catch (error) {
      owned.record = await this.transition(owned.record, "recoverable", {
        resource: { ...owned.record.resource!, state: "unknown" },
        error: "resource action failed or was cancelled; verify before reuse"
      })
      this.options.onRecordChange?.(owned.record)
      throw error
    } finally {
      owned.busy = false
    }
  }

  /** Merge train uses the original Git transaction and both original lease records. */
  private mergeTargetReceipt(owned: OwnedWorktree, target: OwnedWorktree) {
    return {
      handle: target.record.resource!.ownerToken,
      resourceId: target.record.resource!.id,
      runId: target.record.runId,
      generation: target.record.resource!.generation,
      // This is the result of THIS merge, not the target's later mutable tip.
      headCommit: owned.record.integrationCommit!
    }
  }

  async mergeResourceInto(
    handle: string,
    targetHandle: string,
    expectedCommit: string,
    expectedTargetCommit: string,
    reconcile = false
  ) {
    const owned = this.byResourceHandle(handle),
      target = this.byResourceHandle(targetHandle)
    if (
      owned === target ||
      owned.record.commonDir !== target.record.commonDir ||
      this.recordWorkspace(owned.record) !== this.recordWorkspace(target.record)
    )
      throw Error("WORKTREE_RESOURCE_TARGET_SCOPE_CHANGED")
    if (owned.record.resource!.budgets?.some(item => item.status !== "succeeded") ||
        target.record.resource!.budgets?.some(item => item.status !== "succeeded"))
      throw Error("WORKTREE_DEADLINE_UNSETTLED")
    const destination = {
      worktreeId: target.record.id,
      ownerToken: targetHandle,
      generation: target.record.resource!.generation,
      directory: target.record.directory,
      branch: target.record.branch
    }
    if (
      owned.record.integrationTarget &&
      JSON.stringify(owned.record.integrationTarget) !== JSON.stringify(destination)
    )
      throw Error("WORKTREE_RESOURCE_TARGET_CHANGED")
    if (owned.record.status === "merged") {
      if (!owned.record.integrationTarget || owned.record.headCommit !== expectedCommit)
        throw Error("WORKTREE_RESOURCE_COMMIT_CHANGED")
      if (!owned.record.integrationCommit)
        throw Error("WORKTREE_RESOURCE_TARGET_RESULT_UNCONFIRMED")
      return {
        ...this.resourceView(owned),
        target: this.mergeTargetReceipt(owned, target),
        outcome: "merged"
      }
    }
    const before = owned.record.resource!,
      targetBefore = target.record.resource!
    if (
      reconcile
        ? !owned.record.integrationTarget || before.state !== "unknown"
        : before.state !== "sealed" ||
          before.sealedCommit !== expectedCommit ||
          targetBefore.state !== "leased" ||
          target.record.status !== "running"
    )
      throw Error("WORKTREE_RESOURCE_RECONCILE_REQUIRED")
    if (!this.options.integrate || !this.options.approveMerge)
      throw Error("WORKTREE_RESOURCE_INTEGRATION_UNAVAILABLE")
    owned.busy = target.busy = true
    try {
      const inspect = (record: WorkflowWorktreeRecord) =>
        diffWorkflowWorktree({
          workspacePath: this.recordWorkspace(record),
          record,
          appDataRoot: this.options.appDataRoot
        })
      const [candidate, destinationTree] = await Promise.all([
        inspect(owned.record),
        inspect(target.record)
      ])
      this.assertResourceCurrent()
      owned.record = candidate.record
      target.record = destinationTree.record
      if (
        owned.record.dirty ||
        owned.record.headCommit !== expectedCommit ||
        target.record.headCommit !== expectedTargetCommit ||
        (!reconcile && target.record.dirty)
      )
        throw Error("WORKTREE_RESOURCE_COMMIT_CHANGED")
      if (
        reconcile &&
        expectedTargetCommit === owned.record.integrationParent &&
        !target.record.dirty
      ) {
        // CAS never applied, or the original transaction rolled itself back. This
        // explicitly reconciles absence; it does not execute or approve a retry.
        owned.record = await this.transition(owned.record, "ready", {
          resource: { ...before, state: "sealed" },
          integrationTarget: undefined,
          integrationParent: undefined,
          integrationCommit: undefined,
          error: undefined
        })
        target.record = await this.transition(target.record, "running", {
          resource: { ...targetBefore, state: "leased" },
          error: undefined
        })
        this.options.onRecordChange?.(owned.record)
        this.options.onRecordChange?.(target.record)
        return {
          ...this.resourceView(owned),
          target: this.resourceView(target),
          outcome: "not-applied"
        }
      }
      const plan: WorkflowWorktreeMergePlan = {
        runId: this.options.runId,
        resourceId: before.id,
        generation: before.generation,
        headCommit: expectedCommit,
        baseCommit: owned.record.baseCommit,
        sourceCommit: expectedTargetCommit,
        sourceBranch: target.record.branch,
        sourceRoot: target.record.directory,
        targetResource: {
          id: targetBefore.id,
          generation: targetBefore.generation,
          handle: targetHandle
        }
      }
      const accepted = await new Promise<boolean>((done, failed) => {
        const abort = () =>
          failed(this.options.signal?.reason ?? Error("WORKTREE_RESOURCE_CANCELLED"))
        this.options.signal?.addEventListener("abort", abort, { once: true })
        if (this.options.signal?.aborted) abort()
        Promise.resolve()
          .then(() => {
            this.assertResourceCurrent()
            return this.options.approveMerge!(plan)
          })
          .then(done, failed)
          .finally(() => this.options.signal?.removeEventListener("abort", abort))
      })
      this.assertResourceCurrent()
      if (!accepted)
        return {
          ...this.resourceView(owned),
          target: this.resourceView(target),
          outcome: "rejected"
        }
      const [after, afterTarget] = await Promise.all([
        inspect(owned.record),
        inspect(target.record)
      ])
      this.assertResourceCurrent()
      if (
        after.record.headCommit !== expectedCommit ||
        after.record.dirty ||
        afterTarget.record.headCommit !== expectedTargetCommit ||
        (!reconcile && afterTarget.record.dirty) ||
        JSON.stringify(after.record.resource) !== JSON.stringify(before) ||
        JSON.stringify(afterTarget.record.resource) !== JSON.stringify(targetBefore)
      )
        throw Error("WORKTREE_RESOURCE_APPROVAL_CHANGED")
      owned.record = await this.transition(after.record, after.record.status, {
        resource: { ...before, state: "unknown" },
        integrationTarget: destination,
        ...(reconcile
          ? {}
          : { integrationParent: expectedTargetCommit, integrationCommit: undefined })
      })
      target.record = await this.transition(afterTarget.record, afterTarget.record.status, {
        resource: { ...targetBefore, state: "unknown" }
      })
      this.options.onRecordChange?.(owned.record)
      this.options.onRecordChange?.(target.record)
      const result = await this.options.integrate(target.record.sourceRoot, () =>
        mergeWorkflowWorktree({
          workspacePath: this.recordWorkspace(owned.record),
          record: owned.record,
          targetRecord: target.record,
          appDataRoot: this.options.appDataRoot,
          signal: this.options.signal,
          expectedHeadCommit: expectedCommit,
          ...(reconcile ? { reconcileOnly: true } : { expectedSourceCommit: expectedTargetCommit })
        })
      )
      owned.record = result.record
      target.record = (await inspect(target.record)).record
      this.assertResourceCurrent()
      owned.record = await this.transition(owned.record, owned.record.status, {
        resource: { ...before, state: "sealed" },
        integrationCommit: owned.record.integrationCommit ?? target.record.headCommit
      })
      this.options.onRecordChange?.(owned.record)
      this.options.onRecordChange?.(target.record)
      return {
        ...this.resourceView(owned),
        target: this.mergeTargetReceipt(owned, target),
        outcome: "merged"
      }
    } finally {
      owned.busy = target.busy = false
    }
  }

  async resourceCommand(
    handle: string,
    op: "seal" | "reconcile" | "merge" | "discard",
    expectedCommit: string
  ) {
    const owned = this.byResourceHandle(handle)
    if ((op === "seal" || op === "merge") &&
        owned.record.resource!.budgets?.some(item => item.status !== "succeeded"))
      throw Error("WORKTREE_DEADLINE_UNSETTLED")
    owned.busy = true
    try {
      if (owned.record.integrationTarget && owned.record.status !== "merged")
        throw Error("WORKTREE_RESOURCE_TARGET_RECONCILE_REQUIRED")
      if (!/^[a-f0-9]{40,64}$/i.test(expectedCommit))
        throw Error("WORKTREE_RESOURCE_COMMIT_INVALID")
      const before = owned.record.resource!
      if (owned.record.status === "merged" || owned.record.status === "discarded") {
        if (owned.record.headCommit !== expectedCommit)
          throw Error("WORKTREE_RESOURCE_COMMIT_CHANGED")
        return this.resourceView(owned)
      }
      if (op !== "reconcile" && before.state === "unknown")
        throw Error("WORKTREE_RESOURCE_RECONCILE_REQUIRED")
      if (op === "reconcile" && before.state !== "unknown")
        throw Error("WORKTREE_RESOURCE_RECONCILE_NOT_REQUIRED")
      if (op === "reconcile" && owned.record.status === "integrating") {
        owned.record = await recoverInterruptedWorkflowWorktree({
          record: owned.record,
          appDataRoot: this.options.appDataRoot,
          error: "explicit resource reconciliation"
        })
        this.options.onRecordChange?.(owned.record)
        if (owned.record.status === "merged") return this.resourceView(owned)
      }
      const inspected = await diffWorkflowWorktree({
        workspacePath: this.recordWorkspace(owned.record),
        record: owned.record,
        appDataRoot: this.options.appDataRoot
      })
      this.assertResourceCurrent()
      owned.record = inspected.record
      if (owned.record.dirty || owned.record.headCommit !== expectedCommit)
        throw Error("WORKTREE_RESOURCE_COMMIT_CHANGED")
      if (op === "seal" || op === "reconcile") {
        if (op === "seal") {
          if (expectedCommit === owned.info.baseCommit)
            throw Error("WORKTREE_RESOURCE_NO_DELIVERABLE")
          await assertWorkflowWorktreeDeliverableDescendsFromBase(
            owned.info.directory,
            owned.info.baseCommit,
            expectedCommit,
            getWorkflowWorktreeTimeoutMs(),
            this.options.signal
          )
          await assertWorkflowWorktreeDeliverablePathsInScope(
            owned.info.directory,
            owned.info.baseCommit,
            expectedCommit,
            owned.info.sourceRelativePath,
            getWorkflowWorktreeTimeoutMs(),
            this.options.signal
          )
        }
        this.assertResourceCurrent()
        owned.record = await this.transition(owned.record, op === "seal" ? "ready" : "running", {
          resource: {
            ...before,
            state: op === "seal" ? "sealed" : "leased",
            ...(op === "seal"
              ? { sealedCommit: expectedCommit }
              : {
                  ownerToken: randomUUID(),
                  generation: before.generation + 1,
                  sealedCommit: undefined
                })
          },
          error: undefined
        })
      } else {
        let approvedSourceCommit: string | undefined
        if (op === "merge" && (before.state !== "sealed" || before.sealedCommit !== expectedCommit))
          throw Error("WORKTREE_RESOURCE_NOT_SEALED")
        if (op === "merge" && !this.options.integrate)
          throw Error("WORKTREE_RESOURCE_INTEGRATION_UNAVAILABLE")
        if (op === "merge") {
          if (!this.options.approveMerge) throw Error("WORKTREE_RESOURCE_APPROVAL_UNAVAILABLE")
          const source = await prepareWorkflowWorktreeSource(
            this.recordWorkspace(owned.record),
            this.options.signal
          )
          this.assertResourceCurrent()
          const plan = {
            runId: this.options.runId,
            resourceId: before.id,
            generation: before.generation,
            headCommit: expectedCommit,
            baseCommit: owned.record.baseCommit,
            sourceCommit: source.baseCommit,
            sourceBranch: source.sourceBranch,
            sourceRoot: source.sourceRoot
          }
          const accepted = await new Promise<boolean>((done, failed) => {
            const abort = () =>
              failed(this.options.signal?.reason ?? Error("WORKTREE_RESOURCE_CANCELLED"))
            this.options.signal?.addEventListener("abort", abort, { once: true })
            if (this.options.signal?.aborted) abort()
            Promise.resolve()
              .then(() => {
                this.assertResourceCurrent()
                return this.options.approveMerge!(plan)
              })
              .then(done, failed)
              .finally(() => this.options.signal?.removeEventListener("abort", abort))
          })
          this.assertResourceCurrent()
          if (!accepted) return { ...this.resourceView(owned), outcome: "rejected" }
          const after = await prepareWorkflowWorktreeSource(
            this.recordWorkspace(owned.record),
            this.options.signal
          )
          const tree = await diffWorkflowWorktree({
            workspacePath: this.recordWorkspace(owned.record),
            record: owned.record,
            appDataRoot: this.options.appDataRoot
          })
          this.assertResourceCurrent()
          if (
            JSON.stringify(after) !== JSON.stringify(source) ||
            tree.record.dirty ||
            tree.record.headCommit !== expectedCommit ||
            JSON.stringify(tree.record.resource) !== JSON.stringify(before)
          )
            throw Error("WORKTREE_RESOURCE_APPROVAL_CHANGED")
          approvedSourceCommit = source.baseCommit
        }
        owned.record = await this.transition(owned.record, owned.record.status, {
          resource: { ...before, state: "unknown" }
        })
        this.options.onRecordChange?.(owned.record)
        const input = {
          workspacePath: this.recordWorkspace(owned.record),
          record: owned.record,
          appDataRoot: this.options.appDataRoot,
          signal: this.options.signal,
          expectedHeadCommit: expectedCommit,
          expectedSourceCommit: approvedSourceCommit
        }
        const result =
          op === "merge"
            ? await this.options.integrate!(owned.record.sourceRoot, () =>
                mergeWorkflowWorktree(input)
              )
            : await discardWorkflowWorktree(input)
        owned.record = result.record
        this.assertResourceCurrent()
        owned.record = await this.transition(owned.record, owned.record.status, {
          resource: { ...before, state: "sealed" }
        })
      }
      this.options.onRecordChange?.(owned.record)
      return this.resourceView(owned)
    } finally {
      owned.busy = false
    }
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
          if (owned.record.resource?.state === "sealed") return
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
      ...(owned.record.resource
        ? { resource: { ...owned.record.resource, state: "unknown" as const } }
        : {}),
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
    patch: Partial<WorkflowWorktreeRecord>,
    assertPublish?: () => void
  ): Promise<WorkflowWorktreeRecord> {
    const next = { ...record, ...patch, status, updatedAt: new Date().toISOString() }
    await persistWorkflowWorktreeRecord(next, this.options.appDataRoot, assertPublish)
    return next
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
