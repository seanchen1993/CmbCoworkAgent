import type {
  BotPeerDispatchAdmission,
  BotPeerAdmissionPlan,
  BotPeerAdmissionFailure
} from "./peer-dispatch-admission"
import type { BotConnector } from "../../shared/bot-api"
import { randomUUID } from "node:crypto"
import {
  BotDomainError,
  type BotMessage,
  type BotRun,
  type BotRunLease,
  type CoworkBot
} from "../../shared/bot-types"
import { BotStore } from "./store"
import type { LocalBotComputerProvider } from "./computer-provider"
import type { NativeDesktopBroker } from "./native-desktop-broker"
import type { BotArtifacts } from "./artifacts"
import type { BotTeachService } from "./teach-service"
import type { BotSecretRequests } from "./secret-requests"
import { BOT_BUILD_ID, type BotIdleRestartResult } from "./host-build"
import { BotClockFence } from "./clock-fence"
import { BotDocumentReader } from "./document-reader"
import type { BotSerializedFailure } from "../../shared/bot-error-diagnostic"
import type {
  BotClearErrorTrays,
  BotDismissErrorTray,
  BotErrorTraySnapshot
} from "../../shared/bot-error-trays"
import { BotErrorTrays, type BotErrorTrayNotice } from "./error-trays"
import { serializeBotFailure } from "./error-diagnostic"
import { getApiErrorInfo } from "../agent/api-errors"
import type { BotOwnedShellMaintenanceReview } from "./owned-shell-maintenance-fence"

export interface BotRuntimeRequest {
  run: BotRun
  bot: CoworkBot
  messages: BotMessage[]
  signal: AbortSignal
  lease: BotRunLease
  store: BotStore
  /** Reject fresh execution after the physical Host lock loses its identity.
   * Effect receipt collection deliberately keeps its ordinary lease checks. */
  assertOwnership?(): void
  /** Emitted only after this executor commits an actual failed child run. */
  onRunFailure?(run: BotRun, failure: BotSerializedFailure): void
  /** Host-validated Git checkout; never supplied by the model or renderer. */
  worktree?: {
    sourceWorkspacePath: string
    boundary: import("../agent/workflow/types").WorkflowWorktreeIsolationBoundary
  }
}
export interface BotRuntimePort {
  readonly functionSessions?: import("./function-sessions").BotFunctionSessions
  pluginPanes?(
    input: unknown,
    store: BotStore
  ): Promise<import("../../shared/bot-plugin-panes").BotPluginPaneView>
  readonly modelChecks?: import("./model-check").BotModelChecks
  /** Compiled by the actual Host's trusted command runner, independent of client OS. */
  readonly commandExecutionAvailable?: boolean
  readonly shellServices?: import("./shell-services").BotShellServices
  readonly worktrees?: import("./worktrees").BotWorktrees
  readonly secretRequests?: BotSecretRequests
  dispatchBlockedReason?(): string | null
  connectors?(): Promise<BotConnector[]>
  skillDependencies?(
    input: import("../../shared/bot-skill-references").BotSkillSelection,
    store: BotStore
  ): Promise<import("../../shared/bot-skill-dependencies").BotSkillDependencyView>
  refreshSkills?(force?: boolean): Promise<void>
  execute(request: BotRuntimeRequest): Promise<string>
}

const HOST_LEASE_MS = 30_000
const HOST_LEASE_RENEWAL_MARGIN_MS = 20_000
export interface BotHostOwnership {
  assertCurrent(): void
  checkCurrent(): Promise<void>
}

interface IdleRestartAttempt {
  revision: number
  running: boolean
  abort: AbortController
  committed: boolean
}

export interface BotIdleRestartScope {
  signal: AbortSignal
  /** Synchronous RPC fence, entered only after all original idle guards pass. */
  begin(): void
  /** Release only this admission after the exact Host attempt can safely resume. */
  restore(): void
  /** The initiating RPC server still owns this provisional admission. */
  assertCurrent(): void
}

/** Begin all local aborts before awaiting listener or transport shutdown. The
 * returned outcomes are collected later, while effect settlement stays alive. */
export function closeBotHostBackgroundActivity(
  host?: BotHost,
  memory?: Pick<import("./memory-synthesis").BotMemorySynthesis, "close">
) {
  // stop commits the durable executor fence synchronously before any other
  // background owner can abort work and attempt to settle the old lease.
  const stopping = host?.stop()
  host?.functionSessions?.close()
  return Promise.allSettled([host?.backups?.close(), memory?.close(), stopping])
}

