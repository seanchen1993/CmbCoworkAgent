import { webFrameMain } from "electron"
import type { WebFrameMain } from "electron"
import type {
  AiRecordedBrowserAction,
  AiRecordingSession,
  BrowserLocatorMetadata,
  BrowserNavigationSource,
  ManualRecordingStartOptions,
  BrowserRecordingDraftUpdateInput
} from "../../../../shared/browser-types"
import {
  generateAiRecordingScript,
  parseAiRecordingScript
} from "../../../../shared/browser-ai-recording-script"
import {
  buildPlaywrightManualRecorderInjectionScript,
  inspectPlaywrightManualRecorderMessage,
  parsePlaywrightManualRecorderEvent,
  PLAYWRIGHT_MANUAL_RECORDER_FRAME_SELECTOR_HELPER,
  PLAYWRIGHT_MANUAL_RECORDER_ISOLATED_WORLD_ID
} from "./manual-recorder-playwright-adapter"

let activeSession: AiRecordingSession | null = null
let lastSession: AiRecordingSession | null = null
let nextSessionNumber = 0
let nextActionNumber = 0
let pendingExplicitNavigation: { expiresAt: number; url?: string } | null = null

const EXPLICIT_NAVIGATION_TTL_MS = 10_000

interface ManualRecorderEventBase {
  type: string
  timestamp?: string
  frameUrl?: string
  frameHref?: string
}

interface ManualRecorderLocatorPayload {
  target?: string
  role?: string
  label?: string
  placeholder?: string
  testId?: string
  accessibleName?: string
  textContent?: string
  selector?: string
  tagName?: string
  inputType?: string
  isTarget?: boolean
  isVisible?: boolean
  playwrightLocator?: string
  matchCount?: number
  nth?: number
}

interface ManualRecorderClickEvent extends ManualRecorderEventBase {
  type: "click"
  locator?: ManualRecorderLocatorPayload
  locatorCandidates?: ManualRecorderLocatorPayload[]
  doubleClick?: boolean
  button?: number
  toggle?: "check" | "uncheck"
}

interface ManualRecorderFillEvent extends ManualRecorderEventBase {
  type: "fill"
  locator?: ManualRecorderLocatorPayload
  value?: string
}

interface ManualRecorderSelectEvent extends ManualRecorderEventBase {
  type: "select"
  locator?: ManualRecorderLocatorPayload
  values?: string[]
}

interface ManualRecorderPressEvent extends ManualRecorderEventBase {
  type: "press"
  locator?: ManualRecorderLocatorPayload
  key?: string
}

interface ManualRecorderNavigateEvent extends ManualRecorderEventBase {
  type: "navigate"
  url?: string
}

interface ManualRecorderFileUploadEvent extends ManualRecorderEventBase {
  type: "fileUpload"
  locator?: ManualRecorderLocatorPayload
  paths?: string[]
}

type ManualRecorderEvent =
  | ManualRecorderClickEvent
  | ManualRecorderFillEvent
  | ManualRecorderSelectEvent
  | ManualRecorderPressEvent
  | ManualRecorderNavigateEvent
  | ManualRecorderFileUploadEvent

const SENSITIVE_TARGET_PATTERN = /pass(word|code)?|secret|token|密码|口令/i
const DECORATIVE_ROLE_PATTERN = /^(?:img|presentation|none)$/iu
const DECORATIVE_TAG_PATTERN = /^(?:svg|path|g|use|defs|symbol|rect|circle|ellipse|line|polyline|polygon)$/iu
const GENERIC_SELECTOR_PATTERN = /^(?:div|span|p|section|article|main|header|footer|aside|label|ul|ol|li)$/iu
const CONTAINER_TEST_ID_PATTERN =
  /(?:^|[-_])(area|container|wrapper|panel|section|group|list|content|body|header|footer|root)(?:$|[-_])/iu
const INTERACTIVE_TAG_NAMES = new Set(["button", "a", "input", "textarea", "select", "option"])
const MANUAL_RECORDER_DEBUG_PREFIX = "[Browser][ManualRecorderDebug]"
const FRAME_ELEMENT_SELECTOR_CACHE = new Map<string, string>()
const FRAME_INJECTION_PROMISES = new Map<string, Promise<void>>()
const FRAME_CHANNEL_FRAME_CACHE = new Map<string, WebFrameMain>()

