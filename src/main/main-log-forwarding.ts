import { types as nodeUtilTypes } from "node:util"

export interface MainLogForwardWebContents {
  isDestroyed(): boolean
  isCrashed?: () => boolean
  getURL?: () => string
  mainFrame?: {
    detached?: boolean
    isDestroyed?: () => boolean
    url?: string
  }
  send(channel: string, payload: unknown): void
}

export interface MainLogForwardWindow {
  isDestroyed(): boolean
  webContents: MainLogForwardWebContents
}

interface MainLogForwarderOptions {
  channel: string
  isEnabled: () => boolean
  getWindows: () => readonly MainLogForwardWindow[]
  formatValue: (value: unknown) => string
  isTrustedWindow: (window: MainLogForwardWindow) => boolean
  maxMessageChars?: number
  rateWindowMs?: number
  maxMessagesPerWindow?: number
  maxBytesPerWindow?: number
  now?: () => number
}

interface SafeLogMethodOptions {
  level: string
  persist: (level: string, args: unknown[]) => unknown[]
  forward?: (level: string, args: unknown[]) => void
  sink: (...args: unknown[]) => void
  processingGuard: SafeLogProcessingGuard
}

const LOG_PROCESSING_FAILED_ARGS = ["[Main] Log processing failed"] as const
const LOG_PROCESSING_REENTRY_ARGS = ["[Main] Recursive log processing suppressed"] as const
const MAIN_LOG_TRUNCATION_MARKER = "…[main-log-truncated]"
export const MAIN_LOG_MESSAGE_MAX_CHARS = 16 * 1024
export const MAIN_LOG_FORWARD_RATE_WINDOW_MS = 1_000
export const MAIN_LOG_FORWARD_MAX_MESSAGES_PER_WINDOW = 128
export const MAIN_LOG_FORWARD_MAX_BYTES_PER_WINDOW = 256 * 1024
export const MAIN_LOG_DROPPED_SUMMARY =
  "[Main] Renderer log messages were dropped to protect application responsiveness"

export interface SafeLogProcessingGuard {
  processing: boolean
}

export interface MainLogForwardingGate {
  isEnabled: () => boolean
  setFromTrustedRenderer: (enabled: boolean) => void
  disableForLifecycle: () => void
}

interface TrustedToggleRequest {
  enabled: unknown
  expectedWebContents: object | null | undefined
  sender: object | null | undefined
  expectedMainFrame: object | null | undefined
  senderFrame: object | null | undefined
  expectedRendererUrl: string | undefined
  senderUrl: unknown
  senderFrameUrl: unknown
}

interface SafeProcessErrorHandlerOptions {
  prefix: string
  write: (...args: unknown[]) => void
  flush?: () => void
}

function normalizeRendererUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  try {
    const url = new URL(value)
    url.search = ""
    url.hash = ""
    return url
  } catch {
    return undefined
  }
}

function isLocalRendererUrl(url: URL): boolean {
  if (url.protocol === "file:") return url.hostname === ""
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
}

/** Normalize the one URL that is allowed to participate in main-log IPC. */
export function resolveTrustedRendererUrl(value: unknown): string | undefined {
  const url = normalizeRendererUrl(value)
  return url && isLocalRendererUrl(url) ? url.href : undefined
}

/** Query/hash may carry HMR state; origin and pathname must still match exactly. */
export function isTrustedRendererUrl(actual: unknown, expected: string | undefined): boolean {
  if (!expected) return false
  const actualUrl = normalizeRendererUrl(actual)
  const expectedUrl = normalizeRendererUrl(expected)
  return Boolean(
    actualUrl &&
    expectedUrl &&
    isLocalRendererUrl(expectedUrl) &&
    actualUrl.href === expectedUrl.href
  )
}

export function isTrustedMainLogToggleRequest(request: TrustedToggleRequest): boolean {
  return (
    typeof request.enabled === "boolean" &&
    request.expectedWebContents !== null &&
    request.expectedWebContents !== undefined &&
    request.sender === request.expectedWebContents &&
    request.expectedMainFrame !== null &&
    request.expectedMainFrame !== undefined &&
    request.senderFrame === request.expectedMainFrame &&
    isTrustedRendererUrl(request.senderUrl, request.expectedRendererUrl) &&
    isTrustedRendererUrl(request.senderFrameUrl, request.expectedRendererUrl)
  )
}

export function createSafeLogProcessingGuard(): SafeLogProcessingGuard {
  return { processing: false }
}