/** The durable store owns the queue; the Host only supervises currently leased executors. */
export class BotHost {
  nativeComputer?: NativeDesktopBroker
  webhooks?: import("./webhook-server").BotWebhookServer
  backups?: import("./backup-scheduler").BotBackupScheduler
  storage?: import("./storage-monitor").BotStorageMonitor
  readonly id = randomUUID()
  readonly buildId = BOT_BUILD_ID
  private timer?: ReturnType<typeof setInterval>
  private readonly active = new Map<
    string,
    { lease: BotRunLease; abort: AbortController; completion: Promise<void> }
  >()
  private peerAdmission?: BotPeerDispatchAdmission
  private peerAdmissionPending?: {
    abort: AbortController
    completion: Promise<void>
  }
  private readonly peerAdmissionFailures = new Map<string, BotPeerAdmissionFailure>()
  private stopping = false
  private shutdownRevision = 0
  private lastMaintenance = 0
  private readonly clockFence: BotClockFence
  private ownership?: BotHostOwnership
  private ownershipCheck?: Promise<void>
  private ownershipFailure?: BotDomainError
  private ownershipLost?: () => void | Promise<void>
  private lifecycleRevision = 0
  private idleRestartAttempt?: IdleRestartAttempt
  private idleRestartPreflight?: (signal: AbortSignal) => Promise<BotOwnedShellMaintenanceReview>
  private readonly errorTrays: BotErrorTrays
  private maintenanceFailure?: string
  private failureSequence = 0
  lastError: string | null = null

  constructor(
    readonly store: BotStore,
    private readonly runtime?: BotRuntimePort,
    private readonly concurrency = 4,
    readonly computer?: LocalBotComputerProvider,
    readonly files?: BotArtifacts,
    readonly teach?: BotTeachService,
    monotonicClock?: () => number,
    readonly mediaReader = new BotDocumentReader()
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw new Error("Invalid Bot concurrency")
    this.clockFence = new BotClockFence(() => store.now(), monotonicClock)
    this.errorTrays = new BotErrorTrays({ hostId: this.id, dataEpoch: store.dataEpoch() }, () =>
      store.now()
    )
    computer?.bindIdleGuard(() => {
      this.assertOwnership()
      return (
        !this.stopping &&
        this.active.size === 0 &&
        !store.hasUnfinishedWork() &&
        !teach?.repository
          .list()
          .some((session) => ["recording", "paused", "finalizing"].includes(session.phase))
      )
    })
    computer?.bindSupervisionGuard(() => this.assertComputerSupervision())
    store.bindLeaseGuard(this.id, () => {
      // Child executors share this owner. A failed durable shutdown handoff
      // must still revoke their cancellation/settlement authority locally.
      if (this.shutdownRevision > 0)
        throw new BotDomainError("host_stopping", "Bot 后台已停止，任务执行权已失效")
      this.clockFence.assert()
    })
    runtime?.shellServices?.bind(store, this.id)
    if (runtime?.shellServices)
      store.bindServiceActivity(this.id, (runId) => runtime.shellServices!.hasRun(runId))
  }

  getErrorTrays(): BotErrorTraySnapshot {
    this.errorTrays.setDataEpoch(this.store.dataEpoch())
    return this.errorTrays.snapshot()
  }

  dismissErrorTray(input: BotDismissErrorTray): BotErrorTraySnapshot {
    this.getErrorTrays()
    return this.errorTrays.dismiss(input)
  }

  clearErrorTrays(input: BotClearErrorTrays): BotErrorTraySnapshot {
    this.getErrorTrays()
    return this.errorTrays.clear(input)
  }

  /** Trusted producers call after a committed failure, never while projecting
   * cached status. No RPC/tool exposes notification insertion. */
  reportFailure(
    notice: Omit<BotErrorTrayNotice, "detail" | "diagnostic"> & { dataEpoch?: string },
    error: unknown
  ): BotErrorTraySnapshot {
    const snapshot = this.getErrorTrays()
    if (notice.dataEpoch !== undefined && notice.dataEpoch !== snapshot.dataEpoch) return snapshot
    const fields = { ...notice }
    delete fields.dataEpoch
    const failure = serializeBotFailure(error)
    return this.errorTrays.push({
      ...fields,
      detail: failure.message,
      diagnostic: failure.diagnostic ?? { code: failure.code }
    })
  }

