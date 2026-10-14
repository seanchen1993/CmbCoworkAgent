import { ModFunctionError } from "../../../shared/mods/v2/contracts"

declare const scopeBrand: unique symbol
declare const branchBrand: unique symbol
declare const workBrand: unique symbol
declare const reactionBrand: unique symbol
declare const executionBrand: unique symbol

export interface FunctionUiConstructorScope {
  readonly [scopeBrand]: true
}
export interface FunctionUiConstructorBranch {
  readonly [branchBrand]: true
}
export interface FunctionUiConstructorWork {
  readonly [workBrand]: true
}
export interface FunctionUiConstructorReaction {
  readonly [reactionBrand]: true
}
export interface FunctionUiConstructorExecution {
  readonly [executionBrand]: true
}

/** Only an actual host driver supplies these references; none are public SDK/JSON facts. */
export interface FunctionUiConstructorProof {
  actor: object
  receipt: object
  signal: AbortSignal
  /** Authority/lifecycle only. A synchronous CPU cut must not cancel a held normal-return SDK. */
  assertCurrent(): void
  retain(): () => void
  /** A closed original owner can retire queued reactions, without claiming they drained. */
  quiescent?(): void
}

export interface FunctionUiConstructorLimits {
  roots: number
  branches: number
  reactions: number
}

interface ScopeRecord {
  actor: object
  receipt: object
  assertCurrent(): void
  signal: AbortSignal
  originalSignal: AbortSignal
  controller: AbortController
  detach(): void
  release(): void
  rootOpen: boolean
  closed: boolean
  failedRelease: boolean
  releaseFailure?: unknown
  quiescent?: () => void
  quiescentReported: boolean
  quiescentFailure?: unknown
  failure?: unknown
  branches: Set<BranchRecord>
  drain?: {
    promise: Promise<void>
    resolve(): void
    reject(reason: unknown): void
  }
}

interface BranchRecord {
  scope: ScopeRecord
  open: boolean
  settled: boolean
  kinds: Set<WorkRecord["kind"]>
  work: Set<WorkRecord>
  reactions: Set<ReactionRecord>
}

interface WorkRecord {
  branch: BranchRecord
  kind: "host" | "reply-job"
  active: boolean
  running: boolean
  ran: boolean
}

interface ReactionRecord {
  branch: BranchRecord
  phase: "queued" | "running" | "returned" | "settled"
}

interface ExecutionRecord {
  scope: ScopeRecord
  active: boolean
}

const opaque = <T>(): T => Object.freeze({}) as T
const failure = () => new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE")

/**
 * Host-only foundation. One continuous activity token covers a real synchronous call and all
 * admitted branches through host finally, reply jobs, reactions and adopted Promise settlement.
 * The driver must report actual completion; an RPC result alone is not a completion receipt.
 */
export class FunctionUiConstructorActivity {
  private readonly scopes = new WeakMap<FunctionUiConstructorScope, ScopeRecord>()
  private readonly branches = new WeakMap<FunctionUiConstructorBranch, BranchRecord>()
  private readonly work = new WeakMap<FunctionUiConstructorWork, WorkRecord>()
  private readonly reactions = new WeakMap<FunctionUiConstructorReaction, ReactionRecord>()
  private readonly executions = new WeakMap<FunctionUiConstructorExecution, ExecutionRecord>()
  private readonly occupied = new Set<ScopeRecord>()
  private roots = 0
  private branchCount = 0
  private reactionCount = 0
  private failedReleases = 0
  private closed = false
  private limits: Readonly<FunctionUiConstructorLimits>
  private readonly creditIdentity?: object
  private creditRevision: number

