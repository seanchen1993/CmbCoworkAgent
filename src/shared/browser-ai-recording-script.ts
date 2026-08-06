import type {
  AiRecordedBrowserAction,
  BrowserLocatorMetadata,
  BrowserRecordingSource
} from "./browser-types"
import { buildPlaywrightLocator as buildCodegenPlaywrightLocator } from "../main/browser/record/common/playwright-codegen/projectLocatorAdapter"
import { generatePlaywrightCodegenActionLines } from "../main/browser/record/common/playwright-codegen/projectCodegenAdapter"

// 最终 locator 字符串使用 Playwright 源码副本进行格式化。
// 变量处理和不受标准 codegen 覆盖的少数回退路径仍属于项目自定义功能。
export type LocatorRole =
  | "button"
  | "checkbox"
  | "combobox"
  | "link"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "option"
  | "radio"
  | "slider"
  | "spinbutton"
  | "switch"
  | "tab"
  | "textbox"

export interface LocatorSource {
  target?: string
  role?: LocatorRole
  label?: string
  placeholder?: string
  testId?: string
  accessibleName?: string
  textContent?: string
  selector?: string
  tagName?: string
  inputType?: string
  framePath?: string[]
  playwrightLocator?: string
  textExact?: boolean
  matchCount?: number
  nth?: number
}

interface LocatorBuildOptions {
  defaultRole?: LocatorRole
}

export interface AiRecordingScriptOptions {
  variableActionIds?: Iterable<string>
  variableActionNames?: Record<string, string>
  source?: BrowserRecordingSource
}

interface VariableDescriptor {
  displayName: string
  identifier: string
  declaration: string
}

export interface AiRecordingScriptVariable {
  displayName: string
  identifier: string
  isArray: boolean
}

export type AiRecordingScriptVariableValue = string | string[]

type ParsedRecordedActionInput =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target?: string; doubleClick: boolean; locator?: BrowserLocatorMetadata }
  | {
      kind: "fill"
      target?: string
      value: string
      sensitive: boolean
      locator?: BrowserLocatorMetadata
    }
  | {
      kind: "selectOption"
      target?: string
      values: string[]
      locator?: BrowserLocatorMetadata
    }
  | { kind: "fileUpload"; paths: string[]; locator?: BrowserLocatorMetadata }
  | { kind: "press"; key: string; target?: string; locator?: BrowserLocatorMetadata }

const ROLE_PATTERNS: Array<{ pattern: RegExp; role: LocatorRole }> = [
  { pattern: /\bradio button\b|\b单选框\b/iu, role: "radio" },
  { pattern: /\bslider\b|\b滑块\b|\b范围滑块\b|\b拖动条\b/iu, role: "slider" },
  {
    pattern:
      /\bspinbutton\b|\bnumber input\b|\bnumber field\b|\bnumeric input\b|\bnumeric field\b|\b数字输入框\b|\b数值输入框\b|\b数字框\b|\b数值框\b/iu,
    role: "spinbutton"
  },
  {
    pattern: /\btext field\b|\btextbox\b|\btext input\b|\binput\b|\b输入框\b|\b文本框\b/iu,
    role: "textbox"
  },
  { pattern: /\bcombobox\b|\bdropdown\b|\bselect\b|\b下拉框\b|\b选择框\b/iu, role: "combobox" },
  { pattern: /\bcheckbox\b|\b复选框\b/iu, role: "checkbox" },
  { pattern: /\bbutton\b|\b按钮\b/iu, role: "button" },
  { pattern: /\blink\b|\b链接\b/iu, role: "link" },
  { pattern: /\btab\b|\b标签页\b/iu, role: "tab" },
  { pattern: /\bswitch\b|\b开关\b/iu, role: "switch" },
  { pattern: /\bmenuitemradio\b|\b菜单单选项\b/iu, role: "menuitemradio" },
  { pattern: /\bmenuitemcheckbox\b|\b菜单复选项\b/iu, role: "menuitemcheckbox" },
  { pattern: /\bmenu item\b|\bmenuitem\b|\b菜单项\b/iu, role: "menuitem" },
  { pattern: /\boption\b|\b选项\b/iu, role: "option" }
]
const WINDOWS_FAKEPATH_PATTERN = /^[a-z]:\\fakepath\\(.+)$/iu

function quote(value: unknown): string {
  return JSON.stringify(value)
}

function now(): string {
  return new Date().toISOString()
}