  private recordRunFailure(run: BotRun, failure: BotSerializedFailure): void {
    try {
      const info = getApiErrorInfo(failure.diagnostic?.status, failure.code)
      // A nested executor may rethrow the same provider failure to its parent.
      // Its durable call identity denotes that one failure, not two new episodes.
      const episodeId = failure.diagnostic?.callId
        ? `model-failure:${failure.diagnostic.callId}`
        : `run-failure:${run.id}:${run.revision}`
      this.getErrorTrays()
      this.errorTrays.push({
        episodeId,
        source: "run",
        title: info?.label ?? "任务执行失败",
        ...(info?.hint ? { hint: info.hint } : {}),
        detail: failure.message,
        diagnostic: failure.diagnostic ?? { code: failure.code },
        botId: run.botId,
        conversationId: run.conversationId,
        ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
        runId: run.id
      })
    } catch (error) {
      // The failed run and its diagnostic are already committed. Notification
      // I/O/schema failure cannot replace a child's cause or replay its work.
      this.lastError = serializeBotFailure(error).message
    }
  }

  /** Only the lock-owning bootstrap installs a bounded physical reader. */
  bindPeerDispatchAdmission(admission: BotPeerDispatchAdmission): void {
    if (this.peerAdmission) throw new Error("Peer admission is already bound")
    this.peerAdmission = admission
  }

  private hasPeerCapacity(botId: string): boolean {
    if (this.stopping || !this.runtime || this.unavailableReason || this.active.size >= 64)
      return false
    let executing = 0
    for (const id of this.active.keys()) {
      const run = this.store.getRun(id)
      // SQL settlement precedes Promise cleanup. The old executor still owns
      // its final resource cleanup until its active-map completion is released.
      if (run.botId === botId) return false
      if (run.status !== "waiting_input" || this.store.hookNotifications.executing(id)) executing++
    }
    return executing < this.concurrency
  }

  private busyBots(): Set<string> {
    // The original active map also owns cleanup after a durable result commits.
    // Exclude it before the bounded SQL candidate page, not after LIMIT 100.
    return new Set([...this.active.keys()].map((id) => this.store.getRun(id).botId))
  }

  private rememberPeerFailure(plan: BotPeerAdmissionPlan): void {
    // At most one record per existing Bot (the original configured Bot limit), not per
    // queued message. The successful physical proof is never retained.
    this.peerAdmissionFailures.set(plan.botId, {
      runId: plan.runId,
      fingerprint: plan.fingerprint,
      scopeRunIds: plan.scopeRunIds,
      dataEpoch: plan.dataEpoch
    })
  }

  private refreshPeerFailures(): void {
    const epoch = this.store.backupSchedule.epoch()
    for (const [botId, failure] of this.peerAdmissionFailures) {
      if (failure.dataEpoch !== epoch) {
        this.peerAdmissionFailures.delete(botId)
        continue
      }
      try {
        const current = this.store.peerDispatch.admissionPlan(failure.runId)
        if (!current || current.fingerprint !== failure.fingerprint)
          this.peerAdmissionFailures.delete(botId)
      } catch (error) {
        // Invalid evidence for one recipient remains blocked without stopping
        // unrelated Bots or converting a failed physical read into permission.
        this.lastError = serializeBotFailure(error).message
      }
    }
  }

  private beginPeerAdmission(plan: BotPeerAdmissionPlan): void {
    if (this.peerAdmissionPending || !this.peerAdmission || this.stopping) return
    if (plan.scopeRunIds.some((id) => this.active.has(id))) return
    const abort = new AbortController()
    const completion = Promise.resolve()
      .then(async () => {
        if (plan.blocked) {
          this.rememberPeerFailure(plan)
          return
        }
        const permit = await this.peerAdmission!.check(plan, abort.signal)
        abort.signal.throwIfAborted()
        this.assertComputerSupervision()
        if (!this.hasPeerCapacity(plan.botId)) return
        const current = this.store.nextClaim(this.peerAdmissionFailures, this.busyBots())
        if (
          !current ||
          current.id !== plan.runId ||
          this.store.peerDispatch.admissionPlan(current.id)?.fingerprint !== plan.fingerprint
        )
          return
        if (!permit) {
          this.rememberPeerFailure(plan)
          return
        }
        const claim = this.store.claim(
          this.id,
          HOST_LEASE_MS,
          permit,
          this.peerAdmissionFailures,
          this.busyBots()
        )
        if (claim) {
          this.peerAdmissionFailures.delete(plan.botId)
          this.startClaim(claim)
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && !this.stopping) {
          this.rememberPeerFailure(plan)
          this.lastError = serializeBotFailure(error).message
        }
      })
      .finally(() => {
        if (this.peerAdmissionPending?.abort === abort) this.peerAdmissionPending = undefined
        if (!this.stopping) this.tick()
      })
    this.peerAdmissionPending = { abort, completion }
  }

