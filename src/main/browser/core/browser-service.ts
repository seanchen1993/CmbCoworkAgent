import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  type CookiesSetDetails,
  type Rectangle,
  type WebContents
} from "electron"
import { existsSync } from "fs"
import { posix, resolve, win32 } from "path"
import { pathToFileURL } from "url"
import { BROWSER_PANEL_REQUEST_CHANNEL } from "../../../shared/browser-types"
import type {
  BrowserAttachOptions,
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserNavigateOptions,
  BrowserProfileImportSkipReason,
  BrowserProfileImportSkippedWebsite,
  BrowserScreenshotResult,
  BrowserState
} from "../../../shared/browser-types"
import type {
  BrowserSessionCookie,
  BrowserSessionData,
  BrowserSessionImportCounts
} from "./browser-session-data"

const MAX_BROWSER_CONSOLE_ENTRIES = 200
const MAX_BROWSER_CONSOLE_MESSAGE_CHARS = 4_000
const BROWSER_PROFILE_PARTITION = "persist:cmbdevclaw-browser-profile"

interface BrowserSession {
  id: string
  isAttached: boolean
  view: WebContentsView
  targetReady: Promise<void>
  workspacePath: string | null
  consoleEntries: BrowserConsoleEntry[]
  nextConsoleEntryId: number
  error?: string
}

function normalizeBounds(bounds: BrowserBounds): Rectangle {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  }
}

