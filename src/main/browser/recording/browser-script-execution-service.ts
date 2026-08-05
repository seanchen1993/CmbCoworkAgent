import { parse, type Node } from "acorn"
import path from "node:path"
import { getCurrentBrowserCdpPort } from "../cdp/browser-cdp"
import { getGlobalBrowserService } from "../core/browser-service-registry"
import {
  applyAiRecordingVariableValues,
  buildAiRecordingExecutableScript
} from "../../../shared/browser-ai-recording-script"
import type {
  BrowserScriptExecutionInput,
  BrowserScriptExecutionState,
  BrowserState
} from "../../../shared/browser-types"

const BROWSER_SCRIPT_EXECUTION_LOG_PREFIX = "[内置浏览器][BrowserScriptExecution]"
const TARGET_DISCOVERY_TIMEOUT_MS = 5_000
const TARGET_DISCOVERY_POLL_MS = 50

type PlaywrightBrowser = import("playwright").Browser
type PlaywrightBrowserContext = import("playwright").BrowserContext
type PlaywrightPage = import("playwright").Page

interface AcornNode extends Node {
  start: number
  end: number
  body?: unknown
}

type AsyncFunctionType = (
  page: PlaywrightPage,
  browser: PlaywrightBrowser,
  context: PlaywrightBrowserContext,
  expect: unknown,
  __updatePlaybackProgress: (completedSteps: number) => Promise<void>
) => Promise<void>

const AsyncFunction = Object.getPrototypeOf(async function () {
  return undefined
}).constructor as new (...args: string[]) => AsyncFunctionType

class BrowserScriptExecutionCancelledError extends Error {
  constructor() {
    super("回放已终止")
    this.name = "BrowserScriptExecutionCancelledError"
  }
}

interface ActiveBrowserScriptExecution {
  cancelled: boolean
  cancel: () => Promise<boolean>
}

const EMPTY_BROWSER_SCRIPT_EXECUTION_STATE: BrowserScriptExecutionState = {
  status: "idle"
}

const browserScriptExecutionStateListeners = new Set<(state: BrowserScriptExecutionState) => void>()

let browserScriptExecutionState: BrowserScriptExecutionState = EMPTY_BROWSER_SCRIPT_EXECUTION_STATE
let activeBrowserScriptExecution: ActiveBrowserScriptExecution | null = null

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneBrowserScriptExecutionState(
  state: BrowserScriptExecutionState
): BrowserScriptExecutionState {
  return { ...state }
}

function emitBrowserScriptExecutionState(state: BrowserScriptExecutionState): void {
  browserScriptExecutionState = cloneBrowserScriptExecutionState(state)
  for (const listener of browserScriptExecutionStateListeners) {
    listener(cloneBrowserScriptExecutionState(state))
  }
}

function getExecutionLabel(input: BrowserScriptExecutionInput): string {
  const label = input.label?.trim()
  if (label) return label
  const fileName = input.fileName?.trim()
  if (fileName) return fileName
  return "当前脚本"
}

function getExecutionFileName(input: BrowserScriptExecutionInput): string {
  const fileName = input.fileName?.trim()
  if (fileName) return fileName
  return getExecutionLabel(input)
}

function createExecutionState(
  input: BrowserScriptExecutionInput,
  status: BrowserScriptExecutionState["status"],
  options?: { error?: string; startedAt?: string; endedAt?: string; progressPercent?: number }
): BrowserScriptExecutionState {
  return {
    status,
    fileName: getExecutionFileName(input),
    label: getExecutionLabel(input),
    threadId: input.threadId ?? null,
    startedAt: options?.startedAt,
    endedAt: options?.endedAt,
    error: options?.error,
    progressPercent: options?.progressPercent
  }
}