  constructor(
    limits: Partial<FunctionUiConstructorLimits> = {},
    credit?: { identity: object; revision: number }
  ) {
    this.limits = Object.freeze({ roots: 32, branches: 1024, reactions: 1024, ...limits })
    if (
      Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      this.limits.roots > 32 ||
      this.limits.branches > 1024 ||
      this.limits.reactions > 1024 ||
      (credit &&
        (!credit.identity ||
          typeof credit.identity !== "object" ||
          !Number.isSafeInteger(credit.revision) ||
          credit.revision < 0))
    )
      throw new ModFunctionError("MODS_UI_CONSTRUCTOR_LIMIT_INVALID")
    this.creditIdentity = credit?.identity
    this.creditRevision = credit?.revision ?? 0
  }

  /** Main's actual native ACK only; a synchronous constructor never asks main for new credit. */
  increaseCredit(identity: object, revision: number, limits: FunctionUiConstructorLimits): void {
    if (
      !this.creditIdentity ||
      identity !== this.creditIdentity ||
      !Number.isSafeInteger(revision) ||
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      limits.roots > 32 ||
      limits.branches > 1024 ||
      limits.reactions > 1024
    )
      throw new ModFunctionError("MODS_UI_CONSTRUCTOR_CREDIT")
    if (
      revision === this.creditRevision &&
      limits.roots === this.limits.roots &&
      limits.branches === this.limits.branches &&
      limits.reactions === this.limits.reactions
    )
      return
    if (
      revision !== this.creditRevision + 1 ||
      limits.roots < this.limits.roots ||
      limits.branches < this.limits.branches ||
      limits.reactions < this.limits.reactions
    )
      throw new ModFunctionError("MODS_UI_CONSTRUCTOR_CREDIT")
    this.limits = Object.freeze({ ...limits })
    this.creditRevision = revision
  }

  get stats() {
    return Object.freeze({
      scopes: this.occupied.size,
      roots: this.roots,
      branches: this.branchCount,
      reactions: this.reactionCount,
      failedReleases: this.failedReleases
    })
  }

  begin(proof: FunctionUiConstructorProof): FunctionUiConstructorScope {
    if (this.closed) throw failure()
    if (this.roots + this.failedReleases >= this.limits.roots)
      throw new ModFunctionError("MODS_UI_CONSTRUCTOR_LIMIT")
    const actor = proof.actor
    const receipt = proof.receipt
    const sourceSignal = proof.signal
    const assertCurrent = proof.assertCurrent.bind(proof)
    sourceSignal.throwIfAborted()
    assertCurrent()
    this.roots++
    let release: () => void
    try {
      release = proof.retain()
    } catch (error) {
      this.roots--
      throw error
    }
    const controller = new AbortController()
    const record: ScopeRecord = {
      actor,
      receipt,
      assertCurrent,
      controller,
      signal: AbortSignal.any([sourceSignal, controller.signal]),
      originalSignal: sourceSignal,
      release,
      detach: () => sourceSignal.removeEventListener("abort", abort),
      rootOpen: true,
      closed: false,
      failedRelease: false,
      branches: new Set(),
      quiescent: proof.quiescent?.bind(proof),
      quiescentReported: false
    }
    const abort = () => {
      this.seal(record, sourceSignal.reason)
      this.notifyQuiescent(record)
    }
    sourceSignal.addEventListener("abort", abort, { once: true })
    const token = opaque<FunctionUiConstructorScope>()
    this.scopes.set(token, record)
    this.occupied.add(record)
    if (this.closed) this.seal(record, failure())
    try {
      this.check(record)
    } catch (error) {
      this.finishCall(token)
      throw error
    }
    return token
  }

  private scope(token: FunctionUiConstructorScope): ScopeRecord {
    const record = this.scopes.get(token)
    if (!record) throw failure()
    return record
  }

  private branch(token: FunctionUiConstructorBranch): BranchRecord {
    const record = this.branches.get(token)
    if (!record || record.settled) throw failure()
    return record
  }

  private check(record: ScopeRecord): void {
    if (record.closed || record.failedRelease) throw failure()
    if (record.failure !== undefined) throw record.failure
    try {
      record.signal.throwIfAborted()
      record.assertCurrent()
    } catch (error) {
      this.seal(record, error)
      throw error
    }
  }

