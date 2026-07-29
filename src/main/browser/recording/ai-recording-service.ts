import type {
  AiRecordedBrowserAction,
  AiRecordingSession,
  AiRecordingStartOptions
} from "../../../shared/browser-types"

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
  | { kind: "click"; target?: string; doubleClick: boolean }
  | { kind: "fill"; target?: string; value: string; sensitive: boolean }
  | { kind: "selectOption"; target?: string; values: string[] }
  | { kind: "press"; key: string; target?: string }

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
          doubleClick: args.doubleClick === true || args.clickCount === 2
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
          sensitive
        })
      ]
      if (args.submit === true) {
        actions.push(makeAction({ kind: "press", key: "Enter", target }))
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
            sensitive
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
          values
        })
      ]
    }
    case "browser_press_key":
    case "browser_key": {
      const key = readString(args.key) ?? readString(args.keys)
      return key ? [makeAction({ kind: "press", key, target: getTarget(args) })] : []
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

function quote(value: unknown): string {
  return JSON.stringify(value)
}

type LocatorRole = "button" | "link" | "checkbox" | "radio" | "textbox" | "combobox"

interface TargetLocator {
  name: string
  role?: LocatorRole
}

const ROLE_SUFFIXES: Array<{ pattern: RegExp; role: LocatorRole }> = [
  { pattern: /\s*(?:button|按钮)$/iu, role: "button" },
  { pattern: /\s*(?:link|链接)$/iu, role: "link" },
  { pattern: /\s*(?:checkbox|复选框)$/iu, role: "checkbox" },
  { pattern: /\s*(?:radio(?: button)?|单选框)$/iu, role: "radio" },
  { pattern: /\s*(?:select|dropdown|combobox|下拉框|选择框)$/iu, role: "combobox" },
  { pattern: /\s*(?:textbox|text field|input|输入框|文本框)$/iu, role: "textbox" }
]

function parseTargetLocator(target: string | undefined, defaultRole?: LocatorRole): TargetLocator | null {
  if (!target) return null

  const normalized = target
    .replace(/^(?:the\s+)?/iu, "")
    .replace(/^["']|["']$/gu, "")
    .trim()
  for (const entry of ROLE_SUFFIXES) {
    if (!entry.pattern.test(normalized)) continue
    const name = normalized.replace(entry.pattern, "").replace(/^["']|["']$/gu, "").trim()
    return { name: name || normalized, role: entry.role }
  }

  return { name: normalized, role: defaultRole }
}

function getLocator(target: string | undefined, defaultRole?: LocatorRole): string {
  const locator = parseTargetLocator(target, defaultRole)
  if (!locator) return 'page.locator("TODO_SELECTOR")'
  if (locator.role) {
    return `page.getByRole(${quote(locator.role)}, { name: ${quote(locator.name)} })`
  }
  return `page.getByText(${quote(locator.name)}, { exact: true })`
}

function generateActionLine(action: AiRecordedBrowserAction): string {
  switch (action.kind) {
    case "navigate":
      return `await page.goto(${quote(action.url)});`
    case "click":
      return `await ${getLocator(action.target)}.${action.doubleClick ? "dblclick" : "click"}();`
    case "fill":
      return `await ${getLocator(action.target, "textbox")}.fill(${
        action.sensitive ? 'process.env.PLAYWRIGHT_TEST_PASSWORD ?? ""' : quote(action.value)
      });`
    case "selectOption":
      return `await ${getLocator(action.target, "combobox")}.selectOption(${quote(
        action.values.length === 1 ? action.values[0]! : action.values
      )});`
    case "press":
      return action.target
        ? `await ${getLocator(action.target)}.press(${quote(action.key)});`
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

export function startAiRecording(options: AiRecordingStartOptions = {}): AiRecordingSession {
  if (activeSession?.status === "recording") {
    const activeThreadId = activeSession.threadId ?? null
    const nextThreadId = options.threadId ?? null
    if (activeThreadId !== nextThreadId) {
      throw new Error("已有其他任务正在进行 AI 录制，请先停止当前录制。")
    }
    return toView(activeSession)
  }

  nextSessionNumber += 1
  activeSession = {
    id: `ai-recording-${Date.now()}-${nextSessionNumber}`,
    status: "recording",
    threadId: options.threadId,
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
  if (activeSession.threadId && activeSession.threadId !== options.threadId) return

  for (const action of normalizeToolCall(options.toolName, options.args)) {
    appendAction(activeSession, action)
  }
}

export function resetAiRecordingForTests(): void {
  activeSession = null
  lastSession = null
  nextSessionNumber = 0
  nextActionNumber = 0
}
