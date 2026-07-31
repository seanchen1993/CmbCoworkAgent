import type { AiRecordedBrowserAction } from "./browser-types"

export type LocatorRole =
  | "button"
  | "checkbox"
  | "combobox"
  | "link"
  | "menuitem"
  | "option"
  | "radio"
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
}

interface VariableDescriptor {
  displayName: string
  identifier: string
  declaration: string
}

type LocatorCandidateKind =
  | "testId"
  | "label"
  | "placeholder"
  | "role"
  | "selector"
  | "text"
  | "css"
  | "fallback"

interface LocatorCandidate {
  kind: LocatorCandidateKind
  locator: string
  score: number
  assumedUnique: boolean
  reason: string
}

const ROLE_PATTERNS: Array<{ pattern: RegExp; role: LocatorRole }> = [
  { pattern: /\bradio button\b|\b单选框\b/iu, role: "radio" },
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
  { pattern: /\bmenu item\b|\bmenuitem\b|\b菜单项\b/iu, role: "menuitem" },
  { pattern: /\boption\b|\b选项\b/iu, role: "option" }
]

function quote(value: unknown): string {
  return JSON.stringify(value)
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

function applyOccurrenceHint(locator: string, source: LocatorSource): string {
  if (typeof source.nth === "number" && Number.isInteger(source.nth) && source.nth >= 0) {
    return `${locator}.nth(${source.nth})`
  }

  if (typeof source.matchCount === "number" && source.matchCount > 1) {
    return `${locator}.first()`
  }

  return locator
}

function buildCandidate(
  kind: LocatorCandidateKind,
  locator: string,
  score: number,
  assumedUnique: boolean,
  reason: string
): LocatorCandidate {
  return {
    kind,
    locator,
    score,
    assumedUnique,
    reason
  }
}

function pushCandidate(
  candidates: LocatorCandidate[],
  candidate: LocatorCandidate | null | undefined
): void {
  if (!candidate) return

  const existing = candidates.find((item) => item.locator === candidate.locator)
  if (!existing) {
    candidates.push(candidate)
    return
  }

  if (candidate.score > existing.score) {
    existing.kind = candidate.kind
    existing.score = candidate.score
    existing.assumedUnique = candidate.assumedUnique
    existing.reason = candidate.reason
  }
}

function buildRoleCandidate(
  root: string,
  role: LocatorRole | undefined,
  name: string | undefined,
  reason: string,
  score: number
): LocatorCandidate | null {
  if (!role || !name) return null

  return buildCandidate(
    "role",
    `${root}.getByRole(${quote(role)}, { name: ${quote(name)} })`,
    score,
    true,
    reason
  )
}

function buildLabelCandidate(root: string, label: string | undefined): LocatorCandidate | null {
  if (!label) return null
  return buildCandidate("label", `${root}.getByLabel(${quote(label)})`, 90, true, "explicit label")
}

function buildPlaceholderCandidate(
  root: string,
  placeholder: string | undefined
): LocatorCandidate | null {
  if (!placeholder) return null
  return buildCandidate(
    "placeholder",
    `${root}.getByPlaceholder(${quote(placeholder)})`,
    92,
    true,
    "explicit placeholder"
  )
}

function buildTestIdCandidate(root: string, testId: string | undefined): LocatorCandidate | null {
  if (!testId) return null
  return buildCandidate(
    "testId",
    `${root}.getByTestId(${quote(testId)})`,
    100,
    true,
    "explicit test id"
  )
}

function buildSelectorCandidate(
  root: string,
  selector: string | undefined
): LocatorCandidate | null {
  if (!selector) return null
  return buildCandidate(
    "selector",
    `${root}.locator(${quote(selector)})`,
    70,
    false,
    "explicit selector fallback"
  )
}

function buildTextCandidate(
  root: string,
  text: string | undefined,
  exact = true
): LocatorCandidate | null {
  if (!text) return null
  return buildCandidate(
    "text",
    `${root}.getByText(${quote(text)}, { exact: ${exact ? "true" : "false"} })`,
    55,
    false,
    "text fallback"
  )
}

function buildCssCandidate(
  root: string,
  tagName: string | undefined,
  inputType: string | undefined
): LocatorCandidate | null {
  const normalizedTag = tagName ? normalizeText(tagName).toLowerCase() : ""
  const normalizedInputType = inputType ? normalizeText(inputType).toLowerCase() : ""

  if (!normalizedTag && !normalizedInputType) return null

  let selector = normalizedTag || "input"
  if (normalizedInputType) {
    if (!normalizedTag || normalizedTag === "input") {
      selector = `input[type=${normalizedInputType}]`
    } else {
      selector = `${normalizedTag}[type=${normalizedInputType}]`
    }
  }

  return buildCandidate("css", `${root}.locator(${quote(selector)})`, 40, false, "tag fallback")
}

function buildFallbackCandidate(root: string): LocatorCandidate {
  return buildCandidate(
    "fallback",
    `${root}.locator("TODO_SELECTOR")`,
    0,
    false,
    "missing locator metadata"
  )
}

function compareCandidates(left: LocatorCandidate, right: LocatorCandidate): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.assumedUnique !== right.assumedUnique) {
    return Number(right.assumedUnique) - Number(left.assumedUnique)
  }

  const order: Record<LocatorCandidateKind, number> = {
    testId: 0,
    role: 1,
    placeholder: 2,
    label: 3,
    selector: 4,
    text: 5,
    css: 6,
    fallback: 7
  }

  return order[left.kind] - order[right.kind]
}