export function isBrowserScriptExecutionCancelledError(error: unknown): boolean {
  return error instanceof BrowserScriptExecutionCancelledError
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampProgressPercent(completedSteps: number, totalSteps: number): number {
  if (totalSteps <= 0) return completedSteps <= 0 ? 0 : 100
  return Math.max(0, Math.min(100, Math.round((completedSteps / totalSteps) * 100)))
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

function resolveUploadPath(pathValue: string, workspacePath?: string | null): string {
  const normalizedWorkspacePath = workspacePath?.trim()
  const trimmedPathValue = pathValue.trim()
  if (!normalizedWorkspacePath || !trimmedPathValue || path.isAbsolute(trimmedPathValue)) {
    return trimmedPathValue || pathValue
  }

  return path.resolve(normalizedWorkspacePath, trimmedPathValue)
}

function resolveUploadArgument<T>(value: T, workspacePath?: string | null): T {
  if (typeof value === "string") {
    return resolveUploadPath(value, workspacePath) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" ? resolveUploadPath(item, workspacePath) : item
    ) as T
  }

  return value
}

function createUploadAwarePlaybackWrapper(workspacePath?: string | null): <T>(value: T) => T {
  const cache = new WeakMap<object, unknown>()

  const wrap = <T>(value: T): T => {
    if (isPromiseLike(value)) return value
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return value

    const cached = cache.get(value as object)
    if (cached) return cached as T

    const proxy = new Proxy(value as object, {
      get(target, property) {
        const nextValue = Reflect.get(target, property, target)
        if (typeof nextValue !== "function") return wrap(nextValue)

        return (...args: unknown[]) => {
          const nextArgs =
            property === "setInputFiles" || property === "setFiles"
              ? [resolveUploadArgument(args[0], workspacePath), ...args.slice(1)]
              : args
          const result = Reflect.apply(nextValue, target, nextArgs)
          return isPromiseLike(result) ? result.then((resolved) => wrap(resolved)) : wrap(result)
        }
      }
    })

    cache.set(value as object, proxy)
    return proxy as T
  }

  return wrap
}

function buildInstrumentedExecutionScript(source: string): { source: string; totalSteps: number } {
  let program: AcornNode
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: false
    }) as unknown as AcornNode
  } catch {
    return { source, totalSteps: 0 }
  }

  const statements = Array.isArray(program.body) ? (program.body as AcornNode[]) : []
  if (statements.length === 0) {
    return { source, totalSteps: 0 }
  }

  const pieces: string[] = []
  let cursor = 0
  for (const [index, statement] of statements.entries()) {
    pieces.push(source.slice(cursor, statement.end))
    pieces.push(`\nawait __updatePlaybackProgress(${index + 1});`)
    cursor = statement.end
  }
  pieces.push(source.slice(cursor))

  return {
    source: pieces.join(""),
    totalSteps: statements.length
  }
}

function formatBrowserTarget(state: BrowserState): string {
  return `url=${state.url || "(empty)"} title=${state.title || "(empty)"}`
}

function findLastMatchingPage(
  browser: PlaywrightBrowser,
  predicate: (page: PlaywrightPage) => boolean
): { context: PlaywrightBrowserContext; page: PlaywrightPage } | null {
  let match: { context: PlaywrightBrowserContext; page: PlaywrightPage } | null = null
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (predicate(page)) match = { context, page }
    }
  }
  return match
}

async function findBrowserPanelPage(
  browser: PlaywrightBrowser,
  state: BrowserState,
  isCancelled: () => boolean
): Promise<{ context: PlaywrightBrowserContext; page: PlaywrightPage } | null> {
  if (isCancelled()) return null

  const targetUrl = state.url.trim()
  if (targetUrl) {
    const urlMatch = findLastMatchingPage(browser, (page) => page.url() === targetUrl)
    if (urlMatch) return urlMatch
  }

  const targetTitle = state.title.trim()
  if (targetTitle) {
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages().map((page) => ({ context, page })))
    const titles = await Promise.all(
      pages.map(async ({ page }) => {
        try {
          return await page.title()
        } catch {
          return ""
        }
      })
    )
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      if (titles[index] === targetTitle) return pages[index] ?? null
    }
  }

  if (!targetUrl || targetUrl === "about:blank") {
    return findLastMatchingPage(browser, (page) => page.url() === "about:blank")
  }

  return null
}