function now(): string {
  return new Date().toISOString()
}

function frameCacheKey(frame: Pick<WebFrameMain, "processId" | "frameToken">): string {
  return `${frame.processId}:${frame.frameToken}`
}

function supportsIsolatedWorldExecution(
  frame: WebFrameMain
): frame is WebFrameMain & {
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<{ code: string }>
  ) => Promise<unknown>
} {
  return typeof (frame as { executeJavaScriptInIsolatedWorld?: unknown })
    .executeJavaScriptInIsolatedWorld === "function"
}

async function executeManualRecorderScriptInIsolatedWorld(
  frame: WebFrameMain,
  code: string
): Promise<unknown> {
  if (!supportsIsolatedWorldExecution(frame)) {
    throw new Error("frame does not support isolated world execution")
  }
  return frame.executeJavaScriptInIsolatedWorld(
    PLAYWRIGHT_MANUAL_RECORDER_ISOLATED_WORLD_ID,
    [{ code }]
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const text = readString(item)
    return text ? [text] : []
  })
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined
  return value
}

function normalizeRole(value: unknown): BrowserLocatorMetadata["role"] {
  const role = readString(value)?.toLowerCase()
  if (!role) return undefined
  switch (role) {
    case "button":
    case "checkbox":
    case "combobox":
    case "link":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "option":
    case "radio":
    case "slider":
    case "spinbutton":
    case "switch":
    case "tab":
    case "textbox":
      return role
    default:
      return undefined
  }
}

function inferRoleFromLocatorPayload(
  payload: Pick<ManualRecorderLocatorPayload, "tagName" | "inputType">
): BrowserLocatorMetadata["role"] {
  const tagName = readString(payload.tagName)?.toLowerCase()
  const inputType = readString(payload.inputType)?.toLowerCase()

  if (tagName === "textarea") return "textbox"
  if (tagName !== "input") return undefined

  if (inputType === "range") return "slider"
  if (inputType === "number") return "spinbutton"
  if (inputType === "checkbox") return "checkbox"
  if (inputType === "radio") return "radio"
  if (inputType === "button" || inputType === "submit" || inputType === "reset") return "button"

  return undefined
}

function normalizeLocatorPayload(
  payload: ManualRecorderLocatorPayload | undefined,
  framePath: string[]
): BrowserLocatorMetadata | undefined {
  if (!payload) return framePath.length > 0 ? { framePath } : undefined

  const locator: BrowserLocatorMetadata = {
    target: readString(payload.target),
    role: normalizeRole(payload.role) ?? inferRoleFromLocatorPayload(payload),
    label: readString(payload.label),
    placeholder: readString(payload.placeholder),
    testId: readString(payload.testId),
    accessibleName: readString(payload.accessibleName),
    textContent: readString(payload.textContent),
    selector: readString(payload.selector),
    tagName: readString(payload.tagName),
    inputType: readString(payload.inputType),
    isTarget: payload.isTarget === true,
    isVisible:
      typeof payload.isVisible === "boolean" ? payload.isVisible : undefined,
    playwrightLocator: readString(payload.playwrightLocator),
    framePath: framePath.length > 0 ? framePath : undefined,
    matchCount: (() => {
      const matchCount = readNonNegativeInteger(payload.matchCount)
      return matchCount && matchCount > 1 ? matchCount : undefined
    })(),
    nth: readNonNegativeInteger(payload.nth)
  }

  return Object.values(locator).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== ""
  })
    ? locator
    : undefined
}