/**
 * Keep renderer opt-in separate from lifecycle revocation. A navigation, crash,
 * unresponsive renderer, or window teardown always closes the gate; only a new
 * trusted main-frame IPC request may open it again.
 */
export function createMainLogForwardingGate(initiallyEnabled = false): MainLogForwardingGate {
  let enabled = initiallyEnabled === true
  return {
    isEnabled: () => enabled,
    setFromTrustedRenderer: (nextEnabled) => {
      enabled = nextEnabled
    },
    disableForLifecycle: () => {
      enabled = false
    }
  }
}

export function isEpipeError(error: unknown): boolean {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return false
  try {
    // Fatal/error-stream handlers run before the normal logging guard. Never
    // execute user-controlled Proxy traps or a `code` getter while deciding
    // whether an error is safe to ignore.
    if (nodeUtilTypes.isProxy(error)) return false
    const descriptor = Object.getOwnPropertyDescriptor(error, "code")
    return Boolean(descriptor && "value" in descriptor && descriptor.value === "EPIPE")
  } catch {
    return false
  }
}

export function createSafeProcessErrorHandler(
  options: SafeProcessErrorHandlerOptions
): (error: unknown) => void {
  return (error): void => {
    if (isEpipeError(error)) return
    try {
      options.write(options.prefix, error)
    } catch {
      // The emergency sink must remain safe even if it is replaced at runtime.
    }
    try {
      options.flush?.()
    } catch {
      // Fatal error reporting must not throw a second exception from logging code.
    }
  }
}

function formatBoundedMessage(
  args: unknown[],
  formatValue: (value: unknown) => string,
  maxChars: number
): string {
  const normalizedMax = Number.isFinite(maxChars)
    ? Math.floor(maxChars)
    : MAIN_LOG_MESSAGE_MAX_CHARS
  const boundedMax = Math.max(MAIN_LOG_TRUNCATION_MARKER.length, normalizedMax)
  let message = ""
  for (const arg of args) {
    const separator = message ? " " : ""
    const formatted = formatValue(arg)
    if (message.length + separator.length + formatted.length <= boundedMax) {
      message += `${separator}${formatted}`
      continue
    }
    const prefixLimit = boundedMax - MAIN_LOG_TRUNCATION_MARKER.length
    let prefix = message.slice(0, prefixLimit)
    if (prefix.length < prefixLimit && separator) prefix += separator
    if (prefix.length < prefixLimit) {
      prefix += formatted.slice(0, prefixLimit - prefix.length)
    }
    return `${prefix}${MAIN_LOG_TRUNCATION_MARKER}`
  }
  return message
}

