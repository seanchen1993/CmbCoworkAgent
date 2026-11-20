import {
  app,
  BrowserWindow,
  shell,
  WebContentsView,
  session as electronSession,
  type CookiesSetDetails,
  type Rectangle,
  type Session,
  type WebContents
} from "electron"
import { existsSync } from "fs"
import { basename, extname, isAbsolute, join, posix, relative, resolve, win32 } from "path"
import { pathToFileURL } from "url"
import {
  BUILTIN_BROWSER_LOG_PREFIX,
  BROWSER_PANEL_REQUEST_CHANNEL,
  BROWSER_DOWNLOADS_CHANGED_CHANNEL,
  BROWSER_SESSION_ID
} from "../../../shared/browser-types"
import {
  getScriptRecording,
  installScriptRecorderForFrameById,
  installScriptRecorderForSubtree,
  markNextScriptNavigationExplicit,
  recordScriptRecorderConsoleMessage,
  recordScriptNavigation
} from "../record/script-record/script-recording-service"
import type {
  BrowserAttachOptions,
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDownloadRecord,
  BrowserDownloadsChangedPayload,
  BrowserDeviceSize,
  BrowserDeviceViewport,
  BrowserNavigateOptions,
  BrowserProfileImportSkipReason,
  BrowserProfileImportSkippedWebsite,
  BrowserScreenshotResult,
  BrowserState,
  BrowserViewportUpdate
} from "../../../shared/browser-types"
import type {
  BrowserSessionCookie,
  BrowserSessionData,
  BrowserSessionImportCounts
} from "./browser-session-data"

const MAX_BROWSER_CONSOLE_ENTRIES = 200
const MAX_BROWSER_CONSOLE_MESSAGE_CHARS = 4_000
const MIN_BROWSER_ZOOM_FACTOR = 0.25
const MAX_BROWSER_ZOOM_FACTOR = 5
const BROWSER_PROFILE_PARTITION = "persist:cmbdevclaw-browser-profile"
const BROWSER_SERVICE_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[BrowserService]`
const MAX_EXTRACTED_IFRAME_LINKS = 100
// Opening and laying out BrowserPanel can take noticeably longer on Windows,
// especially on the first replay while Electron is creating the target. Keep
// this handshake long enough for the renderer's stabilized viewport syncs.
const VIEWPORT_SYNC_TIMEOUT_MS = 10_000
const configuredDownloadSessions = new WeakSet<Session>()

/**
 * Device preview scale is a renderer layout detail, not part of the recorded
 * viewport. Width and height are the replay contract; the renderer computes the
 * scale from the space available in the current panel.
 */
export function deviceViewportMatchesRequested(
  current: BrowserDeviceViewport | null | undefined,
  requested: BrowserDeviceSize | null | undefined
): boolean {
  if (!current || !requested) return current === requested
  return current.width === requested.width && current.height === requested.height
}

function safeDownloadFileName(fileName: string): string {
  const leafName = basename(win32.basename(fileName.trim()))
  const sanitized = leafName.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[ .]+$/gu, "")
  if (!sanitized || sanitized === "." || sanitized === "..") return "download"

  const extension = extname(sanitized)
  const stem = extension ? sanitized.slice(0, -extension.length) : sanitized
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem) ? `_${sanitized}` : sanitized
}

export function resolveAvailableBrowserDownloadPath(
  downloadsDirectory: string,
  fileName: string,
  isPathTaken: (path: string) => boolean = existsSync
): string {
  const safeFileName = safeDownloadFileName(fileName)
  const extension = extname(safeFileName)
  const stem = extension ? safeFileName.slice(0, -extension.length) : safeFileName
  let candidate = join(downloadsDirectory, safeFileName)
  let suffix = 1
  while (isPathTaken(candidate)) {
    candidate = join(downloadsDirectory, `${stem} (${suffix})${extension}`)
    suffix += 1
  }
  return candidate
}

function configureAutomaticBrowserDownloads(
  browserSession: Session,
  onDownloadChanged: (record: BrowserDownloadRecord, completed: boolean) => void
): void {
  if (configuredDownloadSessions.has(browserSession)) return
  configuredDownloadSessions.add(browserSession)
  const activePaths = new Set<string>()

  browserSession.on("will-download", (_event, item) => {
    const savePath = resolveAvailableBrowserDownloadPath(
      app.getPath("downloads"),
      item.getFilename(),
      (candidate) => existsSync(candidate) || activePaths.has(candidate)
    )
    activePaths.add(savePath)
    item.setSavePath(savePath)
    const record: BrowserDownloadRecord = {
      id: `browser-download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: item.getFilename(),
      savePath,
      status: "progressing",
      startedAt: new Date().toISOString()
    }
    onDownloadChanged(record, false)
    item.once("done", (_doneEvent, state) => {
      activePaths.delete(savePath)
      record.status = state
      record.endedAt = new Date().toISOString()
      onDownloadChanged(record, state === "completed")
      if (state === "completed") {
        console.log(`${BROWSER_SERVICE_LOG_PREFIX} Download saved to ${savePath}.`)
      } else {
        console.warn(`${BROWSER_SERVICE_LOG_PREFIX} Download ${state}: ${savePath}.`)
      }
    })
  })
}