function locatorPayloadScore(
  payload: ManualRecorderLocatorPayload | undefined,
  candidateIndex: number
): number {
  if (!payload) return Number.NEGATIVE_INFINITY

  const rawRole = readString(payload.role)?.toLowerCase()
  const normalizedRole = normalizeRole(rawRole)
  const tagName = readString(payload.tagName)?.toLowerCase()
  const testId = readString(payload.testId)
  const target = readString(payload.target)
  const accessibleName = readString(payload.accessibleName)
  const textContent = readString(payload.textContent)
  const label = readString(payload.label)
  const placeholder = readString(payload.placeholder)
  const selector = readString(payload.selector)
  const isTarget = payload.isTarget === true
  const matchCount = readNonNegativeInteger(payload.matchCount)
  const nth = readNonNegativeInteger(payload.nth)
  const isTargetSvg = tagName === "svg" && isTarget

  let score = 0
  if (tagName && DECORATIVE_TAG_PATTERN.test(tagName)) {
    score -= isTargetSvg && (nth !== undefined || (matchCount ?? 0) > 1) ? 10 : 120
  }
  if (rawRole && DECORATIVE_ROLE_PATTERN.test(rawRole)) score -= 80
  if (isTarget) score += 40
  if (isTargetSvg) score += 80
  if (isTargetSvg && nth !== undefined) score += 40

  if (normalizedRole) score += 120
  else if (tagName && INTERACTIVE_TAG_NAMES.has(tagName)) score += 110

  if (label) score += 60
  if (placeholder) score += 60
  if (accessibleName) score += accessibleName.length <= 40 ? 50 : 20
  if (textContent) score += textContent.length <= 40 ? 40 : 10
  if (target && target !== testId) score += target.length <= 40 ? 30 : 10

  if (testId) {
    score += CONTAINER_TEST_ID_PATTERN.test(testId) ? 5 : 30
  }

  if (selector) {
    score += GENERIC_SELECTOR_PATTERN.test(selector) ? 0 : 20
  }

  if (tagName && (tagName === "div" || tagName === "span" || tagName === "li")) {
    if (accessibleName || textContent || label || testId) score += 10
    if (textContent && textContent.length > 40) score -= 20
  }

  score -= candidateIndex * 5
  return score
}

function selectManualLocatorPayload(
  fallback: ManualRecorderLocatorPayload | undefined,
  candidates: ManualRecorderLocatorPayload[] | undefined
): ManualRecorderLocatorPayload | undefined {
  const pool =
    Array.isArray(candidates) && candidates.length > 0
      ? candidates
      : fallback
        ? [fallback]
        : []

  if (pool.length === 0) return fallback

  let bestPayload: ManualRecorderLocatorPayload | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const [index, payload] of pool.entries()) {
    const score = locatorPayloadScore(payload, index)
    if (score <= bestScore) continue
    bestScore = score
    bestPayload = payload
  }

  return bestPayload ?? fallback
}

function isSensitiveTarget(locator: BrowserLocatorMetadata | undefined): boolean {
  return Boolean(
    locator &&
    [
      locator.target,
      locator.label,
      locator.placeholder,
      locator.accessibleName,
      locator.testId,
      locator.inputType,
      locator.selector,
      locator.playwrightLocator
    ].some((value) => value && SENSITIVE_TARGET_PATTERN.test(value))
  )
}

function actionTargetKey(action: AiRecordedBrowserAction): string {
  const target = "target" in action ? action.target : undefined
  const locator = action.locator
  return JSON.stringify({
    kind: action.kind,
    target: target ?? null,
    key: "key" in action ? action.key : null,
    toggle: "toggle" in action ? action.toggle ?? null : null,
    locator: locator
      ? {
          target: locator.target,
          role: locator.role,
          label: locator.label,
          placeholder: locator.placeholder,
          testId: locator.testId,
          accessibleName: locator.accessibleName,
          textContent: locator.textContent,
          selector: locator.selector,
          playwrightLocator: locator.playwrightLocator,
          framePath: locator.framePath,
          isTarget: locator.isTarget,
          matchCount: locator.matchCount,
          nth: locator.nth
        }
      : null
  })
}

function actionLocatorKey(action: AiRecordedBrowserAction): string {
  const locator = action.locator
  return JSON.stringify({
    target: "target" in action ? (action.target ?? null) : null,
    locator: locator
      ? {
          target: locator.target,
          role: locator.role,
          label: locator.label,
          placeholder: locator.placeholder,
          testId: locator.testId,
          accessibleName: locator.accessibleName,
          textContent: locator.textContent,
          selector: locator.selector,
          playwrightLocator: locator.playwrightLocator,
          framePath: locator.framePath,
          isTarget: locator.isTarget,
          matchCount: locator.matchCount,
          nth: locator.nth
        }
      : null
  })
}

function normalizeNavigationUrl(value: string): string {
  try {
    return new URL(value).href
  } catch {
    return value.trim()
  }
}

function setPendingExplicitNavigation(url?: string): void {
  pendingExplicitNavigation = {
    expiresAt: Date.now() + EXPLICIT_NAVIGATION_TTL_MS,
    url: url ? normalizeNavigationUrl(url) : undefined
  }
}

