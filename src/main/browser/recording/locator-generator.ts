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
}

export interface LocatorBuildOptions {
  defaultRole?: LocatorRole
}

export type LocatorCandidateKind =
  | "testId"
  | "label"
  | "placeholder"
  | "role"
  | "selector"
  | "text"
  | "css"
  | "fallback"

export interface LocatorCandidate {
  kind: LocatorCandidateKind
  locator: string
  score: number
  assumedUnique: boolean
  reason: string
}

export interface LocatorResolution {
  best: LocatorCandidate
  candidates: LocatorCandidate[]
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

function deriveTargetName(
  target: string | undefined
): { name?: string; inferredRole?: LocatorRole } {
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
  return buildCandidate("label", `${root}.getByLabel(${quote(label)})`, 96, true, "explicit label")
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
  return buildCandidate("testId", `${root}.getByTestId(${quote(testId)})`, 100, true, "explicit test id")
}

function buildSelectorCandidate(root: string, selector: string | undefined): LocatorCandidate | null {
  if (!selector) return null
  return buildCandidate(
    "selector",
    `${root}.locator(${quote(selector)})`,
    70,
    false,
    "explicit selector fallback"
  )
}

function buildTextCandidate(root: string, text: string | undefined): LocatorCandidate | null {
  if (!text) return null
  return buildCandidate(
    "text",
    `${root}.getByText(${quote(text)}, { exact: true })`,
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
  return buildCandidate("fallback", `${root}.locator("TODO_SELECTOR")`, 0, false, "missing locator metadata")
}

function compareCandidates(left: LocatorCandidate, right: LocatorCandidate): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.assumedUnique !== right.assumedUnique) {
    return Number(right.assumedUnique) - Number(left.assumedUnique)
  }

  const order: Record<LocatorCandidateKind, number> = {
    testId: 0,
    label: 1,
    placeholder: 2,
    role: 3,
    selector: 4,
    text: 5,
    css: 6,
    fallback: 7
  }

  return order[left.kind] - order[right.kind]
}

export function resolvePlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): LocatorResolution {
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
    normalizedAccessibleName ??
    normalizedLabel ??
    normalizedPlaceholder ??
    normalizedTarget

  pushCandidate(candidates, buildTestIdCandidate(root, normalizedTestId))
  pushCandidate(candidates, buildLabelCandidate(root, normalizedLabel))
  pushCandidate(candidates, buildPlaceholderCandidate(root, normalizedPlaceholder))
  pushCandidate(
    candidates,
    buildRoleCandidate(
      root,
      role,
      roleName,
      source.role ? "explicit role metadata" : derivedTarget.inferredRole ? "inferred role from target" : "default role",
      source.role ? 90 : derivedTarget.inferredRole ? 85 : 80
    )
  )
  pushCandidate(candidates, buildSelectorCandidate(root, normalizedSelector))
  pushCandidate(candidates, buildTextCandidate(root, normalizedText ?? normalizedTarget))
  pushCandidate(candidates, buildCssCandidate(root, source.tagName, source.inputType))

  if (candidates.length === 0) {
    candidates.push(buildFallbackCandidate(root))
  }

  candidates.sort(compareCandidates)
  return {
    best: candidates[0]!,
    candidates
  }
}

export function buildPlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): string {
  return resolvePlaywrightLocator(source, options).best.locator
}
