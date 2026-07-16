import {
  BrowserWindow,
  WebContentsView,
  type MouseInputEvent,
  type MouseWheelInputEvent,
  type Rectangle,
  type WebContents
} from "electron"
import { existsSync } from "fs"
import { posix, resolve, win32 } from "path"
import { pathToFileURL } from "url"
import { BROWSER_PANEL_REQUEST_CHANNEL } from "../../shared/browser-types"
import type {
  BrowserAttachOptions,
  BrowserBounds,
  BrowserClickTarget,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDomResult,
  BrowserMouseButton,
  BrowserMousePoint,
  BrowserNavigateOptions,
  BrowserRenderedState,
  BrowserScrollTarget,
  BrowserScreenshotResult,
  BrowserState
} from "../../shared/browser-types"

const MAX_TEXT_CHARS = 80_000
const MAX_HTML_CHARS = 200_000
const MAX_BROWSER_CONSOLE_ENTRIES = 200
const MAX_BROWSER_CONSOLE_MESSAGE_CHARS = 4_000

interface BrowserSession {
  id: string
  isAttached: boolean
  view: WebContentsView
  workspacePath: string | null
  consoleEntries: BrowserConsoleEntry[]
  nextConsoleEntryId: number
  error?: string
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "default"
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

function normalizeMousePoint(point: BrowserMousePoint): BrowserMousePoint {
  return {
    x: Math.max(0, Math.round(point.x)),
    y: Math.max(0, Math.round(point.y))
  }
}

function normalizeClickCount(clickCount: number | undefined): number {
  return typeof clickCount === "number" && Number.isFinite(clickCount) && clickCount > 0
    ? Math.round(clickCount)
    : 1
}

function finiteDelta(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
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

export function normalizeUrlInput(input: string, workspacePath: string | null): string {
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

export function getUrlPermissionError(url: string, _workspacePath: string | null): string | null {
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

export function appendBrowserConsoleEntry(
  entries: BrowserConsoleEntry[],
  entry: BrowserConsoleEntry
): BrowserConsoleEntry[] {
  const next = [...entries, entry]
  return next.length > MAX_BROWSER_CONSOLE_ENTRIES
    ? next.slice(next.length - MAX_BROWSER_CONSOLE_ENTRIES)
    : next
}

function getChannel(sessionId: string): string {
  return `browser:state:${sessionId}`
}

export class BrowserService {
  private activeSession: BrowserSession | null = null

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  attach(sessionId: string, options: BrowserAttachOptions = {}): BrowserState {
    const window = this.getUsableWindow()

    if (this.activeSession && this.activeSession.id !== sessionId) {
      console.info(`[BrowserService] Disposing Browser session ${this.activeSession.id} before attaching ${sessionId}.`)
      const disposedSessionId = this.disposeActiveSession()
      if (disposedSessionId) this.emitState(disposedSessionId)
    }

    const existingSession = this.getActiveSession(sessionId)
    const session = this.ensureActiveSession(sessionId, options.workspacePath ?? null)
    if (!session.isAttached) {
      window.contentView.addChildView(session.view)
      session.isAttached = true
    }
    const requestedVisible = options.visible ?? true
    const shouldUpdateVisibility = !existingSession || requestedVisible
    const previousVisible = session.view.getVisible()
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

  detach(sessionId: string): BrowserState {
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
      return this.getState(sessionId)
    }

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

  async readRenderedState(sessionId: string, includeHtml = false): Promise<BrowserDomResult> {
    const session = this.getActiveSession(sessionId)
    if (!session) return { success: false, error: "Browser session has not been created" }

    try {
      const state = await this.readStateFromWebContents(session, includeHtml)
      return { success: true, state }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async evaluateInPage<T = unknown>(sessionId: string, script: string): Promise<T> {
    const session = this.requireSession(sessionId)
    return (await session.view.webContents.executeJavaScript(script, false)) as T
  }

  requestPanel(sessionId: string, threadId?: string): void {
    const window = this.getUsableWindow()
    window.webContents.send(BROWSER_PANEL_REQUEST_CHANNEL, { sessionId, threadId })
  }

  async click(sessionId: string, target: BrowserClickTarget): Promise<BrowserState> {
    const session = this.requireSession(sessionId)
    const point = await this.resolveClickPoint(session.view.webContents, target)
    session.view.webContents.focus()
    session.view.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y })
    session.view.webContents.sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    })
    session.view.webContents.sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    })
    return this.getState(sessionId)
  }

  async moveMouse(sessionId: string, point: BrowserMousePoint): Promise<BrowserState> {
    const session = this.requireSession(sessionId)
    const normalized = normalizeMousePoint(point)
    session.view.webContents.focus()
    this.sendMouseInput(session.view.webContents, {
      type: "mouseMove",
      x: normalized.x,
      y: normalized.y
    })
    return this.getState(sessionId)
  }

  async mouseDown(
    sessionId: string,
    point: BrowserMousePoint,
    button: BrowserMouseButton = "left",
    clickCount?: number
  ): Promise<BrowserState> {
    const session = this.requireSession(sessionId)
    const normalized = normalizeMousePoint(point)
    session.view.webContents.focus()
    this.sendMouseInput(session.view.webContents, {
      type: "mouseDown",
      x: normalized.x,
      y: normalized.y,
      button,
      clickCount: normalizeClickCount(clickCount)
    })
    return this.getState(sessionId)
  }

  async mouseUp(
    sessionId: string,
    point: BrowserMousePoint,
    button: BrowserMouseButton = "left",
    clickCount?: number
  ): Promise<BrowserState> {
    const session = this.requireSession(sessionId)
    const normalized = normalizeMousePoint(point)
    session.view.webContents.focus()
    this.sendMouseInput(session.view.webContents, {
      type: "mouseUp",
      x: normalized.x,
      y: normalized.y,
      button,
      clickCount: normalizeClickCount(clickCount)
    })
    return this.getState(sessionId)
  }

  async scroll(sessionId: string, target: BrowserScrollTarget): Promise<BrowserState> {
    const session = this.requireSession(sessionId)
    const point = normalizeMousePoint(target)
    const deltaX = finiteDelta(target.deltaX)
    const deltaY = finiteDelta(target.deltaY)
    session.view.webContents.focus()
    this.sendMouseInput(session.view.webContents, {
      type: "mouseMove",
      x: point.x,
      y: point.y
    })
    this.sendMouseWheelInput(session.view.webContents, {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
      hasPreciseScrollingDeltas: true,
      canScroll: true
    })
    return this.getState(sessionId)
  }

  async typeText(sessionId: string, text: string): Promise<BrowserState> {
    const session = this.requireSession(sessionId)
    session.view.webContents.focus()
    await session.view.webContents.insertText(text)
    return this.getState(sessionId)
  }

  press(sessionId: string, keyCode: string): BrowserState {
    const session = this.requireSession(sessionId)
    session.view.webContents.focus()
    session.view.webContents.sendInputEvent({ type: "keyDown", keyCode })
    session.view.webContents.sendInputEvent({ type: "keyUp", keyCode })
    return this.getState(sessionId)
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
      return existing
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: `cmbdevclaw-browser-${sanitizeSessionId(sessionId)}`,
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
      workspacePath,
      consoleEntries: [],
      nextConsoleEntryId: 1
    }

    this.activeSession = session
    this.configureSessionGuards(session)
    this.bindWebContentsEvents(session)
    console.info(`[BrowserService] Created Browser session ${sessionId}.`)
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

    this.activeSession = null
    session.view.setVisible(false)

    const window = this.getMainWindow()
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(session.view)
        session.isAttached = false
      } catch (error) {
        console.warn(`[BrowserService] Browser view detach failed for ${session.id}: ${formatError(error)}.`)
      }
    }

    try {
      if (!session.view.webContents.isDestroyed()) {
        session.view.webContents.close({ waitForBeforeUnload: false })
      }
    } catch (error) {
      console.warn(`[BrowserService] Browser close failed for ${session.id}: ${formatError(error)}.`)
    }

    console.info(`[BrowserService] Disposed Browser session ${session.id}.`)
    return session.id
  }

  private async readStateFromWebContents(
    session: BrowserSession,
    includeHtml: boolean
  ): Promise<BrowserRenderedState> {
    const script = `
      (() => {
        const maxText = ${MAX_TEXT_CHARS};
        const maxHtml = ${MAX_HTML_CHARS};
        const text = (document.body?.innerText || "").slice(0, maxText + 1);
        const html = ${includeHtml ? "(document.documentElement?.outerHTML || '').slice(0, maxHtml + 1)" : "undefined"};
        return {
          url: location.href,
          title: document.title,
          text: text.slice(0, maxText),
          html: typeof html === "string" ? html.slice(0, maxHtml) : undefined,
          truncated: text.length > maxText || (typeof html === "string" && html.length > maxHtml)
        };
      })()
    `
    const result = (await session.view.webContents.executeJavaScript(script, false)) as {
      url?: string
      title?: string
      text?: string
      html?: string
      truncated?: boolean
    }
    return {
      sessionId: session.id,
      url: result.url || session.view.webContents.getURL(),
      title: result.title || session.view.webContents.getTitle(),
      text: result.text || "",
      html: result.html,
      truncated: Boolean(result.truncated)
    }
  }

  private async resolveClickPoint(
    webContents: WebContents,
    target: BrowserClickTarget
  ): Promise<{ x: number; y: number }> {
    if (typeof target.x === "number" && typeof target.y === "number") {
      return { x: Math.round(target.x), y: Math.round(target.y) }
    }

    const selector = target.selector?.trim()
    if (!selector) {
      throw new Error("Click target must include x/y or selector")
    }

    const script = `
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      })()
    `
    const point = (await webContents.executeJavaScript(script, false)) as {
      x?: number
      y?: number
    } | null
    if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
      throw new Error(`Element not found or not clickable: ${selector}`)
    }
    return { x: point.x, y: point.y }
  }

  private sendMouseInput(webContents: WebContents, event: MouseInputEvent): void {
    webContents.sendInputEvent(event)
  }

  private sendMouseWheelInput(webContents: WebContents, event: MouseWheelInputEvent): void {
    webContents.sendInputEvent(event)
  }
}