function rectanglesEqual(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function formatBounds(bounds: Rectangle | BrowserBounds): string {
  return `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatSessionSnapshot(session: BrowserSession | null): string {
  if (!session) return "(none)"
  const webContents = session.view.webContents
  const destroyed = webContents.isDestroyed()
  const url = destroyed ? "(destroyed)" : webContents.getURL() || "(empty)"
  return `id=${session.id} attached=${session.isAttached} visible=${session.view.getVisible()} bounds=${formatBounds(session.view.getBounds())} destroyed=${destroyed} url=${url}`
}

function sameSiteForElectron(value: BrowserSessionCookie["sameSite"]): CookiesSetDetails["sameSite"] {
  switch ((value ?? "").toLowerCase()) {
    case "strict":
      return "strict"
    case "none":
    case "no_restriction":
      return "no_restriction"
    case "unspecified":
      return "unspecified"
    case "lax":
    default:
      return "lax"
  }
}

function browserProfileCookieDetails(cookie: BrowserSessionCookie): CookiesSetDetails | null {
  if (!cookie.name || typeof cookie.value !== "string") return null

  const domain = typeof cookie.domain === "string" ? cookie.domain.trim() : ""
  const hostname = domain.replace(/^\./, "")
  if (!hostname) return null

  const normalizedPath = typeof cookie.path === "string" && cookie.path.trim() ? cookie.path : "/"
  const path = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`
  const protocol = cookie.secure ? "https:" : "http:"
  const rootUrl = `${protocol}//${hostname}/`
  try {
    new URL(rootUrl)
  } catch {
    return null
  }

  const details: CookiesSetDetails = {
    url: rootUrl,
    name: cookie.name,
    value: cookie.value,
    path
  }

  if (domain.startsWith(".")) {
    details.domain = domain
  }
  if (typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0) {
    details.expirationDate = cookie.expires
  }
  if (cookie.httpOnly === true) details.httpOnly = true
  if (cookie.secure === true) details.secure = true
  if (cookie.sameSite) details.sameSite = sameSiteForElectron(cookie.sameSite)

  return details
}

function normalizeCookieDomain(domain: string | undefined): string {
  const value = domain?.trim().replace(/^\./, "").toLowerCase()
  return value || "(unknown)"
}

function addSkippedWebsite(
  skippedWebsites: Map<string, BrowserProfileImportSkippedWebsite>,
  cookie: BrowserSessionCookie,
  reason: BrowserProfileImportSkipReason
): void {
  const normalizedDomain = normalizeCookieDomain(cookie.domain)
  const url =
    normalizedDomain === "(unknown)"
      ? ""
      : `${cookie.secure ? "https" : "http"}://${normalizedDomain}/`
  const current =
    skippedWebsites.get(normalizedDomain) ??
    ({
      domain: normalizedDomain,
      reasons: [],
      skippedCookies: 0,
      url
    } satisfies BrowserProfileImportSkippedWebsite)
  current.skippedCookies += 1
  if (!current.reasons.includes(reason)) current.reasons.push(reason)
  skippedWebsites.set(normalizedDomain, current)
}

function sortedSkippedWebsites(
  skippedWebsites: Map<string, BrowserProfileImportSkippedWebsite>
): BrowserProfileImportSkippedWebsite[] {
  return Array.from(skippedWebsites.values()).sort(
    (left, right) =>
      right.skippedCookies - left.skippedCookies || left.domain.localeCompare(right.domain)
  )
}

type PathApi = typeof posix

function usesWindowsPaths(...paths: Array<string | null | undefined>): boolean {
  return paths.some((value) => typeof value === "string" && /^[a-zA-Z]:[\\/]/.test(value.trim()))
}

function getPathApi(...paths: Array<string | null | undefined>): PathApi {
  return usesWindowsPaths(...paths) ? win32 : posix
}

function filesystemPathToFileUrl(filePath: string): string {
  if (usesWindowsPaths(filePath)) {
    const url = new URL("file:///")
    url.pathname = `/${win32.resolve(filePath).replace(/\\/g, "/")}`
    return url.toString()
  }
  return pathToFileURL(resolve(filePath)).toString()
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(value)
}

function normalizeUrlInput(input: string, workspacePath: string | null): string {
  const value = input.trim()
  if (!value) return "about:blank"
  if (value === "about:blank") return value

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`
  }

  if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) {
    return value
  }

  if (workspacePath && value.startsWith("/") && !existsSync(value)) {
    const candidate = getPathApi(workspacePath, value).resolve(
      workspacePath,
      value.replace(/^\/+/, "")
    )
    if (existsSync(candidate)) {
      return filesystemPathToFileUrl(candidate)
    }
  }

  if (isAbsoluteFilesystemPath(value)) {
    return filesystemPathToFileUrl(value)
  }

  if (workspacePath) {
    const candidate = getPathApi(workspacePath, value).resolve(workspacePath, value)
    if (existsSync(candidate)) {
      return filesystemPathToFileUrl(candidate)
    }
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return value
  }

  return `https://${value}`
}

function getUrlPermissionError(url: string, _workspacePath: string | null): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "URL 格式无效"
  }

  if (parsed.protocol === "about:" && parsed.href === "about:blank") return null
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return null
  if (parsed.protocol === "file:") return null

  return `不允许加载 ${parsed.protocol} 协议`
}

function getBrowserConsoleLevel(level: number): BrowserConsoleLevel {
  switch (level) {
    case 0:
      return "info"
    case 1:
      return "warn"
    case 2:
      return "error"
    case 3:
      return "debug"
    default:
      return "log"
  }
}

function truncateBrowserConsoleMessage(message: string): string {
  if (message.length <= MAX_BROWSER_CONSOLE_MESSAGE_CHARS) return message
  return `${message.slice(0, MAX_BROWSER_CONSOLE_MESSAGE_CHARS)}\n[message truncated]`
}

function appendBrowserConsoleEntry(
  entries: BrowserConsoleEntry[],
  entry: BrowserConsoleEntry
): BrowserConsoleEntry[] {
  const next = [...entries, entry]
  return next.length > MAX_BROWSER_CONSOLE_ENTRIES
    ? next.slice(next.length - MAX_BROWSER_CONSOLE_ENTRIES)
    : next
}

async function initializeBrowserTarget(
  webContents: Pick<WebContents, "getURL" | "loadURL">
): Promise<void> {
  if (webContents.getURL()) return
  await webContents.loadURL("about:blank")
}

function getChannel(sessionId: string): string {
  return `browser:state:${sessionId}`
}