function normalizeText(value: string): string {
  return value
    .replace(/^(?:the\s+)?/iu, "")
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function findRoleMatch(value: string): { role: LocatorRole; index: number; length: number } | null {
  for (const entry of ROLE_PATTERNS) {
    const match = entry.pattern.exec(value)
    if (!match || match.index === undefined) continue
    return {
      role: entry.role,
      index: match.index,
      length: match[0].length
    }
  }

  return null
}

function deriveTargetName(target: string | undefined): {
  name?: string
  inferredRole?: LocatorRole
} {
  if (!target) return {}

  const match = findRoleMatch(target)
  if (!match) {
    const normalized = normalizeText(target)
    return normalized ? { name: normalized } : {}
  }

  const prefix = normalizeText(target.slice(0, match.index))
  const suffix = normalizeText(target.slice(match.index + match.length))
  return {
    name: prefix || suffix || normalizeText(target),
    inferredRole: match.role
  }
}

function buildFrameRoot(framePath: string[] | undefined): string {
  if (!framePath || framePath.length === 0) return "page"

  return framePath.reduce((expression, frameSelector) => {
    return `${expression}.frameLocator(${quote(frameSelector)})`
  }, "page")
}

function isFileInputLocatorSource(
  source: Pick<LocatorSource, "tagName" | "inputType" | "selector">
): boolean {
  const tagName = source.tagName ? normalizeText(source.tagName).toLowerCase() : ""
  const inputType = source.inputType ? normalizeText(source.inputType).toLowerCase() : ""
  const selector = source.selector ? normalizeText(source.selector).toLowerCase() : ""

  if (inputType === "file") return true
  if (tagName !== "input") return false

  return /\[type\s*=\s*["']?file["']?\]/u.test(selector)
}

function isChoiceInputLocatorSource(
  source: Pick<LocatorSource, "role" | "tagName" | "inputType">
): boolean {
  const role = source.role ? normalizeText(source.role).toLowerCase() : ""
  const tagName = source.tagName ? normalizeText(source.tagName).toLowerCase() : ""
  const inputType = source.inputType ? normalizeText(source.inputType).toLowerCase() : ""

  return (
    role === "radio" ||
    role === "checkbox" ||
    (tagName === "input" && (inputType === "radio" || inputType === "checkbox"))
  )
}

function isLikelyUniqueChoiceInputSelector(selector: string | undefined): boolean {
  const normalizedSelector = selector ? normalizeText(selector).toLowerCase() : ""
  if (!normalizedSelector) return false

  const isNamedInputSelector =
    /^input(?:\[[^\]]+\])+$/u.test(normalizedSelector) && /\[name\s*=.+\]/u.test(normalizedSelector)

  return (
    normalizedSelector.includes("#") ||
    /\[id\s*=.+\]/u.test(normalizedSelector) ||
    /\[data-testid\s*=.+\]/u.test(normalizedSelector) ||
    /\[value\s*=.+\]/u.test(normalizedSelector) ||
    isNamedInputSelector
  )
}

function decodeCssIdentifier(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6}\s?|.)/giu, (_match, escaped: string) => {
    if (/^[0-9a-f]{1,6}\s?$/iu.test(escaped)) {
      const codePoint = Number.parseInt(escaped.trim(), 16)
      if (Number.isFinite(codePoint)) {
        return String.fromCodePoint(codePoint)
      }
    }
    return escaped
  })
}