function takePendingExplicitNavigation(url: string): boolean {
  if (!pendingExplicitNavigation) return false
  if (Date.now() > pendingExplicitNavigation.expiresAt) {
    pendingExplicitNavigation = null
    return false
  }

  if (
    pendingExplicitNavigation.url &&
    pendingExplicitNavigation.url !== normalizeNavigationUrl(url)
  ) {
    return false
  }

  pendingExplicitNavigation = null
  return true
}

function appendAction(session: AiRecordingSession, action: AiRecordedBrowserAction): void {
  const previous = session.actions[session.actions.length - 1]
  if (!previous) {
    session.actions.push(action)
    return
  }

  const sameTarget = actionTargetKey(previous) === actionTargetKey(action)
  if (previous.kind === "navigate" && action.kind === "navigate") {
    if (previous.url === action.url) return
    session.actions[session.actions.length - 1] = action
    return
  }

  if (previous.kind === "fill" && action.kind === "fill" && sameTarget) {
    session.actions[session.actions.length - 1] = action
    return
  }

  const beforePrevious = session.actions[session.actions.length - 2]
  if (
    beforePrevious?.kind === "fill" &&
    previous.kind === "press" &&
    previous.key === "Enter" &&
    action.kind === "fill" &&
    beforePrevious.value === action.value &&
    actionLocatorKey(beforePrevious) === actionLocatorKey(previous) &&
    actionLocatorKey(previous) === actionLocatorKey(action)
  ) {
    // API mode reports framework-replayed input on both sides of Enter. The later
    // fill is the stable post-submit value, so keep the same script shape as codegen.
    session.actions.splice(session.actions.length - 2, 1)
    session.actions.push(action)
    return
  }

  if (
    previous.kind === "selectOption" &&
    action.kind === "selectOption" &&
    sameTarget &&
    previous.values.length === action.values.length &&
    previous.values.every((value, index) => value === action.values[index])
  ) {
    return
  }

  if (
    previous.kind === "press" &&
    action.kind === "press" &&
    sameTarget &&
    previous.key === action.key
  ) {
    return
  }

  if (
    previous.kind === "click" &&
    action.kind === "click" &&
    sameTarget &&
    previous.doubleClick === action.doubleClick
  ) {
    return
  }

  if (
    previous.kind === "click" &&
    action.kind === "click" &&
    sameTarget &&
    !previous.doubleClick &&
    action.doubleClick
  ) {
    session.actions[session.actions.length - 1] = action
    return
  }

  if (
    previous.kind === "fileUpload" &&
    action.kind === "fileUpload" &&
    previous.paths.length === action.paths.length &&
    previous.paths.every((value, index) => value === action.paths[index])
  ) {
    session.actions[session.actions.length - 1] = action
    return
  }

  session.actions.push(action)
}

function cloneAction(action: AiRecordedBrowserAction): AiRecordedBrowserAction {
  return {
    ...action,
    locator: action.locator
      ? {
          ...action.locator,
          framePath: action.locator.framePath ? [...action.locator.framePath] : undefined
        }
      : undefined
  }
}

function toView(session: AiRecordingSession | null): AiRecordingSession {
  if (!session) {
    return {
      source: "manual",
      status: "idle",
      actions: [],
      script: generateAiRecordingScript([], { source: "manual" })
    }
  }

  return {
    ...session,
    actions: session.actions.map(cloneAction),
    variableActionIds: session.variableActionIds ? [...session.variableActionIds] : undefined,
    variableActionNames: session.variableActionNames
      ? { ...session.variableActionNames }
      : undefined,
    script:
      session.scriptPrefix &&
      session.scriptPrefixActionCount === session.actions.length &&
      session.scriptPrefix.trim().length > 0
        ? session.scriptPrefix
        : generateAiRecordingScript(session.actions, {
            source: "manual",
            variableActionIds: session.variableActionIds,
            variableActionNames: session.variableActionNames
          })
  }
}

function nextActionId(): string {
  nextActionNumber += 1
  return `manual-action-${nextActionNumber}`
}