  private startClaim(claim: { run: BotRun; lease: BotRunLease }): void {
    const abort = new AbortController(),
      shutdownRevision = this.shutdownRevision
    const completion = Promise.resolve()
      .then(() => this.execute(claim.run, claim.lease, abort, shutdownRevision))
      .finally(() => {
        this.active.delete(claim.run.id)
        // Cleanup may seal physical evidence after SQL settlement. Retire the
        // negative attempt from this actual completion, without polling files.
        for (const [botId, failure] of this.peerAdmissionFailures)
          if (botId === claim.run.botId || failure.scopeRunIds.includes(claim.run.id))
            this.peerAdmissionFailures.delete(botId)
        if (!this.stopping) this.tick()
      })
    this.active.set(claim.run.id, { lease: claim.lease, abort, completion })
  }

  /** Installed by the lock-owning bootstrap, never by a client or model tool. */
  bindOwnership(owner: BotHostOwnership, lost?: () => void | Promise<void>): void {
    if (this.ownership) throw new Error("Bot Host ownership is already bound")
    owner.assertCurrent()
    this.ownership = owner
    this.ownershipLost = lost
  }

  /** Only the lifetime-lock bootstrap supplies the fixed-root resource reader. */
  bindIdleRestartPreflight(
    inspect: (signal: AbortSignal) => Promise<BotOwnedShellMaintenanceReview>
  ): void {
    if (this.idleRestartPreflight) throw new Error("Idle restart preflight is already bound")
    this.idleRestartPreflight = inspect
  }

  private retireIdleRestart(reason: unknown): void {
    this.lifecycleRevision++
    const attempt = this.idleRestartAttempt
    this.idleRestartAttempt = undefined
    attempt?.abort.abort(reason)
  }

  private loseOwnership(): BotDomainError {
    if (this.ownershipFailure) return this.ownershipFailure
    const error = new BotDomainError(
      "host_ownership_lost",
      "Bot 后台锁已丢失或位置发生变化，已停止执行，请重启后台"
    )
    this.ownershipFailure = error
    this.lastError = error.message
    this.retireIdleRestart(error)
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.peerAdmissionPending?.abort.abort(error)
    this.runtime?.shellServices?.abort(error)
    for (const entry of this.active.values()) entry.abort.abort(error)
    // Cleanup and already-started receipt settlement must remain possible.
    // In particular, do not put this guard into Store.assertLease/finish.
    try {
      void Promise.resolve(this.ownershipLost?.()).catch(() => {})
    } catch {
      /* A failed shutdown never restores the old owner's authority. */
    }
    return error
  }

  assertOwnership(): void {
    if (this.ownershipFailure) throw this.ownershipFailure
    try {
      this.ownership?.assertCurrent()
    } catch {
      throw this.loseOwnership()
    }
  }

  checkOwnership(): Promise<void> {
    if (this.ownershipFailure) return Promise.reject(this.ownershipFailure)
    if (!this.ownership) return Promise.resolve()
    if (this.ownershipCheck) return this.ownershipCheck
    try {
      this.ownershipCheck = this.ownership
        .checkCurrent()
        .catch(() => {
          throw this.loseOwnership()
        })
        .finally(() => {
          this.ownershipCheck = undefined
        })
      return this.ownershipCheck
    } catch {
      return Promise.reject(this.loseOwnership())
    }
  }

  async connectors(): Promise<BotConnector[]> {
    return this.runtime?.connectors?.() ?? []
  }

  async refreshSkills(force = false): Promise<void> {
    // Missing catalog availability is reported separately; private tasks stay usable.
    await this.runtime?.refreshSkills?.(force).catch(() => {})
  }

  async skillDependencies(input: import("../../shared/bot-skill-references").BotSkillSelection) {
    if (!this.runtime?.skillDependencies) return this.store.skillDependencies.view(input)
    return this.runtime.skillDependencies(input, this.store)
  }