export class BrowserService {
  private activeSession: BrowserSession | null = null

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  attach(sessionId: string, options: BrowserAttachOptions = {}): BrowserState {
    const window = this.getUsableWindow()
    console.info(
      `[BrowserService] Attach requested for ${sessionId}; active=${formatSessionSnapshot(this.activeSession)} requestedVisible=${options.visible ?? true} workspacePath=${options.workspacePath ?? "(unchanged)"} initialUrl=${options.initialUrl ?? "(none)"}.`
    )

    if (this.activeSession && this.activeSession.id !== sessionId) {
      console.info(`[BrowserService] Disposing Browser session ${this.activeSession.id} before attaching ${sessionId}.`)
      const disposedSessionId = this.disposeActiveSession()
      if (disposedSessionId) this.emitState(disposedSessionId)
    }

    const existingSession = this.getActiveSession(sessionId)
    const session = this.ensureActiveSession(sessionId, options.workspacePath ?? null)
    if (!session.isAttached) {
      console.info(
        `[BrowserService] addChildView for ${sessionId}; snapshot before attach=${formatSessionSnapshot(session)}.`
      )
      window.contentView.addChildView(session.view)
      session.isAttached = true
    }
    const requestedVisible = options.visible ?? true
    const shouldUpdateVisibility = !existingSession || requestedVisible
    const previousVisible = session.view.getVisible()
    console.info(
      `[BrowserService] Attach resolved session for ${sessionId}; existing=${Boolean(existingSession)} shouldUpdateVisibility=${shouldUpdateVisibility} previousVisible=${previousVisible} current=${formatSessionSnapshot(session)}.`
    )
    if (shouldUpdateVisibility) {
      if (previousVisible !== requestedVisible) session.view.setVisible(requestedVisible)
    }
    if (requestedVisible && (!existingSession || !previousVisible)) {
      this.invalidateSession(session)
    }

    if (options.initialUrl && !session.view.webContents.getURL()) {
      void this.navigate(sessionId, options.initialUrl, options)
    } else {
      this.emitState(sessionId)
    }

    const state = this.getState(sessionId)
    console.info(`[BrowserService] Attached Browser session ${sessionId} visible=${state.visible}.`)
    return state
  }

  async prepareTarget(
    sessionId: string,
    options: BrowserAttachOptions = {}
  ): Promise<BrowserState> {
    this.attach(sessionId, options)
    const session = this.requireSession(sessionId)
    await session.targetReady
    return this.getState(sessionId)
  }

  detach(sessionId: string): BrowserState {
    console.info(
      `[BrowserService] Detach requested for ${sessionId}; active=${formatSessionSnapshot(this.activeSession)}.`
    )
    if (this.activeSession?.id !== sessionId) return this.getState(sessionId)
    this.disposeActiveSession()
    this.emitState(sessionId)
    const state = this.getState(sessionId)
    console.info(`[BrowserService] Detached Browser session ${sessionId}.`)
    return state
  }

  setBounds(sessionId: string, bounds: BrowserBounds, visible = true): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (!session) {
      console.warn(`[BrowserService] Ignored bounds for inactive Browser session ${sessionId}.`)
      return this.getState(sessionId)
    }

    const nextBounds = normalizeBounds(bounds)
    const nextVisible = visible && nextBounds.width > 0 && nextBounds.height > 0
    const currentBounds = session.view.getBounds()
    const currentVisible = session.view.getVisible()
    const boundsChanged = !rectanglesEqual(currentBounds, nextBounds)
    const visibilityChanged = currentVisible !== nextVisible

    if (!boundsChanged && !visibilityChanged) {
      console.info(
        `[BrowserService] Ignored Browser bounds update for ${sessionId}; unchanged current=${formatBounds(currentBounds)} visible=${currentVisible}.`
      )
      return this.getState(sessionId)
    }