function extractIdFromSelector(selector: string | undefined): string | undefined {
  const normalizedSelector = selector ? normalizeText(selector) : ""
  if (!normalizedSelector) return undefined

  if (normalizedSelector.startsWith("#")) {
    return decodeCssIdentifier(normalizedSelector.slice(1))
  }

  const idAttributeMatch = /(?:^|[\w-])\[id\s*=\s*(["'])(.*?)\1\]/u.exec(normalizedSelector)
  return idAttributeMatch?.[2]
}

function buildChoiceLabelSelector(selector: string): string {
  const selectors = [`label:has(${selector})`]
  const inputId = extractIdFromSelector(selector)
  if (inputId) {
    selectors.push(`label[for=${quote(inputId)}]`)
  }
  return selectors.join(", ")
}

function applyOccurrenceHint(locator: string, source: LocatorSource): string {
  if (/\.locator\(\s*["']a\[\s*href\s*=/iu.test(locator)) {
    return locator
  }

  if (typeof source.nth === "number" && Number.isInteger(source.nth) && source.nth >= 0) {
    return `${locator}.nth(${source.nth})`
  }

  if (typeof source.matchCount === "number" && source.matchCount > 1) {
    return `${locator}.first()`
  }

  return locator
}

export function buildPlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): string {
  const fileInputLocator = isFileInputLocatorSource(source)
  if (source.playwrightLocator && !fileInputLocator) return `page.${source.playwrightLocator}`
  return buildCodegenPlaywrightLocator(source as LocatorSource, options)
}

function toLocatorSource(action: AiRecordedBrowserAction): LocatorSource {
  const locator = action.locator
  return {
    target: locator?.target ?? ("target" in action ? action.target : undefined),
    role: locator?.role as LocatorRole | undefined,
    label: locator?.label,
    placeholder: locator?.placeholder,
    testId: locator?.testId,
    accessibleName: locator?.accessibleName,
    textContent: locator?.textContent,
    selector: locator?.selector,
    tagName: locator?.tagName,
    inputType: locator?.inputType,
    framePath: locator?.framePath,
    playwrightLocator: locator?.playwrightLocator,
    textExact: locator?.textExact,
    matchCount: locator?.matchCount,
    nth: locator?.nth
  }
}

function getLocator(
  action: Extract<AiRecordedBrowserAction, { target?: string }>,
  defaultRole?: LocatorRole
): string {
  return buildPlaywrightLocator(toLocatorSource(action), { defaultRole })
}

function buildChoiceInputClickLocator(
  source: LocatorSource,
  visibleTextExpression?: string
): string | null {
  const root = buildFrameRoot(source.framePath)
  const selector = source.selector ? normalizeText(source.selector) : undefined
  if (isLikelyUniqueChoiceInputSelector(selector)) {
    return applyOccurrenceHint(`${root}.locator(${quote(buildChoiceLabelSelector(selector!))})`, source)
  }

  const visibleText =
    visibleTextExpression ??
    [source.textContent, source.accessibleName, source.label, source.target]
      .map((value) => (value ? normalizeText(value) : ""))
      .find(Boolean)

  if (!visibleText) return null

  return applyOccurrenceHint(
    `${root}.getByText(${visibleTextExpression ?? quote(visibleText)}, { exact: ${
      source.textExact !== false ? "true" : "false"
    } })`,
    source
  )
}

function getClickLocator(
  action: Extract<AiRecordedBrowserAction, { kind: "click" }>,
  variableDescriptor?: VariableDescriptor
): string {
  const source = toLocatorSource(action)
  if (isChoiceInputLocatorSource(source)) {
    const choiceLocator = buildChoiceInputClickLocator(source, variableDescriptor?.identifier)
    if (choiceLocator) return choiceLocator
  }

  if (variableDescriptor) {
    return buildVariableizedClickLocator(action, variableDescriptor.identifier)
  }

  return buildPlaywrightLocator(source)
}

function getFileUploadLocator(
  action: Extract<AiRecordedBrowserAction, { kind: "fileUpload" }>
): string {
  const locator = action.locator
  if (locator) {
    return buildPlaywrightLocator({
      target: locator.target,
      role: locator.role as LocatorRole | undefined,
      label: locator.label,
      placeholder: locator.placeholder,
      testId: locator.testId,
      accessibleName: locator.accessibleName,
      textContent: locator.textContent,
      selector: locator.selector,
      tagName: locator.tagName,
      inputType: locator.inputType ?? "file",
      framePath: locator.framePath,
      playwrightLocator: locator.playwrightLocator,
      textExact: locator.textExact,
      matchCount: locator.matchCount,
      nth: locator.nth
    })
  }

  return 'page.locator("input[type=\\"file\\"]")'
}

function sameFramePath(
  left: BrowserLocatorMetadata | undefined,
  right: BrowserLocatorMetadata | undefined
): boolean {
  return JSON.stringify(left?.framePath ?? []) === JSON.stringify(right?.framePath ?? [])
}

function shouldSkipClickBeforeFileUpload(
  clickAction: Extract<AiRecordedBrowserAction, { kind: "click" }>,
  fileUploadAction: Extract<AiRecordedBrowserAction, { kind: "fileUpload" }>
): boolean {
  if (!fileUploadAction.locator) return false
  if (!sameFramePath(clickAction.locator, fileUploadAction.locator)) return false
  return isFileInputLocatorSource(toLocatorSource(fileUploadAction))
}

function canVariableizeClick(action: Extract<AiRecordedBrowserAction, { kind: "click" }>): boolean {
  const locator = action.locator
  return Boolean(
    locator?.textContent ??
    locator?.accessibleName ??
    locator?.label ??
    locator?.placeholder ??
    locator?.target ??
    action.target
  )
}

function supportsVariablePlaceholder(
  action: AiRecordedBrowserAction
): action is
  | Extract<AiRecordedBrowserAction, { kind: "navigate" | "fill" | "selectOption" }>
  | Extract<AiRecordedBrowserAction, { kind: "click" | "fileUpload" }> {
  if (
    action.kind === "navigate" ||
    action.kind === "fill" ||
    action.kind === "selectOption" ||
    action.kind === "fileUpload"
  ) {
    return true
  }
  return action.kind === "click" && canVariableizeClick(action)
}

function stripVariableFieldWords(value: string): string {
  return value
    .replace(/^(?:请输入|请填写|填写|输入|选择|点击)\s*/u, "")
    .replace(
      /\s*(?:输入框|文本框|输入栏|文本域|字段|下拉框|选择框|按钮|链接|选项|流水线|input|textbox|text\s*box|text\s*field|input\s*field|field|dropdown|select|button|link|option)$/iu,
      ""
    )
    .trim()
}

function deriveVariableBaseName(
  action:
    | Extract<AiRecordedBrowserAction, { kind: "navigate" | "fill" | "selectOption" }>
    | Extract<AiRecordedBrowserAction, { kind: "click" | "fileUpload" }>
): string {
  if (action.kind === "navigate") return "页面地址"
  const locator = action.locator
  if (action.kind === "fileUpload") return "上传文件路径"
  const candidates =
    action.kind === "click"
      ? [
          locator?.textContent,
          locator?.accessibleName,
          locator?.label,
          locator?.placeholder,
          locator?.target,
          action.target
        ]
      : [
          locator?.label,
          locator?.placeholder,
          locator?.accessibleName,
          locator?.target,
          action.target,
          locator?.textContent
        ]

  for (const candidate of candidates) {
    if (!candidate) continue
    const derived = deriveTargetName(candidate)
    const rawName = stripVariableFieldWords(normalizeText(derived.name ?? candidate))
    if (!rawName) continue
    return rawName
  }

  return "值"
}

function toSafeVariableStem(value: string): string {
  const normalized = normalizeText(value)
  const stem = normalized.replace(/[^\p{L}\p{N}_]+/gu, "")
  return stem || "值"
}

function toPromptVariableName(identifier: string): string {
  return identifier.replace(/^变量_/u, "变量-").replace(/_/gu, "-")
}

function normalizeVariableDisplayName(value: string | undefined): string {
  return value?.trim() ?? ""
}

function deriveVariableDisplayName(
  identifier: string,
  rawDisplayName?: string
): string {
  const normalizedCommentDisplayName = normalizeVariableDisplayName(
    rawDisplayName?.replace(/^变量[-_]/u, "")
  )
  if (normalizedCommentDisplayName) {
    return normalizedCommentDisplayName
  }

  return toPromptVariableName(identifier).replace(/^变量-/u, "")
}

function buildVariableDescriptorMap(
  actions: AiRecordedBrowserAction[],
  variableActionIds?: Iterable<string>,
  variableActionNames?: Record<string, string>
): Map<string, VariableDescriptor> {
  const variableIds = new Set(variableActionIds)
  const variableDescriptors = new Map<string, VariableDescriptor>()
  const descriptorsByDisplayName = new Map<string, VariableDescriptor>()
  const usedIdentifiers = new Set<string>()

  for (const action of actions) {
    if (!variableIds.has(action.id) || !supportsVariablePlaceholder(action)) continue
    const requestedDisplayName = normalizeVariableDisplayName(variableActionNames?.[action.id])
    const fallbackDisplayName = variableActionNames
      ? ""
      : stripVariableFieldWords(deriveVariableBaseName(action))
    const displayNameBase = requestedDisplayName || fallbackDisplayName
    if (!displayNameBase) continue

    const existingDescriptor = descriptorsByDisplayName.get(displayNameBase)
    if (existingDescriptor) {
      variableDescriptors.set(action.id, existingDescriptor)
      continue
    }

    const baseName = toSafeVariableStem(displayNameBase)
    let suffix = 0
    let identifier = ""

    do {
      suffix += 1
      const identifierSuffix = suffix === 1 ? "" : `_${suffix}`
      identifier = `变量_${baseName}${identifierSuffix}`
    } while (usedIdentifiers.has(identifier))

    usedIdentifiers.add(identifier)
    const promptName = `变量-${displayNameBase}`
    const isArrayVariable = action.kind === "fileUpload" && action.paths.length > 1
    const descriptor: VariableDescriptor = {
      displayName: promptName,
      identifier,
      declaration: buildScriptVariableDeclaration({
        displayName: displayNameBase,
        identifier,
        isArray: isArrayVariable
      })
    }
    descriptorsByDisplayName.set(displayNameBase, descriptor)
    variableDescriptors.set(action.id, descriptor)
  }

  return variableDescriptors
}

function parseScriptQuotedValue(value: string, start = 0): { value: string; end: number } | null {
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

function parseScriptStringArray(value: string): string[] | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null

  const values: string[] = []
  let index = 1
  while (index < trimmed.length - 1) {
    while (/[\s,]/u.test(trimmed[index] ?? "")) index += 1
    if (index >= trimmed.length - 1) break

    const parsed = parseScriptQuotedValue(trimmed, index)
    if (!parsed) return null
    values.push(parsed.value)
    index = parsed.end
  }

  return values
}

type ParsedScriptLiteral =
  | { kind: "string"; value: string }
  | { kind: "identifier"; identifier: string }
  | { kind: "stringArray"; values: string[] }
  | { kind: "unknown" }

function parseScriptLiteralExpression(value: string): ParsedScriptLiteral {
  const trimmed = value.trim()
  if (!trimmed) return { kind: "unknown" }

  const arrayValues = parseScriptStringArray(trimmed)
  if (arrayValues) return { kind: "stringArray", values: arrayValues }

  const quoted = parseScriptQuotedValue(trimmed)
  if (quoted && quoted.end === trimmed.length) {
    return { kind: "string", value: quoted.value }
  }

  if (/^变量_[\p{L}\p{N}_]+$/u.test(trimmed)) {
    return { kind: "identifier", identifier: trimmed }
  }

  return { kind: "unknown" }
}

function parseVariableDeclarationLine(line: string): AiRecordingScriptVariable | null {
  const match =
    /^const\s+(变量_[\p{L}\p{N}_]+)\s*(?::\s*(string\[\]))?\s*=\s*(.+?)(?:\s*;)?(?:\s*\/\/\s*(.+))?\s*$/u.exec(
      line
    )
  if (!match) return null

  const valueExpression = parseScriptLiteralExpression(match[3]!)
  if (valueExpression.kind !== "string" && valueExpression.kind !== "stringArray") {
    return null
  }

  const displayName = deriveVariableDisplayName(match[1]!, match[4])
  if (!displayName) return null
  return {
    identifier: match[1]!,
    displayName,
    isArray: Boolean(match[2])
  }
}

function buildScriptVariableDeclaration(
  variable: AiRecordingScriptVariable,
  value?: AiRecordingScriptVariableValue
): string {
  const serializedValue =
    value === undefined ? (variable.isArray ? "[]" : '""') : JSON.stringify(value)
  return `const ${variable.identifier} = ${serializedValue}; // 变量-${variable.displayName}`
}

function parseLocatorExpressionValue(rawValue: string | undefined): string | undefined {
  if (!rawValue) return undefined
  const parsed = parseScriptLiteralExpression(rawValue)
  if (parsed.kind === "string") return parsed.value
  if (parsed.kind === "identifier") return parsed.identifier
  return undefined
}

function parseScriptStringValue(expression: string): string | undefined {
  const parsed = parseScriptLiteralExpression(expression)
  if (parsed.kind === "string") return parsed.value
  if (parsed.kind === "identifier") return parsed.identifier
  return undefined
}

function parseScriptActionValue(expression: string): {
  value?: string
  identifier?: string
  isPassword?: boolean
  values?: string[]
} {
  const parsed = parseScriptLiteralExpression(expression)
  switch (parsed.kind) {
    case "string":
      return { value: parsed.value }
    case "identifier":
      return { identifier: parsed.identifier }
    case "stringArray":
      return { values: parsed.values }
    default:
      return {}
  }
}

function extractFakePathFileName(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.match(WINDOWS_FAKEPATH_PATTERN)?.[1]
}

function normalizeLegacyFileUploadPaths(value: string): string[] {
  return [extractFakePathFileName(value) ?? value]
}

function shouldTreatFillAsLegacyFileUpload(
  locator: BrowserLocatorMetadata,
  target: string | undefined,
  value: string | undefined
): boolean {
  if (!extractFakePathFileName(value)) return false

  if (
    isFileInputLocatorSource({
      tagName: locator.tagName,
      inputType: locator.inputType,
      selector: locator.selector
    })
  ) {
    return true
  }

  const targetText = [
    locator.accessibleName,
    locator.label,
    locator.target,
    locator.textContent,
    target
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ")

  return locator.role === "button" || /choose file|upload|文件|上传/iu.test(targetText)
}

function preservedFileUploadLocator(
  locator: BrowserLocatorMetadata
): BrowserLocatorMetadata | undefined {
  return isFileInputLocatorSource({
    tagName: locator.tagName,
    inputType: locator.inputType,
    selector: locator.selector
  })
    ? locator
    : undefined
}

function extractVariableIdentifierFromExpression(expression: string): string | undefined {
  return expression.match(/变量_[\p{L}\p{N}_]+/u)?.[0]
}

function parseLocatorRole(value: string | undefined): BrowserLocatorMetadata["role"] {
  const normalized = value?.trim().toLowerCase()
  switch (normalized) {
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
      return normalized
    default:
      return undefined
  }
}

function parseLocatorExpression(expression: string): BrowserLocatorMetadata {
  const locatorExpression = expression.trim()
  const framePath = Array.from(
    locatorExpression.matchAll(/frameLocator\(\s*(['"])(.*?)\1\s*\)/gu)
  ).map((match) => match[2]!)
  const nthMatch = /\.nth\(\s*(\d+)\s*\)/u.exec(locatorExpression)
  const hasFirstHint = /\.first\(\s*\)/u.test(locatorExpression)
  const metadata: BrowserLocatorMetadata = {
    framePath: framePath.length > 0 ? framePath : undefined,
    nth: nthMatch ? Number(nthMatch[1]) : undefined,
    matchCount: hasFirstHint ? 2 : undefined
  }

  const roleQuotedMatch =
    /getByRole\(\s*(['"])(.*?)\1\s*,\s*\{\s*name\s*:\s*((['"])(?:\\.|.)*?\4)\s*(?:,\s*exact\s*:\s*(?:true|false)\s*)?\}\s*\)/u.exec(
      locatorExpression
    )
  if (roleQuotedMatch) {
    metadata.role = parseLocatorRole(roleQuotedMatch[2])
    metadata.accessibleName = parseLocatorExpressionValue(roleQuotedMatch[3])
    return metadata
  }

  const roleVariableMatch =
    /getByRole\(\s*(['"])(.*?)\1\s*,\s*\{\s*name\s*:\s*(变量_[\p{L}\p{N}_]+)\s*(?:,\s*exact\s*:\s*(?:true|false)\s*)?\}\s*\)/u.exec(
      locatorExpression
    )
  if (roleVariableMatch) {
    metadata.role = parseLocatorRole(roleVariableMatch[2])
    metadata.accessibleName = roleVariableMatch[3]
    return metadata
  }

  const builders: Array<{
    name: "label" | "placeholder" | "testId" | "textContent"
    pattern: RegExp
  }> = [
    { name: "label", pattern: /getByLabel\(\s*((?:['"])(?:\\.|.)*?['"])\s*\)/u },
    { name: "placeholder", pattern: /getByPlaceholder\(\s*((?:['"])(?:\\.|.)*?['"])\s*\)/u },
    { name: "testId", pattern: /getByTestId\(\s*((?:['"])(?:\\.|.)*?['"])\s*\)/u },
    {
      name: "textContent",
      pattern:
        /getByText\(\s*(((?:['"])(?:\\.|.)*?['"])|变量_[\p{L}\p{N}_]+)\s*(?:,\s*\{[\s\S]*?\})?\)/u
    }
  ]
  for (const builder of builders) {
    const match = builder.pattern.exec(locatorExpression)
    if (!match) continue
    metadata[builder.name] = parseLocatorExpressionValue(match[1])
    if (builder.name === "textContent") {
      metadata.textExact = /exact\s*:\s*true/u.test(locatorExpression)
    }
    return metadata
  }

  const selectorMatch =
    /locator\(\s*(((['"])(?:\\.|.)*?\3))\s*\)/u.exec(locatorExpression)
  if (selectorMatch) metadata.selector = parseLocatorExpressionValue(selectorMatch[1])
  if (!selectorMatch) metadata.playwrightLocator = locatorExpression
  return metadata
}

function parseRecordedScriptActions(
  script: string,
  source: BrowserRecordingSource
): {
  actions: AiRecordedBrowserAction[]
  variableActionIds: string[]
  variableActionNames: Record<string, string>
} {
  const variableDeclarations = new Map<string, AiRecordingScriptVariable>()
  const lines = script.split(/\r?\n/u).map((line) => line.trim())

  for (const line of lines) {
    const declaration = parseVariableDeclarationLine(line)
    if (!declaration) continue
    variableDeclarations.set(declaration.identifier, declaration)
  }

  const actions: AiRecordedBrowserAction[] = []
  const variableActionIds: string[] = []
  const variableActionNames: Record<string, string> = {}
  let parsedActionNumber = 0

  const pushAction = (action: ParsedRecordedActionInput, variableIdentifier?: string): void => {
    parsedActionNumber += 1
    const id = `${source}-seed-action-${parsedActionNumber}`
    const recordedAction: AiRecordedBrowserAction = {
      ...action,
      id,
      source,
      timestamp: now()
    } as AiRecordedBrowserAction
    if (variableIdentifier) {
      const displayName =
        variableDeclarations.get(variableIdentifier)?.displayName ?? variableIdentifier
      variableActionIds.push(id)
      variableActionNames[id] = displayName
      if ("target" in recordedAction && !recordedAction.target) {
        recordedAction.target = displayName
      }
      if (
        recordedAction.kind === "fill" &&
        recordedAction.locator &&
        !recordedAction.locator.target
      ) {
        recordedAction.locator.target = displayName
      }
      if (
        recordedAction.kind === "click" &&
        recordedAction.locator &&
        !recordedAction.locator.accessibleName &&
        !recordedAction.locator.textContent
      ) {
        recordedAction.locator.accessibleName = displayName
      }
    }
    actions.push(recordedAction)
  }

  for (const line of lines) {
    if (
      !line ||
      line.startsWith("import ") ||
      line.startsWith("const ") ||
      line.startsWith("test(")
    ) {
      continue
    }
    if (line === "});" || line === "// Review generated locators before committing this test.") {
      continue
    }

    const navigateMatch = /^await\s+page\.goto\(\s*(.+)\s*\);$/u.exec(line)
    if (navigateMatch) {
      const value = parseScriptActionValue(navigateMatch[1]!)
      const url =
        value.value ??
        (value.identifier
          ? (variableDeclarations.get(value.identifier)?.displayName ?? value.identifier)
          : undefined)
      if (url) {
        pushAction(
          {
            kind: "navigate",
            url
          },
          value.identifier
        )
      }
      continue
    }

    const keyboardPressMatch = /^await\s+page\.keyboard\.press\(\s*(.+)\s*\);$/u.exec(line)
    if (keyboardPressMatch) {
      const key = parseScriptStringValue(keyboardPressMatch[1]!)
      if (key) pushAction({ kind: "press", key })
      continue
    }

    if (/^const\s+fileChooserPromise\d+\s*=\s*page\.waitForEvent\("filechooser"\);$/u.test(line)) {
      continue
    }

    const fileChooserSetFilesMatch = /^await\s+fileChooser\d+\.setFiles\(\s*(.+)\s*\);$/u.exec(line)
    if (fileChooserSetFilesMatch) {
      const value = parseScriptActionValue(fileChooserSetFilesMatch[1]!)
      const paths = value.values ?? (value.value ? [value.value] : [])
      if (paths.length > 0 || value.identifier) {
        pushAction(
          {
            kind: "fileUpload",
            paths: paths.length > 0 ? paths : value.identifier ? [value.identifier] : []
          },
          value.identifier
        )
      }
      continue
    }

    const setInputFilesMatch = /^await\s+(.+)\.setInputFiles\(\s*(.+)\s*\);$/u.exec(line)
    if (setInputFilesMatch) {
      const locator = parseLocatorExpression(setInputFilesMatch[1]!)
      if (!locator.inputType) locator.inputType = "file"
      if (!locator.tagName && locator.selector?.trim().toLowerCase().startsWith("input")) {
        locator.tagName = "input"
      }
      const value = parseScriptActionValue(setInputFilesMatch[2]!)
      const paths = value.values ?? (value.value ? [value.value] : [])
      if (paths.length > 0 || value.identifier) {
        pushAction(
          {
            kind: "fileUpload",
            paths: paths.length > 0 ? paths : value.identifier ? [value.identifier] : [],
            locator
          },
          value.identifier
        )
      }
      continue
    }

    const actionMatch =
      /^await\s+(.+)\.(dblclick|click|fill|selectOption|press)\(\s*(.*)\s*\);$/u.exec(line)
    if (!actionMatch) continue

    const locatorExpression = actionMatch[1]!
    const method = actionMatch[2] as "dblclick" | "click" | "fill" | "selectOption" | "press"
    const locator = parseLocatorExpression(locatorExpression)
    const variableIdentifier =
      extractVariableIdentifierFromExpression(locatorExpression) ??
      (method === "fill" || method === "selectOption" || method === "press"
        ? extractVariableIdentifierFromExpression(actionMatch[3]!)
        : undefined)
    const actionTarget = variableIdentifier
      ? (variableDeclarations.get(variableIdentifier)?.displayName ?? variableIdentifier)
      : (locator.accessibleName ??
        locator.label ??
        locator.placeholder ??
        locator.target ??
        locator.textContent)

    switch (method) {
      case "dblclick":
      case "click":
        pushAction(
          {
            kind: "click",
            target: actionTarget,
            doubleClick: method === "dblclick",
            locator
          },
          variableIdentifier
        )
        break
      case "fill": {
        const value = parseScriptActionValue(actionMatch[3]!)
        if (shouldTreatFillAsLegacyFileUpload(locator, actionTarget, value.value)) {
          pushAction({
            kind: "fileUpload",
            paths: normalizeLegacyFileUploadPaths(value.value!),
            locator: preservedFileUploadLocator(locator)
          })
          break
        }
        pushAction(
          {
            kind: "fill",
            target: actionTarget,
            value: value.value ?? "",
            sensitive:
              value.isPassword === true ||
              (actionTarget
                ? /pass(word|code)?|secret|token|密码|口令/iu.test(actionTarget)
                : false),
            locator
          },
          value.identifier ?? variableIdentifier
        )
        break
      }
      case "selectOption": {
        const value = parseScriptActionValue(actionMatch[3]!)
        pushAction(
          {
            kind: "selectOption",
            target: actionTarget,
            values: value.values ?? (value.value ? [value.value] : []),
            locator
          },
          value.identifier ?? variableIdentifier
        )
        break
      }
      case "press": {
        const value = parseScriptActionValue(actionMatch[3]!)
        const key = value.value ?? value.identifier
        if (!key) break
        pushAction(
          {
            kind: "press",
            key,
            target: actionTarget,
            locator
          },
          value.identifier ?? variableIdentifier
        )
        break
      }
    }
  }

  return {
    actions,
    variableActionIds,
    variableActionNames
  }
}

function buildVariableizedClickLocator(
  action: Extract<AiRecordedBrowserAction, { kind: "click" }>,
  variableIdentifier: string
): string {
  const source = toLocatorSource(action)
  const root = buildFrameRoot(source.framePath)
  const derivedTarget = deriveTargetName(source.target)
  const role = source.role ?? derivedTarget.inferredRole
  if (role) {
    return applyOccurrenceHint(
      `${root}.getByRole(${quote(role)}, { name: ${variableIdentifier}, exact: true })`,
      source
    )
  }

  return applyOccurrenceHint(
    `${root}.getByText(${variableIdentifier}, { exact: ${source.textExact !== false ? "true" : "false"} })`,
    source
  )
}

function generateActionLine(
  action: AiRecordedBrowserAction,
  variableDescriptor?: VariableDescriptor
): string {
  switch (action.kind) {
    case "navigate":
      return `await page.goto(${
        variableDescriptor ? variableDescriptor.identifier : quote(action.url)
      });`
    case "click":
      return `await ${getClickLocator(action, variableDescriptor)}.${
        action.doubleClick ? "dblclick" : "click"
      }();`
    case "fill":
      return `await ${getLocator(action, "textbox")}.fill(${
        variableDescriptor ? variableDescriptor.identifier : quote(action.value)
      });`
    case "selectOption":
      return `await ${getLocator(action, "combobox")}.selectOption(${
        variableDescriptor
          ? variableDescriptor.identifier
          : quote(action.values.length === 1 ? action.values[0]! : action.values)
      });`
    case "fileUpload":
      return `await ${getFileUploadLocator(action)}.setInputFiles(${formatFileUploadPaths(
        action,
        variableDescriptor
      )});`
    case "press":
      return action.target
        ? `await ${getLocator(action)}.press(${quote(action.key)});`
        : `await page.keyboard.press(${quote(action.key)});`
  }
}

function formatFileUploadPaths(
  action: Extract<AiRecordedBrowserAction, { kind: "fileUpload" }>,
  variableDescriptor?: VariableDescriptor
): string {
  if (variableDescriptor) return variableDescriptor.identifier
  return quote(action.paths.length === 1 ? action.paths[0]! : action.paths)
}

function extractClickLocatorExpressionFromLine(line: string): string | null {
  const match = /^await\s+(.+)\.(dblclick|click)\(\);\s*$/u.exec(line.trim())
  return match?.[1] ?? null
}

function isChoiceLabelSelector(selector: string | undefined): boolean {
  const normalizedSelector = selector ? normalizeText(selector).toLowerCase() : ""
  return normalizedSelector
    .split(",")
    .map((item) => item.trim())
    .some((item) => item.startsWith("label:has(") || /^label\[for=.+\]$/u.test(item))
}

function shouldReplaceWithChoiceWrapperClick(previousLine: string, nextLine: string): boolean {
  const previousLocatorExpression = extractClickLocatorExpressionFromLine(previousLine)
  const nextLocatorExpression = extractClickLocatorExpressionFromLine(nextLine)
  if (!previousLocatorExpression || !nextLocatorExpression) return false

  const previousLocator = parseLocatorExpression(previousLocatorExpression)
  const nextLocator = parseLocatorExpression(nextLocatorExpression)
  if (!isChoiceLabelSelector(nextLocator.selector)) return false

  return (
    previousLocator.role === "radio" ||
    previousLocator.role === "checkbox" ||
    previousLocator.label !== undefined
  )
}

function collapseRedundantChoiceClickLines(source: string): string {
  const lines = source.split(/\r?\n/u)
  const collapsed: string[] = []

  for (const line of lines) {
    const previousLine = collapsed[collapsed.length - 1]
    if (previousLine && shouldReplaceWithChoiceWrapperClick(previousLine, line)) {
      collapsed[collapsed.length - 1] = line
      continue
    }
    collapsed.push(line)
  }

  return collapsed.join("\n")
}

function generateAiRecordingActionLines(
  actions: AiRecordedBrowserAction[],
  variableDescriptorMap: Map<string, VariableDescriptor>
): string[] {
  const lines: string[] = []

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!
    const nextAction = actions[index + 1]
    const variableDescriptor = variableDescriptorMap.get(action.id)

    if (
      !variableDescriptor &&
      action.kind === "click" &&
      nextAction?.kind === "fileUpload" &&
      shouldSkipClickBeforeFileUpload(action, nextAction)
    ) {
      continue
    }

    if (!variableDescriptor && !(action.kind === "press" && !action.target)) {
      const generatedLines = generatePlaywrightCodegenActionLines([action])
      if (generatedLines.length > 0) {
        lines.push(...generatedLines)
        continue
      }
    }

    lines.push(generateActionLine(action, variableDescriptor))
  }

  return lines
}

export function extractAiRecordingVariableNames(script: string): string[] {
  const variableNames = new Set<string>(
    extractAiRecordingVariables(script).map((variable) => `变量-${variable.displayName}`)
  )

  for (const match of script.matchAll(/变量(?:_[\p{L}\p{N}_]+|\d+)/gu)) {
    const identifier = match[0]
    variableNames.add(
      identifier.startsWith("变量_") ? toPromptVariableName(identifier) : identifier
    )
  }

  return Array.from(variableNames)
}

export function extractAiRecordingVariables(script: string): AiRecordingScriptVariable[] {
  const variables: AiRecordingScriptVariable[] = []
  const seenIdentifiers = new Set<string>()

  for (const line of script.split(/\r?\n/u)) {
    const variable = parseVariableDeclarationLine(line.trim())
    if (!variable || seenIdentifiers.has(variable.identifier)) continue
    seenIdentifiers.add(variable.identifier)
    variables.push(variable)
  }

  return variables
}

export function applyAiRecordingVariableValues(
  script: string,
  variableValues?: Record<string, AiRecordingScriptVariableValue>
): string {
  if (!variableValues || Object.keys(variableValues).length === 0) return script

  return script
    .split(/\r?\n/u)
    .map((line) => {
      const variable = parseVariableDeclarationLine(line.trim())
      if (!variable) return line
      if (!Object.prototype.hasOwnProperty.call(variableValues, variable.identifier)) {
        return line
      }

      const nextValue = variableValues[variable.identifier]
      if (variable.isArray) {
        if (!Array.isArray(nextValue)) {
          throw new Error(`变量「${variable.displayName}」需要多行输入`)
        }
        return buildScriptVariableDeclaration(variable, nextValue)
      }
      if (Array.isArray(nextValue)) {
        throw new Error(`变量「${variable.displayName}」只接受单个值`)
      }
      return buildScriptVariableDeclaration(variable, nextValue)
    })
    .join("\n")
}

export function parseAiRecordingScript(
  script: string,
  source: BrowserRecordingSource = "ai"
): {
  actions: AiRecordedBrowserAction[]
  variableActionIds: string[]
  variableActionNames: Record<string, string>
} {
  return parseRecordedScriptActions(script, source)
}

export function generateAiRecordingScript(
  actions: AiRecordedBrowserAction[],
  options: AiRecordingScriptOptions = {}
): string {
  const source = options.source ?? actions[0]?.source ?? "ai"
  const scriptedActions = actions
  const variableDescriptorMap = buildVariableDescriptorMap(
    scriptedActions,
    options.variableActionIds,
    options.variableActionNames
  )
  const variableDeclarations = Array.from(
    new Map(
      Array.from(variableDescriptorMap.values()).map((descriptor) => [
        descriptor.identifier,
        descriptor
      ])
    ).values()
  )
    .map((descriptor) => descriptor.declaration)
    .join("\n")
  const lines = generateAiRecordingActionLines(scriptedActions, variableDescriptorMap)
  const body =
    lines.length > 0
      ? lines.map((line) => `  ${line}`).join("\n")
      : "  // No supported Playwright browser actions were recorded."
  const testName = source === "manual" ? "manual recorded flow" : "AI recorded flow"

  return `import { test } from "@playwright/test";

${variableDeclarations ? `${variableDeclarations}\n` : ""}

test(${quote(testName)}, async ({ page }) => {
  // Review generated locators before committing this test.
${body}
});
`
}

export function buildAiRecordingExecutableScript(script: string): string {
  const normalizedScript = script.replace(
    /^(\s*const\s+变量_[\p{L}\p{N}_]+)\s*:\s*string\[\](\s*=\s*.+;\s*\/\/\s*变量[-_].*)$/gmu,
    "$1$2"
  )
  const lines = normalizedScript.split(/\r?\n/u).filter((line) => !/^\s*import\s+/u.test(line))
  const testStartIndex = lines.findIndex((line) => /^\s*test\s*\(/u.test(line))
  if (testStartIndex === -1) {
    return collapseRedundantChoiceClickLines(lines.join("\n")).trimStart().trimEnd()
  }

  let testEndIndex = -1
  for (let index = lines.length - 1; index > testStartIndex; index -= 1) {
    if (/^\s*\}\);\s*$/u.test(lines[index]!)) {
      testEndIndex = index
      break
    }
  }

  if (testEndIndex === -1) {
    return collapseRedundantChoiceClickLines(lines.join("\n")).trimStart().trimEnd()
  }
  return collapseRedundantChoiceClickLines(
    [...lines.slice(0, testStartIndex), ...lines.slice(testStartIndex + 1, testEndIndex)].join("\n")
  )
    .trimStart()
    .trimEnd()
}