function buildFramePath(frame: WebFrameMain): string[] {
  const chain: string[] = []
  let current: WebFrameMain | null = frame
  while (current?.parent) {
    chain.unshift(
      FRAME_ELEMENT_SELECTOR_CACHE.get(frameCacheKey(current)) ??
        buildFrameSelectorFallback(current)
    )
    current = current.parent
  }
  return chain
}

function describeFrameAncestry(frame: WebFrameMain): Array<{
  url: string
  token: string
}> {
  const ancestry: Array<{ url: string; token: string }> = []
  let current: WebFrameMain | null = frame
  while (current) {
    ancestry.unshift({
      url: current.url || "(empty)",
      token: current.frameToken || "(none)"
    })
    current = current.parent
  }
  return ancestry
}

function buildFrameSelectorFallback(frame: WebFrameMain): string {
  const parent = frame.parent
  if (!parent) return "iframe"

  const siblings = parent.frames
  const index = siblings.findIndex(
    (candidate) =>
      candidate.processId === frame.processId && candidate.frameToken === frame.frameToken
  )
  if (index >= 0) {
    if (siblings.length === 1) return "iframe"
    return `iframe >> nth=${index}`
  }

  const frameName = readString(frame.name)
  if (frameName) return `iframe[name=${JSON.stringify(frameName)}]`

  const frameUrl = readString(frame.url) ?? readString(frame.origin) ?? frame.frameToken
  return frameUrl ? `iframe[src*=${JSON.stringify(frameUrl)}]` : "iframe"
}

async function cacheFrameElementSelector(frame: WebFrameMain): Promise<void> {
  if (!frame.parent) return

  const parent = frame.parent
  if (parent.isDestroyed() || frame.isDestroyed()) return

  const siblings = parent.frames
  const index = siblings.findIndex(
    (candidate) =>
      candidate.processId === frame.processId && candidate.frameToken === frame.frameToken
  )
  if (index < 0) return

  const helperScript = `(() => {
    const helper = window[${JSON.stringify(
      PLAYWRIGHT_MANUAL_RECORDER_FRAME_SELECTOR_HELPER
    )}];
    if (typeof helper !== "function") return "";
    return helper(${index});
  })()`

  try {
    const selector = await executeManualRecorderScriptInIsolatedWorld(parent, helperScript)
    if (typeof selector === "string" && selector.trim()) {
      FRAME_ELEMENT_SELECTOR_CACHE.set(frameCacheKey(frame), selector.trim())
      console.info(
        `${MANUAL_RECORDER_DEBUG_PREFIX} frame-selector-cached source=isolated frame=${frame.url || "(empty)"} token=${frame.frameToken} parent=${parent.url || "(empty)"} index=${index} selector=${JSON.stringify(selector.trim())}`
      )
      return
    }
  } catch {
    // Ignore and fall back to other execution paths below.
  }

  try {
    const selector = await parent.executeJavaScript(helperScript)
    if (typeof selector === "string" && selector.trim()) {
      FRAME_ELEMENT_SELECTOR_CACHE.set(frameCacheKey(frame), selector.trim())
      console.info(
        `${MANUAL_RECORDER_DEBUG_PREFIX} frame-selector-cached source=page frame=${frame.url || "(empty)"} token=${frame.frameToken} parent=${parent.url || "(empty)"} index=${index} selector=${JSON.stringify(selector.trim())}`
      )
      return
    }
  } catch {
    // Ignore and fall back to the heuristic selector path.
  }

  const fallbackSelector = buildFrameSelectorFallback(frame)
  FRAME_ELEMENT_SELECTOR_CACHE.set(frameCacheKey(frame), fallbackSelector)
  console.info(
    `${MANUAL_RECORDER_DEBUG_PREFIX} frame-selector-cached source=fallback frame=${frame.url || "(empty)"} token=${frame.frameToken} parent=${parent.url || "(empty)"} index=${index} selector=${JSON.stringify(fallbackSelector)}`
  )
}

function buildNavigationAction(url: string): AiRecordedBrowserAction {
  return buildNavigationActionWithSource(url, "explicit")
}

function buildNavigationActionWithSource(
  url: string,
  navigationSource: BrowserNavigationSource
): AiRecordedBrowserAction {
  return {
    id: nextActionId(),
    kind: "navigate",
    source: "manual",
    timestamp: now(),
    url,
    navigationSource
  }
}

