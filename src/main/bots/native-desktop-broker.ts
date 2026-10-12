import { createHash, randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { BotDomainError } from "../../shared/bot-types"
import {
  nativeDesktopMessageReviewed,
  type BotNativeDesktopMessageAction,
  type NativeDesktopMessageReviewed,
  nativeDesktopReviewed,
  type NativeDesktopReviewed,
  botNativeDesktopAction,
  botNativeDesktopSemanticAction,
  botNativeDesktopLaunch,
  nativeDesktopPendingLaunch,
  nativeDesktopAdmittedLaunch,
  nativeDesktopImage,
  nativeDesktopObservation,
  nativeDesktopWindows,
  nativeDesktopSensitivity,
  nativeDesktopSecretReviewed,
  type NativeDesktopSecretReviewed,
  type BotNativeDesktopSecretDestination,
  type BotNativeDesktopTarget,
  type BotNativeDesktopFrame,
  type BotNativeDesktopSemanticAction,
  type BotNativeDesktopHumanInput,
  type NativeDesktopWindow,
  type NativeDesktopScope,
  type NativeDesktopCapabilities,
  type NativeDesktopObservation
} from "../../shared/bot-native-desktop"
import { HOST_COMPUTER_CLIENT, type BotComputerClient } from "./computer-client"
import {
  NativeDesktopTransport,
  NativeDesktopNoAllocationError,
  NativeDesktopDispatchError,
  type NativeDesktopProcessLease
} from "./native-desktop-transport"
import * as v from "./validation"
import {
  NativeDesktopMessageReviews,
  nativeDesktopModelFrame,
  nativeDesktopModelMessageAction,
  type NativeDesktopMessageReview,
  type NativeDesktopModelFrame
} from "./native-desktop-message-review"
import type { NativeDesktopTeachView } from "./teach-native-source"

interface Surface {
  target: BotNativeDesktopTarget
  workerScope: NativeDesktopScope
  opening: Promise<NativeDesktopTransport>
  transport?: NativeDesktopTransport
  lease?: NativeDesktopProcessLease
  policy?: { readRoots: string[]; writeRoots: string[] }
  closureConfirmed: boolean
  tail: Promise<unknown>
  queued: number
  closed: boolean
  closing?: Promise<void>
  capabilities?: NativeDesktopCapabilities
  windows: Map<string, { window: NativeDesktopWindow; title: string }>
  selected?: NativeDesktopWindow
  observation?: NativeDesktopObservation
  observationRequired: boolean
  humanClient?: BotComputerClient
  transferring: boolean
  frameSeq: number
  humanFrame?: BotNativeDesktopFrame
  botFrame?: NativeDesktopModelFrame
  ownerSequence: number
  secretEpoch: number
  verifiedMembers: Set<string>
}

/** Persistence is separate from browser URL manifests. Task ownership callbacks
 * delegate to the existing durable run/address authority, not a new task graph. */
export interface NativeDesktopBrokerPorts {
  hostId: string
  dataEpoch(): string
  /** Production fails unavailable until the installation/runtime desktop gate
   * has actual Windows acceptance. A source file or capability bit is not proof. */
  assertOperational(): void
  assertSupervision(): void
  assertOwner(botId: string, taskRunId?: string, mutate?: boolean): void
  assertBotInput?(botId: string): void
  loadHumanHeld(botId: string, taskRunId?: string): boolean
  saveHumanHeld(botId: string, taskRunId: string | undefined, held: boolean): void
  launch(scope: NativeDesktopScope): Promise<NativeDesktopProcessLease>
}

function sameWindow(left: NativeDesktopWindow, right: NativeDesktopWindow): boolean {
  return v.canonicalJson(left) === v.canonicalJson(right)
}

/** Exact owned native window broker. It deliberately exposes only the semantic
 * operations its worker actually supports; no global mouse/keyboard fallback. */
export interface NativeDesktopReview {
  readonly context: {
    backend: "windows-native"
    target: BotNativeDesktopTarget
    action: BotNativeDesktopSemanticAction
    observation: NativeDesktopReviewed
  }
}
interface FrozenReview {
  target: BotNativeDesktopTarget
  action: BotNativeDesktopSemanticAction
  observed: NativeDesktopReviewed
}

interface HumanSecretTicket {
  surface: Surface
  target: BotNativeDesktopTarget
  observation: NativeDesktopObservation
  reviewed: NativeDesktopSecretReviewed
  client: BotComputerClient
  expires: number
  epoch: number
  dispose(): void
}

export class NativeDesktopBroker {
  private readonly secrets = new Map<string, HumanSecretTicket>()
  private readonly messageReviews = new NativeDesktopMessageReviews()
  private readonly reviews = new WeakMap<NativeDesktopReview, FrozenReview>()
  private readonly surfaces = new Map<string, Surface>()
  private readonly viewers = new Map<BotComputerClient, { until: number; dispose(): void }>()
  private closed = false
  private closing?: Promise<void>
  private observationEpoch = 0
  private activityAt = performance.now()
  teachRecordingBot?: string
  beforeHumanTransfer?: (botId: string) => Promise<void>
  humanObserver?: (
    botId: string,
    target: BotNativeDesktopTarget,
    input: BotNativeDesktopHumanInput,
    phase: "before" | "after" | "unconfirmed",
    view: NativeDesktopTeachView
  ) => Promise<void>
  constructor(
    private readonly ports: NativeDesktopBrokerPorts,
    private readonly maxSurfaces = 8
  ) {
    if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1 || maxSurfaces > 16)
      throw new Error("Invalid native desktop surface budget")
  }
  get lastActivityAt(): number {
    return this.activityAt
  }
  get restartBlockedReason(): string | null {
    for (const surface of this.surfaces.values()) {
      if (surface.closed) return "原生电脑关闭尚未确认，请先核对后台资源"
      if (surface.target.control !== "bot") return "请先归还接管的 Bot 电脑"
      if (surface.queued) return "原生电脑操作仍在执行或排队"
    }
    return null
  }
  get idleBlockedReason(): string | null {
    if (this.teachRecordingBot) return "示范仍在使用原生电脑"
    if (this.restartBlockedReason) return this.restartBlockedReason
    const now = performance.now()
    for (const [client, lease] of this.viewers)
      if (client.aborted || lease.until <= now) lease.dispose()
    return this.viewers.size ? "原生电脑正在查看" : null
  }
  private key(botId: string, taskRunId?: string): string {
    v.identifier(botId)
    return taskRunId === undefined ? botId : `task:${botId}:${v.identifier(taskRunId)}`
  }
  private check(surface?: Surface, mutate = false): void {
    if (this.closed || surface?.closed)
      throw new BotDomainError("computer_unavailable", "原生电脑已关闭")
    this.ports.assertOperational()
    this.ports.assertSupervision()
    if (surface) {
      if (
        surface.workerScope.hostId !== this.ports.hostId ||
        surface.workerScope.dataEpoch !== this.ports.dataEpoch()
      )
        throw new BotDomainError("stale_target", "后台数据版本已变化")
      this.ports.assertOwner(surface.target.botId, surface.target.taskRunId, mutate)
    }
  }
  private require(botId: string, taskRunId?: string): Surface {
    const surface = this.surfaces.get(this.key(botId, taskRunId))
    if (!surface) throw new BotDomainError("computer_unavailable", "该 Bot 原生电脑尚未打开")
    this.check(surface)
    return surface
  }
  private assertTarget(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    control?: "human" | "bot"
  ): void {
    this.check(surface, Boolean(control))
    const current = surface.target
    if (control === "bot") this.ports.assertBotInput?.(current.botId)
    if (
      expected.backend !== "windows-native" ||
      expected.botId !== current.botId ||
      expected.taskRunId !== current.taskRunId ||
      expected.generation !== current.generation ||
      expected.controlEpoch !== current.controlEpoch ||
      expected.viewId !== current.viewId ||
      (control && current.control !== control)
    )
      throw new BotDomainError("stale_target", "电脑画面或控制权已变化，请刷新后操作")
  }
  private viewer(client: BotComputerClient): void {
    client.throwIfAborted()
    if (client === HOST_COMPUTER_CLIENT) return
    const now = performance.now()
    for (const [owner, lease] of this.viewers)
      if (owner.aborted || lease.until <= now) lease.dispose()
    const previous = this.viewers.get(client)
    if (previous) {
      previous.until = now + 15_000
      return
    }
    if (this.viewers.size >= 64)
      throw new BotDomainError("computer_viewer_limit", "电脑查看连接过多")
    const dispose = () => {
      this.viewers.delete(client)
      client.removeEventListener("abort", dispose)
    }
    this.viewers.set(client, { until: now + 15_000, dispose })
    client.addEventListener("abort", dispose, { once: true })
  }
  private serialize<T>(surface: Surface, operation: () => Promise<T>): Promise<T> {
    this.check(surface)
    if (surface.queued >= 8)
      return Promise.reject(new BotDomainError("computer_busy", "电脑操作过多，请等待当前操作完成"))
    surface.queued++
    this.activityAt = performance.now()
    const next = surface.tail
      .then(async () => {
        this.check(surface)
        const result = await operation()
        this.check(surface)
        return result
      })
      .finally(() => {
        surface.queued--
        this.activityAt = performance.now()
      })
    surface.tail = next.catch(() => {})
    return next
  }
  target(botId: string, taskRunId?: string): BotNativeDesktopTarget {
    return { ...this.require(botId, taskRunId).target }
  }
  controlHeld(botId: string): boolean {
    const surface = this.surfaces.get(this.key(botId))
    return surface ? surface.target.control !== "bot" : this.ports.loadHumanHeld(botId)
  }
  clientTarget(
    botId: string,
    client: BotComputerClient,
    taskRunId?: string
  ): BotNativeDesktopTarget & {
    controlOwner?: "self" | "other"
    controlOwnerConnected?: boolean
  } {
    this.viewer(client)
    const surface = this.require(botId, taskRunId)
    return {
      ...surface.target,
      ...(surface.target.control === "human"
        ? {
            controlOwner: surface.humanClient === client ? ("self" as const) : ("other" as const),
            controlOwnerConnected: Boolean(surface.humanClient && !surface.humanClient.aborted)
          }
        : {})
    }
  }
  async ensure(botId: string, taskRunId?: string): Promise<BotNativeDesktopTarget> {
    this.check()
    this.ports.assertOwner(botId, taskRunId)
    const key = this.key(botId, taskRunId)
    const current = this.surfaces.get(key)
    if (current) {
      this.check(current)
      await current.opening
      this.check(current)
      return { ...current.target }
    }
    if (this.surfaces.size >= this.maxSurfaces)
      throw new BotDomainError("computer_surface_limit", "原生电脑数量已达上限，请关闭已有电脑")
    const scope: NativeDesktopScope = {
      hostId: this.ports.hostId,
      dataEpoch: this.ports.dataEpoch(),
      botId,
      ...(taskRunId ? { taskRunId } : {}),
      generation: randomUUID(),
      controlEpoch: 0,
      control: this.ports.loadHumanHeld(botId, taskRunId) ? "human" : "bot"
    }
    const surface: Surface = {
      target: { ...scope, backend: "windows-native", viewId: randomUUID() },
      workerScope: scope,
      opening: undefined as unknown as Promise<NativeDesktopTransport>,
      tail: Promise.resolve(),
      queued: 0,
      closed: false,
      closureConfirmed: false,
      windows: new Map(),
      observationRequired: true,
      transferring: false,
      frameSeq: 0,
      ownerSequence: 0,
      secretEpoch: 0,
      verifiedMembers: new Set()
    }
    // Reserve synchronously before any launch await; concurrent opens share the
    // same owned worker and cannot bypass the global bounded surface budget.
    this.surfaces.set(key, surface)
    surface.opening = (async () => {
      let lease: NativeDesktopProcessLease | undefined
      let transport: NativeDesktopTransport | undefined
      try {
        lease = await this.ports.launch(scope)
        surface.lease = lease
        const policy = {
          readRoots: [...lease.policy.readRoots],
          writeRoots: [...lease.policy.writeRoots]
        }
        if (
          [policy.readRoots, policy.writeRoots].some(
            (roots) =>
              roots.length > 64 ||
              roots.some(
                (root) => root.length > 4096 || !/^[A-Za-z]:\\/.test(root) || root.includes("\0")
              )
          )
        )
          throw new Error("Invalid native desktop surface policy roots")
        surface.policy = policy
        transport = new NativeDesktopTransport(lease)
        surface.transport = transport
        this.check(surface)
        await lease.verifyMember(lease.identity.workerPid)
        this.check(surface)
        const ready = await transport.ready
        const identity = lease.identity
        await transport.request({
          scope,
          operation: "open",
          params: {
            jobName: identity.jobName,
            bootId: identity.bootId,
            sessionId: identity.sessionId,
            desktop: identity.desktop,
            ...surface.policy
          },
          authorize: () => this.check(surface, true)
        })
        this.check(surface)
        surface.capabilities = ready.capabilities
        return transport
      } catch (error) {
        surface.closed = true
        if (transport) {
          await transport.close()
          surface.closureConfirmed = true
        } else if (lease) {
          lease.stop()
          await lease.awaitKernelClosure()
          surface.closureConfirmed = true
        }
        // A launcher rejection is not evidence that no Job was allocated. Keep
        // its fenced reservation unless the trusted launch port proves closure.
        if (
          (surface.closureConfirmed ||
            (!lease && error instanceof NativeDesktopNoAllocationError)) &&
          this.surfaces.get(key) === surface
        )
          this.surfaces.delete(key)
        throw error
      }
    })()
    void surface.opening.catch(() => {})
    await surface.opening
    this.check(surface)
    return { ...surface.target }
  }
  async launchApplication(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<unknown> {
    const launch = botNativeDesktopLaunch.parse(submitted)
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "bot")
        authorize()
      }
      check()
      const transport = await surface.opening
      const pending = nativeDesktopPendingLaunch.parse(
        await transport.request({
          scope: surface.workerScope,
          operation: "approved_launch",
          params: { ...launch, ...surface.policy },
          signal,
          authorize: check
        })
      )
      const identity = transport.lease.identity
      try {
        if (
          pending.process.desktop !== identity.desktop ||
          pending.process.sessionId !== identity.sessionId
        )
          throw new Error("Launched process changed its private desktop/session")
        await transport.lease.verifyMember(pending.process.pid)
        check()
        const admitted = nativeDesktopAdmittedLaunch.parse(
          await transport.request({
            scope: surface.workerScope,
            operation: "admit_launch",
            params: {
              launchId: pending.launchId,
              ...pending.process,
              ownerSequence: ++surface.ownerSequence
            },
            signal,
            authorize: check
          })
        )
        if (
          admitted.launchId !== pending.launchId ||
          v.canonicalJson(admitted.process) !== v.canonicalJson(pending.process)
        )
          throw new Error("Native application admission identity changed")
        surface.observationRequired = true
        this.clearSecrets(surface)
        surface.observation = undefined
        surface.humanFrame = undefined
        surface.botFrame = undefined
        return admitted
      } catch (error) {
        // A child exists after launch_pending. Never resume or replay it under
        // a different admission; closing the actual owned Job is the safe fence.
        surface.closed = true
        await transport.close()
        surface.closureConfirmed = true
        throw error
      }
    })
  }
  private async admitWindow(
    surface: Surface,
    window: NativeDesktopWindow,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const transport = await surface.opening
    const identity = transport.lease.identity
    if (window.desktop !== identity.desktop || window.sessionId !== identity.sessionId)
      throw new BotDomainError("wrong_target", "窗口不属于当前 Bot 原生电脑")
    this.check(surface)
    authorize()
    signal?.throwIfAborted()
    const memberKey = `${window.pid}:${window.startTicks}`
    if (!surface.verifiedMembers.has(memberKey)) {
      await transport.lease.verifyMember(window.pid)
      if (surface.verifiedMembers.size >= 512)
        throw new BotDomainError(
          "computer_member_limit",
          "原生电脑应用启动次数较多，请核对应用状态后重启后台"
        )
      surface.verifiedMembers.add(memberKey)
    }
    this.check(surface)
    authorize()
    await transport.request({
      scope: surface.workerScope,
      operation: "admit_window",
      window,
      params: { ownerSequence: ++surface.ownerSequence },
      signal,
      authorize: () => {
        this.check(surface)
        authorize()
      }
    })
  }
  async windows(
    expected: BotNativeDesktopTarget,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<{ viewId: string; title: string; window: NativeDesktopWindow }[]> {
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected)
      const transport = await surface.opening
      const candidates = nativeDesktopWindows.parse(
        await transport.request({
          scope: surface.workerScope,
          operation: "windows",
          signal,
          authorize: () => {
            this.assertTarget(surface, expected)
            authorize()
          }
        })
      )
      const owned = new Map<string, { window: NativeDesktopWindow; title: string }>()
      for (const candidate of candidates.windows) {
        this.assertTarget(surface, expected)
        await this.admitWindow(surface, candidate.window, authorize, signal)
        const old = [...surface.windows].find(([, item]) =>
          sameWindow(item.window, candidate.window)
        )
        owned.set(old?.[0] ?? randomUUID(), candidate)
      }
      surface.windows = owned
      return [...owned].map(([viewId, item]) => ({ viewId, ...item }))
    })
  }
  async selectWindow(
    expected: BotNativeDesktopTarget,
    viewId: string,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<BotNativeDesktopTarget> {
    const surface = this.require(expected.botId, expected.taskRunId)
    v.identifier(viewId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected)
      const window = surface.windows.get(viewId)?.window
      if (!window)
        throw new BotDomainError("wrong_target", "窗口不属于当前 Bot 画面，请重新列出应用")
      await this.admitWindow(surface, window, authorize, signal)
      const transport = await surface.opening
      await transport.request({
        scope: surface.workerScope,
        operation: "select_window",
        window,
        signal,
        authorize: () => {
          this.assertTarget(surface, expected)
          authorize()
        }
      })
      surface.selected = window
      surface.target.viewId = viewId
      this.clearSecrets(surface)
      surface.observation = undefined
      surface.observationRequired = true
      surface.humanFrame = undefined
      surface.botFrame = undefined
      return { ...surface.target }
    })
  }
  private selected(surface: Surface): NativeDesktopWindow {
    if (!surface.selected)
      throw new BotDomainError("native_application_missing", "请先打开并选择 Bot 工作应用")
    return surface.selected
  }
  /** Queue-owned readonly Teach capability; no semantic refs or displayed input tickets change. */
  private teachView(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    client: BotComputerClient
  ): {
    view: NativeDesktopTeachView
    release(): void
  } {
    const window = this.selected(surface)
    let live = true
    const check = () => {
      if (!live) throw new BotDomainError("teach_scope", "示范观察已结束")
      this.assertTarget(surface, expected, "human")
      this.assertHumanClient(expected.botId, client, expected.taskRunId)
      if (!sameWindow(this.selected(surface), window))
        throw new BotDomainError("stale_target", "示范窗口已变化，请重新核对")
    }
    const read = async (operation: "frame" | "has_sensitive_input") => {
      check()
      await this.admitWindow(surface, window, check, client)
      const transport = await surface.opening
      const result = await transport.request({
        scope: surface.workerScope,
        operation,
        window,
        ...(operation === "frame" ? { params: { issueInputTicket: false } } : {}),
        signal: client,
        authorize: check
      })
      check()
      return result
    }
    return {
      release: () => {
        live = false
      },
      view: {
        hasSensitiveInput: async () => {
          const sensitive = nativeDesktopSensitivity.parse(await read("has_sensitive_input"))
          if (!sameWindow(sensitive.window, window))
            throw new Error("Native Teach sensitivity changed window")
          return sensitive.passwordDetected || !sensitive.complete
        },
        capture: async () => {
          const frame = nativeDesktopImage.parse(await read("frame"))
          if (!sameWindow(frame.window, window) || frame.inputTicketIssued !== false)
            throw new Error("Native Teach frame changed identity or issued an input ticket")
          return {
            image: frame.image,
            title: frame.title,
            viewId: expected.viewId
          }
        }
      }
    }
  }
  async teachObserve<T>(
    botId: string,
    client: BotComputerClient,
    observe: (view: NativeDesktopTeachView) => Promise<T>
  ): Promise<T> {
    const surface = this.require(botId)
    return this.serialize(surface, async () => {
      const callback = this.teachView(surface, { ...surface.target }, client)
      try {
        return await observe(callback.view)
      } finally {
        callback.release()
      }
    })
  }
  private async notifyTeach(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    input: BotNativeDesktopHumanInput,
    phase: "before" | "after" | "unconfirmed",
    client: BotComputerClient
  ): Promise<void> {
    const observer = this.humanObserver
    if (!observer || expected.taskRunId) return
    const callback = this.teachView(surface, expected, client)
    try {
      await observer(expected.botId, expected, input, phase, callback.view)
    } finally {
      callback.release()
    }
  }

  private async protectedRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (error) {
      if (
        error instanceof NativeDesktopDispatchError &&
        ["native_sensitive_window", "sensitive_provider_limit", "sensitive_window_limit"].includes(
          error.code
        )
      )
        throw new BotDomainError(
          "native_secret_required",
          "此窗口仍含受保护输入，请接管完成登录后再归还 Bot。"
        )
      throw error
    }
  }
  async observe(
    expected: BotNativeDesktopTarget,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<NativeDesktopObservation> {
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected)
      const window = this.selected(surface)
      await this.admitWindow(surface, window, authorize, signal)
      const transport = await surface.opening
      this.clearSecrets(surface)
      const observed = nativeDesktopObservation.parse(
        await this.protectedRead(() =>
          transport.request({
            scope: surface.workerScope,
            operation: "observe",
            window,
            signal,
            authorize: () => {
              this.assertTarget(surface, expected)
              authorize()
            }
          })
        )
      )
      if (!sameWindow(observed.window, window))
        throw new Error("Native observation changed its exact window")
      this.assertTarget(surface, expected)
      surface.observation = observed
      surface.observationRequired = false
      return observed
    })
  }
  private clearSecrets(surface: Surface): void {
    surface.secretEpoch++
    for (const ticket of this.secrets.values()) if (ticket.surface === surface) ticket.dispose()
  }
  private pruneSecrets(): void {
    const now = performance.now()
    for (const ticket of this.secrets.values())
      if (ticket.client.aborted || ticket.expires <= now) ticket.dispose()
  }
  private async secretReview(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    elementId: string,
    check: () => void,
    client: BotComputerClient
  ): Promise<NativeDesktopSecretReviewed> {
    this.assertTarget(surface, expected, "human")
    check()
    const observed = surface.observation
    const element = observed?.elements.find((item) => item.id === elementId)
    if (
      surface.observationRequired ||
      !observed ||
      !element?.password ||
      !element.enabled ||
      element.offscreen
    )
      throw new BotDomainError("native_secret_unavailable", "请重新观察并选择可用的密码控件")
    const window = this.selected(surface)
    await this.admitWindow(surface, window, check, client)
    const transport = await surface.opening
    const reviewed = nativeDesktopSecretReviewed.parse(
      await transport.request({
        scope: surface.workerScope,
        operation: "secret_review",
        window,
        params: { elementId },
        signal: client,
        authorize: check
      })
    )
    check()
    if (
      !sameWindow(reviewed.window, window) ||
      reviewed.element.id !== elementId ||
      reviewed.title !== observed.title ||
      (reviewed.element.name ?? "") !== element.name ||
      reviewed.element.controlType !== element.controlType
    )
      throw new BotDomainError("native_secret_stale", "密码目标已变化，请重新选择")
    return reviewed
  }
  async prepareHumanSecret(
    expected: BotNativeDesktopTarget,
    elementId: string,
    client: BotComputerClient
  ): Promise<BotNativeDesktopSecretDestination> {
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "human")
        this.assertHumanClient(expected.botId, client, expected.taskRunId)
      }
      const reviewed = await this.secretReview(surface, expected, elementId, check, client)
      this.pruneSecrets()
      this.clearSecrets(surface)
      if (this.secrets.size >= 16)
        throw new BotDomainError("native_secret_busy", "安全输入过多，请关闭其他输入后重试")
      const token = randomUUID()
      const dispose = () => {
        this.secrets.delete(token)
        client.removeEventListener("abort", dispose)
      }
      this.secrets.set(token, {
        surface,
        target: { ...expected },
        observation: surface.observation!,
        reviewed,
        client,
        expires: performance.now() + 60_000,
        epoch: surface.secretEpoch,
        dispose
      })
      client.addEventListener("abort", dispose, { once: true })
      check()
      return {
        token,
        windowTitle: reviewed.title,
        field: reviewed.element.name || reviewed.element.controlType
      }
    })
  }
  async fillHumanSecret(
    expected: BotNativeDesktopTarget,
    token: string,
    value: string,
    client: BotComputerClient
  ): Promise<void> {
    if (typeof value !== "string" || !value.length || value.length > 16000 || value.includes("\0"))
      throw new BotDomainError("native_secret_invalid", "安全输入无效，请重新输入")
    this.pruneSecrets()
    const ticket = this.secrets.get(token)
    // Consume before queuing, including stale and rejected attempts. There is no replay path.
    ticket?.dispose()
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "human")
        this.assertHumanClient(expected.botId, client, expected.taskRunId)
        if (
          !ticket ||
          ticket.surface !== surface ||
          ticket.client !== client ||
          ticket.expires <= performance.now() ||
          ticket.epoch !== surface.secretEpoch ||
          surface.observation !== ticket.observation ||
          v.canonicalJson(ticket.target) !== v.canonicalJson(expected)
        )
          throw new BotDomainError("native_secret_stale", "安全输入已失效，请重新选择密码控件")
      }
      check()
      let mayHaveSubmitted = false
      try {
        const reviewed = await this.secretReview(
          surface,
          expected,
          ticket!.reviewed.element.id,
          check,
          client
        )
        if (v.canonicalJson(reviewed) !== v.canonicalJson(ticket!.reviewed))
          throw new BotDomainError("native_secret_stale", "密码目标已变化，请重新选择")
        const transport = await surface.opening
        mayHaveSubmitted = true
        await transport.request({
          scope: surface.workerScope,
          operation: "set_secret",
          window: reviewed.window,
          params: {
            elementId: reviewed.element.id,
            value,
            expectedElement: reviewed.element,
            expectedWindowTitle: reviewed.title
          },
          signal: client,
          authorize: check
        })
        check()
      } catch (error) {
        // Never forward parser/provider messages, causes or raw worker errors from this lane.
        const unknown =
          error instanceof NativeDesktopDispatchError
            ? error.outcome === "unknown"
            : mayHaveSubmitted
        throw new BotDomainError(
          unknown ? "native_secret_unconfirmed" : "native_secret_failed",
          unknown
            ? "安全输入结果尚未确认，请核对应用；不会自动重试"
            : "安全输入未完成，请重新观察密码控件"
        )
      } finally {
        this.clearSecrets(surface)
        surface.observation = undefined
        surface.observationRequired = true
        surface.humanFrame = undefined
        surface.botFrame = undefined
      }
    })
  }
  async frame(
    botId: string,
    client: BotComputerClient = HOST_COMPUTER_CLIENT,
    taskRunId?: string,
    operationSignal?: AbortSignal
  ): Promise<BotNativeDesktopFrame> {
    const signal = operationSignal ? AbortSignal.any([client, operationSignal]) : client
    signal.throwIfAborted()
    this.viewer(client)
    await this.ensure(botId, taskRunId)
    const surface = this.require(botId, taskRunId)
    return this.serialize(surface, async () => {
      signal.throwIfAborted()
      const target = { ...surface.target }
      const epoch = this.observationEpoch
      const window = this.selected(surface)
      const authorize = () => {
        this.assertTarget(surface, target)
        signal.throwIfAborted()
        if (epoch !== this.observationEpoch)
          throw new BotDomainError("stale_frame", "运行状态已变化，请刷新画面")
      }
      if (target.control === "human" && client === HOST_COMPUTER_CLIENT)
        throw new BotDomainError("native_secret_required", "人工接管期间，应用画面仅供接管人查看")
      if (target.control === "human" && surface.humanClient !== client) {
        const transport = await surface.opening
        await this.admitWindow(surface, window, authorize, signal)
        const sensitivity = nativeDesktopSensitivity.parse(
          await transport.request({
            scope: surface.workerScope,
            operation: "has_sensitive_input",
            window,
            signal,
            authorize
          })
        )
        if (
          !sameWindow(sensitivity.window, window) ||
          sensitivity.passwordDetected ||
          !sensitivity.complete
        )
          throw new BotDomainError("native_secret_required", "此画面包含安全输入，仅接管人可查看")
      }
      // Never forward a holder's cached frame to a second viewer: even after a
      // complete provider-retirement proof it may contain the preceding password UI.
      // The fresh read-only frame below does not replace the holder's input ticket.
      await this.admitWindow(surface, window, authorize, client)
      const transport = await surface.opening
      if (!surface.capabilities?.capture)
        throw new BotDomainError("computer_unavailable", "此电脑不支持原生窗口画面")
      const image = nativeDesktopImage.parse(
        await this.protectedRead(() =>
          transport.request({
            scope: surface.workerScope,
            operation: "frame",
            window,
            params: {
              issueInputTicket: surface.humanClient === client || client === HOST_COMPUTER_CLIENT
            },
            signal,
            authorize
          })
        )
      )
      if (!sameWindow(image.window, window))
        throw new Error("Native capture changed its exact window")
      authorize()
      const frame: BotNativeDesktopFrame = {
        ...this.clientTarget(botId, client, taskRunId),
        ...image,
        frameSeq: ++surface.frameSeq,
        capabilities: surface.capabilities
      }
      if (surface.humanClient === client) surface.humanFrame = frame
      if (client === HOST_COMPUTER_CLIENT && target.control === "bot" && image.inputTicketIssued)
        surface.botFrame = nativeDesktopModelFrame(frame)
      return frame
    })
  }
  private async messageReview(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    action: BotNativeDesktopMessageAction,
    frame: NativeDesktopModelFrame,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<NativeDesktopMessageReviewed> {
    const window = this.selected(surface)
    const check = () => {
      this.assertTarget(surface, expected, "bot")
      if (
        !surface.botFrame ||
        v.canonicalJson(surface.botFrame) !== v.canonicalJson(frame) ||
        !sameWindow(window, this.selected(surface))
      )
        throw new BotDomainError("native_review_changed", "批准的窗口画面已变化，请重新截图")
      authorize()
    }
    check()
    await this.admitWindow(surface, window, check, signal)
    const transport = await surface.opening
    let observed: NativeDesktopMessageReviewed
    try {
      observed = nativeDesktopMessageReviewed.parse(
        await transport.request({
          scope: surface.workerScope,
          operation: "review_message",
          window,
          params: {
            captureId: frame.captureId,
            frameVersion: frame.frameVersion,
            expectedWindowTitle: frame.title,
            actionKind: action.op,
            ...(action.op === "message_pointer"
              ? {
                  x: action.x,
                  y: action.y,
                  ...(action.kind === "drag" ? { kind: action.kind, path: action.path } : {})
                }
              : {})
          },
          signal,
          authorize: check
        })
      )
    } catch (error) {
      if (error instanceof NativeDesktopDispatchError && error.outcome === "not-dispatched") {
        if (error.code === "window_message_sensitive_input")
          throw new BotDomainError(
            "native_secret_required",
            "此画面含敏感输入或无法完整核对，请使用专用授权通道"
          )
        if (
          [
            "published_frame_ticket_stale",
            "window_review_changed",
            "window_message_geometry_changed",
            "window_message_review_changed",
            "window_message_focus_changed",
            "window_message_focus_unavailable",
            "input_child_owner_changed",
            "input_child_unavailable"
          ].includes(error.code)
        )
          throw new BotDomainError("native_review_changed", "窗口画面或输入目标已变化，请重新截图")
      }
      throw error
    }
    check()
    if (
      !sameWindow(observed.window, window) ||
      observed.title !== frame.title ||
      observed.target.geometry.width !== frame.sourceWidth ||
      observed.target.geometry.height !== frame.sourceHeight
    )
      throw new BotDomainError("native_review_changed", "窗口标题或画面尺寸已变化，请重新截图")
    return observed
  }
  prepareMessageReview(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<NativeDesktopMessageReview> {
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      const { input, action } = nativeDesktopModelMessageAction(
        expected,
        submitted,
        surface.botFrame
      )
      const frame = surface.botFrame!
      const observed = await this.messageReview(surface, expected, action, frame, authorize, signal)
      this.assertTarget(surface, expected, "bot")
      return this.messageReviews.freeze({
        target: { ...expected },
        input,
        action,
        frame,
        observed
      })
    })
  }
  assertMessageReview(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    capability: NativeDesktopMessageReview,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      const frozen = this.messageReviews.require(expected, submitted, surface.botFrame, capability)
      const observed = await this.messageReview(
        surface,
        expected,
        frozen.action,
        frozen.frame,
        authorize,
        signal
      )
      if (v.canonicalJson(observed) !== v.canonicalJson(frozen.observed))
        throw new BotDomainError(
          "native_review_changed",
          "审批期间输入目标或窗口位置已变化，请重新截图"
        )
      this.messageReviews.require(expected, submitted, surface.botFrame, capability)
      authorize()
    })
  }
  discardMessageReview(capability: NativeDesktopMessageReview): void {
    this.messageReviews.discard(capability)
  }
  async actMessage(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    authorize: () => void,
    signal: AbortSignal | undefined,
    capability: NativeDesktopMessageReview
  ): Promise<unknown> {
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      const frozen = this.messageReviews.require(expected, submitted, surface.botFrame, capability)
      const check = () => {
        this.assertTarget(surface, expected, "bot")
        this.messageReviews.require(expected, submitted, surface.botFrame, capability)
        authorize()
      }
      try {
        // The graph already rechecked before binding this durable effect. Verify
        // Job membership again here; worker checks the frozen child/focus/geometry
        // and sensitivity inside submission itself, without an extra UIA tree walk.
        await this.admitWindow(surface, frozen.observed.window, check, signal)
        const transport = await surface.opening
        const { op, ...params } = frozen.action
        const delivered = await transport.request({
          scope: surface.workerScope,
          operation: op,
          window: frozen.observed.window,
          params: {
            ...params,
            captureId: frozen.frame.captureId,
            frameVersion: frozen.frame.frameVersion,
            expectedWindowTitle: frozen.observed.title,
            expectedMessageTarget: frozen.observed.target
          },
          signal,
          authorize: check
        })
        // Accepted window messages do not prove a business/UI effect. Reobserve
        // the delivered screenshot before choosing the next operation.
        return { delivery: delivered, nextObservation: "screenshot_required" }
      } finally {
        this.messageReviews.discard(capability)
        surface.botFrame = undefined
        this.clearSecrets(surface)
        surface.observation = undefined
        surface.observationRequired = true
      }
    })
  }
  requiresObservation(botId: string, taskRunId?: string): boolean {
    return this.require(botId, taskRunId).observationRequired
  }
  private actionTarget(surface: Surface, action: BotNativeDesktopSemanticAction): void {
    if (surface.observationRequired || !surface.observation)
      throw new BotDomainError("computer_reobserve", "请先重新查看原生应用元素")
    const element = surface.observation.elements.find(
      (candidate) => candidate.id === action.elementId
    )
    const operation = action.op === "invoke" ? action.action : action.op
    if (!element || !element.supportedActions.includes(operation))
      throw new BotDomainError("native_element_stale", "应用元素已失效或不支持此操作，请重新观察")
    if (element.password)
      throw new BotDomainError("native_secret_required", "密码仅可由接管人通过安全输入填入")
  }
  private async review(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    action: BotNativeDesktopSemanticAction,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<NativeDesktopReviewed> {
    this.actionTarget(surface, action)
    const window = this.selected(surface)
    await this.admitWindow(surface, window, authorize, signal)
    const transport = await surface.opening
    let observed: NativeDesktopReviewed
    try {
      observed = nativeDesktopReviewed.parse(
        await transport.request({
          scope: surface.workerScope,
          operation: "review",
          window,
          params: {
            elementId: action.elementId,
            ...(action.op === "invoke" && action.action === "select_all_text"
              ? { action: action.action }
              : {})
          },
          signal,
          authorize: () => {
            this.assertTarget(surface, expected)
            this.actionTarget(surface, action)
            authorize()
          }
        })
      )
    } catch (error) {
      if (
        action.op === "invoke" &&
        action.action === "select_all_text" &&
        error instanceof NativeDesktopDispatchError &&
        error.outcome === "not-dispatched" &&
        [
          "text_selection_review_changed",
          "text_selection_provider_changed",
          "text_selection_value_mismatch",
          "element_review_changed"
        ].includes(error.code)
      )
        throw new BotDomainError("native_review_changed", "原文本或选择范围已变化，请重新观察")
      throw error
    }
    if (
      !sameWindow(observed.window, window) ||
      observed.element.id !== action.elementId ||
      observed.element.password ||
      !observed.element.enabled ||
      observed.element.offscreen
    )
      throw new BotDomainError("native_review_unavailable", "当前应用元素无法安全核对，请重新观察")
    if (action.op === "invoke" && action.action === "select_all_text") {
      const value = observed.element.value
      if (
        value === null ||
        !observed.textSelection ||
        observed.textSelection.utf16Length !== value.length ||
        observed.textSelection.textSha256 !==
          createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex")
      )
        throw new BotDomainError("native_review_unavailable", "当前文本无法完整核对，请重新观察")
    } else if (observed.textSelection) {
      throw new BotDomainError("native_review_unavailable", "应用控件审查类型已变化，请重新观察")
    }
    return observed
  }
  prepareReview(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<NativeDesktopReview> {
    const action = botNativeDesktopSemanticAction.parse(submitted)
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      const observed = await this.review(surface, expected, action, authorize, signal)
      this.assertTarget(surface, expected, "bot")
      const context = JSON.parse(
        JSON.stringify({
          backend: "windows-native",
          target: expected,
          action,
          observation: observed
        })
      ) as NativeDesktopReview["context"]
      const capability = Object.freeze({ context })
      this.reviews.set(capability, {
        target: { ...expected },
        action,
        observed
      })
      return capability
    })
  }
  private frozenReview(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    action: BotNativeDesktopSemanticAction,
    capability: NativeDesktopReview
  ): FrozenReview {
    const review = this.reviews.get(capability)
    if (
      !review ||
      v.canonicalJson(review.target) !== v.canonicalJson(expected) ||
      v.canonicalJson(review.action) !== v.canonicalJson(action)
    )
      throw new BotDomainError("native_review_changed", "批准的应用目标或操作已变化")
    this.assertTarget(surface, expected, "bot")
    this.actionTarget(surface, action)
    return review
  }
  assertReview(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    capability: NativeDesktopReview,
    authorize: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const action = botNativeDesktopSemanticAction.parse(submitted)
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      const frozen = this.frozenReview(surface, expected, action, capability)
      const current = await this.review(surface, expected, action, authorize, signal)
      if (v.canonicalJson(current) !== v.canonicalJson(frozen.observed))
        throw new BotDomainError("native_review_changed", "应用内容已变化，请重新确认操作")
      this.frozenReview(surface, expected, action, capability)
      authorize()
    })
  }
  discardReview(capability: NativeDesktopReview): void {
    this.reviews.delete(capability)
  }
  private async dispatch(
    surface: Surface,
    expected: BotNativeDesktopTarget,
    action: BotNativeDesktopSemanticAction,
    authorize: () => void,
    signal?: AbortSignal,
    frozen?: FrozenReview
  ): Promise<unknown> {
    if (!surface.capabilities?.semanticInput)
      throw new BotDomainError("computer_unavailable", "此电脑不支持原生应用输入")
    this.actionTarget(surface, action)
    const window = this.selected(surface)
    await this.admitWindow(surface, window, authorize, signal)
    this.actionTarget(surface, action)
    const transport = await surface.opening
    const observed =
      frozen?.observed ?? (await this.review(surface, expected, action, authorize, signal))
    const element = observed.element
    const expectedElement = {
      name: element.name,
      controlType: element.controlType,
      value: element.value,
      password: element.password,
      enabled: element.enabled,
      offscreen: element.offscreen
    }
    const { op, ...args } = action
    const params = {
      ...args,
      expectedWindowTitle: observed.title,
      expectedElement,
      ...(action.op === "invoke" && action.action === "select_all_text"
        ? { expectedTextSelection: observed.textSelection }
        : {})
    }
    surface.humanFrame = undefined
    surface.botFrame = undefined
    try {
      return await transport.request({
        scope: surface.workerScope,
        operation: op,
        window,
        params,
        signal,
        authorize: () => {
          this.assertTarget(surface, expected)
          this.actionTarget(surface, action)
          authorize()
        }
      })
    } finally {
      // Even a rejected/unknown action must be observed again before a second
      // effect; an old element token never authorizes a sequence of assumptions.
      this.clearSecrets(surface)
      surface.observation = undefined
      surface.observationRequired = true
    }
  }
  async act(
    expected: BotNativeDesktopTarget,
    submitted: unknown,
    authorize: () => void,
    signal: AbortSignal | undefined,
    capability: NativeDesktopReview
  ): Promise<unknown> {
    const action = botNativeDesktopSemanticAction.parse(submitted)
    const surface = this.require(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      const frozen = this.frozenReview(surface, expected, action, capability)
      try {
        return await this.dispatch(
          surface,
          expected,
          action,
          () => {
            this.assertTarget(surface, expected, "bot")
            this.frozenReview(surface, expected, action, capability)
            authorize()
          },
          signal,
          frozen
        )
      } finally {
        this.reviews.delete(capability)
      }
    })
  }
  assertHumanClient(botId: string, client: BotComputerClient, taskRunId?: string): void {
    client.throwIfAborted()
    const surface = this.require(botId, taskRunId)
    if (surface.target.control !== "human" || surface.humanClient !== client)
      throw new BotDomainError("computer_owned_elsewhere", "此电脑由另一客户端接管，请先转移控制权")
  }
  async takeControl(
    expected: BotNativeDesktopTarget,
    client: BotComputerClient = HOST_COMPUTER_CLIENT,
    replaceHuman = false
  ): Promise<BotNativeDesktopTarget> {
    client.throwIfAborted()
    const surface = this.require(expected.botId, expected.taskRunId)
    this.assertTarget(surface, expected)
    if (
      surface.transferring ||
      surface.target.control === "handoff" ||
      (surface.target.control === "human" && !replaceHuman)
    )
      throw new BotDomainError("computer_owned_elsewhere", "此电脑已被接管，请明确确认转移控制权")
    if (surface.queued >= 8)
      throw new BotDomainError("computer_busy", "电脑操作过多，请等待当前操作完成")
    surface.transferring = true
    surface.target.control = "handoff"
    surface.target.controlEpoch++
    surface.humanClient = undefined
    surface.humanFrame = undefined
    surface.botFrame = undefined
    this.clearSecrets(surface)
    surface.observation = undefined
    surface.observationRequired = true
    return this.serialize(surface, async () => {
      const transport = await surface.opening
      try {
        this.ports.saveHumanHeld(surface.target.botId, surface.target.taskRunId, true)
        if (!expected.taskRunId) await this.beforeHumanTransfer?.(expected.botId)
        client.throwIfAborted()
        this.check(surface, true)
        const next = {
          ...surface.workerScope,
          controlEpoch: surface.target.controlEpoch,
          control: "human" as const
        }
        await transport.request({
          scope: surface.workerScope,
          responseScope: next,
          operation: "revoke",
          params: {
            nextControlEpoch: next.controlEpoch,
            nextControl: next.control
          },
          signal: client,
          authorize: () => this.check(surface, true)
        })
        surface.workerScope = next
        client.throwIfAborted()
        surface.humanClient = client
      } catch (error) {
        surface.closed = true
        await transport.close()
        surface.closureConfirmed = true
        throw error
      } finally {
        // A disconnected/failed transfer never hands authority back to Bot.
        surface.target.control = "human"
        surface.transferring = false
      }
      return { ...surface.target }
    })
  }
  async releaseControl(
    expected: BotNativeDesktopTarget,
    client: BotComputerClient = HOST_COMPUTER_CLIENT
  ): Promise<BotNativeDesktopTarget> {
    const surface = this.require(expected.botId, expected.taskRunId)
    if (!expected.taskRunId && this.teachRecordingBot === expected.botId)
      throw new Error("请先保存或丢弃示范，再归还 Bot 控制权")
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "human")
      this.assertHumanClient(expected.botId, client, expected.taskRunId)
      const next = {
        ...surface.workerScope,
        controlEpoch: surface.target.controlEpoch + 1,
        control: "bot" as const
      }
      const transport = await surface.opening
      try {
        await transport.request({
          scope: surface.workerScope,
          responseScope: next,
          operation: "grant",
          params: {
            nextControlEpoch: next.controlEpoch,
            nextControl: next.control
          },
          signal: client,
          authorize: () => {
            this.assertTarget(surface, expected, "human")
            this.assertHumanClient(expected.botId, client, expected.taskRunId)
          }
        })
        surface.workerScope = next
        this.ports.saveHumanHeld(expected.botId, expected.taskRunId, false)
      } catch (error) {
        surface.closed = true
        await transport.close()
        surface.closureConfirmed = true
        throw error
      }
      surface.target.control = "bot"
      surface.target.controlEpoch = next.controlEpoch
      surface.humanClient = undefined
      surface.humanFrame = undefined
      surface.botFrame = undefined
      this.clearSecrets(surface)
      surface.observation = undefined
      surface.observationRequired = true
      return { ...surface.target }
    })
  }
  async humanInput(
    expected: BotNativeDesktopTarget,
    submitted: BotNativeDesktopHumanInput,
    client: BotComputerClient = HOST_COMPUTER_CLIENT
  ): Promise<void> {
    const surface = this.require(expected.botId, expected.taskRunId)
    const frameSeq = v.integer(submitted.frameSeq, "画面序号", 1)
    const action = botNativeDesktopAction.parse(submitted.action)
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "human")
        this.assertHumanClient(expected.botId, client, expected.taskRunId)
      }
      check()
      const frame = surface.humanFrame
      if (
        !frame ||
        frame.frameSeq !== frameSeq ||
        frame.generation !== expected.generation ||
        frame.controlEpoch !== expected.controlEpoch
      )
        throw new BotDomainError("stale_frame", "画面已过期，请刷新后操作")
      surface.humanFrame = undefined
      surface.botFrame = undefined
      try {
        if (!expected.taskRunId)
          await this.notifyTeach(surface, expected, { frameSeq, action }, "before", client)
        check()
        if ("elementId" in action) await this.dispatch(surface, expected, action, check, client)
        else {
          if (
            !frame.inputTicketIssued ||
            !frame.messageGeometryReady ||
            (action.op === "message_pointer" && !surface.capabilities?.messagePointer) ||
            (action.op === "message_pointer" &&
              action.kind === "drag" &&
              surface.capabilities?.messageDrag !== true) ||
            (action.op === "message_keyboard" &&
              (!surface.capabilities?.messageKeyboard ||
                (action.modifiers !== undefined && surface.capabilities?.messageChords !== true)))
          )
            throw new BotDomainError(
              "native_input_unavailable",
              "当前应用不支持此操作，请使用应用控件"
            )
          const window = this.selected(surface)
          const transport = await surface.opening
          await this.admitWindow(surface, window, check, client)
          if (action.op === "message_keyboard") {
            const sensitive = nativeDesktopSensitivity.parse(
              await transport.request({
                scope: surface.workerScope,
                operation: "has_sensitive_input",
                window,
                signal: client,
                authorize: check
              })
            )
            if (
              !sameWindow(sensitive.window, window) ||
              !sensitive.complete ||
              sensitive.passwordDetected
            )
              throw new BotDomainError(
                "native_secret_required",
                "此画面包含敏感输入或无法安全核对，请使用安全输入"
              )
          }
          const { op, ...params } = action
          try {
            await transport.request({
              scope: surface.workerScope,
              operation: op,
              window,
              params: {
                ...params,
                captureId: frame.captureId,
                frameVersion: frame.frameVersion,
                expectedWindowTitle: frame.title
              },
              signal: client,
              authorize: check
            })
          } finally {
            this.clearSecrets(surface)
            surface.observation = undefined
            surface.observationRequired = true
          }
        }
        if (!expected.taskRunId)
          await this.notifyTeach(surface, expected, { frameSeq, action }, "after", client)
      } catch (error) {
        if (!expected.taskRunId)
          await this.notifyTeach(
            surface,
            expected,
            { frameSeq, action },
            "unconfirmed",
            client
          ).catch(() => {})
        throw error
      }
    })
  }
  /** Fence only observations of the existing Bot computer. Never allocate a
   * child surface, close applications or change the human's held control. */
  async fenceBotObservations(botId: string, authorize: () => void): Promise<void> {
    this.check()
    authorize()
    const surface = this.surfaces.get(this.key(botId))
    if (!surface) return
    this.check(surface)
    await this.invalidateSurface(surface, authorize)
    authorize()
  }
  private invalidateSurface(surface: Surface, authorize: () => void): Promise<void> {
    this.check(surface)
    authorize()
    surface.target.generation = randomUUID()
    surface.humanFrame = undefined
    surface.botFrame = undefined
    this.clearSecrets(surface)
    surface.observation = undefined
    surface.observationRequired = true
    const generation = surface.target.generation
    const transition = Promise.resolve()
      .then(() =>
        this.serialize(surface, async () => {
          authorize()
          const transport = await surface.opening
          const next = { ...surface.workerScope, generation }
          await transport.request({
            scope: surface.workerScope,
            responseScope: next,
            operation: "invalidate",
            params: { nextGeneration: generation },
            authorize: () => {
              this.check(surface)
              authorize()
            }
          })
          surface.workerScope = next
          if (surface.selected) {
            const selected = surface.selected
            const check = () => {
              this.check(surface)
              authorize()
            }
            await this.admitWindow(surface, selected, check)
            await transport.request({
              scope: next,
              operation: "select_window",
              window: selected,
              authorize: check
            })
          }
          authorize()
        })
      )
      .catch(async (error: unknown) => {
        surface.closed = true
        const transport = await surface.opening.catch(() => undefined)
        if (transport) {
          try {
            await transport.close()
            surface.closureConfirmed = true
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "原生观察失效与资源关闭均未确认")
          }
        }
        throw error
      })
    void transition.catch(() => {})
    return transition
  }
  invalidateObservations(): void {
    this.observationEpoch++
    for (const surface of this.surfaces.values()) {
      if (surface.closed) continue
      void this.invalidateSurface(surface, () => this.check(surface)).catch(() => {})
    }
  }
  async releaseBot(botId: string): Promise<void> {
    v.identifier(botId)
    const results = await Promise.allSettled(
      [...this.surfaces.values()]
        .filter((surface) => surface.target.botId === botId)
        .map((surface) => this.release(surface))
    )
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "原生电脑关闭未确认"
      )
  }
  private release(surface: Surface): Promise<void> {
    if (surface.closing) return surface.closing
    surface.closed = true
    surface.humanClient = undefined
    surface.humanFrame = undefined
    surface.botFrame = undefined
    this.clearSecrets(surface)
    surface.observation = undefined
    surface.closing = (async () => {
      await surface.opening.catch(() => undefined)
      if (surface.transport) {
        await surface.transport.close()
        surface.closureConfirmed = true
      } else if (surface.lease) {
        surface.lease.stop()
        await surface.lease.awaitKernelClosure()
        surface.closureConfirmed = true
      }
      if (!surface.closureConfirmed)
        throw new Error("Native desktop allocation/closure remains unproven")
      await surface.tail
      const key = this.key(surface.target.botId, surface.target.taskRunId)
      if (this.surfaces.get(key) === surface) this.surfaces.delete(key)
    })()
    void surface.closing.catch(() => {})
    return surface.closing
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const lease of this.viewers.values()) lease.dispose()
    this.closing = Promise.allSettled(
      [...this.surfaces.values()].map((surface) => this.release(surface))
    ).then((results) => {
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      )
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "原生电脑资源关闭未确认"
        )
    })
    void this.closing.catch(() => {})
    return this.closing
  }
}