function buildIframeExtractionScript(options: {
  textOffset: number
  maxTextChars: number
  linkOffset: number
}): string {
  const { textOffset, maxTextChars, linkOffset } = options
  return `(() => {
    const fullText = ${linkOffset === 0 ? `(document.body?.innerText || "").replace(/\\s+\\n/g, "\\n").trim()` : `""`}
    const allLinks = ${
      textOffset === 0
        ? `Array.from(document.querySelectorAll("a[href]"), (node) => ({
      text: (node.innerText || node.getAttribute("aria-label") || "").trim(),
      href: node.href,
      visible: node.getClientRects().length > 0
    })).filter((item) => item.visible && item.text && item.href).map(({ text, href }) => ({ text, href }))`
        : "[]"
    }
    return {
      text: ${linkOffset === 0 ? `fullText.slice(${textOffset}, ${textOffset + maxTextChars})` : "undefined"},
      textLength: fullText.length,
      links: ${textOffset === 0 ? `allLinks.slice(${linkOffset}, ${linkOffset + MAX_EXTRACTED_IFRAME_LINKS})` : "undefined"},
      linkCount: allLinks.length
    }
  })()`
}

const READ_WPS_DOCUMENT_TEXT_SCRIPT = `(async () => {
  const wpsOpenApi = window.WPSOpenApi
  if (!wpsOpenApi?.Application?.ActiveDocument) {
    throw new Error("WPS OpenAPI is unavailable in office-iframe")
  }
  const activeDocument = await wpsOpenApi.Application.ActiveDocument
  const documentRange = await activeDocument.GetDocumentRange()
  const text = await documentRange.Text
  if (typeof text !== "string") {
    throw new Error("WPS document range Text did not resolve to a string")
  }
  return text
})()`

interface BrowserIframeInformation {
  index: number
  url: string
  depth: number
  text?: string
  links?: Array<{ text: string; href: string }>
  linksTruncated?: boolean
  nextLinkOffset?: number
  truncated?: boolean
  nextTextOffset?: number
  error?: string
}

interface BrowserSession {
  id: string
  isAttached: boolean
  view: WebContentsView
  targetReady: Promise<void>
  workspacePath: string | null
  consoleEntries: BrowserConsoleEntry[]
  nextConsoleEntryId: number
  viewportRevision: number
  viewportId: string | null
  userZoomFactor: number
  deviceScaleFactor: number
  deviceViewport: BrowserDeviceViewport | null
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

function normalizeZoomFactor(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_BROWSER_ZOOM_FACTOR, Math.max(MIN_BROWSER_ZOOM_FACTOR, value))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortedNavigationError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; errno?: unknown }
    if (candidate.code === "ERR_ABORTED" || candidate.errno === -3) return true
  }
  return /\bERR_ABORTED\b/u.test(formatError(error))
}

function sameSiteForElectron(
  value: BrowserSessionCookie["sameSite"]
): CookiesSetDetails["sameSite"] {
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

async function runCookieImportPool(
  cookies: BrowserSessionCookie[],
  importOneCookie: (cookie: BrowserSessionCookie) => Promise<void>,
  concurrency = 24
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(concurrency, cookies.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < cookies.length) {
        const cookie = cookies[nextIndex]
        nextIndex += 1
        await importOneCookie(cookie)
      }
    })
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

