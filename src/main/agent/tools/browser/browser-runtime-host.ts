import { randomUUID } from "crypto"
import { createConnection, type Socket } from "net"
import type { BrowserToolState } from "../../../../shared/browser-types"
import type { ApprovalDecision, ApprovalRequest } from "../../../types"
import {
  assertBrowserBudgetBytes,
  DEFAULT_BROWSER_PERFORMANCE_BUDGET,
  truncateBrowserString,
  type BrowserPerformanceBudget
} from "../../../browser/browser-performance-budget"
import { createBrowserNativePipeBridge } from "../../../browser/browser-native-pipe-server"
import { createBrowserOfficialBackendAdapter } from "../../../browser/browser-official-backend-adapter"
import {
  ensureBrowserRuntimeTmpDir,
  getOfficialBrowserUseIabPipePath,
  getBrowserRuntimeTmpDir,
  isOfficialBrowserUsePipePath,
  isSupportedNativePipePath
} from "../../../browser/browser-platform"

const TOOL_SURFACE_META_KEY = "codex/toolSurface"

export interface BrowserRuntimeHostContext {
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  workspacePath: string
  threadId?: string
  budget?: BrowserPerformanceBudget
}

export interface BrowserRuntimeImage {
  byteLength: number
  dataUrl: string
  mimeType: string
}

export interface BrowserRuntimeHostState {
  bootstrapState: BrowserToolState["bootstrapState"]
  globals: Record<string, unknown>
  images: BrowserRuntimeImage[]
  lastError?: string
  lastMeta?: unknown
  lastWrite?: unknown
  logs: string[]
  toolState: BrowserToolState
}

export interface BrowserRuntimeNodeReplHost {
  budget: BrowserPerformanceBudget
  globals: Record<string, unknown>
  state: BrowserRuntimeHostState
  dispose(): void
  formatOutput(value: unknown): string
  markBootstrapFailed(error: unknown): void
  markBootstrapping(): void
  markReady(): void
  resetTurnOutput(): void
}

function getBrowserSessionId(threadId: string | undefined): string {
  return `thread-${threadId || "unbound"}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined
}

function normalizeBackend(value: unknown): BrowserToolState["backend"] | undefined {
  if (value === "iab") return "iab"
  if (value === "chrome" || value === "extension") return "chrome"
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bytesToDataUrl(bytes: Uint8Array, mimeType = "image/png"): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`
}

function imageByteLengthFromDataUrl(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return Buffer.byteLength(dataUrl, "utf8")
  const metadata = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (metadata.includes(";base64")) return Buffer.byteLength(payload, "base64")
  return Buffer.byteLength(decodeURIComponent(payload), "utf8")
}

function coerceImageBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}

function safeConsoleValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function cloneConfigValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function getElicitationOrigin(request: Record<string, unknown>): string | undefined {
  const meta = asRecord(request.meta)
  const toolParams = asRecord(meta?.tool_params)
  return (
    stringValue(toolParams?.origin) ??
    stringValue(meta?.origin) ??
    stringValue(toolParams?.url) ??
    stringValue(meta?.url)
  )
}

function approvalTypeToElicitationResponse(
  decision: ApprovalDecision,
  request: Record<string, unknown>
): Record<string, unknown> {
  switch (decision.type) {
    case "approve_permanent":
      return {
        action: "accept",
        meta: { persist: "always" }
      }
    case "approve_session":
      return {
        action: "accept",
        meta: { persist: "session" }
      }
    case "approve":
      return {
        action: "accept",
        meta: {
          approvals_reviewer: "guardian_subagent"
        }
      }
    case "reject":
      return {
        action: "decline"
      }
    default:
      return {
        action: "cancel",
        message: stringValue(request.message) ?? "Browser approval was not granted"
      }
  }
}

