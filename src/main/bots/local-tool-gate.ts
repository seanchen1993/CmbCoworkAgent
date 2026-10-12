import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import type { BotRuntimeRequest } from "./host"
import type { BotSharedWorkspace } from "./shared-workspace"
import { BotDomainError } from "../../shared/bot-types"
import type { BotLocalToolAction } from "../../shared/bot-local-tool-permission"
import { canonicalJson } from "./validation"
import type { BotLocalToolPermit } from "./local-tool-permission"

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

export interface BotLocalReadAdmission {
  /** Check once more at the actual new read boundary, after asynchronous setup. */
  assert(): void
}
export interface BotLocalMutationAdmission {
  /** This handle is scoped to one captured operation; other calls cannot replace it. */
  assert(): void
  bindEffect(approvalId: string): void
}

/** One task-local view of the original project. Derived worktrees carry the same
 * original source evidence; owned-directory exemption is exact, never a prefix. */
export class BotLocalToolGate {
  private readPermit?: BotLocalToolPermit
  private readInvocation = "project-read"
  private reading?: {
    invocation: string
    controller: AbortController
    promise: Promise<BotLocalToolPermit>
    readers: number
    completion: { permit?: BotLocalToolPermit; settled: boolean }
  }
  private constructor(
    private readonly request: BotRuntimeRequest,
    private readonly declared: string,
    private readonly identity: { root: string; dev: string; ino: string }
  ) {}
  static open(
    request: BotRuntimeRequest,
    managed?: BotSharedWorkspace
  ): BotLocalToolGate | undefined {
    const source = request.worktree?.sourceWorkspacePath ?? request.bot.workspacePath
    if (!source) return undefined
    if (managed && source === managed.path) {
      managed.assertCurrent()
      return undefined
    }
    const root = realpathSync(source),
      info = lstatSync(root, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new BotDomainError("local_project_changed", "本机项目目录不可用")
    return new BotLocalToolGate(request, source, {
      root,
      dev: String(info.dev),
      ino: String(info.ino)
    })
  }
  private assertSource(): void {
    this.request.assertOwnership?.()
    const info = lstatSync(this.identity.root, { bigint: true })
    if (
      realpathSync(this.declared) !== this.identity.root ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      String(info.dev) !== this.identity.dev ||
      String(info.ino) !== this.identity.ino
    )
      throw new BotDomainError("local_project_changed", "原本机项目已被替换，旧许可不能沿用")
  }
  private action(
    kind: BotLocalToolAction["kind"],
    target: string,
    description: string,
    value: unknown
  ): BotLocalToolAction {
    this.assertSource()
    return {
      kind,
      workspace: this.identity.root,
      target,
      description,
      fingerprint: digest({
        root: this.identity,
        runId: this.request.run.id,
        fence: this.request.lease.fence,
        value
      })
    }
  }
  private async ask(
    invocation: string,
    action: BotLocalToolAction,
    signal = this.request.signal,
    requested?: (permit: BotLocalToolPermit) => void
  ): Promise<BotLocalToolPermit> {
    const { store, lease } = this.request
    signal.throwIfAborted()
    this.assertSource()
    const call = `${digest(invocation)}:${lease.fence}`
    let permit = store.localTools.request(lease, call, action)
    requested?.(permit)
    while (true) {
      signal.throwIfAborted()
      this.assertSource()
      store.assertLease(lease, true)
      store.steering.interruptIfPending(lease)
      const renewed = store.localTools.renewExpired(lease, permit.id)
      if (renewed) {
        // This creates a fresh card/receipt; it does not extend the old answer.
        // The Store also bounds attempts and preserves every historical card.
        permit = renewed
        requested?.(permit)
      }
      if (permit.decision !== "ask") break
      const item = store.getInteraction(permit.interactionId!)
      if (item.status === "answered") break
      if (item.status !== "pending" || item.expiresAt <= store.now())
        throw new BotDomainError(
          "local_permission_retired",
          "本机许可请求已过期或撤销，此操作尚未执行"
        )
      await delay(250, undefined, { signal })
    }
    store.localTools.assertGranted(lease, permit.id, action)
    return permit
  }
  private async admitReadPermit(signal = this.request.signal): Promise<BotLocalToolPermit> {
    signal.throwIfAborted()
    this.request.signal.throwIfAborted()
    // Concurrent readers share the original permission card, but own their
    // cancellation independently. The last departing reader retires only a
    // still-pending card; an answered permission/receipt is never discarded.
    const invocation = this.readInvocation
    let flight = this.reading?.invocation === invocation ? this.reading : undefined
    if (!flight) {
      const controller = new AbortController()
      const completion: { permit?: BotLocalToolPermit; settled: boolean } = {
        settled: false
      }
      const action = this.action(
        "read-file",
        "本项目的说明、配置和文件（含目录检索）",
        "仅本次任务读取此项目，最长 10 分钟；不允许命令或文件修改",
        { projectRead: true }
      )
      const promise = this.ask(
        invocation,
        action,
        AbortSignal.any([this.request.signal, controller.signal]),
        (permit) => {
          completion.permit = permit
        }
      ).then(
        (permit) => {
          completion.settled = true
          if (this.readInvocation === invocation) this.readPermit = permit
          return permit
        },
        (error: unknown) => {
          completion.settled = true
          throw error
        }
      )
      flight = { invocation, controller, readers: 0, completion, promise }
      this.reading = flight
    }
    const current = flight
    current.readers++
    let rejectAbort: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const abort = () => rejectAbort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      return await Promise.race([current.promise, aborted])
    } finally {
      signal.removeEventListener("abort", abort)
      current.readers--
      if (!current.readers && this.reading === current) {
        this.reading = undefined
        if (!current.completion.settled) {
          current.controller.abort(new Error("读取操作已取消"))
          if (current.completion.permit?.decision === "ask") {
            // Lease cancellation/Store shutdown may already own retirement.
            // Never let an abort listener throw or delete historical records.
            try {
              this.request.store.localTools.retirePending(
                this.request.lease,
                current.completion.permit.id
              )
            } catch {
              // Host cancellation or Store shutdown already owns this lease.
              // Keep its original pending/history record if retirement is unavailable.
            }
          }
        }
      }
    }
  }
  async read(signal = this.request.signal): Promise<BotLocalReadAdmission> {
    const permit = await this.admitReadPermit(signal)
    return Object.freeze({
      assert: () => {
        signal.throwIfAborted()
        this.request.signal.throwIfAborted()
        this.assertSource()
        this.request.store.localTools.assertGranted(this.request.lease, permit.id)
      }
    })
  }
  assert(): void {
    this.assertSource()
    // Collecting an already started operation is not fresh admission. Each new
    // file/command operation owns a strict read/mutation handle separately.
    if (this.readPermit)
      this.request.store.localTools.assertGranted(
        this.request.lease,
        this.readPermit.id,
        undefined,
        true
      )
  }
  /** Receipts are inspected before this caller enters the gate. Always permits
   * only local admission; the original exact action approval still follows. */
  async mutation(id: string, value: unknown): Promise<BotLocalMutationAdmission | undefined> {
    return this.request.store.hookNotifications.withLocalAdmission(
      this.request.lease,
      id,
      value,
      this.identity.root,
      () => this.admitMutation(id, value)
    )
  }
  private async admitMutation(
    id: string,
    value: unknown
  ): Promise<BotLocalMutationAdmission | undefined> {
    let read = await this.admitReadPermit()
    if (!object(value)) return
    let action: BotLocalToolAction | undefined
    const command = [value.shell, value.hook, value.harnessInspect].find(
      (entry) => object(entry) && typeof entry.command === "string"
    )
    if (object(command) && typeof command.command === "string")
      action = this.action(
        "run-command",
        command.command,
        "在本机项目中运行此命令；仍需原动作审批",
        value
      )
    else if (object(value.project) && typeof value.project.path === "string")
      action = this.action(
        "write-file",
        value.project.path,
        "修改此项目文件；最终差异仍需原动作审批",
        value
      )
    else if (object(value.skillImport) && typeof value.skillImport.destination === "string")
      action = this.action(
        "write-file",
        value.skillImport.destination,
        "将此技能模板复制为项目内的新文件；仍需原动作审批",
        value
      )
    if (!action) return
    const originalActionHash = digest(value)
    let permit = await this.ask(id, action)
    // A human may take longer than the earlier read grant to approve a write,
    // or vice versa. Reacquire only naturally expired, unstarted admissions;
    // captured handles and already reserved effects remain strictly fenced.
    while (true) {
      if (this.request.store.localTools.canRenewExpired(this.request.lease, permit.id)) {
        permit = await this.ask(id, action)
        continue
      }
      const upgrade = this.request.store.localTools.readUpgradeInvocation(
        this.request.lease,
        read.id,
        permit.id
      )
      if (upgrade) {
        // Never revive the captured retired handle or rebind an already started
        // effect. Acquire a new same-root admission under this exact user upgrade.
        this.readInvocation = upgrade
        read = await this.admitReadPermit()
        continue
      }

      if (this.request.store.localTools.canRenewExpired(this.request.lease, read.id)) {
        read = await this.admitReadPermit()
        continue
      }
      break
    }
    const exactAction = Object.freeze(action)
    const assert = () => {
      this.request.signal.throwIfAborted()
      this.assertSource()
      this.request.store.localTools.assertGranted(this.request.lease, read.id)
      this.request.store.localTools.assertGranted(this.request.lease, permit.id, exactAction)
    }
    return Object.freeze({
      assert,
      bindEffect: (approvalId: string) => {
        assert()
        this.request.store.localTools.bindEffect(
          this.request.lease,
          approvalId,
          read.id,
          permit.id,
          originalActionHash
        )
      }
    })
  }
}