export function shouldReloadAfterProfileImport(currentUrl: string): boolean {
  const value = currentUrl.trim()
  return Boolean(value && value !== "about:blank")
}

function getUrlPermissionError(url: string, workspacePath: string | null): string | null {
  void workspacePath
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
  private pendingDeviceViewport: BrowserDeviceSize | undefined
  private readonly downloadRecords: BrowserDownloadRecord[] = []
  private hasUnreadCompletedDownload = false

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  getDownloads(): BrowserDownloadsChangedPayload {
    return {
      records: this.downloadRecords.map((record) => ({ ...record })),
      hasUnreadCompleted: this.hasUnreadCompletedDownload
    }
  }

  markDownloadsRead(): BrowserDownloadsChangedPayload {
    this.hasUnreadCompletedDownload = false
    return this.getDownloads()
  }

  restoreDownloads(snapshot: BrowserDownloadsChangedPayload): BrowserDownloadsChangedPayload {
    const downloadsDirectory = resolve(this.getDownloadDirectory())
    const restored = Array.isArray(snapshot.records)
      ? snapshot.records.flatMap((candidate) => {
          if (!candidate || typeof candidate !== "object") return []
          const savePath = resolve(String(candidate.savePath ?? ""))
          const relativePath = relative(downloadsDirectory, savePath)
          if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return []
          const status =
            candidate.status === "completed" ||
            candidate.status === "cancelled" ||
            candidate.status === "interrupted"
              ? candidate.status
              : "interrupted"
          return [
            {
              id: String(candidate.id || `browser-download-restored-${Date.now()}`),
              fileName: safeDownloadFileName(String(candidate.fileName || basename(savePath))),
              savePath,
              status,
              startedAt: String(candidate.startedAt || new Date().toISOString()),
              endedAt: candidate.endedAt ? String(candidate.endedAt) : undefined
            } satisfies BrowserDownloadRecord
          ]
        })
      : []
    const currentIds = new Set(this.downloadRecords.map((record) => record.id))
    const merged = [
      ...this.downloadRecords,
      ...restored.filter((record) => !currentIds.has(record.id))
    ].slice(0, 100)
    this.downloadRecords.splice(0, this.downloadRecords.length, ...merged)
    this.hasUnreadCompletedDownload ||= snapshot.hasUnreadCompleted === true
    return this.getDownloads()
  }

  getDownloadDirectory(): string {
    return app.getPath("downloads")
  }

  async openDownloadDirectory(): Promise<boolean> {
    return (await shell.openPath(this.getDownloadDirectory())) === ""
  }

  showDownloadInFolder(downloadId: string): boolean {
    const record = this.downloadRecords.find((candidate) => candidate.id === downloadId)
    if (!record) return false
    shell.showItemInFolder(record.savePath)
    return true
  }

  private updateDownload(record: BrowserDownloadRecord, completed: boolean): void {
    const index = this.downloadRecords.findIndex((candidate) => candidate.id === record.id)
    if (index >= 0) this.downloadRecords[index] = { ...record }
    else this.downloadRecords.unshift({ ...record })
    if (this.downloadRecords.length > 100) this.downloadRecords.length = 100
    if (completed) this.hasUnreadCompletedDownload = true
    const window = this.getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(BROWSER_DOWNLOADS_CHANGED_CHANNEL, {
      ...this.getDownloads(),
      completedId: completed ? record.id : undefined
    })
  }

  appendConsoleEntry(input: {
    level: BrowserConsoleLevel
    message: string
    sourceId?: string
  }): BrowserState {
    const session = this.getActiveSession()
    if (!session) return this.getState()
    session.consoleEntries = appendBrowserConsoleEntry(session.consoleEntries, {
      id: `${session.id}:${session.nextConsoleEntryId++}`,
      timestamp: new Date().toISOString(),
      level: input.level,
      message: truncateBrowserConsoleMessage(input.message),
      sourceId: input.sourceId
    })
    this.emitState(session.id)
    return this.getState()
  }

  attach(options: BrowserAttachOptions = {}): BrowserState {
    const sessionId = BROWSER_SESSION_ID
    const window = this.getUsableWindow()

    const existingSession = this.activeSession
    const session = this.ensureActiveSession(sessionId, options.workspacePath)
    if (options.viewportId && options.viewportId !== session.viewportId) {
      console.info(
        `${BROWSER_SERVICE_LOG_PREFIX} Viewport owner changed from ${session.viewportId ?? "none"} to ${options.viewportId}; revision reset from ${session.viewportRevision}.`
      )
      session.viewportId = options.viewportId
      session.viewportRevision = 0
    }
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
      void this.navigate(options.initialUrl, options)
    } else {
      this.emitState(sessionId)
    }

    return this.getState()
  }

  async prepareTarget(options: BrowserAttachOptions = {}): Promise<BrowserState> {
    this.attach(options)
    const session = this.requireSession()
    await session.targetReady
    return this.getState()
  }

  async extractIframeInformation(
    options: {
      maxTextCharsPerFrame?: number
      textOffset?: number
      linkOffset?: number
      frameIndex?: number
    } = {}
  ): Promise<{
    frames: BrowserIframeInformation[]
  }> {
    const session = this.requireSession()
    await session.targetReady
    const mainFrame = session.view.webContents.mainFrame
    const iframeFrames = mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)
    const frames = iframeFrames
      .map((frame, index) => ({ frame, index }))
      .filter(({ index }) => options.frameIndex === undefined || index === options.frameIndex)
    const maxTextCharsPerFrame =
      options.maxTextCharsPerFrame ?? (options.frameIndex === undefined ? 4_000 : 12_000)
    const textOffset = options.textOffset ?? 0
    const linkOffset = options.linkOffset ?? 0
    const results = await Promise.all(
      frames.map(async ({ frame, index }): Promise<BrowserIframeInformation> => {
        let depth = 0
        for (let parent = frame.parent; parent; parent = parent.parent) depth += 1
        try {
          const { textLength, linkCount, ...data } = (await frame.executeJavaScript(
            buildIframeExtractionScript({
              textOffset,
              maxTextChars: maxTextCharsPerFrame,
              linkOffset
            })
          )) as Omit<BrowserIframeInformation, "index" | "url" | "depth"> & {
            textLength: number
            linkCount: number
          }
          const nextTextOffset = textOffset + (data.text?.length ?? 0)
          const truncated = nextTextOffset < textLength
          const nextLinkOffset = linkOffset + (data.links?.length ?? 0)
          const linksTruncated = nextLinkOffset < linkCount
          return {
            index,
            url: frame.url,
            depth,
            ...data,
            truncated: truncated || undefined,
            nextTextOffset: truncated ? nextTextOffset : undefined,
            linksTruncated: linksTruncated || undefined,
            nextLinkOffset: linksTruncated ? nextLinkOffset : undefined
          }
        } catch (error) {
          return { index, url: frame.url, depth, error: formatError(error) }
        }
      })
    )
    return { frames: results }
  }

  async readWpsDocumentText(): Promise<{ text: string }> {
    const session = this.requireSession()
    await session.targetReady
    const mainFrame = session.view.webContents.mainFrame
    const iframeFrames = mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)
    const prioritizedFrames = [
      ...iframeFrames.filter((frame) => frame.name === "office-iframe"),
      ...iframeFrames.filter((frame) => frame.name !== "office-iframe")
    ]
    if (prioritizedFrames.length === 0) throw new Error("当前页面未找到 WPS office-iframe")

    let firstError: string | undefined
    for (const frame of prioritizedFrames) {
      try {
        const text = (await frame.executeJavaScript(READ_WPS_DOCUMENT_TEXT_SCRIPT)) as unknown
        if (typeof text !== "string") throw new Error("WPS 文档正文不是文本")
        return { text }
      } catch (error) {
        firstError ??= formatError(error)
      }
    }
    throw new Error(`读取 WPS 文档全文失败：${firstError ?? "WPS OpenAPI 不可用"}`)
  }

  detach(): BrowserState {
    const sessionId = BROWSER_SESSION_ID
    // detach is the explicit "back to home" transition. A replay can be
    // cancelled before the renderer acknowledges its requested device viewport;
    // do not let that stale request reopen the device toolbar after home is
    // attached again.
    if (this.pendingDeviceViewport) {
      console.info(
        `${BROWSER_SERVICE_LOG_PREFIX} Clearing pending device viewport on home detach: ${JSON.stringify(this.pendingDeviceViewport)}.`
      )
    }
    this.pendingDeviceViewport = undefined
    if (!this.activeSession) return this.getState()
    this.disposeActiveSession()
    this.emitState(sessionId)
    return this.getState()
  }

  setBounds(bounds: BrowserBounds, visible = true, emitState = true): BrowserState {
    const sessionId = BROWSER_SESSION_ID
    const session = this.getActiveSession()
    if (!session) {
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Ignored bounds for inactive Browser session ${sessionId}.`
      )
      return this.getState()
    }

    const nextBounds = normalizeBounds(bounds)
    const nextVisible = visible && nextBounds.width > 0 && nextBounds.height > 0
    const currentBounds = session.view.getBounds()
    const currentVisible = session.view.getVisible()
    const boundsChanged = !rectanglesEqual(currentBounds, nextBounds)
    const visibilityChanged = currentVisible !== nextVisible

    if (!boundsChanged && !visibilityChanged) {
      return this.getState()
    }

    if (boundsChanged) {
      try {
        session.view.setBounds(nextBounds)
      } catch (error) {
        console.warn(
          `${BROWSER_SERVICE_LOG_PREFIX} Ignored bounds update for a disposed browser view: ${formatError(error)}.`
        )
        return this.getState()
      }
    }
    if (visibilityChanged) session.view.setVisible(nextVisible)
    if (nextVisible && (boundsChanged || visibilityChanged)) {
      this.invalidateSession(session)
    }
    if (emitState) this.emitState(sessionId)
    return this.getState()
  }

  setZoomFactor(zoomFactor: number): BrowserState {
    const sessionId = BROWSER_SESSION_ID
    const session = this.getActiveSession()
    if (!session) {
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Ignored zoom update for inactive Browser session ${sessionId}.`
      )
      return this.getState()
    }

    session.userZoomFactor = normalizeZoomFactor(zoomFactor)
    this.applyEffectiveZoom(session)
    this.emitState(sessionId)
    return this.getState()
  }

  private setDeviceMetrics(metrics: BrowserDeviceViewport | null): void {
    const session = this.getActiveSession()
    if (!session || session.view.webContents.isDestroyed()) return
    session.deviceScaleFactor =
      metrics && Number.isFinite(metrics.scale) ? Math.min(1, Math.max(0.1, metrics.scale)) : 1
    this.applyEffectiveZoom(session)
  }

  async setViewport(update: BrowserViewportUpdate): Promise<BrowserState> {
    const session = this.getActiveSession()
    if (!session || !Number.isSafeInteger(update.revision)) {
      if (this.pendingDeviceViewport) {
        console.warn(
          `${BROWSER_SERVICE_LOG_PREFIX} Rejected viewport sync while device preview is pending: session=${session ? "active" : "missing"}, revision=${String(update.revision)}.`
        )
      }
      return this.getState()
    }
    // A hidden/unmounted BrowserPanel can still have an IPC update in flight. Do not
    // let it overwrite the bounds of the panel that replaced it.
    if (update.viewportId !== session.viewportId) {
      if (this.pendingDeviceViewport) {
        console.warn(
          `${BROWSER_SERVICE_LOG_PREFIX} Rejected viewport sync from non-owner panel: incoming=${update.viewportId}, owner=${session.viewportId ?? "none"}, revision=${update.revision}, pending=${JSON.stringify(this.pendingDeviceViewport)}.`
        )
      }
      return this.getState()
    }
    if (update.revision <= session.viewportRevision) {
      if (this.pendingDeviceViewport) {
        console.warn(
          `${BROWSER_SERVICE_LOG_PREFIX} Rejected stale viewport sync: incomingRevision=${update.revision}, currentRevision=${session.viewportRevision}, viewportId=${update.viewportId}.`
        )
      }
      return this.getState()
    }
    session.viewportRevision = update.revision
    this.setBounds(update.bounds, update.visible, false)
    const metricsChanged =
      session.deviceViewport?.width !== update.metrics?.width ||
      session.deviceViewport?.height !== update.metrics?.height ||
      session.deviceViewport?.scale !== update.metrics?.scale
    if (metricsChanged) {
      this.setDeviceMetrics(update.metrics)
      session.deviceViewport = update.metrics
        ? {
            width: update.metrics.width,
            height: update.metrics.height,
            scale: update.metrics.scale
          }
        : null
    }
    if (deviceViewportMatchesRequested(session.deviceViewport, this.pendingDeviceViewport)) {
      console.info(
        `${BROWSER_SERVICE_LOG_PREFIX} Device viewport synchronized: current=${JSON.stringify(session.deviceViewport)}, requested=${JSON.stringify(this.pendingDeviceViewport)}, viewportId=${session.viewportId ?? "none"}, revision=${session.viewportRevision}.`
      )
      this.pendingDeviceViewport = undefined
    }
    this.emitState(session.id)
    return this.getState()
  }

  async waitForDeviceViewport(
    viewport?: BrowserDeviceSize,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
    if (!viewport) return
    const deadline = Date.now() + VIEWPORT_SYNC_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (isCancelled()) return
      const current = this.getActiveSession()?.deviceViewport
      if (deviceViewportMatchesRequested(current, viewport)) {
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    const session = this.getActiveSession()
    console.error(
      `${BROWSER_SERVICE_LOG_PREFIX} Device viewport synchronization timed out: requested=${JSON.stringify(viewport)}, current=${JSON.stringify(session?.deviceViewport ?? null)}, pending=${JSON.stringify(this.pendingDeviceViewport ?? null)}, viewportId=${session?.viewportId ?? "none"}, revision=${session?.viewportRevision ?? "none"}.`
    )
    throw new Error("设备预览设置未在回放开始前完成同步")
  }

  async navigate(inputUrl: string, options: BrowserNavigateOptions = {}): Promise<BrowserState> {
    const sessionId = BROWSER_SESSION_ID
    const session = this.getActiveSession()
    if (!session) {
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Ignored navigation for inactive Browser session ${sessionId}.`
      )
      return this.getState()
    }

    if (options.workspacePath !== undefined) {
      session.workspacePath = options.workspacePath ?? null
    }

    const url = normalizeUrlInput(inputUrl, session.workspacePath)
    const permissionError = getUrlPermissionError(url, session.workspacePath)
    if (permissionError) {
      session.error = permissionError
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Navigation blocked for ${sessionId}: ${permissionError}.`
      )
      this.emitState(sessionId)
      return this.getState()
    }

    try {
      session.error = undefined
      // Record the user-issued navigation before awaiting Chromium. loadURL may
      // reject with ERR_ABORTED for redirects or a superseding navigation even
      // though this is still a real, replayable user action.
      recordScriptNavigation(url, "explicit")
      await session.view.webContents.loadURL(url)
    } catch (error) {
      // A following navigate call or an HTTP redirect can cancel the previous
      // load. Electron rejects loadURL with ERR_ABORTED even though the next
      // navigation is healthy, so do not flash that transient cancellation.
      if (isAbortedNavigationError(error)) return this.getState()
      const message = formatError(error)
      session.error = message
      console.error(`${BROWSER_SERVICE_LOG_PREFIX} Navigation failed for ${sessionId}: ${message}.`)
    }

    this.emitState(sessionId)
    return this.getState()
  }

  goBack(): BrowserState {
    const session = this.getActiveSession()
    if (session?.view.webContents.canGoBack()) {
      markNextScriptNavigationExplicit()
      session.view.webContents.goBack()
    }
    return this.getState()
  }

  goForward(): BrowserState {
    const session = this.getActiveSession()
    if (session?.view.webContents.canGoForward()) {
      markNextScriptNavigationExplicit()
      session.view.webContents.goForward()
    }
    return this.getState()
  }

  reload(): BrowserState {
    const session = this.getActiveSession()
    if (session) {
      markNextScriptNavigationExplicit()
      session.view.webContents.reload()
    }
    return this.getState()
  }

  stop(): BrowserState {
    const session = this.getActiveSession()
    if (session) {
      session.view.webContents.stop()
    }
    return this.getState()
  }

  clearConsole(): BrowserState {
    const session = this.getActiveSession()
    if (session) {
      session.consoleEntries = []
      this.emitState(BROWSER_SESSION_ID)
    }
    return this.getState()
  }

  async captureScreenshot(): Promise<BrowserScreenshotResult> {
    const session = this.getActiveSession()
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
    const importOneCookie = async (cookie: BrowserSessionCookie): Promise<void> => {
      if (cookie.partitionKey !== undefined && cookie.partitionKey !== null) {
        skippedCookies += 1
        addSkippedWebsite(skippedWebsites, cookie, "partitioned")
        return
      }

      const details = browserProfileCookieDetails(cookie)
      if (!details) {
        skippedCookies += 1
        addSkippedWebsite(skippedWebsites, cookie, "invalid")
        return
      }

      try {
        await browserSession.cookies.set(details)
        importedCookies += 1
      } catch {
        skippedCookies += 1
        addSkippedWebsite(skippedWebsites, cookie, "browser_rejected")
      }
    }
    await runCookieImportPool(data.cookies, importOneCookie)

    const skippedLocalStorage = data.localStorage.length
    if (this.activeSession && !this.activeSession.view.webContents.isDestroyed()) {
      const currentUrl = this.activeSession.view.webContents.getURL()
      if (shouldReloadAfterProfileImport(currentUrl)) {
        this.activeSession.view.webContents.reload()
        this.emitState(this.activeSession.id)
      }
    }

    return {
      importedCookies,
      importedLocalStorage: 0,
      skippedCookies,
      skippedLocalStorage,
      skippedWebsites: sortedSkippedWebsites(skippedWebsites)
    }
  }

  requestPanel(
    threadId?: string,
    panelWidth?: number,
    restoreDefaultPanelWidth = false,
    deviceViewport?: BrowserDeviceSize
  ): void {
    this.pendingDeviceViewport = deviceViewport ? { ...deviceViewport } : undefined
    if (deviceViewport) {
      const session = this.getActiveSession()
      console.info(
        `${BROWSER_SERVICE_LOG_PREFIX} Requested replay device viewport ${JSON.stringify(deviceViewport)}; current=${JSON.stringify(session?.deviceViewport ?? null)}, viewportId=${session?.viewportId ?? "none"}, revision=${session?.viewportRevision ?? "none"}.`
      )
    }
    const window = this.getUsableWindow()
    window.webContents.send(BROWSER_PANEL_REQUEST_CHANNEL, {
      threadId,
      panelWidth,
      deviceViewport,
      restoreDefaultPanelWidth
    })
    if (this.activeSession) this.emitState()
  }

  getState(): BrowserState {
    const sessionId = BROWSER_SESSION_ID
    const session = this.getActiveSession()
    if (!session) {
      return {
        sessionId,
        url: "",
        title: "",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        visible: false,
        created: false,
        consoleEntries: [],
        pendingDeviceViewport: this.pendingDeviceViewport
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
      zoomFactor: session.userZoomFactor,
      visible: session.view.getVisible(),
      created: true,
      consoleEntries: session.consoleEntries.slice(),
      pendingDeviceViewport: this.pendingDeviceViewport,
      error: session.error
    }
  }

  getWebContents(): WebContents | null {
    const session = this.getActiveSession()
    if (!session) return null
    const webContents = session.view.webContents
    return webContents.isDestroyed() ? null : webContents
  }

  disposeAll(): string | null {
    const disposedSessionId = this.disposeActiveSession()
    if (disposedSessionId) this.emitState(disposedSessionId)
    return disposedSessionId
  }

  private ensureActiveSession(
    sessionId: string,
    workspacePath: string | null | undefined
  ): BrowserSession {
    const existing = this.activeSession
    if (existing) {
      if (workspacePath !== undefined) existing.workspacePath = workspacePath
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
    configureAutomaticBrowserDownloads(view.webContents.session, (record, completed) =>
      this.updateDownload(record, completed)
    )

    const session: BrowserSession = {
      id: sessionId,
      isAttached: false,
      view,
      targetReady: Promise.resolve(),
      workspacePath: workspacePath ?? null,
      consoleEntries: [],
      nextConsoleEntryId: 1,
      viewportRevision: 0,
      viewportId: null,
      userZoomFactor: 1,
      deviceScaleFactor: 1,
      deviceViewport: null
    }

    this.activeSession = session
    this.configureSessionGuards(session)
    this.bindWebContentsEvents(session)
    session.targetReady = initializeBrowserTarget(view.webContents)
    void session.targetReady.catch((error) => {
      if (this.getActiveSession() !== session || view.webContents.isDestroyed()) return
      session.error = `内置浏览器初始化失败: ${formatError(error)}`
      this.emitState(sessionId)
      console.error(`${BROWSER_SERVICE_LOG_PREFIX} ${session.error}.`)
    })
    return session
  }

  private requireSession(): BrowserSession {
    const session = this.getActiveSession()
    if (!session) {
      throw new Error("Browser session has not been created")
    }
    return session
  }

  private bindWebContentsEvents(session: BrowserSession): void {
    const webContents = session.view.webContents
    const emit = (): void => this.emitState(session.id)
    const ensureScriptRecorder = (): void => {
      if (getScriptRecording().status !== "recording") return
      void installScriptRecorderForSubtree(webContents.mainFrame)
    }

    webContents.on("did-start-loading", () => {
      session.error = undefined
      session.consoleEntries = []
      emit()
    })
    webContents.on("did-stop-loading", () => {
      this.invalidateSession(session)
      ensureScriptRecorder()
      emit()
    })
    webContents.on("dom-ready", () => {
      ensureScriptRecorder()
    })
    webContents.on("frame-created", (_event, details) => {
      const createdFrame = details.frame
      if (!createdFrame) return
      // The frame tree entry can exist before the child document is ready.
      // Wait for the frame's own dom-ready so we don't initialize against a
      // transient document and accidentally block later retries.
      createdFrame.once("dom-ready", () => {
        if (getScriptRecording().status !== "recording") return
        if (createdFrame.detached || createdFrame.isDestroyed()) return
        void installScriptRecorderForSubtree(createdFrame)
      })
    })
    webContents.on(
      "did-frame-finish-load",
      (_event, _isMainFrame, frameProcessId, frameRoutingId) => {
        if (getScriptRecording().status !== "recording") return
        void installScriptRecorderForFrameById(frameProcessId, frameRoutingId)
      }
    )
    webContents.on("page-title-updated", () => {
      emit()
    })
    webContents.on("console-message", (details, level, message, line, sourceId) => {
      recordScriptRecorderConsoleMessage(details.frame, details.message)
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
      // Chromium stores page zoom per origin. Every cross-origin navigation can
      // therefore replace the active device-preview zoom with that origin's saved
      // value, so restore the session's effective zoom for scaled and unscaled views.
      this.applyEffectiveZoom(session)
      const permissionError = getUrlPermissionError(url, session.workspacePath)
      if (permissionError) {
        session.error = permissionError
      }
      recordScriptNavigation(url, "implicit")
      ensureScriptRecorder()
      emit()
    })
    webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) {
        recordScriptNavigation(webContents.getURL(), "implicit")
        emit()
      }
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
        console.error(
          `${BROWSER_SERVICE_LOG_PREFIX} Browser load failed for ${session.id}: ${session.error}.`
        )
      }
    )
    webContents.on("render-process-gone", (_event, details) => {
      console.error(
        `${BROWSER_SERVICE_LOG_PREFIX} Browser renderer ended for ${session.id}: ${details.reason}.`
      )
    })
    webContents.setWindowOpenHandler((details) => {
      const permissionError = getUrlPermissionError(details.url, session.workspacePath)
      if (!permissionError) {
        void this.navigate(details.url, { workspacePath: session.workspacePath })
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

  private emitState(sessionId = BROWSER_SESSION_ID): void {
    const payload = this.getState()
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

  private getActiveSession(): BrowserSession | null {
    return this.activeSession
  }

  private applyEffectiveZoom(session: BrowserSession): void {
    const webContents = session.view.webContents
    if (webContents.isDestroyed()) return
    const nextZoomFactor = session.userZoomFactor * session.deviceScaleFactor
    if (Math.abs(webContents.getZoomFactor() - nextZoomFactor) < 0.001) return
    webContents.setZoomFactor(nextZoomFactor)
  }

  private invalidateSession(session: BrowserSession): void {
    const webContents = session.view.webContents
    if (webContents.isDestroyed()) return
    try {
      webContents.invalidate()
    } catch (error) {
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Browser invalidate failed for ${session.id}: ${formatError(error)}.`
      )
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
        console.warn(
          `${BROWSER_SERVICE_LOG_PREFIX} Browser view detach failed for ${session.id}: ${formatError(error)}.`
        )
      }
    }

    try {
      if (!session.view.webContents.isDestroyed()) {
        session.view.webContents.close({ waitForBeforeUnload: false })
      }
    } catch (error) {
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Browser close failed for ${session.id}: ${formatError(error)}.`
      )
    }

    return session.id
  }
}
