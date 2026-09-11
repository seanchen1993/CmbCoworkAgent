import {
  asLocators,
  escapeForAttributeSelector,
  escapeForTextSelector
} from "./playwrightVendored"

// 项目适配器：将项目录制元数据转换为 Playwright 源码副本需要的格式化输入，
// 不修改复制进来的上游源码。

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
  textExact?: boolean
  matchCount?: number
  nth?: number
  isVisible?: boolean
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

interface InternalLocatorCandidate extends LocatorCandidate {
  selector: string
}

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

function inferRoleFromInputMetadata(
  inputType: string | undefined,
  tagName: string | undefined
): LocatorRole | undefined {
  const normalizedTagName = tagName ? normalizeText(tagName).toLowerCase() : ""
  const normalizedInputType = inputType ? normalizeText(inputType).toLowerCase() : ""

  if (normalizedTagName === "textarea") return "textbox"
  if (normalizedTagName !== "input") return undefined

  if (normalizedInputType === "range") return "slider"
  if (normalizedInputType === "number") return "spinbutton"
  if (normalizedInputType === "checkbox") return "checkbox"
  if (normalizedInputType === "radio") return "radio"
  if (
    normalizedInputType === "button" ||
    normalizedInputType === "submit" ||
    normalizedInputType === "reset"
  ) {
    return "button"
  }

  return undefined
}

function buildCandidate(
  kind: LocatorCandidateKind,
  selector: string,
  source: LocatorSource,
  score: number,
  assumedUnique: boolean,
  reason: string
): InternalLocatorCandidate {
  return {
    kind,
    selector,
    locator: formatLocator(selector, source, false),
    score,
    assumedUnique,
    reason
  }
}

function pushCandidate(
  candidates: InternalLocatorCandidate[],
  candidate: InternalLocatorCandidate | null | undefined
): void {
  if (!candidate) return

  const existing = candidates.find((item) => item.locator === candidate.locator)
  if (!existing) {
    candidates.push(candidate)
    return
  }

  if (candidate.score > existing.score) {
    existing.kind = candidate.kind
    existing.selector = candidate.selector
    existing.locator = candidate.locator
    existing.score = candidate.score
    existing.assumedUnique = candidate.assumedUnique
    existing.reason = candidate.reason
  }
}

function buildRoleSelector(role: LocatorRole, name: string): string {
  // Align with Playwright codegen: string role names should translate back to
  // getByRole(..., { name: "..." }) without forcing exact: true.
  return `internal:role=${role}[name=${escapeForAttributeSelector(name, false)}]`
}

function buildRoleCandidate(
  source: LocatorSource,
  role: LocatorRole | undefined,
  name: string | undefined,
  reason: string,
  score: number
): InternalLocatorCandidate | null {
  if (!role || !name) return null
  return buildCandidate("role", buildRoleSelector(role, name), source, score, true, reason)
}

function buildLabelCandidate(
  source: LocatorSource,
  label: string | undefined
): InternalLocatorCandidate | null {
  if (!label) return null
  return buildCandidate(
    "label",
    `internal:label=${escapeForTextSelector(label, true)}`,
    source,
    90,
    true,
    "explicit label"
  )
}

function buildPlaceholderCandidate(
  source: LocatorSource,
  placeholder: string | undefined
): InternalLocatorCandidate | null {
  if (!placeholder) return null
  return buildCandidate(
    "placeholder",
    `internal:attr=[placeholder=${escapeForAttributeSelector(placeholder, true)}]`,
    source,
    92,
    true,
    "explicit placeholder"
  )
}

function buildTestIdCandidate(
  source: LocatorSource,
  testId: string | undefined
): InternalLocatorCandidate | null {
  if (!testId) return null
  return buildCandidate(
    "testId",
    `internal:testid=[data-testid=${escapeForAttributeSelector(testId, true)}]`,
    source,
    100,
    true,
    "explicit test id"
  )
}