  get modelChecks() {
    return this.runtime?.modelChecks
  }
  get secretRequests(): BotSecretRequests | undefined {
    return this.runtime?.secretRequests
  }
  get worktrees() {
    return this.runtime?.worktrees
  }

  get functionSessions() {
    return this.runtime?.functionSessions
  }

  async pluginPanes(input: unknown) {
    if (!this.runtime?.pluginPanes) throw new Error("此后台不支持插件面板，请更新应用")
    return this.runtime.pluginPanes(input, this.store)
  }

  get commandExecutionAvailable(): boolean {
    return this.runtime?.commandExecutionAvailable === true
  }

  get commandServicesAvailable(): boolean {
    return this.commandExecutionAvailable && this.runtime?.shellServices?.available === true
  }

  get ready(): boolean {
    return Boolean(this.runtime) && !this.stopping && !this.unavailableReason
  }

  get unavailableReason(): string | null {
    return this.ownershipFailure?.message ?? this.runtime?.dispatchBlockedReason?.() ?? null
  }

  private idleRestartBlock(expectedHostId: string): BotIdleRestartResult | null {
    this.assertOwnership()
    if (expectedHostId !== this.id) throw new Error("Bot 后台身份已变化")
    if (this.stopping) return { accepted: false, reason: "Bot 后台正在停止" }
    if (this.active.size || this.peerAdmissionPending)
      return {
        accepted: false,
        reason: "仍有任务执行、等待回复或核验，请先完成或停止任务"
      }
    if (this.worktrees?.busy)
      return { accepted: false, reason: "正在检查或合并代码工作区，请稍后重试" }
    if (this.runtime?.shellServices?.busy)
      return { accepted: false, reason: "仍有后台服务运行，请先在后台任务中停止服务" }
    if (
      this.teach?.repository
        .list()
        .some((session) => ["recording", "paused", "finalizing"].includes(session.phase))
    )
      return { accepted: false, reason: "请先保存或结束当前示范" }
    if (this.computer?.restartBlockedReason)
      return { accepted: false, reason: this.computer.restartBlockedReason }
    if (this.nativeComputer?.restartBlockedReason)
      return { accepted: false, reason: this.nativeComputer.restartBlockedReason }
    return null
  }