function normalizeManualEvent(
  event: ManualRecorderEvent,
  framePath: string[]
): AiRecordedBrowserAction | null {
  const timestamp = readString(event.timestamp) ?? now()
  switch (event.type) {
    case "navigate": {
      const url = readString(event.url ?? event.frameHref)
      if (!url) return null
      return buildNavigationActionWithSource(url, "implicit")
    }
    case "click": {
      const locator = normalizeLocatorPayload(
        selectManualLocatorPayload(event.locator, event.locatorCandidates),
        framePath
      )
      return {
        id: nextActionId(),
        kind: "click",
        source: "manual",
        timestamp,
        target: locator?.target,
        doubleClick: event.doubleClick === true,
        toggle: event.toggle === "check" || event.toggle === "uncheck" ? event.toggle : undefined,
        locator
      }
    }
    case "fill": {
      const locator = normalizeLocatorPayload(event.locator, framePath)
      const sensitive = isSensitiveTarget(locator)
      return {
        id: nextActionId(),
        kind: "fill",
        source: "manual",
        timestamp,
        target: locator?.target,
        value: readString(event.value) ?? "",
        sensitive,
        locator
      }
    }
    case "select": {
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "selectOption",
        source: "manual",
        timestamp,
        target: locator?.target,
        values: readStringArray(event.values),
        locator
      }
    }
    case "press": {
      const key = readString(event.key)
      if (!key) return null
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "press",
        source: "manual",
        timestamp,
        key,
        target: locator?.target,
        locator
      }
    }
    case "fileUpload": {
      const paths = readStringArray(event.paths)
      if (paths.length === 0) return null
      const locator = normalizeLocatorPayload(event.locator, framePath)
      return {
        id: nextActionId(),
        kind: "fileUpload",
        source: "manual",
        timestamp,
        paths,
        locator
      }
    }
    default:
      return null
  }
}

export function startManualRecording(
  options: ManualRecordingStartOptions = {}
): AiRecordingSession {
  if (activeSession && activeSession.status !== "completed") return toView(activeSession)

  const seedScript = typeof options.seedScript === "string" ? options.seedScript.trim() : ""
  const seededRecording = seedScript
    ? parseAiRecordingScript(seedScript, "manual")
    : {
        actions: [] as AiRecordedBrowserAction[],
        variableActionIds: [] as string[],
        variableActionNames: {} as Record<string, string>
      }

  nextSessionNumber += 1
  activeSession = {
    id: `manual-recording-${Date.now()}-${nextSessionNumber}`,
    source: "manual",
    status: "recording",
    threadId: readString(options.threadId),
    startedAt: now(),
    scriptPrefix: seedScript || undefined,
    scriptPrefixActionCount: seedScript ? seededRecording.actions.length : undefined,
    libraryFileName: readString(options.libraryFileName),
    libraryDisplayName: readString(options.libraryDisplayName),
    actions: seededRecording.actions,
    variableActionIds: seededRecording.variableActionIds,
    variableActionNames: seededRecording.variableActionNames,
    script: ""
  }
  FRAME_ELEMENT_SELECTOR_CACHE.clear()
  FRAME_INJECTION_PROMISES.clear()
  FRAME_CHANNEL_FRAME_CACHE.clear()

  const currentUrl = readString(options.currentUrl ?? undefined)
  if (!seedScript && currentUrl && currentUrl !== "about:blank") {
    appendAction(activeSession, buildNavigationAction(currentUrl))
  }

  pendingExplicitNavigation = null
  lastSession = null
  return toView(activeSession)
}

export function pauseManualRecording(): AiRecordingSession {
  if (!activeSession || activeSession.status !== "recording")
    return toView(activeSession ?? lastSession)
  activeSession.status = "paused"
  pendingExplicitNavigation = null
  return toView(activeSession)
}

export function updateManualRecordingDraft(
  input: BrowserRecordingDraftUpdateInput
): AiRecordingSession {
  if (!activeSession || activeSession.status === "completed") {
    throw new Error("当前没有可保存的录制会话")
  }

  const script = typeof input.script === "string" ? input.script : ""
  if (!script.trim()) {
    throw new Error("当前没有可保存的脚本内容")
  }

  const parsed = parseAiRecordingScript(script, "manual")
  activeSession.actions = parsed.actions
  activeSession.variableActionIds = parsed.variableActionIds
  activeSession.variableActionNames = parsed.variableActionNames
  activeSession.scriptPrefix = script
  activeSession.scriptPrefixActionCount = parsed.actions.length
  pendingExplicitNavigation = null
  return toView(activeSession)
}