  assertCurrent(
    scope: FunctionUiConstructorScope,
    expected?: { actor: object; receipt: object }
  ): void {
    const record = this.scope(scope)
    if (expected && (record.actor !== expected.actor || record.receipt !== expected.receipt))
      throw failure()
    this.check(record)
  }

  signal(scope: FunctionUiConstructorScope): AbortSignal {
    return this.scope(scope).signal
  }

  /** Actual completion only: cancellation seals effects but does not settle this receipt. */
  whenDrained(scope: FunctionUiConstructorScope): Promise<void> {
    const record = this.scope(scope)
    if (!record.drain) {
      record.drain = Promise.withResolvers<void>()
      // The original receipt remains rejecting for its consumer; an unused host receipt is quiet.
      void record.drain.promise.catch(() => undefined)
      if (record.failedRelease) record.drain.reject(record.releaseFailure)
      else if (record.closed) record.drain.resolve()
    }
    return record.drain.promise
  }

  private seal(record: ScopeRecord, reason: unknown): void {
    if (record.closed || record.failure !== undefined) return
    record.failure = reason ?? failure()
    record.controller.abort(record.failure)
    // Actual work remains occupied; revocation is not a forged completion receipt.
  }

  revoke(scope: FunctionUiConstructorScope, reason?: unknown): void {
    this.seal(this.scope(scope), reason)
  }

  finishCall(scope: FunctionUiConstructorScope): void {
    const record = this.scope(scope)
    if (!record.rootOpen) return
    record.rootOpen = false
    this.roots--
    this.finishScope(record)
  }

  private admission(record: ScopeRecord, parent?: FunctionUiConstructorExecution): void {
    this.check(record)
    if (parent !== undefined) {
      const execution = this.executions.get(parent)
      if (!execution?.active || execution.scope !== record) throw failure()
    } else if (!record.rootOpen) throw failure()
  }

  admitBranch(
    scope: FunctionUiConstructorScope,
    parent?: FunctionUiConstructorExecution
  ): FunctionUiConstructorBranch {
    const record = this.scope(scope)
    this.admission(record, parent)
    if (this.branchCount >= this.limits.branches)
      throw new ModFunctionError("MODS_UI_CONSTRUCTOR_LIMIT")
    const branch: BranchRecord = {
      scope: record,
      open: true,
      settled: false,
      kinds: new Set(),
      work: new Set(),
      reactions: new Set()
    }
    const token = opaque<FunctionUiConstructorBranch>()
    this.branches.set(token, branch)
    record.branches.add(branch)
    this.branchCount++
    return token
  }

  private hold(
    branchToken: FunctionUiConstructorBranch,
    kind: WorkRecord["kind"]
  ): FunctionUiConstructorWork {
    const branch = this.branch(branchToken)
    this.check(branch.scope)
    if (!branch.open || branch.kinds.has(kind)) throw failure()
    const record: WorkRecord = { branch, kind, active: true, running: false, ran: false }
    const token = opaque<FunctionUiConstructorWork>()
    this.work.set(token, record)
    branch.kinds.add(kind)
    branch.work.add(record)
    return token
  }

  holdHost(branch: FunctionUiConstructorBranch): FunctionUiConstructorWork {
    return this.hold(branch, "host")
  }

  /** Reserve before the host reply can settle, not after an idle-looking RPC ACK. */
  holdReplyJob(branch: FunctionUiConstructorBranch): FunctionUiConstructorWork {
    return this.hold(branch, "reply-job")
  }

  registerReaction(
    branchToken: FunctionUiConstructorBranch,
    parent?: FunctionUiConstructorExecution
  ): FunctionUiConstructorReaction {
    const branch = this.branch(branchToken)
    this.admission(branch.scope, parent)
    if (this.reactionCount >= this.limits.reactions)
      throw new ModFunctionError("MODS_UI_CONSTRUCTOR_LIMIT")
    const record: ReactionRecord = { branch, phase: "queued" }
    const token = opaque<FunctionUiConstructorReaction>()
    this.reactions.set(token, record)
    branch.reactions.add(record)
    this.reactionCount++
    return token
  }