    console.info(
      `[BrowserService] Applying Browser bounds for ${sessionId}; from=${formatBounds(currentBounds)} visible=${currentVisible} to=${formatBounds(nextBounds)} visible=${nextVisible}.`
    )
    if (boundsChanged) session.view.setBounds(nextBounds)
    if (visibilityChanged) session.view.setVisible(nextVisible)
    if (nextVisible && (boundsChanged || visibilityChanged)) {
      this.invalidateSession(session)
    }
    this.emitState(sessionId)
    const state = this.getState(sessionId)
    console.info(`[BrowserService] Updated Browser bounds for ${sessionId} to ${formatBounds(nextBounds)} visible=${nextVisible}.`)
    return state
  }

  async navigate(
    sessionId: string,
    inputUrl: string,
    options: BrowserNavigateOptions = {}
  ): Promise<BrowserState> {
    const session = this.getActiveSession(sessionId)
    if (!session) {
      console.warn(`[BrowserService] Ignored navigation for inactive Browser session ${sessionId}.`)
      return this.getState(sessionId)
    }

    if (options.workspacePath !== undefined) {
      session.workspacePath = options.workspacePath ?? null
    }

    const url = normalizeUrlInput(inputUrl, session.workspacePath)
    const permissionError = getUrlPermissionError(url, session.workspacePath)
    if (permissionError) {
      session.error = permissionError
      console.warn(`[BrowserService] Navigation blocked for ${sessionId}: ${permissionError}.`)
      this.emitState(sessionId)
      return this.getState(sessionId)
    }

    try {
      session.error = undefined
      await session.view.webContents.loadURL(url)
    } catch (error) {
      const message = formatError(error)
      session.error = message
      console.error(`[BrowserService] Navigation failed for ${sessionId}: ${message}.`)
    }

    this.emitState(sessionId)
    const state = this.getState(sessionId)
    console.info(`[BrowserService] Navigated ${sessionId} to ${state.url || url}.`)
    return state
  }

  goBack(sessionId: string): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (session?.view.webContents.canGoBack()) {
      session.view.webContents.goBack()
    }
    return this.getState(sessionId)
  }

  goForward(sessionId: string): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (session?.view.webContents.canGoForward()) {
      session.view.webContents.goForward()
    }
    return this.getState(sessionId)
  }

  reload(sessionId: string): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (session) {
      session.view.webContents.reload()
    }
    return this.getState(sessionId)
  }

  stop(sessionId: string): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (session) {
      session.view.webContents.stop()
    }
    return this.getState(sessionId)
  }

  clearConsole(sessionId: string): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (session) {
      session.consoleEntries = []
      this.emitState(sessionId)
    }
    return this.getState(sessionId)
  }

  async captureScreenshot(sessionId: string): Promise<BrowserScreenshotResult> {
    const session = this.getActiveSession(sessionId)
    if (!session) return { success: false, error: "Browser session has not been created" }

    try {
      const image = await session.view.webContents.capturePage()
      return { success: true, dataUrl: image.toDataURL() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async importProfileData(data: BrowserSessionData): Promise<BrowserSessionImportCounts> {
    const browserSession = electronSession.fromPartition(BROWSER_PROFILE_PARTITION)
    const skippedWebsites = new Map<string, BrowserProfileImportSkippedWebsite>()
    let importedCookies = 0
    let skippedCookies = 0
    for (const cookie of data.cookies) {
      if (cookie.partitionKey !== undefined && cookie.partitionKey !== null) {
        skippedCookies += 1
        addSkippedWebsite(skippedWebsites, cookie, "partitioned")
        continue
      }

      const details = browserProfileCookieDetails(cookie)
      if (!details) {
        skippedCookies += 1
        addSkippedWebsite(skippedWebsites, cookie, "invalid")
        continue
      }

      try {
        await browserSession.cookies.set(details)
        importedCookies += 1
      } catch {
        skippedCookies += 1
        addSkippedWebsite(skippedWebsites, cookie, "browser_rejected")
      }
    }

    const skippedLocalStorage = data.localStorage.length
    if (this.activeSession && !this.activeSession.view.webContents.isDestroyed()) {
      this.activeSession.view.webContents.reload()
      this.emitState(this.activeSession.id)
    }

    console.info(
      `[BrowserService] Imported browser profile data cookies=${importedCookies} localStorage=0 skipped=${skippedCookies + skippedLocalStorage}.`
    )
    return {
      importedCookies,
      importedLocalStorage: 0,
      skippedCookies,
      skippedLocalStorage,
      skippedWebsites: sortedSkippedWebsites(skippedWebsites)
    }
  }

  requestPanel(sessionId: string, threadId?: string): void {
    const window = this.getUsableWindow()
    window.webContents.send(BROWSER_PANEL_REQUEST_CHANNEL, { sessionId, threadId })
  }

  getState(sessionId: string): BrowserState {
    const session = this.getActiveSession(sessionId)
    if (!session) {
      return {
        sessionId,
        url: "",
        title: "",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        visible: false,
        created: false,
        consoleEntries: []
      }
    }

    const webContents = session.view.webContents
    const isDestroyed = webContents.isDestroyed()
    return {
      sessionId,
      url: isDestroyed ? "" : webContents.getURL(),
      title: isDestroyed ? "" : webContents.getTitle(),
      isLoading: isDestroyed ? false : webContents.isLoading(),
      canGoBack: isDestroyed ? false : webContents.canGoBack(),
      canGoForward: isDestroyed ? false : webContents.canGoForward(),
      visible: session.view.getVisible(),
      created: true,
      consoleEntries: session.consoleEntries.slice(),
      error: session.error
    }
  }

  disposeAll(): string | null {
    const disposedSessionId = this.disposeActiveSession()
    if (disposedSessionId) this.emitState(disposedSessionId)
    return disposedSessionId
  }

  private ensureActiveSession(sessionId: string, workspacePath: string | null): BrowserSession {
    const existing = this.getActiveSession(sessionId)
    if (existing) {
      existing.workspacePath = workspacePath ?? existing.workspacePath
      console.info(
        `[BrowserService] Reusing active Browser session ${sessionId}; snapshot=${formatSessionSnapshot(existing)} workspacePath=${existing.workspacePath ?? "(none)"}.`
      )
      return existing
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PROFILE_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    view.setBackgroundColor("#ffffff")
    view.setVisible(false)

    const session: BrowserSession = {
      id: sessionId,
      isAttached: false,
      view,
      targetReady: Promise.resolve(),
      workspacePath,
      consoleEntries: [],
      nextConsoleEntryId: 1
    }

    this.activeSession = session
    this.configureSessionGuards(session)
    this.bindWebContentsEvents(session)
    session.targetReady = initializeBrowserTarget(view.webContents)
    void session.targetReady.catch((error) => {
      if (this.getActiveSession(sessionId) !== session || view.webContents.isDestroyed()) return
      session.error = `内置浏览器初始化失败: ${formatError(error)}`
      this.emitState(sessionId)
      console.error(`[BrowserService] ${session.error}.`)
    })
    console.info(
      `[BrowserService] Created Browser session ${sessionId}; snapshot=${formatSessionSnapshot(session)} workspacePath=${workspacePath ?? "(none)"}.`
    )
    return session
  }

  private requireSession(sessionId: string): BrowserSession {
    const session = this.getActiveSession(sessionId)
    if (!session) {
      throw new Error("Browser session has not been created")
    }
    return session
  }

  private bindWebContentsEvents(session: BrowserSession): void {
    const webContents = session.view.webContents
    const emit = (): void => this.emitState(session.id)

    webContents.on("did-start-loading", () => {
      session.error = undefined
      session.consoleEntries = []
      emit()
    })
    webContents.on("did-stop-loading", () => {
      this.invalidateSession(session)
      emit()
      console.info(`[BrowserService] Loaded Browser session ${session.id}.`)
    })
    webContents.on("page-title-updated", (_event, _title) => {
      emit()
    })
    webContents.on("console-message", (_event, level, message, line, sourceId) => {
      session.consoleEntries = appendBrowserConsoleEntry(session.consoleEntries, {
        id: `${session.id}:${session.nextConsoleEntryId++}`,
        timestamp: new Date().toISOString(),
        level: getBrowserConsoleLevel(level),
        message: truncateBrowserConsoleMessage(message),
        sourceId: sourceId || undefined,
        line: Number.isFinite(line) && line > 0 ? line : undefined
      })
      emit()
    })
    webContents.on("did-navigate", (_event, url) => {
      session.error = undefined
      const permissionError = getUrlPermissionError(url, session.workspacePath)
      if (permissionError) {
        session.error = permissionError
      }
      emit()
      console.info(`[BrowserService] Browser session ${session.id} reached ${url}.`)
    })
    webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) emit()
    })
    webContents.on("will-navigate", (event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      const permissionError = getUrlPermissionError(url, session.workspacePath)
      if (!permissionError) return
      event.preventDefault()
      session.error = permissionError
      emit()
    })
    webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        session.error = `${errorDescription}${validatedURL ? `: ${validatedURL}` : ""}`
        emit()
        console.error(`[BrowserService] Browser load failed for ${session.id}: ${session.error}.`)
      }
    )
    webContents.on("render-process-gone", (_event, details) => {
      console.error(`[BrowserService] Browser renderer ended for ${session.id}: ${details.reason}.`)
    })
    webContents.on("destroyed", () => {
      console.info(`[BrowserService] Browser webContents destroyed for ${session.id}.`)
    })
    webContents.setWindowOpenHandler((details) => {
      const permissionError = getUrlPermissionError(details.url, session.workspacePath)
      if (!permissionError) {
        void this.navigate(session.id, details.url, { workspacePath: session.workspacePath })
      } else {
        session.error = permissionError
        emit()
      }
      return { action: "deny" }
    })
  }

  private configureSessionGuards(session: BrowserSession): void {
    const electronSession = session.view.webContents.session
    electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    electronSession.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
      const permissionError = getUrlPermissionError(details.url, session.workspacePath)
      callback({ cancel: Boolean(permissionError) })
    })
  }

  private emitState(sessionId: string): void {
    const payload = this.getState(sessionId)
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(getChannel(sessionId), payload)
    }
  }

  private getUsableWindow(): BrowserWindow {
    const window = this.getMainWindow()
    if (!window || window.isDestroyed()) {
      throw new Error("Main window is not available")
    }
    return window
  }

  private getActiveSession(sessionId: string): BrowserSession | null {
    return this.activeSession?.id === sessionId ? this.activeSession : null
  }

  private invalidateSession(session: BrowserSession): void {
    const webContents = session.view.webContents
    if (webContents.isDestroyed()) return
    try {
      webContents.invalidate()
    } catch (error) {
      console.warn(`[BrowserService] Browser invalidate failed for ${session.id}: ${formatError(error)}.`)
    }
  }

  private disposeActiveSession(): string | null {
    const session = this.activeSession
    if (!session) return null

    console.info(
      `[BrowserService] Disposing active Browser session ${session.id}; snapshot before dispose=${formatSessionSnapshot(session)}.`
    )
    this.activeSession = null
    session.view.setVisible(false)

    const window = this.getMainWindow()
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(session.view)
        session.isAttached = false
        console.info(`[BrowserService] removeChildView completed for ${session.id}.`)
      } catch (error) {
        console.warn(`[BrowserService] Browser view detach failed for ${session.id}: ${formatError(error)}.`)
      }
    }

    try {
      if (!session.view.webContents.isDestroyed()) {
        console.info(`[BrowserService] Closing Browser webContents for ${session.id}.`)
        session.view.webContents.close({ waitForBeforeUnload: false })
      }
    } catch (error) {
      console.warn(`[BrowserService] Browser close failed for ${session.id}: ${formatError(error)}.`)
    }

    console.info(`[BrowserService] Disposed Browser session ${session.id}.`)
    return session.id
  }
}