export function resumeManualRecording(): AiRecordingSession {
  if (!activeSession || activeSession.status !== "paused")
    return toView(activeSession ?? lastSession)
  activeSession.status = "recording"
  pendingExplicitNavigation = null
  return toView(activeSession)
}

export function stopManualRecording(): AiRecordingSession {
  if (!activeSession) return toView(lastSession)

  activeSession.status = "completed"
  activeSession.stoppedAt = now()
  console.info(
    `${MANUAL_RECORDER_DEBUG_PREFIX} session-stopped actions=${JSON.stringify(
      activeSession.actions.map((action) => ({
        kind: action.kind,
        framePath: action.locator?.framePath ?? [],
        selector: action.locator?.selector,
        playwrightLocator: action.locator?.playwrightLocator
      }))
    )}`
  )
  pendingExplicitNavigation = null
  lastSession = activeSession
  activeSession = null
  FRAME_CHANNEL_FRAME_CACHE.clear()
  return toView(lastSession)
}

export function getManualRecording(): AiRecordingSession {
  return toView(activeSession ?? lastSession)
}

export function recordManualNavigation(
  url: string,
  source: BrowserNavigationSource = "explicit"
): void {
  if (!activeSession || activeSession.status !== "recording") return
  const nextUrl = readString(url)
  if (!nextUrl || nextUrl === "about:blank") return
  if (source === "implicit" && !takePendingExplicitNavigation(nextUrl)) return
  if (source === "explicit") pendingExplicitNavigation = null
  appendAction(activeSession, buildNavigationAction(nextUrl))
}

export function markNextManualNavigationExplicit(url?: string): void {
  if (!activeSession || activeSession.status !== "recording") return
  setPendingExplicitNavigation(url)
}

async function installManualRecorderInternal(frame: WebFrameMain): Promise<void> {
  if (!activeSession || activeSession.status !== "recording") return
  if (frame.detached || frame.isDestroyed() || frame.url.startsWith("devtools:")) return

  // 主链路只执行 Playwright 注入脚本；旧脚本保留在仓库里，但不再运行。
  const channelId = `${activeSession.id}:${frameCacheKey(frame)}`
  const script = buildPlaywrightManualRecorderInjectionScript(channelId)

  try {
    let injectionMode: "isolated" | "page" = "isolated"
    let injectionResult: unknown
    try {
      injectionResult = await executeManualRecorderScriptInIsolatedWorld(frame, script)
      // Electron resolves with undefined when isolated-world execution throws.
      if (injectionResult !== true && typeof injectionResult !== "string") {
        throw new Error("isolated world injection did not complete")
      }
    } catch {
      injectionResult = await frame.executeJavaScript(script)
      injectionMode = "page"
    }
    const resolvedChannelId =
      typeof injectionResult === "string" && injectionResult.trim()
        ? injectionResult.trim()
        : channelId
    FRAME_CHANNEL_FRAME_CACHE.set(resolvedChannelId, frame)
    console.info(
      `${MANUAL_RECORDER_DEBUG_PREFIX} injected mode=${injectionMode} frame=${frame.url || "(empty)"} token=${frame.frameToken} channel=${resolvedChannelId} parent=${frame.parent?.url || "(root)"}`
    )
    await cacheFrameElementSelector(frame)
  } catch {
    // Cross-origin or transient frames may reject injection; ignore and keep recording other frames.
    console.info(
      `${MANUAL_RECORDER_DEBUG_PREFIX} inject-skipped frame=${frame.url || "(empty)"} token=${frame.frameToken}`
    )
  }
}

function frameInjectionKey(frame: WebFrameMain): string | undefined {
  const sessionId = activeSession?.id
  if (!sessionId) return undefined
  return `${sessionId}:${frameCacheKey(frame)}`
}

export function installManualRecorder(frame: WebFrameMain): Promise<void> {
  const key = frameInjectionKey(frame)
  if (!key) return Promise.resolve()

  const existing = FRAME_INJECTION_PROMISES.get(key)
  if (existing) return existing

  const injection = installManualRecorderInternal(frame).finally(() => {
    if (FRAME_INJECTION_PROMISES.get(key) === injection) {
      FRAME_INJECTION_PROMISES.delete(key)
    }
  })
  FRAME_INJECTION_PROMISES.set(key, injection)
  return injection
}