function buildSelectorCandidate(
  source: LocatorSource,
  selector: string | undefined
): InternalLocatorCandidate | null {
  if (!selector) return null
  const genericTagOnly = /^[a-z][a-z0-9-]*$/iu.test(selector)
  const anchorHrefSelector = /^\s*a\[\s*href\s*=/iu.test(selector)
  const normalizedSelector =
    anchorHrefSelector && !/:visible\s*$/iu.test(selector) ? `${selector}:visible` : selector
  return buildCandidate(
    "selector",
    normalizedSelector,
    source,
    anchorHrefSelector ? 98 : genericTagOnly ? 25 : 70,
    anchorHrefSelector,
    anchorHrefSelector
      ? "anchor href selector"
      : genericTagOnly
        ? "generic tag selector fallback"
        : "explicit selector fallback"
  )
}

function buildTextCandidate(
  source: LocatorSource,
  text: string | undefined,
  exact = true
): InternalLocatorCandidate | null {
  if (!text) return null
  return buildCandidate(
    "text",
    `internal:text=${escapeForTextSelector(text, exact)}`,
    source,
    55,
    false,
    "text fallback"
  )
}

function buildCssCandidate(
  source: LocatorSource,
  tagName: string | undefined,
  inputType: string | undefined
): InternalLocatorCandidate | null {
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

  return buildCandidate("css", selector, source, 40, false, "tag fallback")
}

function buildFallbackCandidate(source: LocatorSource): InternalLocatorCandidate {
  return buildCandidate("fallback", "TODO_SELECTOR", source, 0, false, "missing locator metadata")
}

// 原生 radio/checkbox 常被自定义样式隐藏（opacity:0、零尺寸等），此时
// getByLabel/getByRole/getByTestId 都会解析到隐藏的 <input>，回放点击会报
// "element is not visible"。只有录制时明确检测到元素不可见（isVisible=false）
// 才切换为点击可见的 label 文本（与上游 Playwright codegen 一致）。
function isHiddenToggleInput(
  source: LocatorSource,
  inferredInputRole: LocatorRole | undefined
): boolean {
  return (
    source.isVisible === false &&
    (inferredInputRole === "radio" || inferredInputRole === "checkbox")
  )
}

interface InternalLocatorResolution {
  best: InternalLocatorCandidate
  candidates: InternalLocatorCandidate[]
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

export function buildFullSelector(framePath: string[] | undefined, selector: string): string {
  if (!framePath || framePath.length === 0) return selector
  return [...framePath, selector].join(" >> internal:control=enter-frame >> ")
}

function applyOccurrenceHint(selector: string, source: LocatorSource): string {
  if (/^\s*a\[\s*href\s*=/iu.test(selector)) {
    return selector
  }

  if (typeof source.nth === "number" && Number.isInteger(source.nth) && source.nth >= 0) {
    return `${selector} >> nth=${source.nth}`
  }

  if (typeof source.matchCount === "number" && source.matchCount > 1) {
    return `${selector} >> nth=0`
  }

  return selector
}

function preferNonCssVariant(locators: string[]): string[] {
  const preferred = locators.filter(
    (locator) => !locator.includes('"css=') && !locator.includes("'css=")
  )
  return preferred.length > 0 ? preferred : locators
}

function chooseLocatorVariant(locators: string[], source: LocatorSource): string {
  let candidates = locators

  if (source.framePath?.length) {
    const frameLocatorCandidates = candidates.filter((locator) => locator.startsWith("frameLocator("))
    if (frameLocatorCandidates.length > 0) candidates = frameLocatorCandidates
  }

  candidates = preferNonCssVariant(candidates)

  if (source.nth === 0) {
    const nthCandidates = candidates.filter((locator) => locator.includes(".nth(0)"))
    if (nthCandidates.length > 0) candidates = nthCandidates
  } else if (
    source.nth === undefined &&
    typeof source.matchCount === "number" &&
    source.matchCount > 1
  ) {
    const firstCandidates = candidates.filter((locator) => locator.includes(".first()"))
    if (firstCandidates.length > 0) candidates = firstCandidates
  }

  return candidates[0] ?? locators[0] ?? 'locator("TODO_SELECTOR")'
}

function formatLocator(selector: string, source: LocatorSource, includeOccurrenceHint: boolean): string {
  const effectiveSelector = includeOccurrenceHint ? applyOccurrenceHint(selector, source) : selector
  const locators = asLocators(
    "javascript",
    buildFullSelector(source.framePath, effectiveSelector),
    false,
    20,
    '"'
  )
  return `page.${chooseLocatorVariant(locators, source)}`
}

// 项目适配器：将 Playwright 录制器直接产出的内部 selector 格式化为
// 可写入录制动作的 locator 链。这里不再重新推断 role、label 等项目字段。
export function formatPlaywrightSelector(
  selector: string,
  framePath?: string[]
): string {
  const locators = asLocators(
    "javascript",
    buildFullSelector(framePath, selector),
    false,
    20,
    '"'
  )
  return chooseLocatorVariant(locators, { framePath })
}

function resolveInternalPlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): InternalLocatorResolution {
  const fileInputLocator = isFileInputLocatorSource(source)
  const candidates: InternalLocatorCandidate[] = []
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
  const inferredInputRole = inferRoleFromInputMetadata(source.inputType, source.tagName)
  const role = source.role ?? inferredInputRole ?? derivedTarget.inferredRole ?? options.defaultRole
  const roleName =
    normalizedAccessibleName ??
    normalizedLabel ??
    normalizedPlaceholder ??
    normalizedTarget

  // 隐藏的 radio/checkbox：跳过所有会解析到隐藏 <input> 的候选（testId/label/
  // role/placeholder/selector/css），只保留点击可见 label 文本的 text 候选。
  const hiddenToggle = isHiddenToggleInput(source, inferredInputRole)
  const hiddenToggleText = hiddenToggle
    ? normalizedLabel ?? normalizedAccessibleName ?? normalizedTarget
    : undefined

  if (hiddenToggle && hiddenToggleText) {
    pushCandidate(
      candidates,
      buildCandidate(
        "text",
        `internal:text=${escapeForTextSelector(hiddenToggleText, true)}`,
        source,
        95,
        true,
        "hidden toggle input label text"
      )
    )
  } else {
    pushCandidate(candidates, buildTestIdCandidate(source, normalizedTestId))
    pushCandidate(candidates, buildLabelCandidate(source, normalizedLabel))
    pushCandidate(candidates, buildPlaceholderCandidate(source, normalizedPlaceholder))
    if (!fileInputLocator) {
      pushCandidate(
        candidates,
        buildRoleCandidate(
          source,
          role,
          roleName,
          source.role
            ? "explicit role metadata"
            : inferredInputRole
              ? "inferred role from input type"
              : derivedTarget.inferredRole
                ? "inferred role from target"
                : "default role",
          source.role ? 96 : inferredInputRole ? 90 : derivedTarget.inferredRole ? 86 : 82
        )
      )
    }
    pushCandidate(candidates, buildSelectorCandidate(source, normalizedSelector))
    pushCandidate(
      candidates,
      buildTextCandidate(source, normalizedText ?? normalizedTarget, source.textExact !== false)
    )
    pushCandidate(candidates, buildCssCandidate(source, source.tagName, source.inputType))
  }

  if (candidates.length === 0) {
    candidates.push(buildFallbackCandidate(source))
  }

  candidates.sort(compareCandidates)
  return { best: candidates[0]!, candidates }
}

export function resolvePlaywrightSelector(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): string {
  const { best } = resolveInternalPlaywrightLocator(source, options)
  return buildFullSelector(source.framePath, applyOccurrenceHint(best.selector, source))
}

export function resolvePlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): LocatorResolution {
  const resolution = resolveInternalPlaywrightLocator(source, options)
  return {
    best: {
      ...resolution.best,
      locator: formatLocator(resolution.best.selector, source, true)
    },
    candidates: resolution.candidates
  }
}

export function buildPlaywrightLocator(
  source: LocatorSource,
  options: LocatorBuildOptions = {}
): string {
  return resolvePlaywrightLocator(source, options).best.locator
}
