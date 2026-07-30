import type {
  AiRecordedBrowserAction,
  BrowserLocatorMetadata,
  AiRecordingSession,
  AiRecordingStartOptions
} from "../../../shared/browser-types"
import { buildPlaywrightLocator, type LocatorRole, type LocatorSource } from "./locator-generator"

let activeSession: AiRecordingSession | null = null
let lastSession: AiRecordingSession | null = null
let nextSessionNumber = 0
let nextActionNumber = 0

const SENSITIVE_TARGET_PATTERN = /pass(word|code)?|secret|token|密码|口令/i

function now(): string {
  return new Date().toISOString()
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = readString(item)
      return text ? [text] : []
    })
  }

  const text = readString(value)
  return text ? [text] : []
}

function getTarget(args: Record<string, unknown>): string | undefined {
  return (
    readString(args.element) ??
    readString(args.target) ??
    readString(args.label) ??
    readString(args.name)
  )
}

function getValue(args: Record<string, unknown>): string {
  return (
    readString(args.text) ??
    readString(args.value) ??
    readString(args.values) ??
    readString(args.input) ??
    ""
  )
}

function isSensitiveTarget(target: string | undefined, args: Record<string, unknown>): boolean {
  return Boolean(
    target &&
      (SENSITIVE_TARGET_PATTERN.test(target) ||
        SENSITIVE_TARGET_PATTERN.test(readString(args.type) ?? ""))
  )
}

type AiRecordedBrowserActionInput =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target?: string; doubleClick: boolean; locator?: BrowserLocatorMetadata }
  | { kind: "fill"; target?: string; value: string; sensitive: boolean; locator?: BrowserLocatorMetadata }
  | { kind: "selectOption"; target?: string; values: string[]; locator?: BrowserLocatorMetadata }
  | { kind: "press"; key: string; target?: string; locator?: BrowserLocatorMetadata }

const LOCATOR_ROLES: LocatorRole[] = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "switch",
  "tab",
  "textbox"
]

function readLocatorRole(value: unknown): LocatorRole | undefined {
  const text = readString(value)?.toLowerCase()
  if (!text) return undefined
  return LOCATOR_ROLES.find((role) => role === text)
}

function buildLocatorMetadata(
  args: Record<string, unknown>,
  fallbackTarget?: string
): BrowserLocatorMetadata | undefined {
  const metadata: BrowserLocatorMetadata = {
    target: fallbackTarget ?? getTarget(args),
    role:
      readLocatorRole(args.role) ??
      readLocatorRole(args.ariaRole) ??
      readLocatorRole(args.controlType) ??
      readLocatorRole(args.type),
    label: readString(args.label),
    placeholder: readString(args.placeholder),
    testId:
      readString(args.testId) ??
      readString(args.testid) ??
      readString(args["data-testid"]),
    accessibleName: readString(args.accessibleName) ?? readString(args.ariaLabel),
    textContent: readString(args.textContent),
    selector: readString(args.selector),
    tagName: readString(args.tagName) ?? readString(args.tag),
    inputType: readString(args.inputType) ?? readString(args.input_type) ?? readString(args.type),
    framePath: (() => {
      const values = readStringArray(args.framePath ?? args.frameSelectors ?? args.frames)
      return values.length > 0 ? values : undefined
    })()
  }

  return Object.values(metadata).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== ""
  })
    ? metadata
    : undefined
}

function makeAction(action: AiRecordedBrowserActionInput): AiRecordedBrowserAction {
  nextActionNumber += 1
  return {
    ...action,
    id: `ai-action-${nextActionNumber}`,
    timestamp: now()
  }
}