  private execute<T>(
    record: ScopeRecord,
    run: (execution: FunctionUiConstructorExecution) => T
  ): T {
    this.check(record)
    const execution: ExecutionRecord = { scope: record, active: true }
    const token = opaque<FunctionUiConstructorExecution>()
    this.executions.set(token, execution)
    try {
      return run(token)
    } finally {
      execution.active = false
    }
  }

  runReplyJob<T>(
    token: FunctionUiConstructorWork,
    run: (execution: FunctionUiConstructorExecution) => T
  ): T {
    const record = this.work.get(token)
    if (!record?.active || record.kind !== "reply-job" || record.ran) throw failure()
    record.running = true
    record.ran = true
    try {
      return this.execute(record.branch.scope, run)
    } finally {
      record.running = false
    }
  }

  runReaction<T>(
    token: FunctionUiConstructorReaction,
    run: (execution: FunctionUiConstructorExecution) => T
  ): T {
    const record = this.reactions.get(token)
    if (!record || record.phase !== "queued") throw failure()
    record.phase = "running"
    try {
      return this.execute(record.branch.scope, run)
    } finally {
      // A returned thenable retains this reaction until its actual adopted settlement.
      record.phase = "returned"
    }
  }

  finishWork(token: FunctionUiConstructorWork): void {
    const record = this.work.get(token)
    if (!record) throw failure()
    if (!record.active) return
    if (record.running) throw failure()
    record.active = false
    record.branch.work.delete(record)
    this.finishBranch(record.branch)
  }

  settleReaction(token: FunctionUiConstructorReaction): void {
    const record = this.reactions.get(token)
    if (!record) throw failure()
    if (record.phase === "settled") return
    if (record.phase === "running") throw failure()
    record.phase = "settled"
    record.branch.reactions.delete(record)
    this.reactionCount--
    this.finishBranch(record.branch)
  }

  settleBranch(token: FunctionUiConstructorBranch): void {
    const record = this.branches.get(token)
    if (!record) throw failure()
    if (!record.open) return
    record.open = false
    this.finishBranch(record)
  }

  private finishBranch(record: BranchRecord): void {
    if (record.open || record.settled || record.work.size || record.reactions.size) {
      this.notifyQuiescent(record.scope)
      return
    }
    record.settled = true
    record.scope.branches.delete(record)
    this.branchCount--
    this.finishScope(record.scope)
  }

  private finishScope(record: ScopeRecord): void {
    if (record.rootOpen || record.closed || record.failedRelease) return
    if (record.branches.size) {
      this.notifyQuiescent(record)
      return
    }
    record.detach()
    try {
      record.release()
    } catch (error) {
      record.failedRelease = true
      record.releaseFailure = error
      this.failedReleases++
      this.seal(record, error)
      record.drain?.reject(error)
      throw error // An uncertain release is never retried or counted as successful cleanup.
    }
    record.closed = true
    this.occupied.delete(record)
    record.drain?.resolve()
  }

  /** This native receipt never releases work, settles reactions or returns quota. */
  private notifyQuiescent(record: ScopeRecord): void {
    if (
      record.quiescentReported ||
      record.rootOpen ||
      record.closed ||
      record.failedRelease ||
      !record.originalSignal.aborted ||
      !record.branches.size
    )
      return
    for (const branch of record.branches) {
      if (branch.open || branch.settled || branch.work.size || !branch.reactions.size) return
      for (const reaction of branch.reactions) if (reaction.phase !== "queued") return
    }
    record.quiescentReported = true
    try {
      record.quiescent?.()
    } catch (error) {
      // A failed notification stays occupied and is not retried from an abort listener.
      record.quiescentFailure = error
      this.seal(record, error)
    }
  }

  close(reason?: unknown): void {
    if (this.closed) return
    this.closed = true
    for (const record of this.occupied) this.seal(record, reason)
  }
}