export function buildPlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): string {
  if (source.playwrightLocator) return `page.${source.playwrightLocator}`

  const root = buildFrameRoot(source.framePath)
  const candidates: LocatorCandidate[] = []
  const normalizedLabel = source.label ? normalizeText(source.label) : undefined
  const normalizedPlaceholder = source.placeholder ? normalizeText(source.placeholder) : undefined
  const normalizedTestId = source.testId ? normalizeText(source.testId) : undefined
  const normalizedAccessibleName = source.accessibleName
    ? normalizeText(source.accessibleName)
    : undefined
  const normalizedText = source.textContent ? normalizeText(source.textContent) : undefined
  const normalizedSelector = source.selector ? normalizeText(source.selector) : undefined
  const derivedTarget = deriveTargetName(source.target)
  const normalizedTarget = derivedTarget.name
  const role = source.role ?? derivedTarget.inferredRole ?? options.defaultRole
  const roleName =
    normalizedAccessibleName ?? normalizedLabel ?? normalizedPlaceholder ?? normalizedTarget

  pushCandidate(candidates, buildTestIdCandidate(root, normalizedTestId))
  pushCandidate(candidates, buildLabelCandidate(root, normalizedLabel))
  pushCandidate(candidates, buildPlaceholderCandidate(root, normalizedPlaceholder))
  pushCandidate(
    candidates,
    buildRoleCandidate(
      root,
      role,
      roleName,
      source.role
        ? "explicit role metadata"
        : derivedTarget.inferredRole
          ? "inferred role from target"
          : "default role",
      source.role ? 96 : derivedTarget.inferredRole ? 86 : 82
    )
  )
  pushCandidate(candidates, buildSelectorCandidate(root, normalizedSelector))
  pushCandidate(
    candidates,
    buildTextCandidate(root, normalizedText ?? normalizedTarget, source.textExact !== false)
  )
  pushCandidate(candidates, buildCssCandidate(root, source.tagName, source.inputType))

  if (candidates.length === 0) {
    candidates.push(buildFallbackCandidate(root))
  }

  candidates.sort(compareCandidates)
  return applyOccurrenceHint(candidates[0]!.locator, source)
}