function normalizeToolCall(
  toolName: string,
  args: Record<string, unknown>
): AiRecordedBrowserAction[] {
  switch (toolName) {
    case "browser_navigate": {
      const url = readString(args.url)
      return url ? [makeAction({ kind: "navigate", url })] : []
    }
    case "browser_click": {
      const target = getTarget(args)
      return [
        makeAction({
          kind: "click",
          target,
          doubleClick: args.doubleClick === true || args.clickCount === 2,
          locator: buildLocatorMetadata(args, target)
        })
      ]
    }
    case "browser_type":
    case "browser_fill": {
      const target = getTarget(args)
      const sensitive = isSensitiveTarget(target, args)
      const actions: AiRecordedBrowserAction[] = [
        makeAction({
          kind: "fill",
          target,
          value: sensitive ? "" : getValue(args),
          sensitive,
          locator: buildLocatorMetadata(args, target)
        })
      ]
      if (args.submit === true) {
        actions.push(
          makeAction({
            kind: "press",
            key: "Enter",
            target,
            locator: buildLocatorMetadata(args, target)
          })
        )
      }
      return actions
    }
    case "browser_fill_form": {
      const fields = args.fields
      if (!Array.isArray(fields) || fields.length === 0) return []
      return fields.flatMap((field: unknown) => {
        if (typeof field !== "object" || field === null) return []
        const fieldObj = field as Record<string, unknown>
        const target = getTarget(fieldObj)
        const value = getValue(fieldObj)
        const sensitive = isSensitiveTarget(target, fieldObj)
        if (!target) return []
        return [
          makeAction({
            kind: "fill",
            target,
            value: sensitive ? "" : value,
            sensitive,
            locator: buildLocatorMetadata(fieldObj, target)
          })
        ]
      })
    }
    case "browser_select_option": {
      const values = readStringArray(args.values ?? args.value)
      return [
        makeAction({
          kind: "selectOption",
          target: getTarget(args),
          values,
          locator: buildLocatorMetadata(args)
        })
      ]
    }
    case "browser_press_key":
    case "browser_key": {
      const key = readString(args.key) ?? readString(args.keys)
      const target = getTarget(args)
      return key
        ? [makeAction({ kind: "press", key, target, locator: buildLocatorMetadata(args, target) })]
        : []
    }
    default:
      return []
  }
}

function appendAction(session: AiRecordingSession, action: AiRecordedBrowserAction): void {
  const previous = session.actions[session.actions.length - 1]
  if (!previous) {
    session.actions.push(action)
    return
  }

  if (previous.kind === "navigate" && action.kind === "navigate" && previous.url === action.url) {
    session.actions[session.actions.length - 1] = action
    return
  }

  if (previous.kind === "fill" && action.kind === "fill" && previous.target === action.target) {
    session.actions[session.actions.length - 1] = action
    return
  }

  if (
    previous.kind === "click" &&
    action.kind === "click" &&
    previous.target === action.target &&
    previous.doubleClick === action.doubleClick
  ) {
    return
  }

  if (
    previous.kind === "selectOption" &&
    action.kind === "selectOption" &&
    previous.target === action.target &&
    previous.values.length === action.values.length &&
    previous.values.every((value, index) => value === action.values[index])
  ) {
    return
  }

  if (
    previous.kind === "press" &&
    action.kind === "press" &&
    previous.target === action.target &&
    previous.key === action.key
  ) {
    return
  }

  session.actions.push(action)
}

function actionsMatch(
  left: AiRecordedBrowserAction,
  right: AiRecordedBrowserAction
): boolean {
  if (left.kind !== right.kind) return false

  switch (left.kind) {
    case "navigate":
      return left.url === (right.kind === "navigate" ? right.url : null)
    case "click":
      return (
        right.kind === "click" &&
        left.target === right.target &&
        left.doubleClick === right.doubleClick
      )
    case "fill":
      return (
        right.kind === "fill" &&
        left.target === right.target &&
        left.value === right.value &&
        left.sensitive === right.sensitive
      )
    case "selectOption":
      return (
        right.kind === "selectOption" &&
        left.target === right.target &&
        left.values.length === right.values.length &&
        left.values.every((value, index) => value === right.values[index])
      )
    case "press":
      return right.kind === "press" && left.target === right.target && left.key === right.key
  }
}

