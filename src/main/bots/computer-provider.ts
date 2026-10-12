import { chromium, type Browser } from "playwright"
import { performance } from "node:perf_hooks"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  BotBrowserBroker,
  type BotBrowserPersistence,
  type BotBrowserSessionCookie
} from "./browser-broker"
import type { BotBrowserDownloadReceiver } from "./browser-downloads"
import { BOT_BROWSER_VIEWPORT, type BotComputerStatus } from "../../shared/bot-computer"

export interface BotComputerIdlePolicy {
  /** Trusted Host configuration only. No renderer/tool changes this policy. */
  idleAfterMs?: number
  viewerLeaseMs?: number
}
const DEFAULT_IDLE_AFTER_MS = 5 * 60_000
const DEFAULT_VIEWER_LEASE_MS = 15_000

/** Chromium 556160935: persistent download history can crash M152–M154.
 * Refuse work before pages/receivers are published; never replay a download or
 * erase a login profile to work around a browser-engine regression. */
class BotBrowserCompatibilityError extends Error {
  constructor(channel: string) {
    super(
      `${channel === "msedge" ? "Microsoft Edge" : "Google Chrome"} 152–154 存在下载稳定性问题，请更新至 155 或更高版本后重试`
    )
  }
}

/** Native Chromium process. Uses a dedicated persistent profile, never the user's normal browser profile. */
export class LocalBotComputerProvider {
  private opening?: Promise<BotBrowserBroker>
  private broker?: BotBrowserBroker
  private closing?: Promise<void>
  private forceClosing?: Promise<void>
  /** Cleanup after Chromium closed outside the Provider's own close path. */
  private externalCleanup?: Promise<void>
  /** Bound to the active Chromium context; reset only before a replacement launches. */
  private externalContextCloseObserved = false
  private keyboardStop?: { browser: Browser; promise: Promise<void> }
  private disposed = false
  private closeEpoch = 0
  private sessionCookies: BotBrowserSessionCookie[] = []
  private closeFailure = false
  private idleTimer?: ReturnType<typeof setTimeout>
  private idleGuard?: () => boolean
  private supervisionGuard?: () => void
  private otherComputerGuard?: (botId: string, taskRunId?: string) => void
  private lastActivityAt = performance.now()
  private observeAfterWake = false
  private readonly idleAfterMs: number
  private readonly viewerLeaseMs: number
  private failed = false
  private version: string | null = null
  private startedAt: number | null = null
  private attemptId: string | null = null
  persistence?: BotBrowserPersistence
  humanDownloadReceiver?: (
    botId: string,
    conversationId?: string,
    threadRootId?: string,
    taskRunId?: string
  ) => BotBrowserDownloadReceiver
  constructor(
    private readonly profile: string,
    private readonly channel = process.platform === "win32" ? "msedge" : "chrome",
    idlePolicy: BotComputerIdlePolicy = {}
  ) {
    this.idleAfterMs = idlePolicy.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS
    this.viewerLeaseMs = idlePolicy.viewerLeaseMs ?? DEFAULT_VIEWER_LEASE_MS
    if (
      ![this.idleAfterMs, this.viewerLeaseMs].every(
        (value) => Number.isSafeInteger(value) && value >= 25 && value <= 86_400_000
      )
    )
      throw new Error("Invalid Bot computer idle policy")
  }

  /** A synchronous Host fence; neither a terminal task nor an OS lock alone proves quiescence. */
  bindIdleGuard(guard: () => boolean): void {
    if (this.idleGuard) throw new Error("Bot computer idle guard already bound")
    this.idleGuard = guard
  }

  /** Trusted Host admission, separate from UI visibility or OS screen lock. */
  bindSupervisionGuard(guard: () => void): void {
    if (this.supervisionGuard) throw new Error("Bot computer supervision guard already bound")
    this.supervisionGuard = guard
  }
  bindOtherComputerGuard(guard: (botId: string, taskRunId?: string) => void): void {
    if (this.otherComputerGuard) throw new Error("Bot computer control guard already bound")
    this.otherComputerGuard = guard
  }
  controlHeld(botId: string): boolean {
    return this.broker
      ? this.broker.controlHeld(botId)
      : Boolean(this.persistence?.loadBrowserSession(botId)?.humanHeld)
  }

