import type {
  AiRecordedBrowserAction,
  BrowserLocatorMetadata,
  AiRecordingSession,
  AiRecordingStartOptions
} from "../../../shared/browser-types"
import {
  generateAiRecordingScript,
  type LocatorRole
} from "../../../shared/browser-ai-recording-script"

let activeSession: AiRecordingSession | null = null
let lastSession: AiRecordingSession | null = null
let nextSessionNumber = 0
let nextActionNumber = 0

const GLOBAL_SNAPSHOT_KEY = "__global__"
const SENSITIVE_TARGET_PATTERN = /pass(word|code)?|secret|token|密码|口令/i

interface SnapshotNode {
  role: string
  name?: string
  inlineText?: string
  placeholder?: string
  ref?: string
}

interface SnapshotContext {
  byRef: Map<string, SnapshotNode>
}

interface ParsedLocatorMetadata {
  metadata: BrowserLocatorMetadata
  method?: "click" | "dblclick" | "fill" | "selectOption" | "press"
}

const snapshotsByThread = new Map<string, SnapshotContext>()

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

function extractSnapshotRef(value: unknown): string | undefined {
  const text = readString(value)
  if (!text) return undefined

  return text.match(/(?:^|[\s\[])(?:aria-)?ref=(e[\w-]+)/iu)?.[1] ?? text.match(/^e[\w-]+$/iu)?.[0]
}

function getRawTarget(args: Record<string, unknown>): string | undefined {
  return (
    readString(args.element) ??
    readString(args.target) ??
    readString(args.label) ??
    readString(args.name)
  )
}

function getTarget(args: Record<string, unknown>): string | undefined {
  const target = getRawTarget(args)
  return extractSnapshotRef(target) ? undefined : target
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
  | {
      kind: "fill"
      target?: string
      value: string
      sensitive: boolean
      locator?: BrowserLocatorMetadata
    }
  | { kind: "selectOption"; target?: string; values: string[]; locator?: BrowserLocatorMetadata }
  | { kind: "fileUpload"; paths: string[] }
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

function parseQuotedValue(value: string, start = 0): { value: string; end: number } | null {
  const quote = value[start]
  if (quote !== "'" && quote !== '"') return null

  let result = ""
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]
    if (character === "\\") {
      const next = value[index + 1]
      if (next === undefined) break
      result += next
      index += 1
      continue
    }
    if (character === quote) {
      return { value: result, end: index + 1 }
    }
    result += character
  }

  return null
}

function parseSnapshotNodeLine(content: string): SnapshotNode | null {
  const roleMatch = /^[^\s:]+/u.exec(content)
  if (!roleMatch) return null

  const role = roleMatch[0]!
  let rest = content.slice(roleMatch[0].length).trim()
  let name: string | undefined

  if (rest.startsWith('"') || rest.startsWith("'")) {
    const parsedName = parseQuotedValue(rest)
    if (parsedName) {
      name = parsedName.value
      rest = rest.slice(parsedName.end).trim()
    }
  }

  let ref: string | undefined
  while (rest.startsWith("[")) {
    const closingIndex = rest.indexOf("]")
    if (closingIndex < 0) break
    const attribute = rest.slice(1, closingIndex)
    ref = attribute.match(/(?:^|\s)(?:aria-)?ref=(e[\w-]+)/iu)?.[1] ?? ref
    rest = rest.slice(closingIndex + 1).trim()
  }

  const inlineText = rest.startsWith(":") ? readString(rest.slice(1)) : undefined
  return {
    role,
    name,
    inlineText,
    ref
  }
}

function extractSnapshotBlock(resultText: string | undefined): string | null {
  if (!resultText) return null
  return resultText.match(/### Snapshot\s+```(?:yaml|yml)?\s*([\s\S]*?)```/iu)?.[1] ?? null
}

function parseSnapshot(resultText: string | undefined): SnapshotContext | null {
  const block = extractSnapshotBlock(resultText)
  if (!block) return null

  const context: SnapshotContext = {
    byRef: new Map()
  }
  const stack: Array<{ indent: number; node: SnapshotNode }> = []

  for (const line of block.split(/\r?\n/u)) {
    const listItemMatch = /^(\s*)-\s+(.*)$/u.exec(line)
    if (!listItemMatch) continue

    const indent = listItemMatch[1]!.length
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop()
    }

    const parent = stack.at(-1)?.node
    const content = listItemMatch[2]!.trim()
    if (content.startsWith("/placeholder:")) {
      if (parent) parent.placeholder = readString(content.slice("/placeholder:".length))
      continue
    }
    if (content.startsWith("/url:") || content.startsWith("/value:")) continue
    if (content.startsWith("text:")) {
      if (parent && !parent.inlineText) parent.inlineText = readString(content.slice(5))
      continue
    }

    const node = parseSnapshotNodeLine(content)
    if (!node) continue
    if (node.ref) context.byRef.set(node.ref, node)
    stack.push({ indent, node })
  }

  return context.byRef.size > 0 ? context : null
}