function sanitizeResponseMetaForBudget(meta: unknown): unknown {
  const root = asRecord(meta)
  if (!root) return meta
  const surface = asRecord(root[TOOL_SURFACE_META_KEY])
  if (!surface) return meta
  const screenshot = asRecord(surface.screenshot)
  if (!screenshot || typeof screenshot.url !== "string") return meta
  return {
    ...root,
    [TOOL_SURFACE_META_KEY]: {
      ...surface,
      screenshot: {
        ...screenshot,
        url: `[screenshot ${imageByteLengthFromDataUrl(screenshot.url)} bytes]`
      }
    }
  }
}

function mapBrowserToolState(
  meta: unknown,
  current: BrowserToolState,
  budget: BrowserPerformanceBudget
): BrowserToolState {
  const root = asRecord(meta)
  if (!root) return current

  const surface = asRecord(root[TOOL_SURFACE_META_KEY])
  const browserUse = asRecord(root.browser_use)
  const screenshot = asRecord(surface?.screenshot)
  const screenshotUrl = stringValue(screenshot?.url)
  let screenshotError: string | undefined
  let nextScreenshotUrl = current.screenshotUrl

  if (screenshotUrl) {
    const byteLength = imageByteLengthFromDataUrl(screenshotUrl)
    if (byteLength <= budget.maxScreenshotBytes) {
      nextScreenshotUrl = screenshotUrl
    } else {
      screenshotError = `Browser screenshot exceeded budget (${byteLength} bytes > ${budget.maxScreenshotBytes} bytes)`
    }
  }

  return {
    ...current,
    backend: normalizeBackend(surface?.backend) ?? current.backend,
    browserId: stringValue(surface?.browserId) ?? current.browserId,
    currentUrl:
      stringValue(browserUse?.url) ??
      stringValue(surface?.currentUrl) ??
      stringValue(root.currentUrl) ??
      current.currentUrl,
    openTabIds: stringArray(surface?.openTabIds) ?? current.openTabIds,
    selectedTabId:
      stringValue(surface?.selectedTabId) ??
      stringValue(screenshot?.tabId) ??
      current.selectedTabId,
    screenshotUrl: nextScreenshotUrl,
    error: screenshotError ?? current.error
  }
}

