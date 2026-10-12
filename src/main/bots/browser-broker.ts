import { prepareBotBrowserUpload, type BotBrowserUploadReview } from "./browser-file-upload"
import type { BotBrowserUploadFile } from "../../shared/bot-browser-upload"
import { performance } from "node:perf_hooks"
import { createHash, randomUUID } from "node:crypto"
import type { Browser, BrowserContext, Frame, Page, Request } from "playwright"
import { BotDomainError } from "../../shared/bot-types"
import {
  executeGrokBrowserAction,
  pressGrokBrowserKey,
  type GrokBrowserState,
  type GrokBrowserResult
} from "./upstream/grok-browser-actions.js"
import * as v from "./validation"
import { validateBotBrowserAction } from "./browser-action-validation"
import { HOST_COMPUTER_CLIENT, type BotComputerClient } from "./computer-client"
import { BotBrowserDownloads, type BotBrowserDownloadReceiver } from "./browser-downloads"
import { BotBrowserSecrets, type BotSecretDestination } from "./browser-secrets"
import { prepareBotBrowserReview, type BotBrowserReview } from "./browser-review"
import { browserCrashRecoveryPage } from "./browser-crash-page"
import { BotNativeSelectController, type BotNativeSelectObservation } from "./browser-native-select"
import type {
  BotBrowserTarget,
  BotBrowserFrame,
  BotHumanInput,
  BotBrowserSession
} from "../../shared/bot-computer"
import {
  BOT_BROWSER_VIEWPORT,
  BOT_HUMAN_INPUT_LIMIT,
  BOT_HUMAN_INPUT_CHARACTERS,
  type BotBrowserControl
} from "../../shared/bot-computer"
export type { BotBrowserTarget, BotBrowserFrame } from "../../shared/bot-computer"
/** Observed page facts, never authority from the document or model arguments. */
export interface BotBrowserObservation {
  pageId: string
  viewId: string
  navigationEpoch: number
  title?: string
  titleTruncated?: true
  url: string
  urlTruncated?: true
  urlSha256: string
}
type CrashedTab = {
  viewId: string
  index: number
  url: string
  error?: string
  recovered?: true
}
type HumanInputFrame = Pick<
  BotBrowserFrame,
  "frameSeq" | "generation" | "controlEpoch" | "navigationEpoch" | "width" | "height"
> & { tabs: { viewId: string }[]; nativeSelect?: { token: string } }
type HumanInputLease = {
  id: string
  client: BotComputerClient
  page: Page
  navigationEpoch: number
  width: number
  height: number
  nextSequence: number
  frames: Map<number, HumanInputFrame>
}
type Surface = {
  closed: boolean
  closing?: Promise<void>
  retireTimer?: ReturnType<typeof setTimeout>
  retired?: boolean
  persistenceQueued?: boolean
  target: BotBrowserTarget
  pages: Set<Page>
  registering: Map<Page, Promise<string>>
  pageTargets: Map<Page, string>
  pageViews: Map<Page, string>
  crashedTabs: Map<string, CrashedTab>
  state: GrokBrowserState
  tail: Promise<unknown>
  frameSeq: number
  lastFrame?: BotBrowserFrame
  /** One image for pending-navigation viewing, carrying no input authority by itself. */
  lastVisualFrame?: BotBrowserFrame
  humanInputLease?: HumanInputLease
  humanPendingInputs?: number
  humanPendingCharacters?: number
  nativeSelect?: BotNativeSelectController
  humanClient?: BotComputerClient
  humanTransferPending?: boolean
  restored: boolean
  observationRequired: boolean
  downloadConversationId?: string
  downloadThreadRootId?: string
}
export type BotBrowserSessionCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number]
export interface BotBrowserIdleResult {
  closed: boolean
  sessionCookies?: BotBrowserSessionCookie[]
}
export interface BotBrowserPersistence {
  now?(): number
  loadBrowserSession(botId: string): BotBrowserSession | null
  saveBrowserSession(botId: string, manifest: BotBrowserSession): void
  assertTaskBrowserOwner?(botId: string, runId: string, mutate?: boolean): void
  loadTaskBrowserSession?(botId: string, runId: string): BotBrowserSession | null
  saveTaskBrowserSession?(botId: string, runId: string, manifest: BotBrowserSession): void
  retireTaskBrowserSession?(botId: string, runId: string, pendingPage?: boolean): number | null
  taskBrowserNeedsReview?(botId: string, runId: string): boolean
  releaseTaskBrowserSession?(botId: string, runId: string): void
}

/**
 * One owned, persistent browser context per user; exact pages and input ownership per Bot.
 * Context launch/packaging belongs to ComputerProvider, not to the public Agent runtime.
 */