function snapshotForThread(threadId: string | undefined): SnapshotContext | undefined {
  return (
    snapshotsByThread.get(threadId ?? GLOBAL_SNAPSHOT_KEY) ??
    snapshotsByThread.get(GLOBAL_SNAPSHOT_KEY)
  )
}

function snapshotNodeForArgs(
  args: Record<string, unknown>,
  snapshot: SnapshotContext | undefined
): SnapshotNode | undefined {
  const ref = extractSnapshotRef(args.ref ?? args.target ?? args.element)
  return ref ? snapshot?.byRef.get(ref) : undefined
}

function mergeLocatorMetadata(
  ...sources: Array<BrowserLocatorMetadata | undefined>
): BrowserLocatorMetadata | undefined {
  const merged: BrowserLocatorMetadata = {}
  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source) as Array<
      [keyof BrowserLocatorMetadata, BrowserLocatorMetadata[keyof BrowserLocatorMetadata]]
    >) {
      if (value === undefined || value === "") continue
      ;(merged as Record<string, unknown>)[key] = value
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

function buildSnapshotMetadata(
  node: SnapshotNode | undefined,
  fallbackTarget?: string
): BrowserLocatorMetadata | undefined {
  if (!node) return undefined
  const role = readLocatorRole(node.role)
  return {
    target: node.name ?? node.inlineText ?? fallbackTarget,
    role,
    accessibleName: node.name,
    textContent: node.role === "text" ? node.inlineText : undefined,
    placeholder: node.placeholder,
    inputType: role === "textbox" ? "text" : undefined
  }
}

function buildArgsMetadata(
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
    testId: readString(args.testId) ?? readString(args.testid) ?? readString(args["data-testid"]),
    accessibleName: readString(args.accessibleName) ?? readString(args.ariaLabel),
    textContent: readString(args.textContent),
    selector: readString(args.selector),
    tagName: readString(args.tagName) ?? readString(args.tag),
    inputType: readString(args.inputType) ?? readString(args.input_type),
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

function readCodeLines(resultText: string | undefined): string[] {
  if (!resultText) return []
  return Array.from(resultText.matchAll(/```(?:js|javascript)?\s*([\s\S]*?)```/giu))
    .flatMap((match) => match[1]!.split(/\r?\n/u))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("await page."))
}

function parseLocatorExpression(expression: string): BrowserLocatorMetadata {
  const locatorExpression = expression.trim()
  const framePath = Array.from(
    locatorExpression.matchAll(/frameLocator\(\s*(['"])(.*?)\1\s*\)/gu)
  ).map((match) => match[2]!)
  const metadata: BrowserLocatorMetadata = {
    framePath: framePath.length > 0 ? framePath : undefined
  }

  const roleMatch =
    /getByRole\(\s*(['"])(.*?)\1\s*,\s*\{\s*[\s\S]*?name\s*:\s*(['"])(.*?)\3[\s\S]*?\}\s*\)/u.exec(
      locatorExpression
    )
  if (roleMatch) {
    metadata.role = readLocatorRole(roleMatch[2])
    metadata.accessibleName = roleMatch[4]
    return metadata
  }

  const builders: Array<{
    name: "label" | "placeholder" | "testId" | "textContent"
    pattern: RegExp
  }> = [
    { name: "label", pattern: /getByLabel\(\s*(['"])(.*?)\1\s*\)/u },
    { name: "placeholder", pattern: /getByPlaceholder\(\s*(['"])(.*?)\1\s*\)/u },
    { name: "testId", pattern: /getByTestId\(\s*(['"])(.*?)\1\s*\)/u },
    { name: "textContent", pattern: /getByText\(\s*(['"])(.*?)\1\s*(?:,\s*\{[\s\S]*?\})?\)/u }
  ]
  for (const builder of builders) {
    const match = builder.pattern.exec(locatorExpression)
    if (!match) continue
    metadata[builder.name] = match[2]
    if (builder.name === "textContent") {
      metadata.textExact = /exact\s*:\s*true/u.test(locatorExpression)
    }
    return metadata
  }

  const selectorMatch = /locator\(\s*(['"])(.*?)\1\s*\)/u.exec(locatorExpression)
  if (selectorMatch) metadata.selector = selectorMatch[2]
  const nthMatch = /\.nth\(\s*(\d+)\s*\)/u.exec(locatorExpression)
  if (nthMatch) metadata.nth = Number(nthMatch[1])
  if (!selectorMatch) metadata.playwrightLocator = locatorExpression
  return metadata
}

function parseActionCodeLine(line: string): ParsedLocatorMetadata | null {
  const keyboardMatch = /^await page\.keyboard\.press\(\s*(['"])(.*?)\1\s*\)/u.exec(line)
  if (keyboardMatch) {
    return {
      metadata: {},
      method: "press"
    }
  }

  const actionMatch = /^await page\.(.+)\.(dblclick|click|fill|selectOption|press)\s*\(/u.exec(line)
  if (!actionMatch) return null
  return {
    metadata: parseLocatorExpression(actionMatch[1]!),
    method: actionMatch[2] as ParsedLocatorMetadata["method"]
  }
}

function makeAction(
  action: AiRecordedBrowserActionInput,
  threadId?: string
): AiRecordedBrowserAction {
  nextActionNumber += 1
  return {
    ...action,
    ...(threadId ? { threadId } : {}),
    id: `ai-action-${nextActionNumber}`,
    timestamp: now()
  }
}

function normalizeToolCall(options: {
  toolName: string
  args: Record<string, unknown>
  threadId?: string
  snapshot?: SnapshotContext
  resultText?: string
}): AiRecordedBrowserAction[] {
  const { toolName, args, threadId, snapshot } = options
  const codeMetadata = readCodeLines(options.resultText).map(parseActionCodeLine)
  const firstCodeMetadata = codeMetadata.find((entry) => entry !== null) ?? null
  const node = snapshotNodeForArgs(args, snapshot)
  const snapshotMetadata = buildSnapshotMetadata(node)
  const target = snapshotMetadata?.target ?? getTarget(args)
  const argsMetadata = buildArgsMetadata(args, target)
  const locator = mergeLocatorMetadata(snapshotMetadata, argsMetadata, firstCodeMetadata?.metadata)

  switch (toolName) {
    case "browser_navigate": {
      const url = readString(args.url)
      return url ? [makeAction({ kind: "navigate", url }, threadId)] : []
    }
    case "browser_click": {
      return [
        makeAction(
          {
            kind: "click",
            target,
            doubleClick: args.doubleClick === true || args.clickCount === 2,
            locator
          },
          threadId
        )
      ]
    }
    case "browser_type":
    case "browser_fill": {
      const sensitive = isSensitiveTarget(target, args)
      const actions: AiRecordedBrowserAction[] = [
        makeAction(
          {
            kind: "fill",
            target,
            value: sensitive ? "" : getValue(args),
            sensitive,
            locator
          },
          threadId
        )
      ]
      if (args.submit === true) {
        actions.push(
          makeAction(
            {
              kind: "press",
              key: "Enter",
              target,
              locator
            },
            threadId
          )
        )
      }
      return actions
    }
    case "browser_fill_form": {
      const fields = args.fields
      if (!Array.isArray(fields) || fields.length === 0) return []
      return fields.flatMap((field: unknown, index) => {
        if (typeof field !== "object" || field === null) return []
        const fieldObj = field as Record<string, unknown>
        const fieldNode = snapshotNodeForArgs(fieldObj, snapshot)
        const fieldSnapshotMetadata = buildSnapshotMetadata(fieldNode)
        const fieldTarget = fieldSnapshotMetadata?.target ?? getTarget(fieldObj)
        const fieldCodeMetadata = codeMetadata[index] ?? null
        const fieldLocator = mergeLocatorMetadata(
          fieldSnapshotMetadata,
          buildArgsMetadata(fieldObj, fieldTarget),
          fieldCodeMetadata?.metadata
        )
        const value = getValue(fieldObj)
        const sensitive = isSensitiveTarget(fieldTarget, fieldObj)
        return [
          makeAction(
            {
              kind: "fill",
              target: fieldTarget,
              value: sensitive ? "" : value,
              sensitive,
              locator: fieldLocator
            },
            threadId
          )
        ]
      })
    }
    case "browser_select_option": {
      const values = readStringArray(args.values ?? args.value)
      return [
        makeAction(
          {
            kind: "selectOption",
            target,
            values,
            locator
          },
          threadId
        )
      ]
    }
    case "browser_file_upload": {
      return [
        makeAction(
          {
            kind: "fileUpload",
            paths: readStringArray(args.paths)
          },
          threadId
        )
      ]
    }
    case "browser_press_key":
    case "browser_key": {
      const key = readString(args.key) ?? readString(args.keys)
      return key
        ? [
            makeAction(
              {
                kind: "press",
                key,
                target,
                locator
              },
              threadId
            )
          ]
        : []
    }
    default:
      return []
  }
}

function locatorKey(locator: BrowserLocatorMetadata | undefined): string {
  if (!locator) return ""
  return JSON.stringify({
    target: locator.target,
    role: locator.role,
    label: locator.label,
    placeholder: locator.placeholder,
    testId: locator.testId,
    accessibleName: locator.accessibleName,
    textContent: locator.textContent,
    selector: locator.selector,
    framePath: locator.framePath
  })
}

function actionTargetKey(action: AiRecordedBrowserAction): string {
  const target = "target" in action ? action.target : undefined
  return `${action.threadId ?? ""}|${target ?? ""}|${locatorKey(action.locator)}`
}

function appendAction(session: AiRecordingSession, action: AiRecordedBrowserAction): void {
  const previous = session.actions[session.actions.length - 1]
  if (!previous) {
    session.actions.push(action)
    return
  }

  const sameTarget = actionTargetKey(previous) === actionTargetKey(action)
  if (previous.kind === "navigate" && action.kind === "navigate" && previous.url === action.url) {
    session.actions[session.actions.length - 1] = action
    return
  }

  if (previous.kind === "fill" && action.kind === "fill" && sameTarget) {
    session.actions[session.actions.length - 1] = action
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

  if (previous.kind === "click" && action.kind === "click" && sameTarget) return

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

  session.actions.push(action)
}

function actionsMatch(left: AiRecordedBrowserAction, right: AiRecordedBrowserAction): boolean {
  if (left.kind !== right.kind || left.threadId !== right.threadId) return false

  switch (left.kind) {
    case "navigate":
      return left.url === (right.kind === "navigate" ? right.url : null)
    case "click":
      return (
        right.kind === "click" &&
        actionTargetKey(left) === actionTargetKey(right) &&
        left.doubleClick === right.doubleClick
      )
    case "fill":
      return (
        right.kind === "fill" &&
        actionTargetKey(left) === actionTargetKey(right) &&
        left.value === right.value &&
        left.sensitive === right.sensitive
      )
    case "selectOption":
      return (
        right.kind === "selectOption" &&
        actionTargetKey(left) === actionTargetKey(right) &&
        left.values.length === right.values.length &&
        left.values.every((value, index) => value === right.values[index])
      )
    case "fileUpload":
      return (
        right.kind === "fileUpload" &&
        left.paths.length === right.paths.length &&
        left.paths.every((path, index) => path === right.paths[index])
      )
    case "press":
      return (
        right.kind === "press" &&
        actionTargetKey(left) === actionTargetKey(right) &&
        left.key === right.key
      )
  }
}

function hasDuplicateTrailingBatch(
  existingActions: AiRecordedBrowserAction[],
  nextActions: AiRecordedBrowserAction[]
): boolean {
  if (nextActions.length === 0 || existingActions.length < nextActions.length) return false

  const offset = existingActions.length - nextActions.length
  return nextActions.every((action, index) =>
    actionsMatch(existingActions[offset + index]!, action)
  )
}

export { generateAiRecordingScript }

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
      status: "idle",
      actions: [],
      script: generateAiRecordingScript([])
    }
  }

  return {
    ...session,
    actions: session.actions.map(cloneAction),
    script: generateAiRecordingScript(session.actions)
  }
}

export function startAiRecording(options: AiRecordingStartOptions = {}): AiRecordingSession {
  if (activeSession?.status === "recording") {
    return toView(activeSession)
  }

  nextSessionNumber += 1
  activeSession = {
    id: `ai-recording-${Date.now()}-${nextSessionNumber}`,
    status: "recording",
    threadId: readString(options.threadId),
    startedAt: now(),
    actions: [],
    script: ""
  }
  snapshotsByThread.clear()
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
  resultText?: string
  threadId?: string
  toolName: string
}): void {
  if (!activeSession || activeSession.status !== "recording") return

  const snapshot = parseSnapshot(options.resultText)
  if (snapshot) {
    snapshotsByThread.set(options.threadId ?? GLOBAL_SNAPSHOT_KEY, snapshot)
  }
  if (options.toolName === "browser_snapshot") return

  const normalizedActions = normalizeToolCall({
    toolName: options.toolName,
    args: options.args,
    threadId: options.threadId,
    snapshot: snapshotForThread(options.threadId),
    resultText: options.resultText
  })
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
  snapshotsByThread.clear()
}