function readUnavailable(check: (() => boolean) | undefined): boolean {
  if (!check) return false
  try {
    return check() === true
  } catch {
    // A destroyed Electron object can throw while its state is queried. Treat it
    // as unavailable instead of attempting an IPC send during the teardown race.
    return true
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const normalized = Math.floor(value)
  return normalized >= 1 ? normalized : fallback
}

function getSendableWebContents(
  window: MainLogForwardWindow
): MainLogForwardWebContents | undefined {
  try {
    if (readUnavailable(window.isDestroyed.bind(window))) return undefined

    const contents = window.webContents
    if (!contents || readUnavailable(contents.isDestroyed.bind(contents))) return undefined
    if (readUnavailable(contents.isCrashed?.bind(contents))) return undefined

    // `mainFrame.detached` is available in current Electron versions. Keep every
    // frame field optional so older runtimes can use the same guard safely.
    const frame = contents.mainFrame
    if (frame?.detached === true || readUnavailable(frame?.isDestroyed?.bind(frame))) {
      return undefined
    }
    return contents
  } catch {
    // The window may be destroyed between any two property reads.
    return undefined
  }
}

/**
 * Build a fail-closed renderer log forwarder.
 *
 * Electron can synchronously call `console.error` from `webContents.send` when a
 * frame disappears. The latch therefore covers formatting, enumeration, and the
 * complete send loop; a nested console call is persisted locally but cannot
 * enter renderer IPC again.
 */
export function createMainLogForwarder(
  options: MainLogForwarderOptions
): (level: string, args: unknown[]) => void {
  let forwarding = false
  const rateWindowMs = normalizePositiveInteger(
    options.rateWindowMs,
    MAIN_LOG_FORWARD_RATE_WINDOW_MS
  )
  const maxMessagesPerWindow = normalizePositiveInteger(
    options.maxMessagesPerWindow,
    MAIN_LOG_FORWARD_MAX_MESSAGES_PER_WINDOW
  )
  const maxBytesPerWindow = normalizePositiveInteger(
    options.maxBytesPerWindow,
    MAIN_LOG_FORWARD_MAX_BYTES_PER_WINDOW
  )
  let rateWindowStartedAt: number | undefined
  let sentMessages = 0
  let sentBytes = 0
  let droppedSinceLastSummary = false
  let droppedSummaryAvailable = false

  const rollRateWindow = (): void => {
    let now: number
    try {
      now = options.now?.() ?? Date.now()
    } catch {
      now = Date.now()
    }
    if (!Number.isFinite(now)) now = Date.now()
    if (rateWindowStartedAt === undefined) {
      rateWindowStartedAt = now
      return
    }
    if (now >= rateWindowStartedAt && now - rateWindowStartedAt < rateWindowMs) return

    rateWindowStartedAt = now
    sentMessages = 0
    sentBytes = 0
    // A summary is emitted lazily, only if a later business log has a trusted,
    // sendable target. No timer is armed, so a failed summary cannot create an
    // autonomous retry loop.
    droppedSummaryAvailable = droppedSinceLastSummary
  }

  const reserveBudget = (message: string): boolean => {
    const messageBytes = Buffer.byteLength(message, "utf8")
    if (
      sentMessages + 1 > maxMessagesPerWindow ||
      sentBytes + messageBytes > maxBytesPerWindow
    ) {
      droppedSinceLastSummary = true
      return false
    }
    sentMessages += 1
    sentBytes += messageBytes
    return true
  }

  const sendWithBudget = (
    contents: MainLogForwardWebContents,
    level: string,
    message: string
  ): void => {
    if (!reserveBudget(message)) return
    try {
      contents.send(options.channel, { level, message })
    } catch {
      // The budget is intentionally not refunded: retrying a failing target in
      // the same window would defeat the circuit breaker.
      droppedSinceLastSummary = true
    }
  }

  return (level, args): void => {
    if (forwarding) {
      // This covers Electron's synchronous send -> console fallback. Async
      // fallbacks are bounded by the same rate budget and stop generating work
      // as soon as one forwarding attempt is dropped.
      droppedSinceLastSummary = true
      return
    }
    forwarding = true
    try {
      if (!options.isEnabled()) return
      rollRateWindow()
      const message = formatBoundedMessage(
        args,
        options.formatValue,
        options.maxMessageChars ?? MAIN_LOG_MESSAGE_MAX_CHARS
      )
      const windows = options.getWindows()
      for (const window of windows) {
        let trusted = false
        try {
          trusted = options.isTrustedWindow(window)
        } catch {
          continue
        }
        if (!trusted) continue
        const contents = getSendableWebContents(window)
        if (!contents) continue
        if (droppedSummaryAvailable) {
          // Consume the one summary opportunity before sending. A synchronous
          // or asynchronous fallback can mark another summary for a later rate
          // window, but can never recursively emit one in this window.
          droppedSummaryAvailable = false
          droppedSinceLastSummary = false
          sendWithBudget(contents, "WARN", MAIN_LOG_DROPPED_SUMMARY)
        }
        sendWithBudget(contents, level, message)
      }
    } catch {
      // Formatting and window enumeration are logging infrastructure too. They
      // must never make the originating application call fail.
    } finally {
      forwarding = false
    }
  }
}

/**
 * Wrap one console method without allowing persistence, forwarding, or the
 * underlying terminal sink to throw back into business code.
 */
export function createSafeLogMethod(options: SafeLogMethodOptions): (...args: unknown[]) => void {
  return (...args): void => {
    if (options.processingGuard.processing) {
      try {
        options.sink(...LOG_PROCESSING_REENTRY_ARGS)
      } catch {
        // Keep recursive logging on the captured raw sink and nowhere else.
      }
      return
    }

    let persistedArgs: unknown[]
    options.processingGuard.processing = true
    try {
      const result = options.persist(options.level, args)
      persistedArgs = Array.isArray(result) ? result : [...LOG_PROCESSING_FAILED_ARGS]
    } catch {
      // Do not pass unredacted input to another sink if projection/redaction fails.
      persistedArgs = [...LOG_PROCESSING_FAILED_ARGS]
    } finally {
      options.processingGuard.processing = false
    }

    if (options.forward) {
      try {
        options.forward(options.level, persistedArgs)
      } catch {
        // Forwarding is optional diagnostics and cannot fail the caller.
      }
    }

    try {
      options.sink(...persistedArgs)
    } catch {
      // stdout/stderr can fail for reasons beyond EPIPE during app shutdown.
    }
  }
}
