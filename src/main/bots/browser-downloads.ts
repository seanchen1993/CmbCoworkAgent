import { mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BrowserContext, CDPSession, Page } from "playwright"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { BOT_FILE_BYTES } from "../../shared/bot-files"

export interface BotBrowserDownload {
  guid: string
  bytes: Buffer
  suggestedName: string
}
export interface BotBrowserDownloadReceiver {
  /** Concurrency accounting identity, never inferred from a URL or filename. */
  owner: string
  check(): void
  started?(guid: string): void
  complete(file: BotBrowserDownload, assertActive: () => void): Promise<void>
  failed(message: string, guid?: string): void
}
type Source = {
  claim?: () => BotBrowserDownloadReceiver | undefined
  scope?: Scope
}
type Scope = {
  active: boolean
  receiver: BotBrowserDownloadReceiver
  tasks: Set<Promise<void>>
  limit?: number
  stop?: (error: Error) => void
  limitReported?: boolean
}
type Started = { frameId: string; guid: string; suggestedFilename: string }
type Progress = { guid: string; totalBytes: number; receivedBytes: number; state: string }
type DirectResponse = {
  requestId: string
  frameId: string
  responseStatusCode?: number
  responseStatusText?: string
  responseHeaders?: { name: string; value: string }[]
  request: { url: string }
}
type Job = {
  owner: string
  scope?: Scope
  stop(error: Error): void
  progress(event: Progress): void
  done: Promise<void>
}

/** One Chromium download router for explicit exports, normal clicks and human input.
 * Ownership comes from exact frame/target identities (including popup openers), never URLs.
 * Explicit captures override automatic collection, so each GUID is delivered once. */
export class BotBrowserDownloads {
  private initializing?: Promise<CDPSession>
  private browserSession?: CDPSession
  private closing?: Promise<void>
  private directory?: string
  private closed = false
  private readonly frames = new Map<string, Source>()
  private readonly targets = new Map<string, Source>()
  private readonly pages = new Map<Page, Promise<Source>>()
  private readonly pageCleanups = new Map<CDPSession, () => Promise<void>>()
  private readonly jobs = new Map<string, Job>()
  private readonly scopes = new Set<Scope>()
  constructor(
    private readonly context: BrowserContext,
    private readonly directoryRoot?: string
  ) {}

  get busy(): boolean {
    return this.jobs.size > 0 || this.scopes.size > 0
  }

  async ready(): Promise<void> {
    await this.getSession()
  }