export async function installManualRecorderForFrameById(
  frameProcessId: number,
  frameRoutingId: number
): Promise<void> {
  if (!activeSession || activeSession.status !== "recording") return
  const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
  if (!frame || frame.detached || frame.isDestroyed()) {
    console.info(
      `${MANUAL_RECORDER_DEBUG_PREFIX} frame-by-id-miss pid=${frameProcessId} rid=${frameRoutingId}`
    )
    return
  }
  console.info(
    `${MANUAL_RECORDER_DEBUG_PREFIX} frame-by-id-hit pid=${frameProcessId} rid=${frameRoutingId} frame=${frame.url || "(empty)"} token=${frame.frameToken}`
  )
  await installManualRecorderForSubtree(frame)
}

export async function installManualRecorderForSubtree(frame: WebFrameMain): Promise<void> {
  const frames = frame.framesInSubtree
  for (const child of frames) {
    await installManualRecorder(child)
  }
}

export function recordManualRecorderConsoleMessage(frame: WebFrameMain, message: string): void {
  if (!activeSession || activeSession.status !== "recording") return
  const diagnostic = inspectPlaywrightManualRecorderMessage(message)
  if (!diagnostic) return
  const channelId = diagnostic.frameContext?.channelId
  const mappedFrame = channelId ? FRAME_CHANNEL_FRAME_CACHE.get(channelId) : undefined
  const resolvedFrame =
    mappedFrame && !mappedFrame.isDestroyed() && !mappedFrame.detached ? mappedFrame : frame
  const framePath = buildFramePath(resolvedFrame)
  console.info(
    `${MANUAL_RECORDER_DEBUG_PREFIX} console-message-received electronFrame=${frame.url || "(empty)"} electronToken=${frame.frameToken || "(none)"} resolvedFrame=${resolvedFrame.url || "(empty)"} resolvedToken=${resolvedFrame.frameToken || "(none)"} resolvedFrom=${mappedFrame ? "channel" : "electron"} ancestry=${JSON.stringify(describeFrameAncestry(resolvedFrame))} computedPath=${JSON.stringify(framePath)} payload=${JSON.stringify(diagnostic)}`
  )
  const playwrightEvent = parsePlaywrightManualRecorderEvent(message, framePath)
  if (playwrightEvent) {
    console.info(
      `${MANUAL_RECORDER_DEBUG_PREFIX} console-event frame=${resolvedFrame.url || "(empty)"} token=${resolvedFrame.frameToken || "(none)"} path=${JSON.stringify(framePath)} type=${playwrightEvent.type}`
    )
    const action = normalizeManualEvent(playwrightEvent as ManualRecorderEvent, framePath)
    if (action) {
      appendAction(activeSession, action)
      console.info(
        `${MANUAL_RECORDER_DEBUG_PREFIX} action-appended kind=${action.kind} target=${"target" in action ? action.target || "" : ""} framePath=${JSON.stringify(action.locator?.framePath ?? [])} selector=${JSON.stringify(action.locator?.selector ?? "")} playwrightLocator=${JSON.stringify(action.locator?.playwrightLocator ?? "")} actionCount=${activeSession.actions.length}`
      )
    } else {
      console.info(`${MANUAL_RECORDER_DEBUG_PREFIX} action-dropped type=${playwrightEvent.type}`)
    }
    return
  }
  console.info(
    `${MANUAL_RECORDER_DEBUG_PREFIX} console-message-dropped action=${diagnostic.actionName ?? "(unknown)"} clickCount=${diagnostic.clickCount ?? "(none)"} reason=${diagnostic.actionName === "click" && diagnostic.clickCount === 0 ? "synthetic-click" : "unsupported-or-invalid-action"}`
  )
}

export function resetManualRecordingForTests(): void {
  activeSession = null
  lastSession = null
  nextSessionNumber = 0
  nextActionNumber = 0
  pendingExplicitNavigation = null
  FRAME_ELEMENT_SELECTOR_CACHE.clear()
  FRAME_INJECTION_PROMISES.clear()
  FRAME_CHANNEL_FRAME_CACHE.clear()
}