  private pauseIdleRestart(): void {
    // Synchronous fence: no timer or newly queued request can claim work after acceptance.
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Synchronous admission remains available to controlled embedded Hosts.
   * A physical owner must use the asynchronous held-resource path. */
  prepareIdleRestart(expectedHostId: string): BotIdleRestartResult {
    const blocked = this.idleRestartBlock(expectedHostId)
    if (blocked) return blocked
    if (this.ownership) return { accepted: false, reason: "请通过持锁后台的资源核验请求重启" }
    this.pauseIdleRestart()
    return { accepted: true, reason: null }
  }

  private restoreIdleRestart(attempt: IdleRestartAttempt, scope: BotIdleRestartScope): void {
    if (
      this.idleRestartAttempt !== attempt ||
      attempt.revision !== this.lifecycleRevision ||
      attempt.committed
    )
      return
    this.assertOwnership()
    scope.assertCurrent()
    scope.restore()
    this.idleRestartAttempt = undefined
    this.stopping = false
    // A Host which was not started must not gain a timer or claim queued work.
    // The normal heartbeat retains its clock fencing after a long read.
    if (attempt.running) this.timer = setInterval(() => this.tick(), 1000)
  }

  async prepareOwnedIdleRestart(
    expectedHostId: string,
    scope: BotIdleRestartScope
  ): Promise<BotIdleRestartResult> {
    scope.signal.throwIfAborted()
    scope.assertCurrent()
    const blocked = this.idleRestartBlock(expectedHostId)
    if (blocked) return blocked
    if (this.ownership && !this.idleRestartPreflight)
      throw new BotDomainError("restart_unavailable", "此持锁后台未配置重启资源核验")
    const attempt: IdleRestartAttempt = {
      revision: ++this.lifecycleRevision,
      running: !!this.timer,
      abort: new AbortController(),
      committed: false
    }
    scope.begin()
    this.idleRestartAttempt = attempt
    const cancel = () => attempt.abort.abort(scope.signal.reason)
    scope.signal.addEventListener("abort", cancel, { once: true })
    this.pauseIdleRestart()
    try {
      // No physical owner is an explicit embedded/test configuration. Deployed
      // Hosts bind both ownership and this reader before listening for RPCs.
      const review = await this.idleRestartPreflight?.(attempt.abort.signal)
      attempt.abort.signal.throwIfAborted()
      await this.checkOwnership()
      attempt.abort.signal.throwIfAborted()
      this.assertOwnership()
      scope.assertCurrent()
      if (this.idleRestartAttempt !== attempt || attempt.revision !== this.lifecycleRevision)
        throw new BotDomainError("host_stopping", "Bot 后台正在停止")
      if (review?.state === "requires_review") {
        this.restoreIdleRestart(attempt, scope)
        return { accepted: false, reason: `${review.title}：${review.hint}` }
      }
      attempt.committed = true
      return { accepted: true, reason: null }
    } catch (error) {
      if (this.idleRestartAttempt === attempt && !attempt.committed) {
        // A failed reader may have detected a replaced lock. Promote that loss
        // through Host's irreversible ownership fence before any rollback.
        await this.checkOwnership()
        this.restoreIdleRestart(attempt, scope)
      }
      throw error
    } finally {
      scope.signal.removeEventListener("abort", cancel)
    }
  }

  start(): void {
    if (this.shutdownRevision > 0)
      throw new BotDomainError("host_stopping", "Bot 后台已停止，请重新启动后台")
    this.assertOwnership()
    if (this.idleRestartAttempt)
      throw new BotDomainError("host_restarting", "Bot 后台正在核验或执行重启")
    if (this.timer) return
    this.lifecycleRevision++
    this.stopping = false
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  /** Computer RPCs can arrive before the periodic heartbeat after a lost
   * supervision interval. Revoke old leases/tickets before admitting new IO;
   * tool/viewer traffic deliberately cannot advance the heartbeat baseline. */
  assertComputerSupervision(): void {
    this.assertOwnership()
    if (this.stopping)
      throw new BotDomainError("host_stopping", "Bot 后台正在关闭，不能继续操作电脑")
    try {
      this.clockFence.assert()
    } catch (error) {
      if (!(error instanceof BotDomainError) || error.code !== "clock_changed") throw error
      this.fenceClockChange()
      // A non-finite or otherwise unknown clock is not restored authority.
      this.clockFence.assert()
    }
  }

  private fenceClockChange(): void {
    // Commit revocation before any callback can dispatch with the old authority.
    // Queued work and completed receipts are not rolled back.
    const reason = "系统时间变化或休眠导致执行间隔中断，请核对现场后恢复"
    this.store.fenceOwner(this.id, reason)
    this.computer?.invalidateObservations()
    this.nativeComputer?.invalidateObservations()
    this.runtime?.shellServices?.abort(new Error(reason))
    for (const entry of this.active.values()) entry.abort.abort(new Error(reason))
    this.clockFence.resetAfterFencing()
    this.lastMaintenance = 0
  }

  tick(): void {
    if (this.stopping) return
    try {
      this.assertOwnership()
      if (!this.clockFence.heartbeat()) this.fenceClockChange()
      for (const entry of this.active.values()) {
        try {
          const run = this.store.assertLease(entry.lease, true, true)
          if (run.status === "cancelling") entry.abort.abort(new Error("任务已停止"))
          // Validate authority/cancellation on every heartbeat. A waiting model
          // or human does not need a durable SQLite lease write every second.
          if ((run.leaseUntil ?? 0) - this.store.now() <= HOST_LEASE_RENEWAL_MARGIN_MS)
            this.store.renew(entry.lease, HOST_LEASE_MS)
        } catch (error) {
          entry.abort.abort(error)
        }
      }
      this.store.recoverExpired()
      this.runtime?.shellServices?.tick()
      const now = this.store.now()
      if (now - this.lastMaintenance >= 1000) {
        this.teach?.maintain()
        this.store.advanceGroups()
        this.store.dispatchDueRoutines()
        this.store.taskBrowsers.compactExpired()
        this.store.skillMaintenance.tick()
        this.lastMaintenance = now
      }
      this.lastError = null
      this.maintenanceFailure = undefined
      if (!this.runtime || this.unavailableReason) return
      // Waiting for a person or a peer does not consume a model execution slot.
      const executing = () =>
        [...this.active.keys()].filter(
          (id) =>
            this.store.getRun(id).status !== "waiting_input" ||
            this.store.hookNotifications.executing(id)
        ).length
      while (executing() < this.concurrency && this.active.size < 64) {
        this.assertOwnership()
        // Failure-only state keys suppress repeated private filesystem reads.
        // Successful permits are consumed immediately, never cached.
        this.refreshPeerFailures()
        const next = this.store.nextClaim(this.peerAdmissionFailures, this.busyBots())
        if (!next || !this.hasPeerCapacity(next.botId)) break
        if (this.store.peerDispatch.requiresAdmission(next.id)) {
          const plan = this.store.peerDispatch.admissionPlan(next.id)
          if (plan) this.beginPeerAdmission(plan)
          break
        }
        const claim = this.store.claim(
          this.id,
          HOST_LEASE_MS,
          undefined,
          this.peerAdmissionFailures,
          this.busyBots()
        )
        if (!claim) break
        this.startClaim(claim)
      }
    } catch (error) {
      // A database/disk failure stops dispatch. It never turns into permission to run unrecorded work.
      const failure = serializeBotFailure(error)
      this.lastError = failure.message
      const identity = JSON.stringify(failure)
      if (this.maintenanceFailure !== identity) {
        this.maintenanceFailure = identity
        this.errorTrays.push({
          episodeId: `host-maintenance:${++this.failureSequence}`,
          groupKey: "maintenance",
          title: "Bot 后台运行异常",
          detail: failure.message,
          diagnostic: failure.diagnostic ?? { code: failure.code },
          source: "host"
        })
      }
      for (const entry of this.active.values()) entry.abort.abort(error)
      this.runtime?.shellServices?.abort(error)
    }
  }

  private async execute(
    run: BotRun,
    lease: BotRunLease,
    abort: AbortController,
    shutdownRevision: number
  ): Promise<void> {
    if (shutdownRevision !== this.shutdownRevision) return
    try {
      this.assertOwnership()
      const result = await this.runtime!.execute({
        run,
        lease,
        store: this.store,
        signal: abort.signal,
        assertOwnership: () => this.assertOwnership(),
        onRunFailure: (settled, failure) => this.recordRunFailure(settled, failure),
        bot: this.store.getBot(run.botId),
        messages: this.store.messagesForRun(run.id)
      })
      if (shutdownRevision !== this.shutdownRevision) return
      this.store.finish(lease, abort.signal.aborted ? "cancelled" : "succeeded", result)
    } catch (error) {
      // Shutdown hands the original run to recovery. Even a failed handoff
      // write must not turn a physical abort into the user's task cancellation.
      if (shutdownRevision !== this.shutdownRevision) return
      try {
        const failure = serializeBotFailure(error)
        const settled = this.store.finish(
          lease,
          abort.signal.aborted ? "cancelled" : "failed",
          failure.message,
          failure.diagnostic
        )
        if (settled.status === "failed") this.recordRunFailure(settled, failure)
      } catch (settlementError) {
        // Lost leases are intentionally unable to overwrite recovery state.
        this.lastError = serializeBotFailure(settlementError).message
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.shutdownRevision++
    const failures: unknown[] = []
    try {
      // Reuse crash recovery before triggering any physical cancellation. The
      // exact run/checkpoint survives; uncertain effects require human review.
      this.store.fenceOwner(this.id, "后台进程正在停止，请核对中断任务后恢复")
    } catch (error) {
      failures.push(error)
    }
    this.retireIdleRestart(new BotDomainError("host_stopping", "Bot 后台正在停止"))
    // Fence native input and stop its physical owner while model cancellation
    // settles existing effects. Shutdown cannot wait on a live GUI command.
    const nativeClose = this.nativeComputer?.close()
    void nativeClose?.catch(() => {})
    this.peerAdmissionFailures.clear()
    this.peerAdmissionPending?.abort.abort(new Error("Bot 后台正在停止"))
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const entry of this.active.values()) {
      entry.abort.abort(new Error("Bot 后台正在停止"))
    }
    await Promise.allSettled([
      this.peerAdmissionPending?.completion,
      ...[...this.active.values()].map((entry) => entry.completion),
      this.runtime?.modelChecks?.close()
    ])
    try {
      const outcomes = await Promise.allSettled([this.runtime?.shellServices?.close(), nativeClose])
      for (const outcome of outcomes)
        if (outcome.status === "rejected") failures.push(outcome.reason)
      if (failures.length) throw new AggregateError(failures, "Bot 后台资源关闭失败")
    } finally {
      this.runtime?.functionSessions?.close()
    }
  }
}