export class BotBrowserBroker {
  private readonly navigationEpochs = new WeakMap<Page, number>()
  private readonly pendingNavigations = new WeakMap<Page, Map<Frame, Request>>()
  private recordingBot?: string
  get teachRecordingBot(): string | undefined {
    return this.recordingBot
  }
  set teachRecordingBot(value: string | undefined) {
    this.recordingBot = value
    this.activityAt = performance.now()
  }
  private pendingOperations = 0
  private activeUploads = 0
  private admissions = 0
  private idleFenced = false
  private activityAt = performance.now()
  private readonly viewers = new Map<BotComputerClient, { until: number; dispose(): void }>()
  private readonly encoderPages = new Set<Page>()
  get lastActivityAt(): number {
    return this.activityAt
  }
  private hold(): () => void {
    if (this.closed || this.idleFenced)
      throw new BotDomainError("computer_unavailable", "浏览器正在关闭或已关闭")
    this.admissions++
    this.activityAt = performance.now()
    let released = false
    return () => {
      if (released) return
      released = true
      this.admissions--
      this.activityAt = performance.now()
    }
  }
  private observeViewer(client: BotComputerClient): void {
    if (client === HOST_COMPUTER_CLIENT) return
    client.throwIfAborted()
    const now = performance.now()
    for (const [owner, lease] of this.viewers)
      if (owner.aborted || lease.until <= now) lease.dispose()
    const previous = this.viewers.get(client)
    if (previous) {
      previous.until = now + (this.idlePolicy.viewerLeaseMs ?? 15_000)
      return
    }
    if (this.viewers.size >= 64)
      throw new BotDomainError("computer_viewer_limit", "浏览器查看连接过多")
    const dispose = () => {
      this.viewers.delete(client)
      client.removeEventListener("abort", dispose)
    }
    this.viewers.set(client, {
      until: now + (this.idlePolicy.viewerLeaseMs ?? 15_000),
      dispose
    })
    client.addEventListener("abort", dispose, { once: true })
  }
  get idleBlockedReason(): string | null {
    if (this.closed || this.pendingOperations || this.admissions) return "浏览器操作仍在执行或排队"
    if (this.recordingBot || this.encoderPages.size) return "示范仍在使用浏览器"
    if (this.downloads.busy) return "浏览器文件仍在下载"
    for (const surface of this.surfaces.values())
      if (surface.target.control !== "bot" || surface.registering.size || surface.closing)
        return "浏览器控制权或页面正在交接"
    for (const surface of this.surfaces.values())
      if (
        surface.target.taskRunId &&
        this.persistence?.taskBrowserNeedsReview?.(surface.target.botId, surface.target.taskRunId)
      )
        return "浏览器任务结果仍需核对，保留任务页面"
    const now = performance.now()
    for (const [client, lease] of this.viewers)
      if (client.aborted || lease.until <= now) lease.dispose()
    return this.viewers.size ? "浏览器正在查看" : null
  }
  /** Persistent tabs/profile survive; page JS/DOM memory is deliberately not a checkpoint. */
  tryIdleClose(canClose: () => boolean = () => true): Promise<BotBrowserIdleResult> | null {
    if (this.idleBlockedReason) return null
    // Admission is fenced before the cookie read yields. New get() callers join
    // the Provider transition; no old target can mutate the snapshot in between.
    this.idleFenced = true
    return (async () => {
      try {
        const cookies = await this.captureSessionCookies()
        if (this.closed || this.idleBlockedReason || !canClose()) return { closed: false }
        for (const surface of this.surfaces.values()) this.persist(surface)
        await this.close()
        return { closed: true, sessionCookies: cookies }
      } finally {
        if (!this.closed) this.idleFenced = false
      }
    })()
  }
  get isClosed(): boolean {
    return this.closed
  }
  /**
   * True only after this Broker itself has committed to closing the Chromium
   * context.  A context `close` event alone must never be treated as an
   * intentional close: Chromium can emit it for an OS/process failure.
   */
  get contextCloseRequested(): boolean {
    return this.contextCloseRequestedByBroker
  }
  private async captureSessionCookies(): Promise<BotBrowserSessionCookie[]> {
    // One bounded protocol request at a time. If the transport stalls beyond
    // the deadline its hold remains until completion/forced shutdown, preventing
    // an unbounded accumulation of cookie reads while ordinary work stays usable.
    this.admissions++
    const read = Promise.resolve()
      .then(() => this.context.cookies())
      .finally(() => {
        this.admissions--
        this.activityAt = performance.now()
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const cookies = await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("浏览器登录状态读取超时，保留当前浏览器")),
            5000
          )
          timer.unref()
        })
      ])
      const session: BotBrowserSessionCookie[] = []
      let bytes = 0
      for (const cookie of cookies)
        if (cookie.expires === -1) {
          bytes += Buffer.byteLength(JSON.stringify(cookie), "utf8")
          if (session.length >= 2048 || bytes > 2 * 1024 * 1024)
            throw new Error("临时浏览器登录状态超出休眠预算，保留当前浏览器")
          session.push(cookie)
        }
      return session
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  requiresObservation(botId: string, taskRunId?: string): boolean {
    return this.requireSurface(botId, taskRunId).observationRequired
  }
  private assertObserved(surface: Surface): void {
    if (surface.observationRequired)
      throw new BotDomainError("computer_reobserve", "浏览器画面已变化，请先查看新画面再操作")
  }
  beforeHumanTransfer?: (botId: string) => Promise<void>
  humanObserver?: (
    botId: string,
    page: Page,
    input: BotHumanInput,
    phase: "before" | "after" | "unconfirmed",
    selection?: BotNativeSelectObservation
  ) => Promise<void>
  private observationEpoch = 0
  private readonly surfaces = new Map<string, Surface>()
  private closed = false
  private contextCloseRequestedByBroker = false
  private closing?: Promise<void>
  private readonly downloads: BotBrowserDownloads
  private readonly secrets = new BotBrowserSecrets()
  humanDownloadReceiver?: (
    botId: string,
    conversationId?: string,
    threadRootId?: string,
    taskRunId?: string
  ) => BotBrowserDownloadReceiver
  constructor(
    private readonly context: BrowserContext,
    private readonly persistence?: BotBrowserPersistence,
    downloadRoot?: string,
    private readonly idlePolicy: {
      requireObservation?: boolean
      viewerLeaseMs?: number
      assertSupervision?: () => void
      assertBotInput?: (botId: string, taskRunId?: string) => void
      stopKeyboardCleanup?: (browser: Browser) => Promise<void>
    } = {}
  ) {
    this.downloads = new BotBrowserDownloads(context, downloadRoot)
    // Chromium can close a context outside the Provider's normal shutdown path
    // (for example after a crash or OS termination). The Provider will fence a
    // replacement browser, while this broker must still release its own pages,
    // downloads, secret handles and timers. Do not close the already-closed
    // context again.
    context.once("close", () => {
      void this.onContextClosed().catch(() => {})
    })
  }

  /** Host already committed its execution fence. Keep the existing pages and
   * human owner; old coordinates/element assumptions cannot authorize new IO. */
  invalidateObservations(): void {
    this.observationEpoch++
    for (const surface of this.surfaces.values()) this.invalidateSurfaceObservation(surface)
  }

  private invalidateHumanFrame(surface: Surface): void {
    surface.lastFrame = undefined
    surface.humanInputLease = undefined
    surface.nativeSelect?.invalidate()
  }

  private invalidateSurfaceObservation(surface: Surface): void {
    surface.target.generation = randomUUID()
    this.invalidateHumanFrame(surface)
    surface.observationRequired = true
  }

  private assertSupervision(epoch?: number): void {
    this.idlePolicy.assertSupervision?.()
    if (epoch !== undefined && epoch !== this.observationEpoch)
      throw new BotDomainError("stale_frame", "运行状态已变化，请刷新画面后操作")
  }

  private persist(surface: Surface, humanHeld = surface.target.control !== "bot"): void {
    if (!this.persistence || this.closed || surface.closed) return
    const pages = [...surface.pages].filter((page) => !page.isClosed())
    const current =
      pages.find((page) => surface.pageViews.get(page) === surface.target.viewId) ?? pages[0]
    const value: BotBrowserSession = {
      urls: pages.map((page) => page.url()),
      active: Math.max(0, pages.indexOf(current)),
      ...(humanHeld ? { humanHeld: true as const } : {})
    }
    if (surface.target.taskRunId)
      this.persistence.saveTaskBrowserSession?.(
        surface.target.botId,
        surface.target.taskRunId,
        value
      )
    else this.persistence.saveBrowserSession(surface.target.botId, value)
  }

  private async serialize<T>(surface: Surface, operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.idleFenced || surface.closed)
      throw new BotDomainError("computer_unavailable", "浏览器已关闭")
    this.pendingOperations++
    this.activityAt = performance.now()
    const next = surface.tail.then(async () => {
      if (this.closed || this.idleFenced || surface.closed)
        throw new BotDomainError("computer_unavailable", "浏览器已关闭")
      const result = await operation()
      if (this.closed || this.idleFenced || surface.closed)
        throw new BotDomainError("computer_unavailable", "浏览器已关闭")
      return result
    })
    const settled = next.finally(() => {
      this.pendingOperations--
      this.activityAt = performance.now()
    })
    surface.tail = settled.catch(() => {})
    return settled
  }

  private ownerKey(botId: string, taskRunId?: string): string {
    v.identifier(botId)
    return taskRunId === undefined ? botId : `task:${botId}:${v.identifier(taskRunId)}`
  }

  private assertTaskOwner(botId: string, taskRunId?: string, mutate = false): void {
    if (taskRunId === undefined) return
    if (!this.persistence?.assertTaskBrowserOwner)
      throw new BotDomainError("workflow_browser_scope", "任务浏览器缺少可信归属")
    this.persistence.assertTaskBrowserOwner(botId, taskRunId, mutate)
  }

  private requireSurface(botId: string, taskRunId?: string): Surface {
    if (this.closed || this.idleFenced)
      throw new BotDomainError("computer_unavailable", "浏览器正在关闭或已关闭")
    const surface = this.surfaces.get(this.ownerKey(botId, taskRunId))
    if (!surface || surface.closed)
      throw new BotDomainError("computer_unavailable", "该 Bot 的浏览器尚未准备或已关闭")
    return surface
  }

  private assertTarget(
    surface: Surface,
    expected: BotBrowserTarget,
    control?: "bot" | "human"
  ): void {
    const current = surface.target
    this.assertTaskOwner(expected.botId, expected.taskRunId, Boolean(control))
    if (control === "bot") this.idlePolicy.assertBotInput?.(current.botId, current.taskRunId)
    if (
      this.closed ||
      surface.closed ||
      expected.botId !== current.botId ||
      expected.taskRunId !== current.taskRunId ||
      expected.generation !== current.generation ||
      expected.controlEpoch !== current.controlEpoch ||
      expected.viewId !== current.viewId ||
      (control && current.control !== control)
    ) {
      throw new BotDomainError("stale_target", "画面或控制权已变化，请重新查看后操作")
    }
  }

  private registerPage(
    surface: Surface,
    page: Page,
    viewId: string = randomUUID()
  ): Promise<string> {
    if (surface.pages.has(page)) return Promise.resolve(surface.pageViews.get(page)!)
    const pending = surface.registering.get(page)
    if (pending) return pending
    const pageCount = [...this.surfaces.values()].reduce(
      (count, owned) => count + new Set([...owned.pages, ...owned.registering.keys()]).size,
      0
    )
    if (pageCount >= 128) {
      void page.close().catch(() => {})
      return Promise.reject(new BotDomainError("computer_page_limit", "浏览器页面数量已达上限"))
    }
    if (this.closed || surface.closed || surface.pages.size + surface.registering.size >= 30)
      return page.close().then(() => {
        throw new BotDomainError("tab_limit", "浏览器已关闭或标签页数量已达上限")
      })
    // Reserve before CDP yields. Concurrent popups cannot each observe the same
    // free slot or install duplicate target/download listeners for one page.
    const registration = this.attachPage(surface, page, viewId)
      .catch(async (error) => {
        await page.close().catch(() => {})
        throw error
      })
      .finally(() => surface.registering.delete(page))
    surface.registering.set(page, registration)
    return registration
  }

  private async attachPage(surface: Surface, page: Page, viewId: string): Promise<string> {
    const check = async () => {
      if (!this.closed && !surface.closed) return
      await page.close().catch(() => {})
      throw new BotDomainError("computer_unavailable", "浏览器已关闭")
    }
    await check()
    const session = await this.context.newCDPSession(page)
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo")
      await check()
      surface.state.views[viewId] = targetInfo.targetId
      surface.pageTargets.set(page, targetInfo.targetId)
      surface.pageViews.set(page, viewId)
    } finally {
      await session.detach()
    }
    surface.pages.add(page)
    const unregister = () => {
      if (surface.crashedTabs.get(viewId)?.recovered && surface.pageViews.get(page) === viewId)
        surface.crashedTabs.delete(viewId)
      surface.pages.delete(page)
      const targetId = surface.pageTargets.get(page)
      surface.pageTargets.delete(page)
      surface.pageViews.delete(page)
      for (const [id, target] of Object.entries(surface.state.views)) {
        if (target === targetId) delete surface.state.views[id]
      }
    }
    // Attachment-only popups can close while their CDP session is being registered.
    page.once("close", unregister)
    try {
      await this.downloads.watch(page, () => {
        if (surface.closed || surface.target.control !== "human" || !this.humanDownloadReceiver)
          return undefined
        const client = surface.humanClient
        if (!client || client.aborted) return undefined
        const epoch = surface.target.controlEpoch
        const receiver = this.humanDownloadReceiver(
          surface.target.botId,
          surface.downloadConversationId,
          surface.downloadThreadRootId,
          surface.target.taskRunId
        )
        return {
          ...receiver,
          owner: this.ownerKey(surface.target.botId, surface.target.taskRunId),
          check: () => {
            if (
              this.closed ||
              surface.closed ||
              client.aborted ||
              surface.humanClient !== client ||
              surface.target.control !== "human" ||
              surface.target.controlEpoch !== epoch
            )
              throw new Error("下载期间控制权已变化")
            receiver.check()
          }
        }
      })
      await check()
    } catch (error) {
      unregister()
      throw error
    }
    page.once("crash", () => {
      if (this.closed || surface.closed || !surface.pages.has(page)) return
      const crash: CrashedTab = {
        viewId,
        index: [...surface.pages].indexOf(page),
        url: page.url().slice(0, 8192)
      }
      const previous = surface.crashedTabs.get(viewId)
      // Only the crashed selected page invalidates current input/frame authority.
      // A background page has its own target and refs; retiring it must not turn
      // an already dispatched operation on the healthy current page into unknown.
      if (surface.target.viewId === viewId) {
        surface.target.generation = randomUUID()
        this.invalidateHumanFrame(surface)
        surface.observationRequired = true
      }
      unregister()
      surface.crashedTabs.set(viewId, crash)
      if (previous) {
        crash.error = "标签页再次崩溃；未自动重试，请重新启动 Bot 浏览器后核对原操作结果"
        if (surface.target.viewId !== viewId) surface.crashedTabs.delete(viewId)
        void page.close().catch(() => {})
        return
      }
      // A crashed Page is not closed, but Playwright permanently rejects its operations.
      // Queue one replacement, never replay an input or reload an uncertain request.
      void this.serialize(surface, () => this.recoverCrashedTab(surface, page, crash)).catch(
        () => {}
      )
    })
    page.on("popup", (popup) => {
      void this.registerPage(surface, popup).catch(() => popup.close().catch(() => {}))
    })
    page.on("request", (request) => {
      if (!request.isNavigationRequest()) return
      let frame: Frame
      try {
        frame = request.frame()
      } catch {
        return // Service-worker requests do not identify this page's visible document.
      }
      const pending = this.pendingNavigations.get(page) ?? new Map<Frame, Request>()
      pending.set(frame, request)
      this.pendingNavigations.set(page, pending)
      if (surface.target.viewId === viewId) this.invalidateHumanFrame(surface)
    })
    page.on("requestfailed", (request) => {
      if (!request.isNavigationRequest()) return
      try {
        const pending = this.pendingNavigations.get(page)
        const frame = request.frame()
        if (pending?.get(frame) === request) pending.delete(frame)
      } catch {
        // A request without a frame cannot revive an input lease.
      }
    })
    page.on("framedetached", (frame) => this.pendingNavigations.get(page)?.delete(frame))
    page.on("framenavigated", (frame) => {
      if (this.closed || surface.closed) return
      this.pendingNavigations.get(page)?.delete(frame)
      if (surface.target.viewId === viewId) {
        this.invalidateHumanFrame(surface)
      }
      if (frame !== page.mainFrame()) return
      this.navigationEpochs.set(page, (this.navigationEpochs.get(page) ?? 0) + 1)
      if (surface.persistenceQueued) return
      // Navigations can burst while a tool holds the serial queue. One pending
      // save observes the latest URLs when it runs; intermediate URLs need no writes.
      surface.persistenceQueued = true
      void this.serialize(surface, async () => this.persist(surface))
        .finally(() => {
          surface.persistenceQueued = false
        })
        .catch(() => {})
    })
    page.setDefaultTimeout(10_000)
    return viewId
  }

  private async recoverCrashedTab(
    surface: Surface,
    crashedPage: Page,
    crash: CrashedTab
  ): Promise<void> {
    const check = () => {
      if (
        this.closed ||
        surface.closed ||
        surface.retired ||
        this.surfaces.get(this.ownerKey(surface.target.botId, surface.target.taskRunId)) !==
          surface ||
        surface.crashedTabs.get(crash.viewId) !== crash
      )
        throw new BotDomainError("computer_unavailable", "故障标签页已不属于当前 Bot")
      this.assertTaskOwner(surface.target.botId, surface.target.taskRunId, true)
    }
    let replacement: Page | undefined
    try {
      check()
      await crashedPage.close()
      check()
      replacement = await this.context.newPage()
      check()
      await this.registerPage(surface, replacement, crash.viewId)
      check()
      await replacement.setContent(browserCrashRecoveryPage(crash.url), {
        waitUntil: "domcontentloaded",
        timeout: 10_000
      })
      check()
      // Replacing a background tab must retain the active page and the tab ordering.
      const pages = [...surface.pages].filter((page) => page !== replacement)
      pages.splice(Math.min(crash.index, pages.length), 0, replacement)
      surface.pages = new Set(pages)
      if (surface.target.viewId === crash.viewId) this.invalidateHumanFrame(surface)
      this.persist(surface)
      crash.recovered = true
    } catch (error) {
      // Publish failure before the serial tail settles; the next frame must not
      // race the detached handler catch and mistake a settled failure for pending.
      if (!this.closed && !surface.closed && surface.crashedTabs.get(crash.viewId) === crash)
        crash.error = "标签页恢复失败；未重放原操作，请重新启动 Bot 浏览器后重试并核对原结果"
      if (replacement) await replacement.close().catch(() => {})
      // A failed background page is no longer selectable; retain no unreachable
      // record as users open new tabs. The selected failure stays explicit.
      if (surface.target.viewId !== crash.viewId && !surface.state.views[crash.viewId])
        surface.crashedTabs.delete(crash.viewId)
      throw error
    } finally {
      // Even retirement/deletion before this queued work starts disposes only its failed page.
      await crashedPage.close().catch(() => {})
    }
  }

  async ensure(botId: string, taskRunId?: string): Promise<BotBrowserTarget> {
    const release = this.hold()
    try {
      const key = this.ownerKey(botId, taskRunId)
      this.assertTaskOwner(botId, taskRunId)
      if (this.closed || this.idleFenced)
        throw new BotDomainError("computer_unavailable", "浏览器正在关闭或已关闭")
      await this.downloads.ready()
      let surface = this.surfaces.get(key)
      // Validate a new target before publishing it. A request that outlived Bot
      // deletion must not recreate a page after releaseBot removed its old surface.
      const saved =
        !surface || !surface.restored
          ? taskRunId
            ? this.persistence?.loadTaskBrowserSession?.(botId, taskRunId)
            : this.persistence?.loadBrowserSession(botId)
          : null
      if (!surface) {
        // Retained, already-settled pages may yield capacity to new work. Never
        // evict a live task, human holder, unknown effect or persistent Bot.
        while (this.surfaces.size >= 64) {
          const retired = [...this.surfaces.values()].find(
            (item) => item.retireTimer && item.target.control === "bot" && !item.closed
          )
          if (!retired) break
          await this.releaseSurface(retired.target.botId, retired.target.taskRunId, true)
          this.assertTaskOwner(botId, taskRunId)
          if (!taskRunId) this.persistence?.loadBrowserSession(botId)
          if (this.surfaces.has(key)) return await this.ensure(botId, taskRunId)
        }
        if (this.surfaces.size >= 64)
          throw new BotDomainError(
            "computer_surface_limit",
            "浏览器任务画面已达上限，请结束或关闭已有任务"
          )
        surface = {
          closed: false,
          target: {
            botId,
            ...(taskRunId ? { taskRunId } : {}),
            generation: randomUUID(),
            controlEpoch: 0,
            control: "bot",
            viewId: randomUUID()
          },
          pages: new Set(),
          registering: new Map(),
          pageTargets: new Map(),
          pageViews: new Map(),
          crashedTabs: new Map(),
          state: { views: {} },
          tail: Promise.resolve(),
          frameSeq: 0,
          restored: false,
          observationRequired: Boolean(this.idlePolicy.requireObservation)
        }
        this.surfaces.set(key, surface)
      }
      const owned = surface
      return await this.serialize(owned, async () => {
        const crashed = owned.crashedTabs.get(owned.target.viewId)
        if (crashed && !crashed.recovered)
          throw new BotDomainError(
            "browser_tab_recovery_failed",
            crashed.error ?? "标签页正在恢复，请稍后重试"
          )
        if (owned.pages.size === 0) {
          this.assertTaskOwner(botId, taskRunId, true)
          // Rebuilding a closed target invalidates every prior frame and input ticket.
          owned.target.generation = randomUUID()
          const manifest = owned.restored ? null : saved
          if (manifest?.humanHeld) owned.target.control = "human"
          owned.restored = true
          const urls = manifest?.urls?.length ? manifest.urls.slice(0, 30) : ["about:blank"]
          for (let index = 0; index < urls.length; index++) {
            const page = await this.context.newPage(),
              viewId = await this.registerPage(owned, page)
            if (index === Math.min(manifest?.active ?? 0, urls.length - 1))
              owned.target.viewId = viewId
            if (/^https?:\/\//i.test(urls[index])) {
              this.validateAction({ op: "navigate", url: urls[index] })
              await page
                .goto(urls[index], {
                  waitUntil: "domcontentloaded",
                  timeout: 15_000
                })
                .catch(() => {})
            }
          }
          owned.state.lastViewId = owned.target.viewId
          this.invalidateHumanFrame(owned)
        }
        if (!(await this.currentPage(owned).catch(() => null))) {
          owned.target.viewId = await this.registerPage(owned, [...owned.pages][0])
          owned.state.lastViewId = owned.target.viewId
          owned.target.generation = randomUUID()
        }
        await this.persist(owned)
        return { ...owned.target }
      })
    } finally {
      release()
    }
  }

  target(botId: string, taskRunId?: string): BotBrowserTarget {
    return { ...this.requireSurface(botId, taskRunId).target }
  }
  /** Synchronous publication fence after the screenshot bytes have been written. */
  assertBotObservation(expected: BotBrowserTarget, observation: BotBrowserObservation): void {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    this.assertTarget(surface, expected, "bot")
    const page = [...surface.pages].find(
      (item) => surface.pageTargets.get(item) === observation.pageId
    )
    if (
      !page ||
      page.isClosed() ||
      surface.pageViews.get(page) !== expected.viewId ||
      observation.viewId !== expected.viewId ||
      createHash("sha256").update(page.url()).digest("hex") !== observation.urlSha256 ||
      (this.navigationEpochs.get(page) ?? 0) !== observation.navigationEpoch
    )
      throw new BotDomainError("stale_target", "截图页面已变化，请重新查看后再交付")
  }
  controlHeld(botId: string): boolean {
    const surface = this.surfaces.get(this.ownerKey(botId))
    return surface
      ? surface.target.control !== "bot"
      : Boolean(this.persistence?.loadBrowserSession(botId)?.humanHeld)
  }

  clientTarget(botId: string, client: BotComputerClient, taskRunId?: string): BotBrowserControl {
    client.throwIfAborted()
    this.observeViewer(client)
    const surface = this.requireSurface(botId, taskRunId)
    if (surface.humanClient === client) surface.nativeSelect?.keepAlive()
    return {
      ...surface.target,
      ...(surface.target.control === "human"
        ? {
            controlOwner: surface.humanClient === client ? ("self" as const) : ("other" as const),
            controlOwnerConnected: this.humanClientConnected(botId, taskRunId)
          }
        : {})
    }
  }

  assertHumanClient(botId: string, client: BotComputerClient, taskRunId?: string): void {
    this.assertTaskOwner(botId, taskRunId, true)
    client.throwIfAborted()
    const surface = this.requireSurface(botId, taskRunId)
    if (surface.target.control !== "human" || surface.humanClient !== client)
      throw new BotDomainError(
        "computer_owned_elsewhere",
        "此浏览器由另一客户端接管，请先转移控制权"
      )
  }

  humanClientConnected(botId: string, taskRunId?: string): boolean {
    const client = this.requireSurface(botId, taskRunId).humanClient
    return Boolean(client && !client.aborted)
  }

  get restartBlockedReason(): string | null {
    if (this.downloads.busy) return "浏览器文件仍在下载，请完成后再切换后台版本"
    if (this.encoderPages.size) return "请先结束示范录制，再切换后台版本"
    return [...this.surfaces.values()].some((surface) => surface.target.control !== "bot")
      ? "请先归还当前接管的 Bot 电脑，再切换后台版本"
      : null
  }

  /** Observe the owned human-controlled page without issuing or invalidating UI input tickets. */
  async teachObserve<T>(botId: string, observe: (page: Page) => Promise<T>): Promise<T> {
    const surface = this.requireSurface(botId)
    return this.serialize(surface, async () => {
      if (surface.target.control !== "human") throw new Error("示范录制需要由你控制浏览器")
      return observe(await this.currentPage(surface))
    })
  }

  async teachEncoderPage(): Promise<Page> {
    if (this.closed) throw new Error("浏览器已关闭")
    // Deliberately absent from every Bot surface and scoped tool context.
    const release = this.hold()
    try {
      const page = await this.context.newPage()
      this.encoderPages.add(page)
      page.once("close", () => {
        this.encoderPages.delete(page)
        this.activityAt = performance.now()
      })
      return page
    } finally {
      release()
    }
  }

  private scopedContext(
    surface: Surface,
    beforeNewPage?: () => void
  ): Pick<BrowserContext, "pages" | "newPage" | "newCDPSession"> {
    return {
      pages: () => [...surface.pages].filter((page) => !page.isClosed()),
      newPage: async () => {
        const opener = await this.currentPage(surface).catch(() => null)
        beforeNewPage?.()
        const page = await this.context.newPage()
        await this.registerPage(surface, page)
        if (opener) await this.downloads.inheritAction(page, opener)
        return page
      },
      newCDPSession: (page) => {
        if (!surface.pages.has(page as Page))
          throw new BotDomainError("wrong_target", "页面不属于当前 Bot")
        return this.context.newCDPSession(page)
      }
    }
  }

  private stopKeyboardCleanup = (browser: Browser | null | undefined): Promise<void> => {
    // The browser is shared by all Bot surfaces. Revoke admission synchronously
    // before stopping its captured transport; do not await this broker's own tail.
    this.closed = true
    this.invalidateObservations()
    if (!browser)
      return Promise.reject(new Error("Browser keyboard cleanup could not stop transport"))
    return this.idlePolicy.stopKeyboardCleanup?.(browser) ?? browser.close()
  }

  private validateAction(input: unknown): Record<string, unknown> & { op: string } {
    return validateBotBrowserAction(input)
  }

  async act(
    expected: BotBrowserTarget,
    input: unknown,
    authorize: () => void,
    downloadReceiver?: BotBrowserDownloadReceiver,
    review?: BotBrowserReview
  ): Promise<{
    summary: string
    data?: string
    image?: string
    target: BotBrowserTarget
    observation?: BotBrowserObservation
  }> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId),
      action = this.validateAction(input)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      if (!["snapshot", "screenshot"].includes(action.op)) this.assertObserved(surface)
      if (review) await review.assert(await this.currentPage(surface), action)
      this.assertTarget(surface, expected, "bot")
      authorize() // Re-check the durable run lease and approval at the actual dispatch boundary.
      const previousTargetId = surface.state.views[surface.target.viewId]
      const reviewedPage = await this.currentPage(surface)
      let firstInput = true
      const assertInput = (page?: Page) => {
        this.assertTarget(surface, expected, "bot")
        authorize()
        if (
          page &&
          (page.isClosed() ||
            !surface.pages.has(page) ||
            (action.op !== "tabs" &&
              !(action.op === "navigate" && action.newTab === true) &&
              page !== reviewedPage))
        )
          throw new BotDomainError("wrong_target", "页面不属于本次浏览器操作目标")
      }
      const beforeInput = {
        async prepare(page?: Page) {
          assertInput(page)
          if (firstInput && review) await review.assert(reviewedPage, action)
          // Review reads are asynchronous. Recheck immediately after them;
          // the driver also calls assert synchronously before its real input.
          assertInput(page)
          firstInput = false
        },
        assert: assertInput,
        stopKeyboardCleanup: this.stopKeyboardCleanup
      }
      let resizeDispatched = false
      const execute = async (): Promise<GrokBrowserResult> => {
        if (action.op === "resize") {
          await beforeInput.prepare(reviewedPage)
          beforeInput.assert(reviewedPage)
          resizeDispatched = true
          // Retire Grok's page-owned ref map as part of this approved action.
          // A screenshot alone cannot revive refs chosen at the previous geometry.
          await reviewedPage.evaluate(() => {
            const refs = (globalThis as unknown as { __sandRefs?: Map<string, unknown> }).__sandRefs
            if (refs instanceof Map) refs.clear()
          })
          beforeInput.assert(reviewedPage)
          await reviewedPage.setViewportSize({
            width: Number(action.width),
            height: Number(action.height)
          })
          beforeInput.assert(reviewedPage)
          const viewport = await reviewedPage.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight
          }))
          beforeInput.assert(reviewedPage)
          if (viewport.width !== action.width || viewport.height !== action.height)
            throw new BotDomainError(
              "browser_resize_unconfirmed",
              "页面尺寸未确认，请查看新画面后核对"
            )
          return {
            page: reviewedPage,
            viewId: expected.viewId,
            summary: `Resized page viewport to ${viewport.width} × ${viewport.height} CSS pixels; take a fresh snapshot before further input`,
            data: JSON.stringify({ viewport, unit: "css-px", requiresSnapshot: true })
          }
        }
        return executeGrokBrowserAction(
          {
            ...action,
            // The displayed target identifies an existing page. A newly opened
            // page must not overwrite that identity, or accept a model-supplied
            // identity. Its owned registration supplies the returned view ID.
            viewId: action.op === "navigate" && action.newTab === true ? undefined : expected.viewId
          },
          this.scopedContext(surface, () => assertInput(reviewedPage)),
          surface.state,
          beforeInput
        )
      }
      let result: GrokBrowserResult
      try {
        result = downloadReceiver
          ? await this.downloads.during<GrokBrowserResult>(
              await this.currentPage(surface),
              {
                ...downloadReceiver,
                owner: this.ownerKey(expected.botId, expected.taskRunId),
                check: () => {
                  // Selecting a tab can legitimately change the view during this action.
                  if (
                    surface.target.control !== "bot" ||
                    surface.target.controlEpoch !== expected.controlEpoch
                  )
                    throw new Error("下载期间控制权已变化")
                  authorize()
                  downloadReceiver.check()
                }
              },
              execute,
              action.op === "navigate" ? () => ({ summary: "页面导航触发了文件下载" }) : undefined
            )
          : await execute()
        // A crash may have fenced this view while the external operation was in flight.
        // Its eventual reply cannot authorize a fresh view or clear re-observation.
        this.assertTarget(surface, expected, "bot")
      } finally {
        // Even a rejected/lost resize reply may have changed the page geometry.
        // Retire queued targets and human frame tickets without changing ownership.
        if (resizeDispatched) this.invalidateSurfaceObservation(surface)
      }
      if (result.page) result.viewId = surface.pageViews.get(result.page) ?? result.viewId
      if (
        result.viewId &&
        (result.viewId !== surface.target.viewId ||
          surface.state.views[result.viewId] !== previousTargetId)
      ) {
        surface.target.viewId = result.viewId
        surface.target.generation = randomUUID()
      }
      surface.state.lastViewId = surface.target.viewId
      this.invalidateHumanFrame(surface)
      if (surface.crashedTabs.has(surface.target.viewId)) surface.observationRequired = true
      if (action.op === "navigate" && result.page) {
        const viewId = surface.pageViews.get(result.page)
        if (viewId) surface.crashedTabs.delete(viewId)
      }
      if (
        action.op === "tabs" &&
        action.action === "close" &&
        surface.pages.size &&
        !surface.state.views[surface.target.viewId]
      ) {
        const page = [...surface.pages][0],
          viewId = await this.registerPage(surface, page)
        surface.target.viewId = viewId
        surface.state.lastViewId = viewId
        surface.target.generation = randomUUID()
      }
      await this.persist(surface)
      const capturedTarget = { ...surface.target }
      const observing = ["snapshot", "screenshot", "highlight"].includes(action.op)
      const page =
        (result.page && !result.page.isClosed() && surface.pages.has(result.page)
          ? result.page
          : undefined) ??
        [...surface.pages].find((item) => surface.pageViews.get(item) === capturedTarget.viewId)
      let observation: BotBrowserObservation | undefined
      if (page) {
        const navigationEpoch = this.navigationEpochs.get(page) ?? 0
        const url = page.url()
        // Completed input must not fail because a new title request races the
        // navigation it caused. Only explicit observations read document text.
        const title = observing ? await page.title() : undefined
        observation = {
          pageId: surface.pageTargets.get(page)!,
          viewId: capturedTarget.viewId,
          navigationEpoch,
          ...(title === undefined ? {} : { title: title.slice(0, 2000) }),
          ...(title !== undefined && title.length > 2000 ? { titleTruncated: true as const } : {}),
          url: url.slice(0, 8192),
          ...(url.length > 8192 ? { urlTruncated: true as const } : {}),
          urlSha256: createHash("sha256").update(url).digest("hex")
        }
        if (observing) this.assertBotObservation(capturedTarget, observation)
      }
      const image =
        ["screenshot", "highlight"].includes(action.op) && result.page
          ? `data:image/jpeg;base64,${(await result.page.screenshot({ type: "jpeg", quality: 70 })).toString("base64")}`
          : undefined
      if (observing) {
        authorize()
        this.assertTarget(surface, capturedTarget, "bot")
        if (observation) this.assertBotObservation(capturedTarget, observation)
      }
      if (["snapshot", "screenshot"].includes(action.op)) surface.observationRequired = false
      return {
        summary: result.summary,
        ...(result.data ? { data: result.data } : {}),
        ...(image ? { image } : {}),
        ...(observation ? { observation } : {}),
        target: capturedTarget
      }
    })
  }

  async prepareReview(
    expected: BotBrowserTarget,
    input: unknown,
    authorize: () => void
  ): Promise<BotBrowserReview> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId),
      action = this.validateAction(input)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      this.assertObserved(surface)
      authorize()
      const review = await prepareBotBrowserReview(await this.currentPage(surface), action, () =>
        [...surface.pages]
          .filter((page) => !page.isClosed())
          .map((page) => ({
            id: surface.pageTargets.get(page)!,
            url: page.url()
          }))
      )
      try {
        this.assertTarget(surface, expected, "bot")
        this.assertObserved(surface)
        authorize()
        return review
      } catch (error) {
        await review.dispose()
        throw error
      }
    })
  }

  async assertReview(
    expected: BotBrowserTarget,
    input: unknown,
    review: BotBrowserReview,
    authorize: () => void
  ): Promise<void> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId),
      action = this.validateAction(input)
    await this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      await review.assert(await this.currentPage(surface), action)
      this.assertTarget(surface, expected, "bot")
      authorize()
    })
  }

  private async currentPage(surface: Surface): Promise<Page> {
    const crashed = surface.crashedTabs.get(surface.target.viewId)
    if (crashed && !crashed.recovered)
      throw new BotDomainError(
        "browser_tab_recovery_failed",
        crashed.error ?? "标签页正在恢复，请稍后重试"
      )
    const targetId = surface.state.views[surface.target.viewId]
    for (const page of surface.pages) {
      if (page.isClosed()) continue
      if (surface.pageTargets.get(page) === targetId) return page
    }
    throw new BotDomainError("target_closed", "当前页面已关闭，请重新打开 Bot 电脑")
  }

  async prepareUpload(
    expected: BotBrowserTarget,
    ref: string,
    files: BotBrowserUploadFile[],
    authorize: () => void
  ): Promise<BotBrowserUploadReview> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      this.assertObserved(surface)
      authorize()
      const page = await this.currentPage(surface)
      const review = await prepareBotBrowserUpload(
        page,
        ref,
        files,
        () =>
          [...surface.pages]
            .filter((page) => !page.isClosed())
            .map((page) => ({ id: surface.pageTargets.get(page)!, url: page.url() })),
        () => this.navigationEpochs.get(page) ?? 0
      )
      try {
        this.assertTarget(surface, expected, "bot")
        this.assertObserved(surface)
        authorize()
        return review
      } catch (error) {
        await review.dispose()
        throw error
      }
    })
  }

  async assertUpload(
    expected: BotBrowserTarget,
    review: BotBrowserUploadReview,
    authorize: () => void
  ): Promise<void> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    await this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      this.assertObserved(surface)
      await review.assert(await this.currentPage(surface))
      this.assertTarget(surface, expected, "bot")
      authorize()
    })
  }

  async performUpload(
    expected: BotBrowserTarget,
    review: BotBrowserUploadReview,
    loadFiles: () => Promise<{ metadata: BotBrowserUploadFile; bytes: Buffer }[]>,
    authorize: () => void
  ): Promise<{
    status: "files_selected"
    serverAcceptance: "unverified"
    files: BotBrowserUploadFile[]
    target: BotBrowserTarget
    requiresSnapshot: true
  }> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "bot")
        this.assertObserved(surface)
        authorize()
      }
      check()
      if (this.activeUploads >= 4)
        throw new BotDomainError("browser_upload_limit", "同时上传的文件过多，请等待当前上传结束")
      this.activeUploads++
      let dispatched = false
      let files: { metadata: BotBrowserUploadFile; bytes: Buffer }[] = []
      try {
        // Acquire this page's queue and a bounded byte-reader slot before loading
        // any original. Queued calls never retain a 25 MiB buffer during review.
        await review.assert(await this.currentPage(surface))
        check()
        files = await loadFiles()
        check()
        await review.perform(await this.currentPage(surface), files, check, () => {
          dispatched = true
        })
        this.invalidateSurfaceObservation(surface)
        dispatched = false
        return {
          status: "files_selected",
          serverAcceptance: "unverified",
          files: files.map((file) => file.metadata),
          target: { ...surface.target },
          requiresSnapshot: true
        }
      } finally {
        files.length = 0
        this.activeUploads--
        if (dispatched) this.invalidateSurfaceObservation(surface)
      }
    })
  }

  async prepareSecret(
    expected: BotBrowserTarget,
    ref: string,
    authorize: () => void
  ): Promise<BotSecretDestination> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    if (expected.taskRunId)
      throw new BotDomainError("workflow_browser_scope", "浏览器子任务不能读取或填充 Bot 凭据")
    v.text(ref, "密码输入框", 100)
    return this.serialize(surface, async () => {
      this.assertTarget(surface, expected, "bot")
      this.assertObserved(surface)
      authorize()
      const result = await this.secrets.prepare(expected, await this.currentPage(surface), ref)
      try {
        this.assertTarget(surface, expected, "bot")
        this.assertObserved(surface)
        authorize()
        return result
      } catch (error) {
        await this.secrets.discard(result.token)
        throw error
      }
    })
  }

  async fillSecret(
    token: string,
    value: string,
    authorize: () => void,
    signal: AbortSignal
  ): Promise<void> {
    const target = this.secrets.target(token),
      surface = this.requireSurface(target.botId, target.taskRunId)
    await this.serialize(surface, async () => {
      await this.secrets.fill(
        token,
        value,
        () => {
          this.assertTarget(surface, target, "bot")
          authorize()
        },
        signal
      )
      this.invalidateHumanFrame(surface)
    })
  }

  discardSecret(token: string): Promise<void> {
    return this.secrets.discard(token)
  }

  async download(
    expected: BotBrowserTarget,
    url: string,
    authorize: () => void,
    signal: AbortSignal,
    review?: BotBrowserReview
  ): Promise<{ bytes: Buffer; suggestedName: string }> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    const action = this.validateAction({ op: "navigate", url })
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "bot")
        this.assertObserved(surface)
        authorize()
      }
      check()
      if (review) await review.assert(await this.currentPage(surface), action)
      check()
      const page = await this.context.newPage()
      // This temporary page is never adopted by URL or exposed as another Bot's screen.
      try {
        if (review) await review.assert(await this.currentPage(surface), action)
        check()
        return await this.downloads.fetch(page, url, check, signal)
      } finally {
        await page.close().catch(() => {})
      }
    })
  }

  /** Use the site's own form/export action, preserving cookies, CSRF and POST semantics. */
  async downloadFromPage(
    expected: BotBrowserTarget,
    ref: string,
    authorize: () => void,
    signal: AbortSignal,
    review?: BotBrowserReview,
    element?: string
  ): Promise<{ bytes: Buffer; suggestedName: string }> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    v.text(ref, "页面元素", 100)
    const action = this.validateAction({
      op: "click",
      ref,
      ...(element === undefined ? {} : { element })
    })
    return this.serialize(surface, async () => {
      const check = () => {
        this.assertTarget(surface, expected, "bot")
        this.assertObserved(surface)
        authorize()
      }
      check()
      const page = await this.currentPage(surface)
      if (review) await review.assert(page, action)
      check()
      try {
        return await this.downloads.capture(
          page,
          async () => {
            if (review) await review.assert(page, action)
            check()
            return executeGrokBrowserAction(
              { ...action, viewId: expected.viewId },
              this.scopedContext(surface),
              surface.state,
              {
                async prepare(current) {
                  if (current !== page) throw new BotDomainError("wrong_target", "下载页面已变化")
                  if (review) await review.assert(page, action)
                  check()
                },
                assert(current) {
                  if (current !== page) throw new BotDomainError("wrong_target", "下载页面已变化")
                  check()
                }
              }
            )
          },
          check,
          signal
        )
      } finally {
        this.invalidateHumanFrame(surface)
        await this.persist(surface)
      }
    })
  }

  async frame(
    botId: string,
    client: BotComputerClient = HOST_COMPUTER_CLIENT,
    taskRunId?: string
  ): Promise<BotBrowserFrame> {
    client.throwIfAborted()
    this.assertSupervision()
    this.observeViewer(client)
    await this.ensure(botId, taskRunId)
    const surface = this.requireSurface(botId, taskRunId)
    return this.serialize(surface, async () => {
      client.throwIfAborted()
      this.assertSupervision()
      const epoch = this.observationEpoch
      const capturedTarget = { ...surface.target }
      const page = await this.currentPage(surface)
      const navigationEpoch = this.navigationEpochs.get(page) ?? 0
      this.assertSupervision(epoch)
      if (this.pendingNavigations.get(page)?.size) {
        const previous = surface.lastVisualFrame
        if (!previous || previous.viewId !== capturedTarget.viewId)
          throw new BotDomainError("stale_frame", "页面正在跳转，请等待新画面后操作")
        // Screenshot can itself wait for navigation. Keep showing the last observed
        // pixels, explicitly read-only, instead of blocking the surface's input tail.
        const pending: BotBrowserFrame = {
          ...previous,
          ...this.clientTarget(botId, client, taskRunId),
          humanInputPending: true
        }
        delete pending.humanInputLease
        delete pending.nativeSelect
        return pending
      }
      const image = await page.screenshot({
        type: "jpeg",
        quality: 70,
        timeout: 10_000
      })
      const size = page.viewportSize() ?? BOT_BROWSER_VIEWPORT
      const nativeSelect =
        surface.humanClient === client && surface.target.control === "human"
          ? await (surface.nativeSelect ??= new BotNativeSelectController()).capture(page)
          : undefined
      const frame: BotBrowserFrame = {
        ...(nativeSelect ? { nativeSelect } : {}),
        ...this.clientTarget(botId, client, taskRunId),
        frameSeq: ++surface.frameSeq,
        navigationEpoch,
        ...size,
        title: await page.title(),
        url: page.url(),
        image: `data:image/jpeg;base64,${image.toString("base64")}`,
        tabs: await Promise.all(
          [...surface.pages]
            .filter((item) => !item.isClosed())
            .map(async (item) => ({
              viewId: surface.pageViews.get(item)!,
              title: await item.title().catch(() => ""),
              url: item.url()
            }))
        )
      }
      try {
        client.throwIfAborted()
        this.assertSupervision(epoch)
        this.assertTarget(surface, capturedTarget)
        if ((this.navigationEpochs.get(page) ?? 0) !== navigationEpoch)
          throw new BotDomainError("stale_frame", "页面已变化，请刷新后操作")
      } catch (error) {
        if (nativeSelect) surface.nativeSelect?.invalidate()
        throw error
      }
      // A second viewer may watch without invalidating the controlling client's input ticket.
      if (surface.humanClient === client) {
        surface.lastVisualFrame = frame
        const navigationPending = Boolean(this.pendingNavigations.get(page)?.size)
        surface.lastFrame = navigationPending ? undefined : frame
        if (navigationPending) frame.humanInputPending = true
        if (surface.target.control === "human" && !this.pendingNavigations.get(page)?.size) {
          let lease = surface.humanInputLease
          if (
            !lease ||
            lease.client !== client ||
            lease.page !== page ||
            lease.navigationEpoch !== navigationEpoch ||
            lease.width !== size.width ||
            lease.height !== size.height
          ) {
            lease = {
              id: randomUUID(),
              client,
              page,
              navigationEpoch,
              ...size,
              nextSequence: 1,
              frames: new Map()
            }
            surface.humanInputLease = lease
          }
          lease.frames.set(frame.frameSeq, {
            frameSeq: frame.frameSeq,
            generation: frame.generation,
            controlEpoch: frame.controlEpoch,
            navigationEpoch,
            ...size,
            tabs: frame.tabs.map(({ viewId }) => ({ viewId })),
            ...(nativeSelect ? { nativeSelect: { token: nativeSelect.token } } : {})
          })
          // Keep source tickets, not JPEGs, for a bounded overlap of painted frames.
          if (lease.frames.size > BOT_HUMAN_INPUT_LIMIT)
            lease.frames.delete(lease.frames.keys().next().value!)
          frame.humanInputLease = { id: lease.id, nextSequence: lease.nextSequence }
        } else surface.humanInputLease = undefined
      }
      return frame
    })
  }

  async takeControl(
    expected: BotBrowserTarget,
    conversationId?: string,
    threadRootId?: string,
    client: BotComputerClient = HOST_COMPUTER_CLIENT,
    replaceHuman = false
  ): Promise<BotBrowserTarget> {
    client.throwIfAborted()
    this.assertSupervision()
    const epoch = this.observationEpoch
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    if (conversationId !== undefined) v.identifier(conversationId)
    if (threadRootId !== undefined) {
      v.identifier(threadRootId)
      if (!conversationId) throw new BotDomainError("thread_unavailable", "分支需要指定所属对话")
    }
    this.assertTarget(surface, expected)
    this.assertTaskOwner(expected.botId, expected.taskRunId, true)
    const transferring = surface.target.control === "human"
    if (
      surface.humanTransferPending ||
      surface.target.control === "handoff" ||
      (transferring && !replaceHuman)
    )
      throw new BotDomainError("computer_owned_elsewhere", "此浏览器已被接管，请明确确认转移控制权")
    // Stop queued Bot inputs immediately, then wait for the already dispatched action to settle.
    surface.target.control = transferring ? "human" : "handoff"
    surface.humanTransferPending = true
    surface.humanClient = undefined
    this.invalidateHumanFrame(surface)
    surface.target.controlEpoch++
    return this.serialize(surface, async () => {
      try {
        await this.persist(surface, true)
        if (!expected.taskRunId) await this.beforeHumanTransfer?.(expected.botId)
        this.assertTaskOwner(expected.botId, expected.taskRunId, true)
        client.throwIfAborted()
        this.assertSupervision(epoch)
        surface.humanClient = client
        surface.downloadConversationId = conversationId
        surface.downloadThreadRootId = threadRootId
      } finally {
        // Failure/disconnection leaves the surface suspended for explicit reclaim.
        surface.target.control = "human"
        surface.humanTransferPending = false
        this.invalidateHumanFrame(surface)
      }
      return { ...surface.target }
    })
  }

  async releaseControl(
    expected: BotBrowserTarget,
    client: BotComputerClient = HOST_COMPUTER_CLIENT
  ): Promise<BotBrowserTarget> {
    if (!expected.taskRunId && this.teachRecordingBot === expected.botId)
      throw new Error("请先保存或丢弃示范，再归还 Bot 控制权")
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    return this.serialize(surface, async () => {
      this.assertSupervision()
      this.assertTarget(surface, expected, "human")
      this.assertHumanClient(expected.botId, client, expected.taskRunId)
      // Persist and publish the handback without an await gap in which a new
      // transfer could leave a human-owned surface saved as Bot-controlled.
      this.persist(surface, false)
      surface.target.control = "bot"
      surface.observationRequired = true
      surface.humanClient = undefined
      surface.downloadConversationId = undefined
      surface.downloadThreadRootId = undefined
      surface.target.controlEpoch++
      this.invalidateHumanFrame(surface)
      return { ...surface.target }
    })
  }

  async humanInput(
    expected: BotBrowserTarget,
    input: BotHumanInput,
    client: BotComputerClient = HOST_COMPUTER_CLIENT
  ): Promise<void> {
    const surface = this.requireSurface(expected.botId, expected.taskRunId)
    this.assertSupervision()
    this.assertTarget(surface, expected, "human")
    this.assertHumanClient(expected.botId, client, expected.taskRunId)
    if (v.canonicalJson(input).length > 64_000)
      throw new BotDomainError("invalid_input", "人工输入内容过大")
    const characters = [input.text, input.key, input.url]
      .filter((value): value is string => typeof value === "string")
      .reduce((size, value) => size + value.length, 0)
    if (
      (surface.humanPendingInputs ?? 0) >= BOT_HUMAN_INPUT_LIMIT ||
      (surface.humanPendingCharacters ?? 0) + characters > BOT_HUMAN_INPUT_CHARACTERS
    )
      throw new BotDomainError("input_queue_full", "待发送输入已满，请等待后重试")
    const requestedLease = input.humanInputLease
    const lease = requestedLease ? surface.humanInputLease : undefined
    let sourceFrame: HumanInputFrame | undefined
    if (requestedLease) {
      v.record(requestedLease)
      const id = v.identifier(requestedLease.id)
      const sequence = v.integer(requestedLease.sequence, "输入序号", 1)
      sourceFrame = lease?.frames.get(v.integer(input.frameSeq, "来源画面", 1))
      if (
        !lease ||
        lease.id !== id ||
        lease.client !== client ||
        !sourceFrame ||
        sequence !== lease.nextSequence
      )
        throw new BotDomainError("stale_frame", "连续输入已失效，请查看新画面后操作")
      lease.nextSequence++ // Admission is synchronous; a duplicate never dispatches twice.
    }
    surface.humanPendingInputs = (surface.humanPendingInputs ?? 0) + 1
    surface.humanPendingCharacters = (surface.humanPendingCharacters ?? 0) + characters
    try {
      await this.serialize(surface, async () => {
        this.assertSupervision()
        const epoch = this.observationEpoch
        this.assertTarget(surface, expected, "human")
        this.assertHumanClient(expected.botId, client, expected.taskRunId)
        // Dismissal only revokes a matching capability. It performs no page input and
        // remains safe when a late polling frame was never painted before panel closure.
        if (input.kind === "select_dismiss") {
          const page = await this.currentPage(surface)
          await surface.nativeSelect?.dismiss(page, input.selectToken)
          surface.lastFrame = undefined
          return
        }
        const frame = sourceFrame ?? surface.lastFrame
        const requestedEpoch =
          input.navigationEpoch === undefined
            ? frame?.navigationEpoch
            : v.integer(input.navigationEpoch, "页面版本")
        if (
          !frame ||
          frame.frameSeq !== input.frameSeq ||
          frame.controlEpoch !== expected.controlEpoch ||
          frame.generation !== expected.generation ||
          requestedEpoch !== frame.navigationEpoch
        ) {
          throw new BotDomainError("stale_frame", "画面已过期，请刷新后操作")
        }
        const page = await this.currentPage(surface)
        const assertDocument = () => {
          if (
            frame.navigationEpoch !== (this.navigationEpochs.get(page) ?? 0) ||
            this.pendingNavigations.get(page)?.size
          )
            throw new BotDomainError("stale_frame", "页面已变化，请刷新后操作")
          if (lease) {
            const viewport = page.viewportSize() ?? BOT_BROWSER_VIEWPORT
            if (
              surface.humanInputLease !== lease ||
              lease.page !== page ||
              this.pendingNavigations.get(page)?.size ||
              lease.width !== viewport.width ||
              lease.height !== viewport.height
            )
              throw new BotDomainError("stale_frame", "页面或尺寸已变化，请查看新画面后操作")
          }
        }
        this.assertSupervision(epoch)
        this.assertTarget(surface, expected, "human")
        this.assertHumanClient(expected.botId, client, expected.taskRunId)
        assertDocument()
        surface.lastFrame = undefined // One ticket cannot authorize repeated page input.
        if (input.kind !== "select_option") surface.nativeSelect?.reset()
        let selection: BotNativeSelectObservation | undefined
        try {
          if (!expected.taskRunId && input.kind !== "select_option")
            await this.humanObserver?.(expected.botId, page, input, "before")
          this.assertSupervision(epoch)
          this.assertTarget(surface, expected, "human")
          this.assertHumanClient(expected.botId, client, expected.taskRunId)
          assertDocument()
          switch (input.kind) {
            case "tab_select":
            case "tab_close":
            case "tab_new": {
              surface.humanInputLease = undefined
              const viewId = input.kind === "tab_new" ? null : v.identifier(input.viewId)
              if (viewId && !frame.tabs.some((tab) => tab.viewId === viewId))
                throw new BotDomainError("wrong_target", "标签页不属于当前 Bot 画面")
              const index = viewId
                ? [...surface.pages].findIndex(
                    (item) => surface.pageTargets.get(item) === surface.state.views[viewId]
                  )
                : -1
              if (viewId && index < 0)
                throw new BotDomainError("target_closed", "标签页已关闭，请刷新画面")
              const result = await executeGrokBrowserAction(
                {
                  op: "tabs",
                  action:
                    input.kind === "tab_new"
                      ? "new"
                      : input.kind === "tab_select"
                        ? "select"
                        : "close",
                  ...(index >= 0 ? { index } : {})
                },
                this.scopedContext(surface),
                surface.state
              )
              if (result.viewId)
                surface.target.viewId =
                  (result.page && surface.pageViews.get(result.page)) || result.viewId
              if (!surface.state.views[surface.target.viewId] && surface.pages.size)
                surface.target.viewId = await this.registerPage(surface, [...surface.pages][0])
              surface.state.lastViewId = surface.target.viewId
              surface.target.generation = randomUUID()
              if (surface.crashedTabs.has(surface.target.viewId)) surface.observationRequired = true
              break
            }
            case "navigate": {
              surface.humanInputLease = undefined
              const action = this.validateAction({
                op: "navigate",
                url: input.url
              })
              await page
                .goto(String(action.url), {
                  waitUntil: "domcontentloaded",
                  timeout: 30_000
                })
                .catch((error) => {
                  if (
                    !String(error).includes("ERR_ABORTED") &&
                    !String(error).includes("Download is starting")
                  )
                    throw error
                })
              this.assertTarget(surface, expected, "human")
              this.assertHumanClient(expected.botId, client, expected.taskRunId)
              surface.crashedTabs.delete(expected.viewId)
              break
            }
            case "select_option": {
              if (!surface.nativeSelect || frame.nativeSelect?.token !== input.selectToken)
                throw new BotDomainError("stale_frame", "选项已变化，请重新点击下拉框")
              const guard = () => {
                client.throwIfAborted()
                this.assertSupervision(epoch)
                this.assertTarget(surface, expected, "human")
                this.assertHumanClient(expected.botId, client, expected.taskRunId)
                assertDocument()
              }
              selection = await surface.nativeSelect.select(
                page,
                input.selectToken,
                input.optionIndices,
                { prepare: async () => guard(), assert: guard },
                async (details) => {
                  selection = details
                  if (!expected.taskRunId)
                    await this.humanObserver?.(expected.botId, page, input, "before", details)
                }
              )
              break
            }
            case "click":
              await page.mouse.click(
                v.integer(input.x, "横坐标", 0, frame.width - 1),
                v.integer(input.y, "纵坐标", 0, frame.height - 1)
              )
              break
            case "text":
              await page.keyboard.insertText(v.text(input.text, "输入内容", 16_000))
              break
            case "key":
              await pressGrokBrowserKey(
                page,
                v.text(input.key, "按键", 100),
                this.stopKeyboardCleanup
              )
              break
            case "scroll":
              if (
                typeof input.deltaY !== "number" ||
                !Number.isFinite(input.deltaY) ||
                Math.abs(input.deltaY) > 3000
              )
                throw new BotDomainError("invalid_input", "滚动距离不正确")
              await page.mouse.wheel(0, input.deltaY)
              break
            default:
              throw new BotDomainError("invalid_input", "未知人工操作")
          }
          if (!["tab_select", "tab_close", "tab_new"].includes(input.kind)) {
            this.assertTarget(surface, expected, "human")
            this.assertHumanClient(expected.botId, client, expected.taskRunId)
          }
          await this.persist(surface)
          if (!expected.taskRunId)
            await this.humanObserver?.(
              expected.botId,
              await this.currentPage(surface),
              input,
              "after",
              selection
            )
        } catch (error) {
          if (!expected.taskRunId)
            await this.humanObserver?.(expected.botId, page, input, "unconfirmed", selection).catch(
              () => {}
            )
          throw error
        }
      })
    } catch (error) {
      // The effect may already have happened. Retire subsequent intentions, never replay it.
      if (lease && surface.humanInputLease === lease) surface.humanInputLease = undefined
      throw error
    } finally {
      surface.humanPendingInputs!--
      surface.humanPendingCharacters! -= characters
    }
  }

  /** No new operation after task retirement; existing issued receipts are joined
   * by the workflow runner before this bounded read-only viewing window starts. */
  retireTask(botId: string, taskRunId: string): void {
    const surface = this.surfaces.get(this.ownerKey(botId, taskRunId))
    const until = this.persistence?.retireTaskBrowserSession?.(botId, taskRunId, Boolean(surface))
    if (until === undefined || until === null) return
    if (!surface || surface.retireTimer) return
    const now = this.persistence?.now?.() ?? Date.now()
    if (!Number.isFinite(now)) return // Unknown time does not authorize automatic disposal.
    surface.retired = true
    surface.retireTimer = setTimeout(
      () => {
        surface.retireTimer = undefined
        void this.releaseSurface(botId, taskRunId, true).catch(() => {})
      },
      Math.max(0, until - now)
    )
    surface.retireTimer.unref()
  }

  releaseBot(botId: string): Promise<void> {
    v.identifier(botId)
    return Promise.all(
      [...this.surfaces.values()]
        .filter((surface) => surface.target.botId === botId)
        .map((surface) => this.releaseSurface(botId, surface.target.taskRunId))
    ).then(() => {})
  }

  private releaseSurface(botId: string, taskRunId?: string, retirement = false): Promise<void> {
    const surface = this.surfaces.get(this.ownerKey(botId, taskRunId))
    if (!surface) return Promise.resolve()
    if (surface.closing) return surface.closing
    // Fence queued actions immediately. Closing pages interrupts already issued
    // CDP calls; late page registrations check this same fence and close themselves.
    if (surface.retireTimer) clearTimeout(surface.retireTimer)
    surface.closed = true
    this.invalidateHumanFrame(surface)
    surface.lastVisualFrame = undefined
    surface.humanClient = undefined
    const closing = (async () => {
      const results = await Promise.allSettled([
        surface.nativeSelect?.close(),
        taskRunId ? Promise.resolve() : this.secrets.releaseBot(botId),
        this.downloads.releaseOwner(this.ownerKey(botId, taskRunId)),
        ...[...new Set([...surface.pages, ...surface.registering.keys()])].map((page) =>
          page.close()
        )
      ])
      await Promise.allSettled(surface.registering.values())
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
      if (retirement && taskRunId && surface.retired)
        this.persistence?.releaseTaskBrowserSession?.(botId, taskRunId)
      if (this.surfaces.get(this.ownerKey(botId, taskRunId)) === surface)
        this.surfaces.delete(this.ownerKey(botId, taskRunId))
    })().finally(() => {
      surface.closing = undefined
    })
    surface.closing = closing
    return closing
  }

  private startClose(contextClosed: boolean): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    // Set this before `context.close()`: Playwright may emit `close`
    // synchronously from that call, and the Provider must distinguish that
    // expected event from a browser crash while an idle cookie read is pending.
    if (!contextClosed) this.contextCloseRequestedByBroker = true
    for (const lease of this.viewers.values()) lease.dispose()
    for (const surface of this.surfaces.values())
      if (surface.retireTimer) clearTimeout(surface.retireTimer)
    // Publish the shared close promise before context.close can synchronously
    // emit its event. That event must join this shutdown rather than start a
    // second cleanup pass over the same BrowserContext resources.
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const closing = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    this.closing = closing
    void this.closeResources(contextClosed).then(resolve, reject)
    return closing
  }

  private async closeResources(contextClosed: boolean): Promise<void> {
    // Close the transport first to interrupt pending page/CDP operations. Waiting
    // for the serial queues first can deadlock on a page promise with no timeout.
    for (const surface of this.surfaces.values()) this.invalidateHumanFrame(surface)
    let failure: unknown
    const settle = async (operation: Promise<unknown>): Promise<void> => {
      try {
        await operation
      } catch (error) {
        failure ??= error
      }
    }
    try {
      if (!contextClosed) await settle(this.context.close())
      await Promise.allSettled(
        [...this.surfaces.values()].map((surface) => surface.nativeSelect?.close())
      )
      await settle(this.secrets.close())
      await Promise.allSettled([...this.surfaces.values()].map((surface) => surface.tail))
      await settle(this.downloads.close())
    } finally {
      this.surfaces.clear()
    }
    if (failure) throw failure
  }

  /**
   * Called when Chromium has already closed this context outside the ordinary
   * Broker shutdown path. It only releases Host-owned resources and never
   * claims to close, restart or otherwise replace the physical browser.
   */
  onContextClosed(): Promise<void> {
    return this.startClose(true)
  }

  close(): Promise<void> {
    return this.startClose(false)
  }
}