function hasDuplicateTrailingBatch(
  existingActions: AiRecordedBrowserAction[],
  nextActions: AiRecordedBrowserAction[]
): boolean {
  if (nextActions.length === 0 || existingActions.length < nextActions.length) return false

  const offset = existingActions.length - nextActions.length
  return nextActions.every((action, index) => actionsMatch(existingActions[offset + index]!, action))
}

function quote(value: unknown): string {
  return JSON.stringify(value)
}

function getLocator(
  action: Extract<AiRecordedBrowserAction, { target?: string }>,
  defaultRole?: LocatorRole
): string {
  const locator = action.locator
  const source: LocatorSource = {
    target: locator?.target ?? action.target,
    role: readLocatorRole(locator?.role),
    label: locator?.label,
    placeholder: locator?.placeholder,
    testId: locator?.testId,
    accessibleName: locator?.accessibleName,
    textContent: locator?.textContent,
    selector: locator?.selector,
    tagName: locator?.tagName,
    inputType: locator?.inputType,
    framePath: locator?.framePath
  }

  return buildPlaywrightLocator(source, { defaultRole })
}

function generateActionLine(action: AiRecordedBrowserAction): string {
  switch (action.kind) {
    case "navigate":
      return `await page.goto(${quote(action.url)});`
    case "click":
      return `await ${getLocator(action)}.${action.doubleClick ? "dblclick" : "click"}();`
    case "fill":
      return `await ${getLocator(action, "textbox")}.fill(${
        action.sensitive ? 'process.env.PLAYWRIGHT_TEST_PASSWORD ?? ""' : quote(action.value)
      });`
    case "selectOption":
      return `await ${getLocator(action, "combobox")}.selectOption(${quote(
        action.values.length === 1 ? action.values[0]! : action.values
      )});`
    case "press":
      return action.target
        ? `await ${getLocator(action)}.press(${quote(action.key)});`
        : `await page.keyboard.press(${quote(action.key)});`
  }
}

export function generateAiRecordingScript(actions: AiRecordedBrowserAction[]): string {
  const lines = actions.map(generateActionLine)
  const body =
    lines.length > 0
      ? lines.map((line) => `  ${line}`).join("\n")
      : "  // No supported Playwright browser actions were recorded."

  return `import { test } from "@playwright/test";

test("AI recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
${body}
});
`
}

function toView(session: AiRecordingSession | null): AiRecordingSession {
  if (!session) {
    return {
      status: "idle",
      actions: [],
      script: generateAiRecordingScript([])
    }
  }

  return {
    ...session,
    actions: session.actions.map((action) => ({ ...action })),
    script: generateAiRecordingScript(session.actions)
  }
}

export function startAiRecording(_options: AiRecordingStartOptions = {}): AiRecordingSession {
  if (activeSession?.status === "recording") {
    return toView(activeSession)
  }

  nextSessionNumber += 1
  activeSession = {
    id: `ai-recording-${Date.now()}-${nextSessionNumber}`,
    status: "recording",
    startedAt: now(),
    actions: [],
    script: ""
  }
  lastSession = null
  return toView(activeSession)
}

export function stopAiRecording(): AiRecordingSession {
  if (!activeSession) return toView(lastSession)

  activeSession.status = "completed"
  activeSession.stoppedAt = now()
  lastSession = activeSession
  activeSession = null
  return toView(lastSession)
}

export function getAiRecording(): AiRecordingSession {
  return toView(activeSession ?? lastSession)
}

export function recordSuccessfulAiBrowserToolCall(options: {
  args: Record<string, unknown>
  threadId?: string
  toolName: string
}): void {
  if (!activeSession || activeSession.status !== "recording") return

  const normalizedActions = normalizeToolCall(options.toolName, options.args)
  if (hasDuplicateTrailingBatch(activeSession.actions, normalizedActions)) return

  for (const action of normalizedActions) {
    appendAction(activeSession, action)
  }
}

export function resetAiRecordingForTests(): void {
  activeSession = null
  lastSession = null
  nextSessionNumber = 0
  nextActionNumber = 0
}