export function createBrowserRuntimeNodeReplHost(
  context: BrowserRuntimeHostContext
): BrowserRuntimeNodeReplHost {
  const budget = context.budget ?? DEFAULT_BROWSER_PERFORMANCE_BUDGET
  const sessionId = getBrowserSessionId(context.threadId)
  const state: BrowserRuntimeHostState = {
    bootstrapState: "idle",
    globals: {},
    images: [],
    logs: [],
    toolState: {
      runtime: "official",
      bootstrapState: "idle"
    }
  }
  const screenshotTimestamps: number[] = []

  const updateToolState = (patch: Partial<BrowserToolState>): void => {
    state.toolState = {
      ...state.toolState,
      ...patch
    }
    state.bootstrapState = state.toolState.bootstrapState
  }

  const enforceScreenshotBudget = (byteLength: number): void => {
    if (byteLength > budget.maxScreenshotBytes) {
      throw new Error(
        `Browser screenshot exceeds budget (${byteLength} bytes > ${budget.maxScreenshotBytes} bytes)`
      )
    }
    const cutoff = Date.now() - 60_000
    while (screenshotTimestamps.length > 0 && screenshotTimestamps[0] < cutoff) {
      screenshotTimestamps.shift()
    }
    if (screenshotTimestamps.length >= budget.maxScreenshotsPerMinute) {
      throw new Error(
        `Browser screenshot rate exceeded (${budget.maxScreenshotsPerMinute}/minute)`
      )
    }
    screenshotTimestamps.push(Date.now())
  }

  const setResponseMeta = (meta: unknown): void => {
    assertBrowserBudgetBytes(
      "Browser response meta",
      sanitizeResponseMetaForBudget(meta),
      budget.maxResponseMetaBytes
    )
    state.lastMeta = meta
    state.toolState = mapBrowserToolState(meta, state.toolState, budget)
  }

  const emitImage = async (value: unknown): Promise<BrowserRuntimeImage> => {
    const rawDataUrl = typeof value === "string" && value.startsWith("data:image/") ? value : null
    const bytes = rawDataUrl ? null : coerceImageBytes(value)
    if (!rawDataUrl && !bytes) {
      throw new Error("Browser emitImage expects image bytes or a data:image URL")
    }

    const dataUrl = rawDataUrl ?? bytesToDataUrl(bytes!)
    const byteLength = rawDataUrl ? imageByteLengthFromDataUrl(rawDataUrl) : bytes!.byteLength
    enforceScreenshotBudget(byteLength)

    const mimeType = dataUrl.slice("data:".length, dataUrl.indexOf(";")) || "image/png"
    const image = { byteLength, dataUrl, mimeType }
    state.images.push(image)
    state.lastWrite = `[${mimeType} ${byteLength} bytes]`
    updateToolState({ screenshotUrl: dataUrl, error: undefined })
    return image
  }

  const write = (value: unknown): unknown => {
    assertBrowserBudgetBytes("Browser runtime output", value, budget.maxMessageBytes)
    state.lastWrite = value
    return value
  }

  const isBrowserTelemetryUrl = (input: Parameters<typeof fetch>[0]): boolean => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof Request !== "undefined" && input instanceof Request
            ? input.url
            : ""
    try {
      const url = new URL(rawUrl)
      return url.hostname === "ab.chatgpt.com" || url.hostname.endsWith(".sentry.io")
    } catch {
      return false
    }
  }

  const runtimeFetch: typeof fetch = async (input, init) => {
    if (isBrowserTelemetryUrl(input)) {
      return new Response(null, { status: 204 })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), budget.operationTimeoutMs)
    timeout.unref?.()
    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ?? controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  const connectExternalNativePipe = (pipePath: string): Promise<Socket> => {
    if (!isOfficialBrowserUsePipePath(pipePath)) {
      throw new Error(`Browser native pipe path is outside the official Browser namespace: ${pipePath}`)
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection(pipePath)
      const onError = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once("error", onError)
      socket.once("connect", () => {
        socket.off("error", onError)
        console.log(`[BrowserRuntime] external native pipe connected for ${context.threadId ?? "unbound"}.`)
        resolve(socket)
      })
    })
  }

  const configStore = new Map<string, unknown>()
  const tomlConfigStore = new Map<string, unknown>()
  const turnMetadata = {
    session_id: sessionId,
    thread_id: context.threadId,
    thread_source: "desktop",
    turn_id: "browser-plugin-runtime"
  }
  void ensureBrowserRuntimeTmpDir().catch((error) => {
    state.lastError = errorMessage(error)
  })
  const nativePipeBridge = createBrowserNativePipeBridge({
    backend: createBrowserOfficialBackendAdapter({
      budget,
      sessionId,
      threadId: context.threadId,
      workspacePath: context.workspacePath
    }),
    phase: 2,
    pipePath: getOfficialBrowserUseIabPipePath(sessionId),
    sessionId
  })

  const nodeRepl = {
    cwd: context.workspacePath,
    tmpDir: getBrowserRuntimeTmpDir(),
    requestMeta: {
      ...turnMetadata,
      "x-codex-turn-metadata": turnMetadata
    },
    write,
    setResponseMeta,
    emitImage,
    nativePipe: {
      async createConnection(pipePath: string) {
        if (!isSupportedNativePipePath(pipePath)) {
          throw new Error(`Unsupported Browser native pipe path: ${pipePath}`)
        }
        if (pipePath === nativePipeBridge.pipePath) {
          return nativePipeBridge.createConnection(pipePath)
        }
        return connectExternalNativePipe(pipePath)
      }
    },
    async createElicitation(request: unknown): Promise<Record<string, unknown>> {
      const requestRecord = asRecord(request) ?? {}
      const origin = getElicitationOrigin(requestRecord)
      const message =
        stringValue(requestRecord.message) ??
        (origin ? `Allow Browser Use to access ${origin}?` : "Allow Browser Use action?")

      if (!context.requestApproval) {
        console.warn(`[BrowserRuntime] elicitation unavailable for ${context.threadId ?? "unbound"} because approval is missing.`)
        return {
          action: "decline",
          reason: "Browser runtime approval is not available"
        }
      }

      const requestId = randomUUID()
      const toolCallId = randomUUID()
      const command = origin ? `browser access ${origin}` : "browser action approval"
      const approval = await context.requestApproval({
        id: requestId,
        tool_call: {
          id: toolCallId,
          name: "browser_access_origin",
          args: {
            message,
            origin,
            request: requestRecord
          }
        },
        safety_level: "needs_approval",
        command,
        cwd: context.workspacePath,
        params: {
          connector: "browser-use",
          origin,
          requestKind: asRecord(requestRecord.meta)?.codex_approval_kind
        },
        reason: message,
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "approve_session", "approve_permanent", "reject"]
      })

      console.log(`[BrowserRuntime] elicitation resolved for ${origin ?? "unknown"} with ${approval.type}.`)
      return approvalTypeToElicitationResponse(approval, requestRecord)
    },
    env: { ...process.env },
    config: {
      async readRequirements() {
        return {}
      },
      async read() {
        return {}
      },
      async readToml(key: string) {
        return cloneConfigValue(tomlConfigStore.get(key)) ?? {}
      },
      async writeToml(key: string, value: unknown) {
        tomlConfigStore.set(key, cloneConfigValue(value))
      },
      get(key: string) {
        return configStore.get(key)
      },
      set(key: string, value: unknown) {
        configStore.set(key, value)
      },
      delete(key: string) {
        return configStore.delete(key)
      }
    },
    fetch: runtimeFetch
  }

  const globals = state.globals
  globals.globalThis = globals
  globals.nodeRepl = nodeRepl
  globals.fetch = runtimeFetch
  globals.console = {
    log: (...values: unknown[]) => {
      state.logs.push(values.map(safeConsoleValue).join(" "))
      if (state.logs.length > budget.maxLogEntriesPerSession) {
        state.logs.splice(0, state.logs.length - budget.maxLogEntriesPerSession)
      }
    },
    info: (...values: unknown[]) => {
      state.logs.push(values.map(safeConsoleValue).join(" "))
      if (state.logs.length > budget.maxLogEntriesPerSession) {
        state.logs.splice(0, state.logs.length - budget.maxLogEntriesPerSession)
      }
    },
    warn: (...values: unknown[]) => {
      state.logs.push(values.map(safeConsoleValue).join(" "))
      if (state.logs.length > budget.maxLogEntriesPerSession) {
        state.logs.splice(0, state.logs.length - budget.maxLogEntriesPerSession)
      }
    },
    error: (...values: unknown[]) => {
      state.logs.push(values.map(safeConsoleValue).join(" "))
      if (state.logs.length > budget.maxLogEntriesPerSession) {
        state.logs.splice(0, state.logs.length - budget.maxLogEntriesPerSession)
      }
    }
  }
  globals.Buffer = Buffer
  globals.URL = URL
  globals.setTimeout = setTimeout
  globals.clearTimeout = clearTimeout

  return {
    budget,
    globals,
    state,
    dispose(): void {
      nativePipeBridge.dispose()
    },
    formatOutput(value: unknown): string {
      if (value === undefined) return ""
      if (typeof value === "string") return truncateBrowserString(value, budget.maxMessageBytes)
      if (value instanceof Uint8Array) return `[Uint8Array ${value.byteLength} bytes]`
      if (value instanceof Error) return value.stack || value.message
      try {
        return truncateBrowserString(JSON.stringify(value, null, 2), budget.maxMessageBytes)
      } catch {
        return truncateBrowserString(String(value), budget.maxMessageBytes)
      }
    },
    markBootstrapFailed(error: unknown): void {
      const message = errorMessage(error)
      state.lastError = message
      updateToolState({ bootstrapState: "failed", error: message })
    },
    markBootstrapping(): void {
      updateToolState({ bootstrapState: "bootstrapping", error: undefined })
    },
    markReady(): void {
      updateToolState({ bootstrapState: "ready", error: undefined })
    },
    resetTurnOutput(): void {
      state.lastWrite = undefined
      state.logs = []
    }
  }
}