async function waitForBrowserPanelPage(
  browser: PlaywrightBrowser,
  state: BrowserState,
  isCancelled: () => boolean
): Promise<{ context: PlaywrightBrowserContext; page: PlaywrightPage }> {
  const deadline = Date.now() + TARGET_DISCOVERY_TIMEOUT_MS
  while (true) {
    if (isCancelled()) {
      throw new BrowserScriptExecutionCancelledError()
    }

    const target = await findBrowserPanelPage(browser, state, isCancelled)
    if (target) return target

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`未找到 BrowserPanel 对应的 CDP target（${formatBrowserTarget(state)}）`)
    }
    await delay(Math.min(TARGET_DISCOVERY_POLL_MS, remaining))
  }
}

async function connectInAppBrowser(options: {
  threadId?: string | null
  workspacePath?: string | null
  isCancelled: () => boolean
}): Promise<{
  browser: PlaywrightBrowser
  context: PlaywrightBrowserContext
  page: PlaywrightPage
}> {
  const browserService = getGlobalBrowserService()
  if (!browserService) {
    throw new Error("In-app browser service is unavailable")
  }

  const cdpPort = getCurrentBrowserCdpPort()
  if (cdpPort === null) {
    throw new Error("Browser CDP endpoint is not configured")
  }

  browserService.requestPanel(options.threadId ?? undefined)
  const targetState = await browserService.prepareTarget({
    workspacePath: options.workspacePath ?? undefined,
    visible: true
  })
  if (options.isCancelled()) {
    throw new BrowserScriptExecutionCancelledError()
  }

  const { chromium } = await import("playwright")
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  try {
    const { context, page } = await waitForBrowserPanelPage(
      browser,
      targetState,
      options.isCancelled
    )
    return { browser, context, page }
  } catch (error) {
    await closeBrowserConnection(browser)
    throw error
  }
}

function buildExecutionScript(
  script: string,
  variableValues?: BrowserScriptExecutionInput["variableValues"]
): { source: string; totalSteps: number } {
  const executableSource = buildAiRecordingExecutableScript(
    applyAiRecordingVariableValues(script, variableValues)
  )
  const instrumented = buildInstrumentedExecutionScript(executableSource)
  return {
    source: ["const test = { step: async (_name, fn) => await fn() };", instrumented.source].join(
      "\n"
    ),
    totalSteps: instrumented.totalSteps
  }
}

async function closeBrowserConnection(browser: PlaywrightBrowser): Promise<void> {
  const disconnectableBrowser = browser as PlaywrightBrowser & {
    disconnect?: () => void
  }
  if (typeof disconnectableBrowser.disconnect === "function") {
    disconnectableBrowser.disconnect()
    return
  }

  await browser.close()
}

export function getBrowserScriptExecutionState(): BrowserScriptExecutionState {
  return cloneBrowserScriptExecutionState(browserScriptExecutionState)
}

export function onBrowserScriptExecutionStateChange(
  listener: (state: BrowserScriptExecutionState) => void
): () => void {
  browserScriptExecutionStateListeners.add(listener)
  listener(getBrowserScriptExecutionState())
  return () => {
    browserScriptExecutionStateListeners.delete(listener)
  }
}

export async function cancelRecordingScriptExecutionInBuiltinBrowser(): Promise<boolean> {
  if (!activeBrowserScriptExecution) return false
  return activeBrowserScriptExecution.cancel()
}