  /** No launch/close or control handback: discard only unobserved authority. */
  invalidateObservations(): void {
    this.observeAfterWake = true
    this.broker?.invalidateObservations()
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.disposed || !this.broker || this.closing || this.closeFailure) {
      this.idleTimer = undefined
      return
    }
    const activity = Math.max(this.lastActivityAt, this.broker.lastActivityAt)
    const remaining = Math.max(25, this.idleAfterMs - (performance.now() - activity))
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.idleTick()
    }, remaining)
    this.idleTimer.unref()
  }

  private idleTick(): void {
    const broker = this.broker
    if (!broker || this.closing) return
    const now = performance.now()
    if (now - Math.max(this.lastActivityAt, broker.lastActivityAt) < this.idleAfterMs) {
      this.armIdle()
      return
    }
    try {
      if ((this.idleGuard && !this.idleGuard()) || broker.idleBlockedReason) {
        this.lastActivityAt = now
        this.armIdle()
        return
      }
      // The broker saves every owned tab, then fences admission synchronously.
      // Its actual close follows only after zero queued/in-flight operations.
      const sleep = broker.tryIdleClose(() => !this.idleGuard || this.idleGuard())
      if (!sleep) {
        this.lastActivityAt = now
        this.armIdle()
        return
      }
      const closing = sleep
        .then((result) => {
          if (result.closed && !this.forceClosing) {
            this.observeAfterWake = true
            this.sessionCookies = result.sessionCookies ?? []
          } else this.lastActivityAt = performance.now()
        })
        .catch((error) => {
          // A native context can disappear while `tryIdleClose()` awaits its
          // cookie escrow.  Its close listener has already fenced and drained
          // the Broker; do not turn that recoverable external close into a
          // permanent "physical close unconfirmed" failure.
          if (broker.isClosed && !this.forceClosing && !this.externalContextCloseObserved) {
            this.failed = true
            this.closeFailure = true
            throw error
          } else this.lastActivityAt = performance.now()
        })
        .finally(() => {
          if (this.closing === closing) this.closing = undefined
          this.armIdle()
        })
      this.closing = closing
      // The transition is also awaited by get()/close(); a background rejection
      // must not become an unhandled process error or repeat physical closure.
      void closing.catch(() => {})
    } catch {
      // A failed durable save must keep the live browser and retry at bounded cadence.
      this.lastActivityAt = now
      this.armIdle()
    }
  }
  get restartBlockedReason(): string | null {
    return this.broker?.restartBlockedReason ?? null
  }
  status(): BotComputerStatus {
    return {
      state: this.closing
        ? "stopping"
        : this.closeFailure
          ? "failed"
          : this.broker
            ? "ready"
            : this.opening
              ? "starting"
              : this.failed
                ? "failed"
                : "stopped",
      browser: this.channel,
      version: this.version,
      startedAt: this.startedAt,
      attemptId: this.attemptId
    }
  }
  get(): Promise<BotBrowserBroker> {
    try {
      this.supervisionGuard?.()
    } catch (error) {
      return Promise.reject(error)
    }
    this.lastActivityAt = performance.now()
    if (this.closeFailure)
      return Promise.reject(new Error("浏览器关闭未确认，请重启 Bot 后台后再恢复电脑"))
    if (this.disposed) return Promise.reject(new Error("Bot 浏览器服务已关闭"))
    if (this.forceClosing) return Promise.reject(new Error("Bot 浏览器正在关闭"))
    if (this.externalCleanup) {
      const cleanup = this.externalCleanup
      // A replacement profile must never start while the old Broker still owns
      // download state, secret handles or task tails after an external close.
      return cleanup.then(
        () => this.get(),
        () => {
          this.closeFailure = true
          throw new Error("浏览器关闭后的资源清理未确认，请重启 Bot 后台后再恢复电脑")
        }
      )
    }
    if (this.closing) {
      const epoch = this.closeEpoch
      return this.closing.then(() => {
        if (epoch !== this.closeEpoch) throw new Error("Bot 浏览器已关闭，请重新打开")
        return this.get()
      })
    }
    if (this.opening) return this.opening
    this.failed = false
    this.externalContextCloseObserved = false
    this.keyboardStop = undefined
    this.attemptId = randomUUID()
    const opening = chromium
      .launchPersistentContext(this.profile, {
        channel: this.channel,
        // Browsing untrusted pages uses Chromium's own process sandbox.
        // Playwright otherwise defaults to --no-sandbox. Never retry without it.
        chromiumSandbox: true,
        // Backport upstream Playwright chromiumSwitches.ts: avoid updater children
        // retaining the controlled browser's process pipes during shutdown.
        args: ["--disable-updater-scheduler"],
        headless: true,
        viewport: { ...BOT_BROWSER_VIEWPORT },
        acceptDownloads: true
      })
      .then(async (context) => {
        let initialized = false
        let contextClosed = false
        let broker: BotBrowserBroker | undefined
        context.once("close", () => {
          contextClosed = true
          // Do not infer intent from Provider state. Idle shutdown deliberately
          // sets `closing` before the async cookie read completes, so an OS
          // close in that window used to bypass the cleanup/reopen fence.
          // Only the Broker can attest that it requested this physical close.
          const external = !broker?.contextCloseRequested
          if (broker && external) {
            this.externalContextCloseObserved = true
            const cleanup = broker.onContextClosed()
            this.externalCleanup = cleanup
            void cleanup.then(
              () => {
                if (this.externalCleanup === cleanup) this.externalCleanup = undefined
              },
              () => {
                if (this.externalCleanup === cleanup) this.closeFailure = true
              }
            )
          }
          // Hold the opening promise until failed setup has finished releasing
          // the profile. A new caller must not race a still-closing process.
          if (initialized && this.opening === opening) {
            this.failed = external
            if (this.failed) this.observeAfterWake = true
            this.opening = undefined
            this.broker = undefined
            this.version = null
            this.startedAt = null
          }
        })
        try {
          const version = context.browser()?.version() ?? ""
          const major = Number(version.split(".")[0])
          if (major >= 152 && major <= 154) throw new BotBrowserCompatibilityError(this.channel)
          await context.clearPermissions()
          if (this.sessionCookies.length) await context.addCookies(this.sessionCookies)
          // The blank startup tab is not owned by a Bot and must never be adopted by URL.
          for (const page of context.pages()) await page.close()
          if (contextClosed || this.disposed)
            throw new Error("Browser closed during initialization")
          broker = new BotBrowserBroker(
            context,
            this.persistence,
            join(this.profile, "bot-downloads"),
            {
              requireObservation: this.observeAfterWake,
              viewerLeaseMs: this.viewerLeaseMs,
              assertSupervision: () => this.supervisionGuard?.(),
              assertBotInput: (botId, taskRunId) => this.otherComputerGuard?.(botId, taskRunId),
              stopKeyboardCleanup: (browser) => this.stopKeyboardCleanup(browser, broker!)
            }
          )
          broker.humanDownloadReceiver = this.humanDownloadReceiver
          this.version = context.browser()?.version() ?? null
          this.startedAt = Date.now()
          this.broker = broker
          initialized = true
          this.sessionCookies = []
          this.armIdle()
          return broker
        } catch (error) {
          // A browser can launch successfully but fail during setup. Release its
          // profile/process before permitting another attempt.
          try {
            await context.close()
          } catch (closeError) {
            this.failed = true
            this.closeFailure = true
            throw closeError
          }
          throw error
        }
      })
      .catch((error) => {
        // close events may already have cleared opening during failed setup.
        if (!this.opening || this.opening === opening) {
          this.opening = undefined
          this.broker = undefined
          this.failed = true
          this.version = null
          this.startedAt = null
        }
        if (error instanceof BotBrowserCompatibilityError) throw error
        throw new Error(
          `Bot 浏览器无法启动，请确认已安装 ${this.channel === "msedge" ? "Microsoft Edge" : "Google Chrome"}，且 Bot 浏览器目录未被其他进程占用`
        )
      })
    this.opening = opening
    return opening
  }
  existing(): Promise<BotBrowserBroker | undefined> {
    if (this.disposed || this.closing || this.externalCleanup) return Promise.resolve(undefined)
    return this.opening?.catch(() => undefined) ?? Promise.resolve(undefined)
  }

  async retireTask(botId: string, runId: string): Promise<void> {
    // Never launch a browser just to release a task surface.
    const broker = await this.opening?.catch(() => undefined)
    if (broker) broker.retireTask(botId, runId)
    else this.persistence?.retireTaskBrowserSession?.(botId, runId)
  }

  async releaseBot(botId: string): Promise<void> {
    // Deleting a Bot must not launch a browser. An existing launch may still
    // be opening its profile; release its target once that attempt settles.
    const broker = await this.opening?.catch(() => undefined)
    await broker?.releaseBot(botId)
  }
  private stopKeyboardCleanup(browser: Browser, broker: BotBrowserBroker): Promise<void> {
    if (this.keyboardStop?.browser === browser) return this.keyboardStop.promise
    const opening = this.opening
    this.closeEpoch++
    this.observeAfterWake = true
    this.failed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const stopping = Promise.resolve()
      .then(() => browser.close())
      .then(() => {
        if (browser.isConnected()) throw new Error("浏览器关闭未确认")
      })
      .catch((error) => {
        this.closeFailure = true
        throw error
      })
    this.keyboardStop = { browser, promise: stopping }
    if (!this.forceClosing) {
      // The input tail joins only stopping, never this drain which includes it.
      // get/close remain fenced even if the context emits close before this ends.
      const closing = stopping
        .then(() => broker.close())
        .catch((error) => {
          this.closeFailure = true
          throw error
        })
        .finally(() => {
          if (this.opening === opening) this.opening = undefined
          if (this.broker === broker) this.broker = undefined
          if (this.forceClosing === closing) this.forceClosing = undefined
          if (this.closing === closing) this.closing = undefined
          this.failed = true
        })
      this.forceClosing = closing
      this.closing = closing
      void closing.catch(() => {})
    }
    return stopping
  }

  /** Ends this Host-owned lifetime. Unlike a manual close, later admission is revoked. */
  shutdown(): Promise<void> {
    this.disposed = true
    return this.close()
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.forceClosing) return this.forceClosing
    if (this.closeFailure) throw new Error("浏览器关闭未确认")
    if (this.externalCleanup) {
      const cleanup = this.externalCleanup
      // Fence get() immediately while the externally closed Broker drains. A
      // later callback must not slip through and recreate the same persistent
      // profile between cleanup completion and this caller's close result.
      const closing = cleanup
        .then(
          () => {
            this.sessionCookies = []
          },
          (error) => {
            this.closeFailure = true
            throw error
          }
        )
        .finally(() => {
          if (this.forceClosing === closing) this.forceClosing = undefined
          if (this.closing === closing) this.closing = undefined
          if (this.disposed && !this.closeFailure) this.failed = false
        })
      this.forceClosing = closing
      this.closing = closing
      return closing
    }
    this.closeEpoch++
    const opening = this.opening,
      idle = this.closing
    if (!opening && !idle) {
      this.sessionCookies = []
      return
    }
    // Shutdown closes the live transport immediately, including a pending idle
    // cookie read. Waiting for idle preparation first could leave Chromium alive.
    const closing = (async () => {
      try {
        await opening?.then(
          (broker) =>
            broker.close().catch((error) => {
              this.failed = true
              this.closeFailure = true
              throw error
            }),
          () => {
            // A failed launch/setup releases its unowned context before rejecting.
            // Preserve failed physical closure instead of claiming shutdown completed.
            if (this.closeFailure) throw new Error("浏览器关闭未确认")
          }
        )
      } finally {
        await idle?.catch(() => {})
        this.sessionCookies = []
      }
    })().finally(() => {
      if (this.opening === opening) this.opening = undefined
      if (this.closing === closing) this.closing = undefined
      if (this.forceClosing === closing) this.forceClosing = undefined
      if (this.disposed && !this.closeFailure) this.failed = false
    })
    this.forceClosing = closing
    this.closing = closing
    return closing
  }
}