  private getSession(): Promise<CDPSession> {
    if (this.closed) return Promise.reject(new Error("下载服务已关闭"))
    if (this.initializing) return this.initializing
    const opening = (async () => {
      const browser = this.context.browser()
      if (!browser) throw new Error("当前浏览器不支持受限文件下载")
      const session = await browser.newBrowserCDPSession()
      let directory: string | undefined
      const checkOpen = () => {
        if (this.closed) throw new Error("下载服务已关闭")
      }
      const active = () => !this.closed && this.browserSession === session
      try {
        checkOpen()
        this.browserSession = session
        if (this.directoryRoot) {
          // Chromium's profile lock is held by the provider. Touch only our staging folders.
          await mkdir(this.directoryRoot, { recursive: true, mode: 0o700 })
          for (const item of await readdir(this.directoryRoot, { withFileTypes: true }))
            if (item.isDirectory() && /^session-[a-zA-Z0-9]{6}$/.test(item.name))
              await rm(join(this.directoryRoot, item.name), { recursive: true, force: true })
        }
        directory = await mkdtemp(
          this.directoryRoot
            ? join(this.directoryRoot, "session-")
            : join(tmpdir(), "cmb-bot-download-")
        )
        this.directory = directory
        checkOpen()
        // targetCreated precedes the first navigation/download, unlike Playwright's popup
        // event which may arrive after an attachment-only popup has already closed.
        session.on("Target.targetCreated", ({ targetInfo }) => {
          if (!active() || targetInfo.type !== "page") return
          const parent =
            this.targets.get(targetInfo.openerId ?? "") ??
            this.frames.get(targetInfo.openerFrameId ?? "")
          if (!parent) return
          const source: Source = { scope: this.scope(parent), claim: parent.claim }
          this.targets.set(targetInfo.targetId, source)
          this.frames.set(targetInfo.targetId, source)
        })
        session.on("Target.targetDestroyed", ({ targetId }) => {
          if (!active()) return
          const source = this.targets.get(targetId)
          this.targets.delete(targetId)
          if (this.frames.get(targetId) === source) this.frames.delete(targetId)
        })
        session.on("Browser.downloadWillBegin", (event: Started) => {
          if (active()) this.start(session, event)
        })
        session.on("Browser.downloadProgress", (event: Progress) => {
          if (!active()) return
          const job = this.jobs.get(event.guid)
          if (job) job.progress(event)
          else if (event.state === "completed" || event.state === "canceled")
            void this.remove(event.guid)
        })
        await session.send("Target.setDiscoverTargets", { discover: true })
        checkOpen()
        await session.send("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: this.directory,
          eventsEnabled: true
        })
        checkOpen()
        return session
      } catch (error) {
        if (this.browserSession === session) this.browserSession = undefined
        await session.detach().catch(() => {})
        if (directory) {
          try {
            await rm(directory, { recursive: true, force: true })
            if (this.directory === directory) this.directory = undefined
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "下载初始化失败，临时目录清理未完成")
          }
        }
        throw error
      }
    })()
    this.initializing = opening
    // All callers share one attempt. A failed attachment/configuration must not
    // poison future explicit retries or let an old completion clear a newer one.
    void opening.catch(() => {
      if (this.initializing === opening) this.initializing = undefined
    })
    return opening
  }

  async watch(page: Page, claim?: () => BotBrowserDownloadReceiver | undefined): Promise<Source> {
    if (this.closed) throw new Error("下载服务已关闭")
    let pending = this.pages.get(page)
    if (!pending) {
      pending = this.attach(page)
      this.pages.set(page, pending)
      void pending.catch(() => {
        if (this.pages.get(page) === pending) this.pages.delete(page)
      })
    }
    const source = await pending
    if (this.closed) throw new Error("下载服务已关闭")
    if (claim) source.claim = claim
    return source
  }

  private async attach(page: Page): Promise<Source> {
    await this.ready()
    const session = await this.context.newCDPSession(page)
    const owned = new Set<string>()
    let source: Source | undefined
    let targetId: string | undefined
    let released = false
    let detaching: Promise<void> | undefined
    const checkOpen = () => {
      if (this.closed) throw new Error("下载服务已关闭")
      if (released || page.isClosed()) throw new Error("下载页面已关闭")
    }
    const own = (id: string) => {
      if (released || this.closed) return
      owned.add(id)
      this.frames.set(id, source!)
    }
    const frameAttached = ({ frameId }: { frameId: string }) => own(frameId)
    const frameNavigated = ({ frame }: { frame: { id: string } }) => own(frame.id)
    const frameDetached = ({ frameId, reason }: { frameId: string; reason: string }) => {
      // OOPIF swaps retain the frame identity and its ownership.
      if (reason === "swap") return
      owned.delete(frameId)
      if (this.frames.get(frameId) === source) this.frames.delete(frameId)
    }
    const cleanup = () => {
      if (detaching) return detaching
      released = true
      page.off("close", onPageClose)
      session.off("Page.frameAttached", frameAttached)
      session.off("Page.frameNavigated", frameNavigated)
      session.off("Page.frameDetached", frameDetached)
      for (const id of owned) if (this.frames.get(id) === source) this.frames.delete(id)
      owned.clear()
      if (targetId && this.targets.get(targetId) === source) this.targets.delete(targetId)
      this.pages.delete(page)
      detaching = session
        .detach()
        .catch(() => {})
        .finally(() => this.pageCleanups.delete(session))
      return detaching
    }
    const onPageClose = () => {
      void cleanup()
    }
    this.pageCleanups.set(session, cleanup)
    try {
      checkOpen()
      const { targetInfo } = await session.send("Target.getTargetInfo")
      checkOpen()
      targetId = targetInfo.targetId
      source = this.targets.get(targetInfo.targetId) ?? {}
      this.targets.set(targetInfo.targetId, source)
      session.on("Page.frameAttached", frameAttached)
      session.on("Page.frameNavigated", frameNavigated)
      session.on("Page.frameDetached", frameDetached)
      page.once("close", onPageClose)
      await session.send("Page.enable")
      checkOpen()
      const { frameTree } = await session.send("Page.getFrameTree")
      checkOpen()
      type Tree = { frame: { id: string }; childFrames?: Tree[] }
      const adopt = (tree: Tree): void => {
        own(tree.frame.id)
        tree.childFrames?.forEach(adopt)
      }
      adopt(frameTree)
      return source
    } catch (error) {
      await cleanup()
      throw error
    }
  }

  private scope(source: Source): Scope | undefined {
    return source.scope?.active ? source.scope : undefined
  }

  async inheritAction(page: Page, opener: Page): Promise<void> {
    const source = await this.watch(page),
      parent = await this.watch(opener)
    source.scope = this.scope(parent)
  }

  private start(session: CDPSession, event: Started): void {
    const source = this.frames.get(event.frameId)
    const scope = source && this.scope(source)
    if (scope?.limit !== undefined && scope.tasks.size >= scope.limit) {
      void session.send("Browser.cancelDownload", { guid: event.guid }).catch(() => {})
      if (scope.limit > 1 && !scope.limitReported) {
        scope.limitReported = true
        try {
          scope.receiver.failed("同时下载的文件过多，请等待当前下载完成")
        } catch {
          /* deleted destination */
        }
      }
      return
    }
    let receiver: BotBrowserDownloadReceiver | undefined
    try {
      if (this.closed) throw new Error("下载服务已关闭")
      receiver = scope?.receiver ?? source?.claim?.()
      if (!receiver) throw new Error("下载页面没有有效归属")
      receiver.check()
      if (!/^[a-f0-9-]{36}$/i.test(event.guid) || this.jobs.has(event.guid))
        throw new Error("下载身份无效")
      if (
        this.jobs.size >= 8 ||
        [...this.jobs.values()].filter((job) => job.owner === receiver!.owner).length >= 4
      )
        throw new Error("同时下载的文件过多，请等待当前下载完成")
      receiver.started?.(event.guid)
    } catch (error) {
      void session.send("Browser.cancelDownload", { guid: event.guid }).catch(() => {})
      try {
        receiver?.failed(error instanceof Error ? error.message : "下载未获授权")
      } catch {
        /* destination may have been deleted */
      }
      return
    }
    const sink = receiver
    let failure: Error | undefined
    let completed = false
    let finish!: () => void
    let reject!: (error: Error) => void
    const received = new Promise<void>((resolve, fail) => {
      finish = resolve
      reject = fail
    })
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      reject(error)
      if (!completed)
        void session.send("Browser.cancelDownload", { guid: event.guid }).catch(() => {})
    }
    const check = () => {
      if (failure) throw failure
      if (this.closed || (scope && !scope.active)) throw new Error("下载操作已结束")
      sink.check()
    }
    const ticker = setInterval(() => {
      try {
        check()
      } catch (error) {
        stop(error instanceof Error ? error : new Error("下载授权已失效"))
      }
    }, 100)
    const timeout = setTimeout(() => stop(new Error("文件下载超过 30 秒，请稍后重试")), 30_000)
    const done = (async () => {
      try {
        await received
        check()
        const handle = await openStableFileHandle(
          this.directory!,
          join(this.directory!, event.guid)
        )
        try {
          const bytes = await readStableFileHandleBounded(handle, BOT_FILE_BYTES)
          check()
          await sink.complete(
            { guid: event.guid, bytes, suggestedName: event.suggestedFilename },
            check
          )
        } finally {
          await handle.handle.close()
        }
      } catch (error) {
        try {
          sink.failed(error instanceof Error ? error.message : "文件保存失败", event.guid)
        } catch {
          /* destination no longer exists */
        }
      } finally {
        clearInterval(ticker)
        clearTimeout(timeout)
        this.jobs.delete(event.guid)
        // A completed transfer is already terminal. Its staging file belongs
        // to us; deleting it does not require cancelling Chromium's history item.
        if (!completed)
          await session.send("Browser.cancelDownload", { guid: event.guid }).catch(() => {})
        await this.remove(event.guid)
      }
    })()
    this.jobs.set(event.guid, {
      owner: sink.owner,
      scope,
      stop,
      done,
      progress: (progress) => {
        if (Math.max(progress.totalBytes, progress.receivedBytes) > BOT_FILE_BYTES)
          stop(new Error("下载文件超过 25 MiB 上限"))
        else if (progress.state === "completed") {
          completed = true
          finish()
        } else if (progress.state === "canceled") stop(new Error("文件下载已取消"))
      }
    })
    scope?.tasks.add(done)
  }

  /** Collect the downloads initiated by a browser action, including newly opened popups.
   * The scope outlives the click until all started files have been saved. */
  async during<T>(
    page: Page,
    receiver: BotBrowserDownloadReceiver,
    action: () => Promise<T>,
    downloadNavigation?: () => T
  ): Promise<T> {
    const source = await this.watch(page)
    if (source.scope?.active) throw new Error("当前页面已有下载操作")
    const scope: Scope = { receiver, active: true, tasks: new Set(), limit: 4 }
    source.scope = scope
    this.scopes.add(scope)
    try {
      receiver.check()
      let actionFailure: unknown
      let result: T | undefined
      try {
        result = await action()
      } catch (error) {
        actionFailure = error
      }
      // Chromium can emit downloadWillBegin just after its click/navigation acknowledgement.
      await new Promise((resolve) => setTimeout(resolve, 200))
      let seen = 0
      while (seen !== scope.tasks.size) {
        seen = scope.tasks.size
        await Promise.all(scope.tasks)
      }
      receiver.check()
      if (actionFailure !== undefined) {
        if (
          downloadNavigation &&
          scope.tasks.size &&
          /net::ERR_ABORTED|Download is starting/.test(String(actionFailure))
        )
          return downloadNavigation()
        throw actionFailure
      }
      return result as T
    } finally {
      scope.active = false
      for (const job of this.jobs.values())
        if (job.scope === scope) job.stop(new Error("下载操作已结束"))
      await Promise.all(scope.tasks)
      if (source.scope === scope) source.scope = undefined
      this.scopes.delete(scope)
    }
  }

  async fetch(
    page: Page,
    url: string,
    check: () => void,
    signal: AbortSignal
  ): Promise<BotBrowserDownload> {
    // A direct file can be served inline (PDF/image/text), without a download
    // event. Change only this private page's final response disposition. CDP
    // continues the original streamed body: no second GET, cookie copy, body
    // buffering or page script. Ordinary navigation and POST exports are untouched.
    const session = await this.context.newCDPSession(page)
    const pending = new Set<Promise<void>>()
    let rejectResponse!: (error: unknown) => void
    const responseFailure = new Promise<never>((_, reject) => {
      rejectResponse = reject
    })
    void responseFailure.catch(() => {})
    let active = true
    const respond = async (event: DirectResponse, frameId: string) => {
      try {
        check()
        signal.throwIfAborted()
        const status = event.responseStatusCode
        if (event.frameId !== frameId || status === undefined || status < 200 || status >= 300) {
          await session.send("Fetch.continueResponse", { requestId: event.requestId })
          return
        }
        const headers = event.responseHeaders ?? []
        const disposition = headers.find(
          (header) => header.name.toLowerCase() === "content-disposition"
        )
        let originalName = new URL(event.request.url).pathname.split("/").at(-1) || "download.bin"
        try {
          originalName = decodeURIComponent(originalName)
        } catch {
          // A malformed percent escape is a literal filename, not an error page.
        }
        // Keep server filenames (including RFC 5987); never put URL queries,
        // credentials or unencoded response data into a new header.
        const attachment = disposition?.value.match(/^\s*inline\b/i)
          ? disposition.value.replace(/^\s*inline\b/i, "attachment")
          : `attachment; filename*=UTF-8''${encodeURIComponent(originalName).replace(/'/g, "%27")}`
        const responseHeaders = disposition?.value.match(/^\s*attachment\b/i)
          ? headers
          : [
              ...headers.filter((header) => header.name.toLowerCase() !== "content-disposition"),
              { name: "Content-Disposition", value: attachment }
            ]
        await session.send("Fetch.continueResponse", {
          requestId: event.requestId,
          responseCode: status,
          ...(event.responseStatusText ? { responsePhrase: event.responseStatusText } : {}),
          responseHeaders
        })
      } catch (error) {
        await session
          .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
          .catch(() => {})
        throw error
      }
    }
    let onResponse: ((event: DirectResponse) => void) | undefined
    try {
      check()
      signal.throwIfAborted()
      const { frameTree } = await session.send("Page.getFrameTree")
      onResponse = (event) => {
        if (!active) return
        const task = respond(event, frameTree.frame.id).catch(rejectResponse)
        pending.add(task)
        void task.finally(() => pending.delete(task))
      }
      session.on("Fetch.requestPaused", onResponse)
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }]
      })
      return await this.capture(
        page,
        () =>
          Promise.race([
            page.goto(url, { waitUntil: "commit", timeout: 25_000 }).catch((error) => {
              if (
                !String(error).includes("ERR_ABORTED") &&
                !String(error).includes("Download is starting")
              )
                throw error
            }),
            responseFailure
          ]),
        check,
        signal,
        true
      )
    } finally {
      active = false
      if (onResponse) session.off("Fetch.requestPaused", onResponse)
      await session.send("Fetch.disable").catch(() => {})
      await Promise.all(pending)
      await session.detach().catch(() => {})
    }
  }

  async capture(
    page: Page,
    trigger: () => Promise<unknown>,
    check: () => void,
    signal: AbortSignal,
    closePage = false
  ): Promise<BotBrowserDownload> {
    const source = await this.watch(page)
    if (source.scope?.active) throw new Error("当前页面已有下载操作")
    let resolve!: (file: BotBrowserDownload) => void, reject!: (error: Error) => void
    const result = new Promise<BotBrowserDownload>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    // validate() can throw before Promise.all installs its rejection handler.
    void result.catch(() => {})
    let accepted = false
    const validate = () => {
      check()
      signal.throwIfAborted()
    }
    const scope: Scope = {
      active: true,
      tasks: new Set(),
      limit: 1,
      stop: reject,
      receiver: {
        owner: "explicit",
        check: validate,
        complete: async (file) => {
          if (!accepted) {
            accepted = true
            resolve(file)
          }
        },
        failed: (message) => reject(new Error(message))
      }
    }
    source.scope = scope
    this.scopes.add(scope)
    const onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("下载已取消"))
    const onClose = () => {
      if (!accepted) reject(new Error("下载页面已关闭"))
    }
    const timeout = setTimeout(() => reject(new Error("文件下载超过 30 秒，请稍后重试")), 30_000)
    // The lease can expire before downloadWillBegin, while Chromium waits for headers.
    const ticker = setInterval(() => {
      try {
        validate()
      } catch (error) {
        reject(error instanceof Error ? error : new Error("下载授权已失效"))
      }
    }, 100)
    signal.addEventListener("abort", onAbort, { once: true })
    page.once("close", onClose)
    try {
      validate()
      const [file] = await Promise.all([result, trigger()])
      validate()
      return file
    } finally {
      clearTimeout(timeout)
      clearInterval(ticker)
      scope.active = false
      for (const job of this.jobs.values())
        if (job.scope === scope) job.stop(new Error("下载操作已结束"))
      await Promise.all(scope.tasks)
      source.scope = undefined
      this.scopes.delete(scope)
      signal.removeEventListener("abort", onAbort)
      page.off("close", onClose)
      if (closePage) await page.close().catch(() => {})
      else if (!accepted && !page.isClosed()) {
        const pendingNavigation = await this.context.newCDPSession(page).catch(() => null)
        if (pendingNavigation) {
          await pendingNavigation.send("Page.stopLoading").catch(() => {})
          await pendingNavigation.detach().catch(() => {})
        }
      }
    }
  }

  private async remove(guid: string): Promise<void> {
    if (!this.directory || !/^[a-f0-9-]{36}$/i.test(guid)) return
    await unlink(join(this.directory, guid)).catch(() => {})
    await unlink(join(this.directory, `${guid}.crdownload`)).catch(() => {})
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.closeResources()
    return this.closing
  }

  async releaseOwner(owner: string): Promise<void> {
    const reason = new Error("Bot 已删除，下载已停止")
    for (const scope of this.scopes) if (scope.receiver.owner === owner) scope.stop?.(reason)
    const jobs = [...this.jobs.values()].filter((job) => job.owner === owner)
    for (const job of jobs) job.stop(reason)
    await Promise.all(jobs.map((job) => job.done))
  }

  private async closeResources(): Promise<void> {
    for (const scope of this.scopes) scope.stop?.(new Error("浏览器已关闭，下载未完成"))
    for (const job of this.jobs.values()) job.stop(new Error("浏览器已关闭，下载未完成"))
    await Promise.all([...this.jobs.values()].map((job) => job.done))
    // Pending attachments must settle before taking the cleanup snapshot. Each
    // attach checks closed after awaiting CDP, so it cannot publish late frames.
    await Promise.allSettled(this.pages.values())
    await Promise.all([...this.pageCleanups.values()].map((cleanup) => cleanup()))
    await this.initializing?.then((session) => session.detach()).catch(() => {})
    if (this.directory) await rm(this.directory, { recursive: true, force: true })
    this.initializing = undefined
    this.browserSession = undefined
    this.directory = undefined
    this.pages.clear()
    this.frames.clear()
    this.targets.clear()
    this.pageCleanups.clear()
  }
}