export async function executeRecordingScriptInBuiltinBrowser(
  input: BrowserScriptExecutionInput
): Promise<void> {
  const script = typeof input.script === "string" ? input.script.trim() : ""
  if (!script) {
    throw new Error("当前没有可执行的脚本内容")
  }
  if (activeBrowserScriptExecution) {
    throw new Error("当前已有回放正在执行")
  }

  const { source: executionScriptSource, totalSteps } = buildExecutionScript(
    script,
    input.variableValues
  )
  const startedAt = new Date().toISOString()
  let completedSteps = 0
  const runningState = createExecutionState(input, "running", {
    startedAt,
    progressPercent: clampProgressPercent(completedSteps, totalSteps)
  })
  emitBrowserScriptExecutionState(runningState)

  let browserConnection: PlaywrightBrowser | null = null
  let rejectCancellation: ((error: BrowserScriptExecutionCancelledError) => void) | null = null
  const abortPromise = new Promise<never>((_, reject) => {
    rejectCancellation = reject
  })
  void abortPromise.catch(() => undefined)

  const executionController: ActiveBrowserScriptExecution = {
    cancelled: false,
    cancel: async () => {
      if (executionController.cancelled) return false
      executionController.cancelled = true
      emitBrowserScriptExecutionState(
        createExecutionState(input, "cancelled", {
          startedAt,
          endedAt: new Date().toISOString()
        })
      )
      rejectCancellation?.(new BrowserScriptExecutionCancelledError())
      if (browserConnection) {
        await closeBrowserConnection(browserConnection).catch(() => undefined)
      }
      return true
    }
  }
  activeBrowserScriptExecution = executionController

  const updatePlaybackProgress = async (nextCompletedSteps: number): Promise<void> => {
    if (executionController.cancelled) {
      throw new BrowserScriptExecutionCancelledError()
    }
    if (!Number.isFinite(nextCompletedSteps)) return
    completedSteps = Math.max(completedSteps, Math.trunc(nextCompletedSteps))
    emitBrowserScriptExecutionState(
      createExecutionState(input, "running", {
        startedAt,
        progressPercent: clampProgressPercent(completedSteps, totalSteps)
      })
    )
  }

  try {
    const { browser, context, page } = await connectInAppBrowser({
      threadId: input.threadId,
      workspacePath: input.workspacePath,
      isCancelled: () => executionController.cancelled
    })
    const wrapPlaybackValue = createUploadAwarePlaybackWrapper(input.workspacePath)
    browserConnection = browser
    if (executionController.cancelled) {
      throw new BrowserScriptExecutionCancelledError()
    }

    const { expect } = await import("playwright/test")
    const runner = new AsyncFunction(
      "page",
      "browser",
      "context",
      "expect",
      "__updatePlaybackProgress",
      executionScriptSource
    )
    const executionPromise = runner(
      wrapPlaybackValue(page),
      wrapPlaybackValue(browser),
      wrapPlaybackValue(context),
      expect,
      updatePlaybackProgress
    )
    await Promise.race([executionPromise, abortPromise])

    if (executionController.cancelled) {
      throw new BrowserScriptExecutionCancelledError()
    }

    emitBrowserScriptExecutionState(
      createExecutionState(input, "completed", {
        startedAt,
        endedAt: new Date().toISOString(),
        progressPercent: clampProgressPercent(totalSteps || completedSteps || 1, totalSteps)
      })
    )
    console.info(
      `${BROWSER_SCRIPT_EXECUTION_LOG_PREFIX} Executed recorded script in the in-app browser.`
    )
  } catch (error) {
    if (isBrowserScriptExecutionCancelledError(error) || executionController.cancelled) {
      emitBrowserScriptExecutionState(
        createExecutionState(input, "cancelled", {
          startedAt,
          endedAt: new Date().toISOString(),
          progressPercent: clampProgressPercent(completedSteps, totalSteps)
        })
      )
      throw new BrowserScriptExecutionCancelledError()
    }

    const message = formatError(error)
    emitBrowserScriptExecutionState(
      createExecutionState(input, "error", {
        error: message,
        startedAt,
        endedAt: new Date().toISOString(),
        progressPercent: clampProgressPercent(completedSteps, totalSteps)
      })
    )
    console.error(
      `${BROWSER_SCRIPT_EXECUTION_LOG_PREFIX} Failed to execute recorded script: ${message}`
    )
    throw error
  } finally {
    if (browserConnection) {
      await closeBrowserConnection(browserConnection)
    }
    if (activeBrowserScriptExecution === executionController) {
      activeBrowserScriptExecution = null
    }
  }
}