function toLocatorSource(
  action: Extract<AiRecordedBrowserAction, { target?: string }>
): LocatorSource {
  const locator = action.locator
  return {
    target: locator?.target ?? action.target,
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
  | Extract<AiRecordedBrowserAction, { kind: "fill" | "selectOption" }>
  | Extract<AiRecordedBrowserAction, { kind: "click" | "fileUpload" }> {
  if (action.kind === "fill" || action.kind === "selectOption" || action.kind === "fileUpload") {
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
    | Extract<AiRecordedBrowserAction, { kind: "fill" | "selectOption" }>
    | Extract<AiRecordedBrowserAction, { kind: "click" | "fileUpload" }>
): string {
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

function buildVariableDescriptorMap(
  actions: AiRecordedBrowserAction[],
  variableActionIds?: Iterable<string>,
  variableActionNames?: Record<string, string>
): Map<string, VariableDescriptor> {
  const variableIds = new Set(variableActionIds)
  const variableDescriptors = new Map<string, VariableDescriptor>()
  const usedIdentifiers = new Set<string>()
  const usedPromptNames = new Set<string>()

  for (const action of actions) {
    if (!variableIds.has(action.id) || !supportsVariablePlaceholder(action)) continue
    const requestedDisplayName = normalizeVariableDisplayName(variableActionNames?.[action.id])
    const fallbackDisplayName = variableActionNames
      ? ""
      : stripVariableFieldWords(deriveVariableBaseName(action))
    const displayNameBase = requestedDisplayName || fallbackDisplayName
    if (!displayNameBase) continue

    const baseName = toSafeVariableStem(displayNameBase)
    let suffix = 0
    let identifier = ""
    let promptName = ""

    do {
      suffix += 1
      const identifierSuffix = suffix === 1 ? "" : `_${suffix}`
      const promptSuffix = suffix === 1 ? "" : `${suffix}`
      identifier = `变量_${baseName}${identifierSuffix}`
      promptName = `变量-${displayNameBase}${promptSuffix}`
    } while (usedIdentifiers.has(identifier) || usedPromptNames.has(promptName))

    usedIdentifiers.add(identifier)
    usedPromptNames.add(promptName)
    variableDescriptors.set(action.id, {
      displayName: promptName,
      identifier,
      declaration:
        action.kind === "fileUpload" && action.paths.length > 1
          ? `const ${identifier}: string[] = []; // ${promptName}`
          : `const ${identifier} = ""; // ${promptName}`
    })
  }

  return variableDescriptors
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
      `${root}.getByRole(${quote(role)}, { name: ${variableIdentifier} })`,
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
      return `await page.goto(${quote(action.url)});`
    case "click":
      return `await ${
        variableDescriptor
          ? buildVariableizedClickLocator(action, variableDescriptor.identifier)
          : getLocator(action)
      }.${action.doubleClick ? "dblclick" : "click"}();`
    case "fill":
      return `await ${getLocator(action, "textbox")}.fill(${
        variableDescriptor
          ? variableDescriptor.identifier
          : action.sensitive
            ? 'process.env.PLAYWRIGHT_TEST_PASSWORD ?? ""'
            : quote(action.value)
      });`
    case "selectOption":
      return `await ${getLocator(action, "combobox")}.selectOption(${
        variableDescriptor
          ? variableDescriptor.identifier
          : quote(action.values.length === 1 ? action.values[0]! : action.values)
      });`
    case "fileUpload":
      return `await page.locator("input[type=\\"file\\"]").setInputFiles(${formatFileUploadPaths(
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

function fileChooserVariableNames(actionIndex: number): {
  chooser: string
  promise: string
} {
  const suffix = actionIndex + 1
  return {
    chooser: `fileChooser${suffix}`,
    promise: `fileChooserPromise${suffix}`
  }
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

    if (action.kind === "click" && nextAction?.kind === "fileUpload") {
      const names = fileChooserVariableNames(index)
      lines.push(`const ${names.promise} = page.waitForEvent("filechooser");`)
      lines.push(generateActionLine(action, variableDescriptor))
      lines.push(`const ${names.chooser} = await ${names.promise};`)
      lines.push(
        `await ${names.chooser}.setFiles(${formatFileUploadPaths(
          nextAction,
          variableDescriptorMap.get(nextAction.id)
        )});`
      )
      index += 1
      continue
    }

    lines.push(generateActionLine(action, variableDescriptor))
  }

  return lines
}

export function extractAiRecordingVariableNames(script: string): string[] {
  const variableNames = new Set<string>()

  for (const match of script.matchAll(
    /const\s+变量_[^\s=]+\s*=\s*"";\s*\/\/\s*(变量-[^\n\r]+)/gu
  )) {
    variableNames.add(match[1]!.trim())
  }

  for (const match of script.matchAll(/变量(?:_[\p{L}\p{N}_]+|\d+)/gu)) {
    const identifier = match[0]
    variableNames.add(
      identifier.startsWith("变量_") ? toPromptVariableName(identifier) : identifier
    )
  }

  return Array.from(variableNames)
}

export function generateAiRecordingScript(
  actions: AiRecordedBrowserAction[],
  options: AiRecordingScriptOptions = {}
): string {
  const variableDescriptorMap = buildVariableDescriptorMap(
    actions,
    options.variableActionIds,
    options.variableActionNames
  )
  const variableDeclarations = Array.from(variableDescriptorMap.values())
    .map((descriptor) => descriptor.declaration)
    .join("\n")
  const lines = generateAiRecordingActionLines(actions, variableDescriptorMap)
  const body =
    lines.length > 0
      ? lines.map((line) => `  ${line}`).join("\n")
      : "  // No supported Playwright browser actions were recorded."

  return `import { test } from "@playwright/test";

${variableDeclarations ? `${variableDeclarations}\n` : ""}

test("AI recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
${body}
});
`
}
