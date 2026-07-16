import { mkdtemp, readFile, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"
import type { BrowserMouseButton, BrowserState } from "../../shared/browser-types"
import type { BrowserPerformanceBudget } from "./browser-performance-budget"
import type {
  BrowserNativePipeRpcBackend,
  BrowserNativePipeTransport
} from "./browser-native-pipe-server"
import type { BrowserService } from "./browser-service"
import { getGlobalBrowserService } from "./browser-service-registry"

interface BrowserOfficialBackendAdapterContext {
  budget: BrowserPerformanceBudget
  sessionId: string
  threadId?: string
  workspacePath: string
  getService?: () => BrowserService | null
}

interface BrowserOfficialTabInfo {
  active?: boolean
  id: number | string
  title?: string
  url?: string
}

interface BrowserOfficialCdpRequest {
  commandParams?: Record<string, unknown>
  method?: string
  target?: {
    sessionId?: string
    tabId?: number
    targetId?: string
  }
  timeoutMs?: number
}

interface BrowserOfficialCdpEvent {
  method: string
  params?: Record<string, unknown>
  source: {
    sessionId?: string
    tabId: number
    targetId?: string
  }
}

interface LocalTabState {
  active: boolean
  created: boolean
  documentHtml: string
  documentText: string
  history: string[]
  historyIndex: number
  id: string
  loaderSequence: number
  title: string
  url: string
}

interface LocalPageResourceEntry {
  initiatorType?: string
  name: string
}

interface LocalElementSnapshot {
  attributes: Record<string, string>
  innerHtml: string
  key: string
  tagName: string
  text: string
}

interface LocalTextMatcher {
  caseInsensitive: boolean
  exact: boolean
  value: string
}

interface LocalSelectOptionDescriptor {
  index?: number
  label?: string
  value?: string
}

interface LocalSyntheticDownload {
  data: Buffer
  filename: string
  id: string
  requestId: string
  tabId: number
  url: string
}

interface LocalRoleMatcher {
  name?: LocalTextMatcher
  role: string
}

interface LocalSimplifiedSelector {
  attr?: {
    name: string
    value: LocalTextMatcher
  }
  css?: string
  nth?: number
  role?: LocalRoleMatcher
  scopeCss?: string
  text?: LocalTextMatcher
}

type LocalPlaywrightSelectorEvaluation =
  | {
      ok: true
      value: unknown
    }
  | {
      message: string
      ok: false
    }

type RuntimeEvaluateFallback =
  | {
      handled: true
      value: unknown
    }
  | {
      handled: false
    }

const IAB_BROWSER_ID = "iab"
const PRIMARY_TAB_ID = "1"
const DEFAULT_VIEWPORT = {
  height: 720,
  width: 1280
}
const PAGE_ASSETS_TAB_CAPABILITY_INFO = {
  description:
    "List assets already observed in the current page state and bundle selected assets into a temporary local artifact.",
  id: "pageAssets"
}
const PAGE_ASSETS_COMPUTED_STYLE_PROPERTIES = [
  "background-image",
  "border-image-source",
  "cursor",
  "list-style-image",
  "mask-image"
]
const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
const MAX_ARIA_SNAPSHOT_TEXT_CHARS = 20_000
const FALLBACK_SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IR//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveIntegerValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

function isKeyboardDownEvent(type: string | undefined): boolean {
  return type === "keyDown" || type === "rawKeyDown"
}

function isPrintableKeyboardText(text: string | undefined): text is string {
  return typeof text === "string" && text.length > 0 && !/[\b\t\n\r\u001b]/.test(text)
}

function tabIdFromValue(value: unknown): string {
  const raw = typeof value === "number" ? String(value) : stringValue(value)
  if (raw !== PRIMARY_TAB_ID) {
    throw new Error(`Unsupported iab tab id: ${String(value)}`)
  }
  return PRIMARY_TAB_ID
}

function tabNumberFromTarget(target: BrowserOfficialCdpRequest["target"]): number {
  const tabId = target?.tabId
  if (tabId !== 1) throw new Error(`Unsupported iab CDP tab id: ${String(tabId)}`)
  return tabId
}

function mouseButtonValue(value: unknown): BrowserMouseButton {
  switch (value) {
    case "middle":
      return "middle"
    case "right":
      return "right"
    case "left":
    case "none":
    case undefined:
      return "left"
    default:
      throw new Error(`Unsupported iab mouse button: ${String(value)}`)
  }
}

function normalizeDataUrlBase64(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return null
  return dataUrl.slice(comma + 1)
}

function remoteObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return { type: "undefined" }
  if (value === null) return { type: "object", subtype: "null", value: null }
  const type = typeof value
  if (type === "string" || type === "number" || type === "boolean") {
    return { type, value }
  }
  return { type: "object", value }
}

function runtimeExceptionDetails(message: string): Record<string, unknown> {
  return {
    text: message,
    exception: {
      type: "object",
      subtype: "error",
      description: message,
      value: message
    }
  }
}

function localSelectorValue(value: unknown): LocalPlaywrightSelectorEvaluation {
  return { ok: true, value }
}

function localSelectorException(message: string): LocalPlaywrightSelectorEvaluation {
  return { ok: false, message }
}

function frameUrl(url: string): string {
  return url || "about:blank"
}

function titleForUrl(url: string): string {
  if (!url || url === "about:blank") return ""
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return match ? decodeHtmlText(match[1].replace(/\s+/g, " ").trim()) : ""
}

function extractHtmlText(html: string): string {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  const body = bodyMatch ? bodyMatch[1] : html
  return decodeHtmlText(
    body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

function extractHtmlBody(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return match ? match[1] : html
}

function parseHtmlAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const attributePattern = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = attributePattern.exec(rawAttributes)) !== null) {
    const name = match[1]?.toLowerCase()
    if (!name) continue
    attributes[name] = decodeHtmlText(match[2] ?? match[3] ?? match[4] ?? "")
  }
  return attributes
}

function localElement(
  tagName: string,
  attributes: Record<string, string>,
  innerHtml: string,
  key: string
): LocalElementSnapshot {
  return {
    attributes,
    innerHtml,
    key,
    tagName: tagName.toLowerCase(),
    text: extractHtmlText(innerHtml)
  }
}

function extractLocalElements(html: string, documentText: string): LocalElementSnapshot[] {
  const elements: LocalElementSnapshot[] = [
    localElement("body", {}, html ? extractHtmlBody(html) : documentText, "body:0")
  ]
  const openTagPattern = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g
  let match: RegExpExecArray | null
  while ((match = openTagPattern.exec(html)) !== null) {
    const tagName = match[1]?.toLowerCase()
    if (!tagName || tagName.startsWith("!")) continue
    const rawAttributes = match[2] ?? ""
    const closePattern = new RegExp(`</${tagName}\\s*>`, "i")
    const afterOpenIndex = openTagPattern.lastIndex
    const closeMatch = closePattern.exec(html.slice(afterOpenIndex))
    const innerHtml = closeMatch ? html.slice(afterOpenIndex, afterOpenIndex + closeMatch.index) : ""
    elements.push(
      localElement(tagName, parseHtmlAttributes(rawAttributes), innerHtml, `${tagName}:${match.index}`)
    )
  }
  return elements
}

function absolutePageAssetUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl || undefined).toString()
  } catch {
    return value
  }
}

function firstSrcsetUrl(value: string): string | undefined {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .find((candidate): candidate is string => Boolean(candidate))
}

function styleUrls(value: string): string[] {
  return [...value.matchAll(/url\((["']?)(.*?)\1\)/g)]
    .map((match) => match[2]?.trim())
    .filter((url): url is string => Boolean(url))
}

function pageResourceEntriesFromElement(
  element: LocalElementSnapshot,
  baseUrl: string
): LocalPageResourceEntry[] {
  const entries: LocalPageResourceEntry[] = []
  const push = (attributeName: string, initiatorType: string, fromSrcset = false): void => {
    const raw = element.attributes[attributeName]
    const value = raw && fromSrcset ? firstSrcsetUrl(raw) : raw
    if (!value) return
    entries.push({
      initiatorType,
      name: absolutePageAssetUrl(value, baseUrl)
    })
  }

  switch (element.tagName) {
    case "img":
      push("src", "img")
      push("srcset", "img", true)
      break
    case "source":
      push("src", "video")
      push("srcset", "img", true)
      break
    case "video":
      push("poster", "img")
      push("src", "video")
      break
    case "script":
      push("src", "script")
      break
    case "link":
      push("href", element.attributes.rel === "stylesheet" ? "css" : "link")
      break
    case "use":
      push("href", "img")
      push("xlink:href", "img")
      break
  }

  for (const url of styleUrls(element.attributes.style ?? "")) {
    entries.push({
      initiatorType: "css",
      name: absolutePageAssetUrl(url, baseUrl)
    })
  }

  return entries
}

function inferPageResourceEntries(
  html: string,
  documentText: string,
  baseUrl: string
): LocalPageResourceEntry[] {
  const entries = new Map<string, LocalPageResourceEntry>()
  for (const element of extractLocalElements(html, documentText)) {
    for (const entry of pageResourceEntriesFromElement(element, baseUrl)) {
      if (!entries.has(entry.name)) entries.set(entry.name, entry)
    }
  }
  return [...entries.values()]
}

function sanitizePageResourceEntries(value: unknown): LocalPageResourceEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const record = item as Record<string, unknown>
    const name = stringValue(record.name)
    if (!name) return []
    const initiatorType = stringValue(record.initiatorType)
    return [
      {
        ...(initiatorType ? { initiatorType } : {}),
        name
      }
    ]
  })
}

function mergePageResourceEntries(
  primary: LocalPageResourceEntry[],
  fallback: LocalPageResourceEntry[]
): LocalPageResourceEntry[] {
  const entries = new Map<string, LocalPageResourceEntry>()
  for (const entry of [...primary, ...fallback]) {
    if (!entries.has(entry.name)) entries.set(entry.name, entry)
  }
  return [...entries.values()]
}

function pathExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url, "https://example.invalid").pathname
    return pathname.split(".").at(-1)?.toLowerCase() ?? ""
  } catch {
    return url.split(/[?#]/, 1)[0]?.split(".").at(-1)?.toLowerCase() ?? ""
  }
}

function mimeTypeFromDataUrl(url: string): string | null {
  if (!url.startsWith("data:")) return null
  const comma = url.indexOf(",")
  if (comma === -1) return null
  const mediaType = url
    .slice("data:".length, comma)
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase()
  return mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : null
}

function mimeTypeForPageResource(entry: LocalPageResourceEntry): string {
  const dataMimeType = mimeTypeFromDataUrl(entry.name)
  if (dataMimeType) return dataMimeType

  switch (pathExtensionFromUrl(entry.name)) {
    case "avif":
      return "image/avif"
    case "gif":
      return "image/gif"
    case "ico":
      return "image/x-icon"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "svg":
      return "image/svg+xml"
    case "webp":
      return "image/webp"
    case "css":
      return "text/css"
    case "mp4":
    case "m4v":
      return "video/mp4"
    case "mov":
      return "video/quicktime"
    case "webm":
      return "video/webm"
    case "otf":
      return "font/otf"
    case "ttf":
      return "font/ttf"
    case "woff":
      return "font/woff"
    case "woff2":
      return "font/woff2"
    default:
      break
  }

  switch (entry.initiatorType) {
    case "css":
      return "text/css"
    case "font":
      return "font/woff2"
    case "img":
      return "image/png"
    case "video":
      return "video/mp4"
    default:
      return "application/octet-stream"
  }
}

function bufferFromDataUrl(url: string): Buffer | null {
  if (!url.startsWith("data:")) return null
  const comma = url.indexOf(",")
  if (comma === -1) return null
  const metadata = url.slice(0, comma)
  const payload = url.slice(comma + 1)
  return metadata.includes(";base64")
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8")
}

function syntheticPageResourceBuffer(url: string, mimeType: string): Buffer {
  const dataBuffer = bufferFromDataUrl(url)
  if (dataBuffer) return dataBuffer
  if (mimeType === "text/css") {
    return Buffer.from(`/* Bundled stylesheet placeholder for ${url} */\n`, "utf8")
  }
  if (mimeType === "image/svg+xml") {
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>${url}</title></svg>\n`,
      "utf8"
    )
  }
  if (mimeType.startsWith("image/")) {
    return Buffer.from(FALLBACK_PNG_BASE64, "base64")
  }
  return Buffer.from(`Bundled asset placeholder for ${url}\n`, "utf8")
}

function cdpResourceTypeForMimeType(mimeType: string): string {
  if (mimeType === "text/css") return "Stylesheet"
  if (mimeType.startsWith("image/")) return "Image"
  if (mimeType.startsWith("font/")) return "Font"
  if (mimeType.startsWith("video/")) return "Media"
  if (mimeType.includes("javascript")) return "Script"
  return "Other"
}

function inlineSvgEntriesFromHtml(html: string): Array<{ markup: string; name: string }> {
  const entries: Array<{ markup: string; name: string }> = []
  const svgPattern = /<svg\b([^>]*)>[\s\S]*?<\/svg>/gi
  let match: RegExpExecArray | null
  while ((match = svgPattern.exec(html)) !== null) {
    const markup = match[0]
    const attributes = parseHtmlAttributes(match[1] ?? "")
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(markup)?.[1]
    entries.push({
      markup,
      name:
        attributes["aria-label"] ||
        (title ? decodeHtmlText(title.replace(/\s+/g, " ").trim()) : "") ||
        attributes.id ||
        `svg-${entries.length + 1}`
    })
  }
  return entries
}

function cssPropertyValue(style: string, propertyName: string): string {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "i").exec(style)
  return match?.[1]?.trim() ?? ""
}

function isPageAssetsResourceEntriesExpression(expression: string): boolean {
  return (
    expression.includes("performance.getEntriesByType(\"resource\")") &&
    expression.includes("initiatorType") &&
    expression.includes("entry.name")
  )
}

function isPageAssetsInlineSvgExpression(expression: string): boolean {
  return (
    expression.includes("document.querySelectorAll(\"svg\")") &&
    expression.includes("svg.outerHTML") &&
    expression.includes("aria-label")
  )
}

function localDomSnapshotForHtml(
  html: string,
  documentText: string,
  documentUrl: string
): Record<string, unknown> {
  const strings: string[] = []
  const intern = (value: string): number => {
    let index = strings.indexOf(value)
    if (index === -1) {
      strings.push(value)
      index = strings.length - 1
    }
    return index
  }
  const elements = extractLocalElements(html, documentText)
  const attributes = elements.map((element) =>
    Object.entries(element.attributes).flatMap(([name, value]) => [intern(name), intern(value)])
  )
  const layoutNodeIndex: number[] = []
  const layoutStyles: number[][] = []
  for (const [index, element] of elements.entries()) {
    const style = element.attributes.style ?? ""
    const values = PAGE_ASSETS_COMPUTED_STYLE_PROPERTIES.map((property) =>
      intern(cssPropertyValue(style, property))
    )
    if (values.some((value) => strings[value] !== "")) {
      layoutNodeIndex.push(index)
      layoutStyles.push(values)
    }
  }

  return {
    documents: [
      {
        documentURL: intern(documentUrl),
        layout: {
          nodeIndex: layoutNodeIndex,
          styles: layoutStyles
        },
        nodes: {
          attributes,
          backendNodeId: elements.map((_, index) => index + 1),
          nodeName: elements.map((element) => intern(element.tagName))
        }
      }
    ],
    strings
  }
}

function selectorStringFromExpression(expression: string): string | undefined {
  const match = expression.match(/parseSelector\(("(?:\\.|[^"\\])*")\)/)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return undefined
  }
}

function attributeNameFromExpression(expression: string): string | undefined {
  const match = expression.match(/"name"\s*:\s*("(?:\\.|[^"\\])*")/)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return undefined
  }
}

function parseJsonStringLiteral(value: string): string | undefined {
  try {
    return JSON.parse(value) as string
  } catch {
    return undefined
  }
}

function parseJsStringLiteral(value: string): string | undefined {
  if (value.startsWith('"')) return parseJsonStringLiteral(value)
  if (!value.startsWith("'") || !value.endsWith("'")) return undefined
  return value
    .slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
}

function assignedStringLiteral(source: string, target: string): string | undefined {
  const match = new RegExp(`${target}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`).exec(source)
  return match?.[1] ? parseJsStringLiteral(match[1]) : undefined
}

function elementIdFromDataUrlExpression(expression: string): string | undefined {
  if (!expression.includes(".toDataURL(")) return undefined
  const source = extractPlaywrightUserScriptSource(expression)
  const match = source.match(
    /document\.getElementById\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/
  )
  return match?.[1] ? parseJsStringLiteral(match[1]) : undefined
}

function mimeTypeFromDataUrlExpression(expression: string): string {
  const source = extractPlaywrightUserScriptSource(expression)
  const match = source.match(/\.toDataURL\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
  return match?.[1] ? parseJsStringLiteral(match[1]) ?? "image/png" : "image/png"
}

function isMissingCanvasDataUrlError(error: unknown): boolean {
  return error instanceof Error && /toDataURL is not a function/.test(error.message)
}

function elementDataUrlCompatibilityScript(elementId: string, mimeType: string): string {
  return `
    (() => {
      const root = document.getElementById(${JSON.stringify(elementId)});
      if (!root) return null;
      const mimeType = ${JSON.stringify(mimeType)};
      const toDataUrl = (candidate) => {
        if (candidate && typeof candidate.toDataURL === "function") {
          return candidate.toDataURL(mimeType);
        }
        return null;
      };
      const direct = toDataUrl(root);
      if (direct) return direct;
      const nestedCanvas = typeof root.querySelector === "function" ? root.querySelector("canvas") : null;
      const nested = toDataUrl(nestedCanvas);
      if (nested) return nested;
      const image =
        root.tagName && String(root.tagName).toLowerCase() === "img"
          ? root
          : typeof root.querySelector === "function"
            ? root.querySelector("img")
            : null;
      const imageUrl = image && (image.currentSrc || image.src);
      return typeof imageUrl === "string" && imageUrl.length > 0 ? imageUrl : null;
    })()
  `
}

function waitForStateFromExpression(expression: string): string | undefined {
  const match = expression.match(/"state"\s*:\s*("(?:\\.|[^"\\])*")/)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return undefined
  }
}

function stateNameFromExpression(expression: string): string | undefined {
  const fieldMatch = expression.match(/"stateName"\s*:\s*("(?:\\.|[^"\\])*")/)
  if (fieldMatch?.[1]) return parseJsonStringLiteral(fieldMatch[1])

  const literalMatch = expression.match(/\.elementState\([^,]+,\s*("(?:\\.|[^"\\])*")\)/)
  return literalMatch?.[1] ? parseJsonStringLiteral(literalMatch[1]) : undefined
}

function stringArrayFieldFromExpression(expression: string, fieldName: string): string[] {
  const match = new RegExp(`"${fieldName}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(expression)
  if (!match?.[1]) return []
  const values: string[] = []
  const stringPattern = /"(?:\\.|[^"\\])*"/g
  let item: RegExpExecArray | null
  while ((item = stringPattern.exec(match[1])) !== null) {
    const value = parseJsonStringLiteral(item[0])
    if (value !== undefined) values.push(value)
  }
  return values
}

function selectionsFromExpression(expression: string): LocalSelectOptionDescriptor[] {
  const fieldIndex = expression.indexOf('"selections"')
  if (fieldIndex === -1) return []
  const arrayStart = expression.indexOf("[", fieldIndex)
  if (arrayStart === -1) return []

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = arrayStart; index < expression.length; index += 1) {
    const char = expression[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "[") depth += 1
    if (char === "]") {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed = JSON.parse(expression.slice(arrayStart, index + 1)) as unknown
          if (!Array.isArray(parsed)) return []
          return parsed
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            .map((item) => ({
              index: typeof item.index === "number" && Number.isInteger(item.index) ? item.index : undefined,
              label: typeof item.label === "string" ? item.label : undefined,
              value: typeof item.value === "string" ? item.value : undefined
            }))
            .filter(
              (item) =>
                item.index !== undefined || item.label !== undefined || item.value !== undefined
            )
        } catch {
          return []
        }
      }
    }
  }
  return []
}

function parseInternalTextSelector(part: string): LocalTextMatcher | null {
  const match = part.match(/^internal:text=("(?:\\.|[^"\\])*")([is])?$/)
  if (!match?.[1]) return null
  const value = parseJsonStringLiteral(match[1])
  if (value === undefined) return null
  const suffix = match[2]
  return {
    caseInsensitive: suffix !== "s",
    exact: suffix === "s",
    value
  }
}

function parseInternalRoleSelector(part: string): LocalRoleMatcher | null {
  const match = part.match(
    /^internal:role=([a-zA-Z0-9_-]+)(?:\[name=("(?:\\.|[^"\\])*")([is])?\])?$/
  )
  if (!match?.[1]) return null
  const role = match[1].toLowerCase()
  const rawName = match[2]
  if (!rawName) return { role }
  const name = parseJsonStringLiteral(rawName)
  if (name === undefined) return null
  const suffix = match[3]
  return {
    name: {
      caseInsensitive: suffix !== "s",
      exact: suffix === "s",
      value: name
    },
    role
  }
}

function parseInternalAttrSelector(part: string): LocalSimplifiedSelector["attr"] | null {
  const match = part.match(/^internal:attr=\[([a-zA-Z0-9_:-]+)=("(?:\\.|[^"\\])*")([is])?\]$/)
  if (!match?.[1] || !match[2]) return null
  const value = parseJsonStringLiteral(match[2])
  if (value === undefined) return null
  const suffix = match[3]
  return {
    name: match[1].toLowerCase(),
    value: {
      caseInsensitive: suffix !== "s",
      exact: true,
      value
    }
  }
}

function simplifySelector(selector: string): LocalSimplifiedSelector | null {
  const parts = selector
    .split(" >> ")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.some((part) => part.includes("internal:control=enter-frame"))) return null

  let nth: number | undefined
  const cssParts: string[] = []
  let attr: LocalSimplifiedSelector["attr"] | undefined
  let text: LocalTextMatcher | undefined
  let role: LocalRoleMatcher | undefined
  for (const part of parts) {
    const nthMatch = part.match(/^nth=(-?\d+)$/)
    if (nthMatch?.[1]) {
      nth = Number(nthMatch[1])
      continue
    }
    if (part.startsWith("internal:text=")) {
      const parsed = parseInternalTextSelector(part)
      if (!parsed) return null
      text = parsed
      continue
    }
    if (part.startsWith("internal:role=")) {
      const parsed = parseInternalRoleSelector(part)
      if (!parsed) return null
      role = parsed
      continue
    }
    if (part.startsWith("internal:attr=")) {
      const parsed = parseInternalAttrSelector(part)
      if (!parsed) return null
      attr = parsed
      continue
    }
    if (part.startsWith("internal:")) return null
    cssParts.push(part)
  }

  if (attr || text || role) return { attr, nth, role, scopeCss: cssParts.at(-1), text }
  return { css: cssParts.at(-1) ?? selector, nth }
}

function elementMatchesSimpleSelector(element: LocalElementSnapshot, selector: string): boolean {
  const value = selector.trim()
  if (!value || value === "*") return true
  if (value === "body") return element.tagName === "body"

  const attrMatch = value.match(/^(?:(\w[\w-]*)|)?(?:#([\w-]+)|\.([\w-]+)|\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\])$/)
  if (attrMatch) {
    const tag = attrMatch[1]?.toLowerCase()
    const id = attrMatch[2]
    const className = attrMatch[3]
    const attrName = attrMatch[4]?.toLowerCase()
    const attrValue = attrMatch[5] ?? attrMatch[6] ?? attrMatch[7]
    if (tag && element.tagName !== tag) return false
    if (id) return element.attributes.id === id
    if (className) return (element.attributes.class ?? "").split(/\s+/).includes(className)
    if (attrName) {
      if (!(attrName in element.attributes)) return false
      return attrValue === undefined || element.attributes[attrName] === attrValue
    }
  }

  const tagClassMatch = value.match(/^(\w[\w-]*)(?:#([\w-]+)|\.([\w-]+))$/)
  if (tagClassMatch) {
    if (element.tagName !== tagClassMatch[1]?.toLowerCase()) return false
    const id = tagClassMatch[2]
    const className = tagClassMatch[3]
    if (id) return element.attributes.id === id
    if (className) return (element.attributes.class ?? "").split(/\s+/).includes(className)
  }

  if (/^\w[\w-]*$/.test(value)) return element.tagName === value.toLowerCase()
  return false
}

function textMatches(value: string, matcher: LocalTextMatcher): boolean {
  const actual = matcher.caseInsensitive ? value.toLowerCase() : value
  const expected = matcher.caseInsensitive ? matcher.value.toLowerCase() : matcher.value
  return matcher.exact ? actual === expected : actual.includes(expected)
}

function localElementRole(element: LocalElementSnapshot): string | undefined {
  const explicitRole = element.attributes.role?.trim().toLowerCase()
  if (explicitRole) return explicitRole

  switch (element.tagName) {
    case "a":
      return element.attributes.href ? "link" : undefined
    case "button":
      return "button"
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading"
    case "img":
      return "img"
    case "input": {
      const type = (element.attributes.type ?? "text").toLowerCase()
      if (type === "button" || type === "submit" || type === "reset") return "button"
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "range") return "slider"
      return "textbox"
    }
    case "select":
      return "combobox"
    case "textarea":
      return "textbox"
    default:
      return undefined
  }
}

function localElementAccessibleName(element: LocalElementSnapshot): string {
  return (
    element.attributes["aria-label"] ??
    element.attributes.alt ??
    element.attributes.title ??
    element.attributes.value ??
    element.text
  )
}

function elementMatchesInternalText(
  element: LocalElementSnapshot,
  matcher: LocalTextMatcher
): boolean {
  return textMatches(element.text, matcher)
}

function isLeafLocalElement(element: LocalElementSnapshot): boolean {
  return !/<[a-zA-Z][\w:-]*\b/.test(element.innerHtml)
}

function elementMatchesInternalRole(
  element: LocalElementSnapshot,
  matcher: LocalRoleMatcher
): boolean {
  if (localElementRole(element) !== matcher.role) return false
  return matcher.name ? textMatches(localElementAccessibleName(element), matcher.name) : true
}

function localElementInputType(element: LocalElementSnapshot): string {
  return (element.attributes.type ?? "text").toLowerCase()
}

function isLocalElementDisabled(element: LocalElementSnapshot): boolean {
  return "disabled" in element.attributes || element.attributes["aria-disabled"] === "true"
}

function isLocalElementHidden(element: LocalElementSnapshot): boolean {
  const style = (element.attributes.style ?? "").toLowerCase()
  return (
    "hidden" in element.attributes ||
    element.attributes["aria-hidden"] === "true" ||
    (element.tagName === "input" && localElementInputType(element) === "hidden") ||
    /display\s*:\s*none/.test(style) ||
    /visibility\s*:\s*hidden/.test(style)
  )
}

function isLocalElementEditable(element: LocalElementSnapshot): boolean {
  if (isLocalElementDisabled(element) || "readonly" in element.attributes) return false
  if (element.attributes.contenteditable === "true") return true
  if (element.tagName === "textarea") return true
  if (element.tagName !== "input") return false

  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit"
  ].includes(localElementInputType(element))
}

function isLocalElementRadio(element: LocalElementSnapshot): boolean {
  return element.tagName === "input" && localElementInputType(element) === "radio"
}

function isLocalElementCheckable(element: LocalElementSnapshot): boolean {
  const role = localElementRole(element)
  return (
    role === "checkbox" ||
    role === "radio" ||
    role === "switch" ||
    (element.tagName === "input" &&
      (localElementInputType(element) === "checkbox" || localElementInputType(element) === "radio"))
  )
}

function elementsForSelector(
  html: string,
  documentText: string,
  selector: LocalSimplifiedSelector
): LocalElementSnapshot[] {
  let elements = extractLocalElements(html, documentText)
  if (selector.scopeCss) {
    const scopes = elements.filter((element) => elementMatchesSimpleSelector(element, selector.scopeCss!))
    elements = scopes.flatMap((scope) => extractLocalElements(scope.innerHtml, scope.text))
  }
  if (selector.css) {
    elements = elements.filter((element) => elementMatchesSimpleSelector(element, selector.css!))
  }
  if (selector.text) {
    const matches = elements.filter((element) => elementMatchesInternalText(element, selector.text!))
    const withoutSyntheticBody = matches.filter((element) => element.tagName !== "body")
    const leafMatches = withoutSyntheticBody.filter(isLeafLocalElement)
    if (leafMatches.length > 0) {
      elements = leafMatches
    } else {
      elements = withoutSyntheticBody.length > 0 ? withoutSyntheticBody : matches
    }
  }
  if (selector.attr) {
    elements = elements.filter((element) => {
      const actual = element.attributes[selector.attr!.name]
      return typeof actual === "string" && textMatches(actual, selector.attr!.value)
    })
  }
  if (selector.role) {
    elements = elements.filter((element) => elementMatchesInternalRole(element, selector.role!))
  }
  return elements
}

function applyNth(elements: LocalElementSnapshot[], nth: number | undefined): LocalElementSnapshot[] {
  if (nth === undefined) return elements
  const index = nth < 0 ? elements.length + nth : nth
  const element = elements[index]
  return element ? [element] : []
}

function isPlaywrightSelectorExpression(expression: string): boolean {
  return (
    expression.includes("window.__codexPlaywrightInjected") &&
    expression.includes("parseSelector(") &&
    expression.includes("selectorScopeFor(")
  )
}

function compactJsExpression(expression: string): string {
  return expression.replace(/\s+/g, "")
}

function hasArrowPropertyRead(compactExpression: string, propertyName: string): boolean {
  return new RegExp(`=>[a-zA-Z_$][\\w$]*\\.${propertyName}\\b`).test(compactExpression)
}

function isAllTextContentsExpression(compactExpression: string): boolean {
  return compactExpression.includes(".map(") && compactExpression.includes(".textContent")
}

function isInnerTextExpression(compactExpression: string): boolean {
  return compactExpression.includes("innerText")
}

function isGetAttributeExpression(compactExpression: string): boolean {
  return compactExpression.includes(".getAttribute(") && compactExpression.includes(".name")
}

function isElementReadAllExpression(compactExpression: string): boolean {
  return compactExpression.includes("attributes:Object.fromEntries")
}

function isWaitForStateExpression(compactExpression: string): boolean {
  return compactExpression.includes(".elementState(") && compactExpression.includes(".state")
}

function isReadCheckedStateExpression(compactExpression: string): boolean {
  return (
    compactExpression.includes(".elementState(") &&
    compactExpression.includes('"checked"') &&
    compactExpression.includes("checked:!!") &&
    compactExpression.includes("isRadio:!!")
  )
}

function isPointerActionTargetExpression(compactExpression: string): boolean {
  return (
    compactExpression.includes("prepareFrameChainForPointerAction(") &&
    compactExpression.includes("waitForStableBoundingRect") &&
    compactExpression.includes("getBoundingClientRect()")
  )
}

function isFocusActionExpression(compactExpression: string): boolean {
  return compactExpression.includes(".focusNode(") || compactExpression.includes(".selectText(")
}

function isFillActionExpression(compactExpression: string): boolean {
  return compactExpression.includes(".fill(") && compactExpression.includes(".value")
}

function isSelectOptionExpression(compactExpression: string): boolean {
  return compactExpression.includes(".selectOptions(") && compactExpression.includes('"selections"')
}

function valueFieldFromExpression(expression: string): string | undefined {
  const match = expression.match(/(?:^|[,{])\s*"?value"?\s*:\s*("(?:\\.|[^"\\])*")/)
  return match?.[1] ? parseJsonStringLiteral(match[1]) : undefined
}

function isDownloadMediaExpression(expression: string): boolean {
  return (
    expression.includes("document.createElement(\"a\")") &&
    expression.includes(".download") &&
    expression.includes(".click()")
  )
}

function localElementDownloadUrl(element: LocalElementSnapshot): string | undefined {
  return (
    element.attributes.currentsrc ??
    element.attributes.src ??
    element.attributes.href
  )
}

function sanitizeDownloadFilename(value: string): string {
  const sanitized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim()
  return sanitized.slice(0, 120) || "download"
}

function downloadFilenameFromUrl(url: string, fallback = "download"): string {
  try {
    if (url.startsWith("data:")) return sanitizeDownloadFilename(fallback)
    const parsed = new URL(url)
    const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1)
    return sanitizeDownloadFilename(decodeURIComponent(lastSegment || fallback))
  } catch {
    return sanitizeDownloadFilename(fallback)
  }
}

function localDownloadDataFromUrl(url: string): Buffer {
  if (!url.startsWith("data:")) return Buffer.from(`Downloaded from ${url}\n`, "utf8")
  const comma = url.indexOf(",")
  if (comma === -1) return Buffer.alloc(0)
  const metadata = url.slice(0, comma)
  const payload = url.slice(comma + 1)
  if (metadata.includes(";base64")) return Buffer.from(payload, "base64")
  return Buffer.from(decodeURIComponent(payload), "utf8")
}

function localDownloadTargetForElement(element: LocalElementSnapshot): {
  data: Buffer
  filename: string
  url: string
} | null {
  const candidates = [
    element,
    ...extractLocalElements(element.innerHtml, element.text)
  ]
  for (const candidate of candidates) {
    if (!["a", "img", "source", "video"].includes(candidate.tagName)) continue
    const url = localElementDownloadUrl(candidate)
    if (!url) continue
    const filename = candidate.attributes.download || downloadFilenameFromUrl(url)
    return {
      data: localDownloadDataFromUrl(url),
      filename: sanitizeDownloadFilename(filename),
      url
    }
  }
  return null
}

function localOptionsForSelect(element: LocalElementSnapshot): LocalElementSnapshot[] {
  if (element.tagName !== "select") return []
  const options: LocalElementSnapshot[] = []
  const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
  let match: RegExpExecArray | null
  while ((match = optionPattern.exec(element.innerHtml)) !== null) {
    const attributes = parseHtmlAttributes(match[1] ?? "")
    const innerHtml = match[2] ?? ""
    options.push(localElement("option", attributes, innerHtml, `${element.key}:option:${match.index}`))
  }
  return options
}

function localClickPointForElement(element: LocalElementSnapshot): { x: number; y: number } {
  const hash = Array.from(element.key).reduce((value, char) => value + char.charCodeAt(0), 0)
  return {
    x: 32 + (hash % 320),
    y: 32 + ((hash * 7) % 240)
  }
}

function extractPlaywrightUserScriptSource(expression: string): string {
  const marker = '"use strict";'
  const markerIndex = expression.indexOf(marker)
  if (markerIndex === -1) return expression

  const sourceStart = markerIndex + marker.length
  const sourceEnd = expression.indexOf("}).call(windowObject)", sourceStart)
  if (sourceEnd === -1) return expression
  return expression.slice(sourceStart, sourceEnd)
}

function isPlaywrightAriaSnapshotExpression(expression: string): boolean {
  return (
    expression.includes("const injected = window.__codexPlaywrightInjected") &&
    expression.includes("incrementalAriaSnapshot")
  )
}

function normalizeAriaSnapshotText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function quotedAriaSnapshotValue(value: string): string {
  return JSON.stringify(normalizeAriaSnapshotText(value))
}

function buildAriaSnapshotFull(title: string, text: string, url: string): string {
  const normalizedText = normalizeAriaSnapshotText(text).slice(0, MAX_ARIA_SNAPSHOT_TEXT_CHARS)
  const normalizedTitle = normalizeAriaSnapshotText(title || titleForUrl(url))
  if (!normalizedText && !normalizedTitle) return ""

  const heading = normalizedTitle
    ? `- document ${quotedAriaSnapshotValue(normalizedTitle)}`
    : "- document"
  if (!normalizedText) return heading
  return `${heading}:\n  - text ${quotedAriaSnapshotValue(normalizedText)}`
}

async function readLocalDocument(url: string): Promise<{
  html: string
  text: string
  title: string
}> {
  if (url === "about:blank") return { html: "", text: "", title: "" }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "file:") return { html: "", text: "", title: titleForUrl(url) }
    const html = await readFile(fileURLToPath(parsed), "utf8")
    return {
      html,
      text: extractHtmlText(html),
      title: extractHtmlTitle(html) || titleForUrl(url)
    }
  } catch {
    return { html: "", text: "", title: titleForUrl(url) }
  }
}

export class BrowserOfficialBackendAdapter implements BrowserNativePipeRpcBackend {
  private readonly allowedDownloadUrls = new Set<string>()
  private localFocusedElementKey: string | null = null
  private readonly localCheckedValues = new Map<string, boolean>()
  private readonly localInputValues = new Map<string, string>()
  private readonly localSelectValues = new Map<string, string[]>()
  private pageScriptSequence = 0
  private syntheticDownloadSequence = 0
  private readonly syntheticDownloads = new Map<string, LocalSyntheticDownload>()
  private readonly syntheticDownloadsByRequestId = new Map<string, LocalSyntheticDownload>()
  private panelRequested = false
  private readonly tab: LocalTabState = {
    active: true,
    created: false,
    documentHtml: "",
    documentText: "",
    history: ["about:blank"],
    historyIndex: 0,
    id: PRIMARY_TAB_ID,
    loaderSequence: 1,
    title: "",
    url: "about:blank"
  }

  constructor(private readonly context: BrowserOfficialBackendAdapterContext) {}

  async handleRequest(
    method: string,
    params: unknown,
    transport: BrowserNativePipeTransport
  ): Promise<unknown> {
    switch (method) {
      case "ping":
        return "pong"
      case "getInfo":
        return this.getInfo()
      case "attach":
        return this.attach(params)
      case "detach":
        return this.detach(params)
      case "attachTarget":
      case "detachTarget":
      case "markTab":
        return {}
      case "allowDownload":
        return this.allowDownload(params)
      case "moveMouse":
        return this.moveMouse(params)
      case "getTabs":
        return this.getTabs()
      case "getUserTabs":
      case "getUserHistory":
        return []
      case "claimUserTab":
        return this.claimUserTab(params)
      case "createTab":
        return this.createTab()
      case "finalizeTabs":
        return this.finalizeTabs(params)
      case "nameSession":
        return {}
      case "executeCdp":
        return this.executeCdp(params, transport)
      case "executeUnhandledCommand":
        throw new Error("Browser iab backend does not support this command yet")
      default:
        throw new Error(`Unsupported Browser iab backend method: ${method}`)
    }
  }

  private getInfo(): Record<string, unknown> {
    return {
      apiSupportOverrides: {},
      capabilities: {
        browser: [],
        tab: [PAGE_ASSETS_TAB_CAPABILITY_INFO]
      },
      id: IAB_BROWSER_ID,
      metadata: {
        codexSessionId: this.context.sessionId,
        threadId: this.context.threadId ?? "",
        threadSource: "desktop"
      },
      name: "In-app Browser",
      type: "iab"
    }
  }

  private async attach(params: unknown): Promise<Record<string, never>> {
    const tabId = asRecord(params).tabId
    if (tabId !== undefined) tabIdFromValue(tabId)
    await this.ensureTab()
    return {}
  }

  private detach(params: unknown): Record<string, never> {
    const tabId = asRecord(params).tabId
    if (tabId !== undefined) tabIdFromValue(tabId)
    return {}
  }

  private async createTab(): Promise<{ id: number }> {
    const currentTabs = await this.getTabs()
    if (currentTabs.length >= this.context.budget.maxOpenTabsPerSession && !this.tab.created) {
      throw new Error(
        `Browser tab budget exceeded (${this.context.budget.maxOpenTabsPerSession})`
      )
    }
    await this.ensureTab()
    return { id: Number(PRIMARY_TAB_ID) }
  }

  private async claimUserTab(params: unknown): Promise<BrowserOfficialTabInfo> {
    tabIdFromValue(asRecord(params).tabId)
    await this.ensureTab()
    return this.getPrimaryTabInfo()
  }

  private async finalizeTabs(params: unknown): Promise<Record<string, never>> {
    const keep = asRecord(params).keep
    if (Array.isArray(keep) && keep.length === 0) {
      this.getService()?.detach(this.context.sessionId)
      this.tab.created = false
    }
    return {}
  }

  private async getTabs(): Promise<BrowserOfficialTabInfo[]> {
    if (!this.tab.created) return []
    return [await this.getPrimaryTabInfo()]
  }

  private async getPrimaryTabInfo(): Promise<BrowserOfficialTabInfo> {
    const state = this.getServiceState()
    if (state?.created) {
      return {
        active: true,
        id: Number(PRIMARY_TAB_ID),
        title: state.title || undefined,
        url: state.url || undefined
      }
    }

    return {
      active: true,
      id: Number(PRIMARY_TAB_ID),
      title: this.tab.title || undefined,
      url: this.tab.url || undefined
    }
  }

  private async executeCdp(
    params: unknown,
    transport: BrowserNativePipeTransport
  ): Promise<unknown> {
    const request = asRecord(params) as BrowserOfficialCdpRequest
    if (!request.method) throw new Error("executeCdp requires method")
    const tabId = tabNumberFromTarget(request.target)
    await this.ensureTab()

    switch (request.method) {
      case "Emulation.setFocusEmulationEnabled":
      case "DOM.enable":
      case "Log.enable":
      case "Network.enable":
      case "Page.enable":
      case "Runtime.enable":
      case "Target.setAutoAttach":
        return {}
      case "Page.getFrameTree":
        return this.getFrameTree(tabId)
      case "Page.getLayoutMetrics":
        return this.getLayoutMetrics()
      case "Page.getNavigationHistory":
        return this.getNavigationHistory()
      case "Page.getResourceContent":
        return this.getResourceContent(request.commandParams)
      case "Page.getResourceTree":
        return this.getResourceTree(tabId)
      case "DOMSnapshot.captureSnapshot":
        return this.captureDomSnapshot()
      case "Page.navigate":
        return this.navigate(tabId, request.commandParams, transport)
      case "Page.navigateToHistoryEntry":
        return this.navigateToHistoryEntry(tabId, request.commandParams, transport)
      case "Page.reload":
        return this.reload(tabId, transport)
      case "Page.captureScreenshot":
        return { data: await this.captureScreenshotBase64() }
      case "Page.startScreencast":
        this.emitCdpEvent(transport, {
          method: "Page.screencastFrame",
          params: {
            data: await this.captureScreenshotBase64(),
            metadata: { timestamp: Date.now() / 1000 },
            sessionId: 1
          },
          source: { tabId }
        })
        return {}
      case "Page.screencastFrameAck":
      case "Page.stopScreencast":
        return {}
      case "Runtime.addBinding":
        return this.addRuntimeBinding(request.commandParams)
      case "Runtime.removeBinding":
        return this.removeRuntimeBinding(request.commandParams)
      case "Runtime.evaluate":
        return this.evaluateRuntime(request.commandParams, tabId, transport)
      case "Page.addScriptToEvaluateOnNewDocument":
        return this.addScriptToEvaluateOnNewDocument(request.commandParams)
      case "Page.createIsolatedWorld":
        return { executionContextId: 1 }
      case "Page.removeScriptToEvaluateOnNewDocument":
      case "Runtime.releaseObject":
        return {}
      case "Fetch.enable":
      case "Fetch.disable":
        return {}
      case "Fetch.continueRequest":
        this.forgetSyntheticDownload(request.commandParams)
        return {}
      case "Fetch.continueResponse":
        return this.completeSyntheticDownload(request.commandParams, transport)
      case "Fetch.failRequest":
        this.forgetSyntheticDownload(request.commandParams)
        return {}
      case "Input.dispatchMouseEvent":
        return this.dispatchMouseEvent(request.commandParams)
      case "Input.dispatchKeyEvent":
        return this.dispatchKeyEvent(request.commandParams)
      case "Input.insertText":
        return this.insertText(request.commandParams)
      case "Input.synthesizeScrollGesture":
        return this.synthesizeScrollGesture(request.commandParams)
      case "Target.getTargets":
        return this.getTargets()
      case "Target.closeTarget":
      case "Page.close":
        this.getService()?.detach(this.context.sessionId)
        this.tab.created = false
        return {}
      default:
        throw new Error(`Unsupported iab CDP method: ${request.method}`)
    }
  }

  private async navigate(
    tabId: number,
    commandParams: Record<string, unknown> | undefined,
    transport: BrowserNativePipeTransport
  ): Promise<Record<string, string>> {
    const url = stringValue(commandParams?.url)
    if (!url) throw new Error("Page.navigate requires url")
    console.info(`[BrowserOfficialBackend] Navigating ${this.context.sessionId} to ${url}.`)
    await this.setCurrentUrl(url)
    this.emitNavigationEvents(transport, tabId)
    return {
      frameId: this.frameId(),
      loaderId: this.loaderId()
    }
  }

  private async navigateToHistoryEntry(
    tabId: number,
    commandParams: Record<string, unknown> | undefined,
    transport: BrowserNativePipeTransport
  ): Promise<Record<string, never>> {
    const entryId = numberValue(commandParams?.entryId)
    const index = typeof entryId === "number" ? entryId - 1 : -1
    const url = this.tab.history[index]
    if (!url) throw new Error(`Navigation history entry is not available: ${String(entryId)}`)
    this.tab.historyIndex = index
    await this.setCurrentUrl(url, false)
    this.emitNavigationEvents(transport, tabId)
    return {}
  }

  private async reload(
    tabId: number,
    transport: BrowserNativePipeTransport
  ): Promise<Record<string, never>> {
    await this.setCurrentUrl(this.currentUrl(), false)
    this.emitNavigationEvents(transport, tabId)
    return {}
  }

  private async setCurrentUrl(url: string, pushHistory = true): Promise<void> {
    const service = this.getService()
    this.localFocusedElementKey = null
    this.localCheckedValues.clear()
    this.localInputValues.clear()
    this.localSelectValues.clear()
    if (service) {
      await service.navigate(this.context.sessionId, url, {
        workspacePath: this.context.workspacePath
      })
      const state = service.getState(this.context.sessionId)
      this.tab.url = state.url || url
      this.tab.title = state.title
    } else {
      this.tab.url = url
      const document = await readLocalDocument(url)
      this.tab.documentHtml = document.html
      this.tab.documentText = document.text
      this.tab.title = document.title
    }

    this.tab.loaderSequence += 1
    if (pushHistory) {
      this.tab.history = this.tab.history.slice(0, this.tab.historyIndex + 1)
      this.tab.history.push(this.tab.url)
      this.tab.historyIndex = this.tab.history.length - 1
    }
  }

  private async evaluateRuntime(
    commandParams: Record<string, unknown> | undefined,
    tabId: number,
    transport: BrowserNativePipeTransport
  ): Promise<Record<string, unknown>> {
    const expression = stringValue(commandParams?.expression) ?? ""
    if (expression.includes("window.devicePixelRatio")) {
      return { result: remoteObject(1) }
    }
    if (expression.includes("window.location.href") && expression.includes("document.readyState")) {
      return {
        result: remoteObject({
          href: this.currentUrl(),
          readyState: "complete"
        })
      }
    }
    if (isPageAssetsResourceEntriesExpression(expression)) {
      return { result: remoteObject(await this.evaluatePageAssetResourceEntries(expression)) }
    }
    if (isPageAssetsInlineSvgExpression(expression)) {
      return { result: remoteObject(await this.evaluatePageAssetInlineSvgEntries(expression)) }
    }

    const service = this.getService()
    if (service) {
      try {
        const value = await service.evaluateInPage(this.context.sessionId, expression)
        return { result: remoteObject(value) }
      } catch (error) {
        const fallback = await this.evaluateElementDataUrlFallback(service, expression, error)
        if (fallback.handled) {
          return { result: remoteObject(fallback.value) }
        }
        if (!isPlaywrightAriaSnapshotExpression(expression)) throw error
        return { result: remoteObject(await this.createAriaSnapshotValue()) }
      }
    }

    if (this.applyLocalDocumentMutation(expression)) {
      return { result: remoteObject(undefined) }
    }
    if (isPlaywrightAriaSnapshotExpression(expression)) {
      return { result: remoteObject(await this.createAriaSnapshotValue()) }
    }
    if (isPlaywrightSelectorExpression(expression)) {
      const downloadEvaluation = await this.evaluateLocalDownloadMediaExpression(
        expression,
        tabId,
        transport
      )
      if (downloadEvaluation) {
        if (!downloadEvaluation.ok) {
          return {
            result: remoteObject(undefined),
            exceptionDetails: runtimeExceptionDetails(downloadEvaluation.message)
          }
        }
        return { result: remoteObject(downloadEvaluation.value) }
      }
      const evaluation = this.evaluateLocalPlaywrightSelectorExpression(expression)
      if (!evaluation.ok) {
        return {
          result: remoteObject(undefined),
          exceptionDetails: runtimeExceptionDetails(evaluation.message)
        }
      }
      return { result: remoteObject(evaluation.value) }
    }

    return { result: remoteObject(this.evaluateLocalReadOnlyExpression(expression)) }
  }

  private async evaluateElementDataUrlFallback(
    service: BrowserService,
    expression: string,
    error: unknown
  ): Promise<RuntimeEvaluateFallback> {
    if (!isMissingCanvasDataUrlError(error)) return { handled: false }
    const elementId = elementIdFromDataUrlExpression(expression)
    if (!elementId) return { handled: false }

    try {
      const value = await service.evaluateInPage(
        this.context.sessionId,
        elementDataUrlCompatibilityScript(elementId, mimeTypeFromDataUrlExpression(expression))
      )
      return { handled: true, value }
    } catch {
      return { handled: false }
    }
  }

  private async createAriaSnapshotValue(): Promise<Record<string, unknown>> {
    const service = this.getService()
    if (service) {
      const result = await service.readRenderedState(this.context.sessionId, false).catch(() => null)
      if (result?.success && result.state) {
        return {
          full: buildAriaSnapshotFull(result.state.title, result.state.text, result.state.url),
          iframeDepths: {},
          iframeRefs: []
        }
      }
    }

    return {
      full: buildAriaSnapshotFull(this.currentTitle(), this.tab.documentText, this.currentUrl()),
      iframeDepths: {},
      iframeRefs: []
    }
  }

  private async currentRenderedDocument(): Promise<{
    html: string
    text: string
    title: string
    url: string
  }> {
    const service = this.getService()
    if (service) {
      const result = await service.readRenderedState(this.context.sessionId, true).catch(() => null)
      if (result?.success && result.state) {
        return {
          html: result.state.html ?? "",
          text: result.state.text,
          title: result.state.title,
          url: result.state.url
        }
      }
    }
    return {
      html: this.tab.documentHtml,
      text: this.tab.documentText,
      title: this.currentTitle(),
      url: this.currentUrl()
    }
  }

  private async captureDomSnapshot(): Promise<Record<string, unknown>> {
    const document = await this.currentRenderedDocument()
    return localDomSnapshotForHtml(document.html, document.text, document.url)
  }

  private async currentPageResourceEntries(): Promise<LocalPageResourceEntry[]> {
    const document = await this.currentRenderedDocument()
    const inferredEntries = inferPageResourceEntries(document.html, document.text, document.url)
    const service = this.getService()
    if (!service) return inferredEntries

    const serviceEntries = sanitizePageResourceEntries(
      await service
        .evaluateInPage(
          this.context.sessionId,
          `performance.getEntriesByType("resource").map((entry) => ({
            initiatorType: "initiatorType" in entry ? entry.initiatorType : undefined,
            name: entry.name,
          }))`
        )
        .catch(() => [])
    )
    return mergePageResourceEntries(serviceEntries, inferredEntries)
  }

  private async getResourceContent(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const url = stringValue(commandParams?.url)
    if (!url) throw new Error("Page.getResourceContent requires url")
    const entry = (await this.currentPageResourceEntries()).find((candidate) => candidate.name === url)
    if (!entry) throw new Error(`Resource is not available in the current page inventory: ${url}`)

    const mimeType = mimeTypeForPageResource(entry)
    return {
      base64Encoded: true,
      content: syntheticPageResourceBuffer(url, mimeType).toString("base64")
    }
  }

  private async getResourceTree(tabId: number): Promise<Record<string, unknown>> {
    const resources = (await this.currentPageResourceEntries()).map((entry) => {
      const mimeType = mimeTypeForPageResource(entry)
      return {
        mimeType,
        type: cdpResourceTypeForMimeType(mimeType),
        url: entry.name
      }
    })
    return {
      frameTree: {
        frame: this.framePayload(tabId),
        resources
      }
    }
  }

  private async evaluatePageAssetResourceEntries(
    expression: string
  ): Promise<LocalPageResourceEntry[]> {
    const service = this.getService()
    const serviceEntries = service
      ? sanitizePageResourceEntries(
          await service.evaluateInPage(this.context.sessionId, expression).catch(() => [])
        )
      : []
    const document = await this.currentRenderedDocument()
    const inferredEntries = inferPageResourceEntries(document.html, document.text, document.url)
    return mergePageResourceEntries(serviceEntries, inferredEntries)
  }

  private async evaluatePageAssetInlineSvgEntries(
    expression: string
  ): Promise<Array<{ markup: string; name: string }>> {
    const service = this.getService()
    const serviceEntries = service
      ? await service.evaluateInPage(this.context.sessionId, expression).catch(() => [])
      : []
    if (Array.isArray(serviceEntries) && serviceEntries.length > 0) {
      return serviceEntries.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return []
        const record = entry as Record<string, unknown>
        const markup = stringValue(record.markup)
        if (!markup) return []
        return [
          {
            markup,
            name: stringValue(record.name) ?? "svg"
          }
        ]
      })
    }

    const document = await this.currentRenderedDocument()
    return inlineSvgEntriesFromHtml(document.html)
  }

  private async addRuntimeBinding(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, never>> {
    const name = stringValue(commandParams?.name)
    if (!name) throw new Error("Runtime.addBinding requires name")
    const service = this.getService()
    if (service) {
      await service.evaluateInPage(this.context.sessionId, this.runtimeBindingScript(name))
    }
    return {}
  }

  private async removeRuntimeBinding(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, never>> {
    const name = stringValue(commandParams?.name)
    if (!name) throw new Error("Runtime.removeBinding requires name")
    const service = this.getService()
    if (service) {
      await service.evaluateInPage(
        this.context.sessionId,
        `Reflect.deleteProperty(globalThis, ${JSON.stringify(name)})`
      ).catch(() => undefined)
    }
    return {}
  }

  private async addScriptToEvaluateOnNewDocument(
    commandParams: Record<string, unknown> | undefined
  ): Promise<{ identifier: string }> {
    const source = stringValue(commandParams?.source)
    const runImmediately = commandParams?.runImmediately === true
    const identifier = `iab-script-${++this.pageScriptSequence}`
    if (source && runImmediately) {
      await this.getService()?.evaluateInPage(this.context.sessionId, source)
    }
    return { identifier }
  }

  private runtimeBindingScript(name: string): string {
    return `
      (() => {
        const bindingName = ${JSON.stringify(name)};
        const clipboardKey = "__cmbBrowserUseVirtualClipboardItems";
        Object.defineProperty(globalThis, bindingName, {
          configurable: true,
          value(payload) {
            let request;
            try {
              request = JSON.parse(String(payload));
            } catch (error) {
              return;
            }
            if (!request || typeof request !== "object" || typeof request.id !== "number") return;
            let response;
            try {
              if (request.operation === "write") {
                globalThis[clipboardKey] = Array.isArray(request.items) ? request.items : [];
                response = { id: request.id, ok: true };
              } else if (request.operation === "read") {
                response = { id: request.id, ok: true, items: globalThis[clipboardKey] || [] };
              } else {
                response = { id: request.id, ok: false, error: "Unsupported clipboard operation" };
              }
            } catch (error) {
              response = {
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error)
              };
            }
            globalThis.__browserUseClipboardBridge?.respond(JSON.stringify(response));
          }
        });
      })()
    `
  }

  private allowDownload(params: unknown): Record<string, never> {
    const request = asRecord(params)
    const tabId = Number(tabIdFromValue(request.tabId))
    const url = stringValue(request.url)
    if (url) this.allowedDownloadUrls.add(this.downloadPermissionKey(tabId, url))
    return {}
  }

  private evaluateLocalDownloadMediaExpression(
    expression: string,
    tabId: number,
    transport: BrowserNativePipeTransport
  ): LocalPlaywrightSelectorEvaluation | null {
    if (!isDownloadMediaExpression(expression)) return null

    const selector = selectorStringFromExpression(expression)
    if (!selector) return localSelectorValue(undefined)
    const simplified = simplifySelector(selector)
    if (!simplified) return localSelectorValue(undefined)
    const elements = applyNth(
      elementsForSelector(this.tab.documentHtml, this.tab.documentText, simplified),
      simplified.nth
    )
    const element = elements[0]
    if (!element) return localSelectorException("Element is not attached")

    const target = localDownloadTargetForElement(element)
    if (!target) return localSelectorException("Matched element does not expose a downloadable URL")

    const sequence = ++this.syntheticDownloadSequence
    const download: LocalSyntheticDownload = {
      ...target,
      id: `download-${sequence}`,
      requestId: `download-request-${sequence}`,
      tabId
    }
    this.syntheticDownloads.set(download.id, download)
    this.syntheticDownloadsByRequestId.set(download.requestId, download)
    this.emitCdpEvent(transport, {
      method: "Fetch.requestPaused",
      params: {
        requestId: download.requestId,
        request: {
          headers: {},
          method: "GET",
          url: download.url
        },
        resourceType: "Document",
        responseHeaders: [
          {
            name: "content-disposition",
            value: `attachment; filename="${download.filename}"`
          },
          {
            name: "content-type",
            value: "application/octet-stream"
          }
        ],
        responseStatusCode: 200
      },
      source: { tabId }
    })
    return localSelectorValue(true)
  }

  private async completeSyntheticDownload(
    commandParams: Record<string, unknown> | undefined,
    transport: BrowserNativePipeTransport
  ): Promise<Record<string, never>> {
    const requestId = stringValue(commandParams?.requestId)
    const download = requestId ? this.syntheticDownloadsByRequestId.get(requestId) : undefined
    if (!download) return {}

    const permissionKey = this.downloadPermissionKey(download.tabId, download.url)
    if (!this.allowedDownloadUrls.delete(permissionKey)) {
      throw new Error("Download was not allowed")
    }

    const directory = await mkdtemp(join(tmpdir(), "cmb-browser-download-"))
    const filePath = join(directory, download.filename)
    await writeFile(filePath, download.data)
    download.filename = filePath
    this.emitDownloadChange(transport, download, "started")
    this.emitDownloadChange(transport, download, "complete")
    this.syntheticDownloadsByRequestId.delete(download.requestId)
    return {}
  }

  private forgetSyntheticDownload(commandParams: Record<string, unknown> | undefined): void {
    const requestId = stringValue(commandParams?.requestId)
    const download = requestId ? this.syntheticDownloadsByRequestId.get(requestId) : undefined
    if (!download) return
    this.syntheticDownloadsByRequestId.delete(requestId!)
    this.syntheticDownloads.delete(download.id)
  }

  private emitDownloadChange(
    transport: BrowserNativePipeTransport,
    download: LocalSyntheticDownload,
    status: "started" | "complete" | "failed" | "canceled"
  ): void {
    transport.sendNotification("onDownloadChange", {
      id: download.id,
      filename: download.filename,
      status,
      url: download.url
    })
  }

  private downloadPermissionKey(tabId: number, url: string): string {
    return `${tabId}:${url}`
  }

  private evaluateLocalPlaywrightSelectorExpression(
    expression: string
  ): LocalPlaywrightSelectorEvaluation {
    const selector = selectorStringFromExpression(expression)
    if (!selector) return localSelectorValue(undefined)
    const simplified = simplifySelector(selector)
    if (!simplified) return localSelectorValue(undefined)

    const elements = applyNth(
      elementsForSelector(this.tab.documentHtml, this.tab.documentText, simplified),
      simplified.nth
    )

    const compactExpression = compactJsExpression(expression)
    if (isFillActionExpression(compactExpression)) {
      const element = elements[0]
      if (!element) return localSelectorException("Element is not attached")
      const value = valueFieldFromExpression(expression)
      this.localFocusedElementKey = element.key
      if (value !== undefined) this.localInputValues.set(element.key, value)
      return localSelectorValue("done")
    }
    if (isSelectOptionExpression(compactExpression)) {
      const element = elements[0]
      if (!element) return localSelectorException("Element is not attached")
      const selectedValues = this.selectLocalOptions(element, selectionsFromExpression(expression))
      if (!selectedValues) {
        return localSelectorException(
          element.tagName === "select"
            ? "No option matched selection"
            : "Element is not a select element"
        )
      }
      return localSelectorValue(true)
    }
    if (isPointerActionTargetExpression(compactExpression)) {
      const element = elements[0]
      if (!element) return localSelectorException("Element does not have a clickable bounding box")
      const requiredStates = stringArrayFieldFromExpression(expression, "requiredStates")
      for (const state of requiredStates) {
        if (!this.localElementStateMatches(element, state)) {
          return localSelectorException(`Element is not ${state}`)
        }
      }
      this.toggleLocalCheckedValue(element)
      return localSelectorValue(localClickPointForElement(element))
    }
    if (isFocusActionExpression(compactExpression)) {
      const element = elements[0]
      if (!element) return localSelectorException("Element is not attached")
      this.localFocusedElementKey = element.key
      return localSelectorValue(true)
    }
    if (isReadCheckedStateExpression(compactExpression)) {
      const element = elements[0]
      if (!element) return localSelectorException("Element is not connected")
      return localSelectorValue({
        checked: this.localElementChecked(element),
        isRadio: isLocalElementRadio(element)
      })
    }
    if (isWaitForStateExpression(compactExpression) && waitForStateFromExpression(expression)) {
      return this.evaluateLocalWaitForState(expression, elements)
    }
    if (hasArrowPropertyRead(compactExpression, "length")) return localSelectorValue(elements.length)
    if (isAllTextContentsExpression(compactExpression)) {
      return localSelectorValue(elements.map((element) => element.text))
    }
    if (hasArrowPropertyRead(compactExpression, "textContent")) {
      return localSelectorValue(elements[0]?.text ?? null)
    }
    if (isInnerTextExpression(compactExpression)) {
      return localSelectorValue(elements[0]?.text ?? "")
    }
    if (isGetAttributeExpression(compactExpression)) {
      const name = attributeNameFromExpression(expression)?.toLowerCase()
      if (!name) return localSelectorValue(null)
      const element = elements[0]
      if (!element) return localSelectorValue(null)
      const attributes = this.localAttributesForElement(element)
      if (name === "value" && "value" in attributes) {
        return localSelectorValue(attributes.value ?? "")
      }
      return localSelectorValue(attributes[name] ?? null)
    }
    if (isElementReadAllExpression(compactExpression)) {
      return localSelectorValue(
        elements.map((element) => ({
          attributes: this.localAttributesForElement(element),
          inner_text: element.text,
          text_content: element.text
        }))
      )
    }
    const stateName = stateNameFromExpression(expression)
    if (stateName) {
      const element = elements[0]
      return localSelectorValue(element ? this.localElementStateMatches(element, stateName) : false)
    }

    return localSelectorValue(undefined)
  }

  private applyLocalDocumentMutation(expression: string): boolean {
    const source = extractPlaywrightUserScriptSource(expression)
    const title = assignedStringLiteral(source, "document\\.title")
    const bodyHtml = assignedStringLiteral(source, "document\\.body\\.innerHTML")
    if (title === undefined && bodyHtml === undefined) return false

    if (title !== undefined) {
      this.tab.title = title
    }
    if (bodyHtml !== undefined) {
      this.tab.documentHtml = `<body>${bodyHtml}</body>`
      this.tab.documentText = extractHtmlText(this.tab.documentHtml)
      this.localFocusedElementKey = null
      this.localCheckedValues.clear()
      this.localInputValues.clear()
      this.localSelectValues.clear()
    }
    return true
  }

  private localElementChecked(element: LocalElementSnapshot): boolean {
    if (this.localCheckedValues.has(element.key)) {
      return this.localCheckedValues.get(element.key) === true
    }
    return (
      "checked" in element.attributes ||
      element.attributes["aria-checked"] === "true" ||
      element.attributes.checked === "true"
    )
  }

  private localElementStateMatches(element: LocalElementSnapshot, state: string): boolean {
    switch (state) {
      case "attached":
        return true
      case "checked":
        return isLocalElementCheckable(element) && this.localElementChecked(element)
      case "disabled":
        return isLocalElementDisabled(element)
      case "editable":
        return isLocalElementEditable(element)
      case "enabled":
        return !isLocalElementDisabled(element)
      case "hidden":
        return isLocalElementHidden(element)
      case "unchecked":
        return isLocalElementCheckable(element) && !this.localElementChecked(element)
      case "visible":
        return !isLocalElementHidden(element)
      default:
        return false
    }
  }

  private localAttributesForElement(element: LocalElementSnapshot): Record<string, string> {
    const attributes = { ...element.attributes }
    if (this.localInputValues.has(element.key)) {
      attributes.value = this.localInputValues.get(element.key) ?? ""
    }
    if (this.localSelectValues.has(element.key)) {
      attributes.value = this.localSelectValues.get(element.key)?.[0] ?? ""
    }
    if (this.localCheckedValues.has(element.key)) {
      if (this.localCheckedValues.get(element.key)) {
        attributes.checked = attributes.checked ?? "true"
        attributes["aria-checked"] = attributes["aria-checked"] ?? "true"
      } else {
        delete attributes.checked
        if (attributes["aria-checked"] === "true") attributes["aria-checked"] = "false"
      }
    }
    return attributes
  }

  private defaultLocalSelectValues(element: LocalElementSnapshot): string[] {
    const options = localOptionsForSelect(element)
    const selected = options.filter((option) => "selected" in option.attributes)
    const source = selected.length > 0 ? selected : options.slice(0, "multiple" in element.attributes ? 0 : 1)
    return source.map((option) => this.localOptionValue(option))
  }

  private localOptionValue(option: LocalElementSnapshot): string {
    return option.attributes.value ?? option.text
  }

  private selectLocalOptions(
    element: LocalElementSnapshot,
    selections: LocalSelectOptionDescriptor[]
  ): string[] | null {
    if (element.tagName !== "select") return null
    const options = localOptionsForSelect(element)
    const selectedValues: string[] = []
    const hasExplicitSelection = selections.length > 0

    for (const selection of selections) {
      const option =
        selection.index !== undefined
          ? options[selection.index]
          : options.find((candidate) => {
              const value = this.localOptionValue(candidate)
              if (selection.value !== undefined && value === selection.value) return true
              if (selection.label !== undefined && candidate.text === selection.label) return true
              return false
            })
      if (!option) return null
      selectedValues.push(this.localOptionValue(option))
    }

    const values =
      selectedValues.length > 0
        ? selectedValues
        : hasExplicitSelection
          ? []
          : this.defaultLocalSelectValues(element)
    if (hasExplicitSelection && values.length === 0) return null
    this.localSelectValues.set(element.key, "multiple" in element.attributes ? values : values.slice(0, 1))
    return this.localSelectValues.get(element.key) ?? []
  }

  private allLocalElements(): LocalElementSnapshot[] {
    return extractLocalElements(this.tab.documentHtml, this.tab.documentText)
  }

  private localElementByKey(key: string): LocalElementSnapshot | undefined {
    return this.allLocalElements().find((element) => element.key === key)
  }

  private setLocalCheckedValue(element: LocalElementSnapshot, checked: boolean): void {
    if (!isLocalElementCheckable(element)) return
    if (isLocalElementRadio(element) && checked) {
      const radioName = element.attributes.name
      for (const candidate of this.allLocalElements()) {
        if (
          candidate.key !== element.key &&
          isLocalElementRadio(candidate) &&
          (!radioName || candidate.attributes.name === radioName)
        ) {
          this.localCheckedValues.set(candidate.key, false)
        }
      }
    }
    this.localCheckedValues.set(element.key, checked)
  }

  private toggleLocalCheckedValue(element: LocalElementSnapshot): void {
    if (!isLocalElementCheckable(element)) return
    if (isLocalElementRadio(element)) {
      if (!this.localElementChecked(element)) this.setLocalCheckedValue(element, true)
      return
    }
    this.setLocalCheckedValue(element, !this.localElementChecked(element))
  }

  private evaluateLocalWaitForState(
    expression: string,
    elements: LocalElementSnapshot[]
  ): LocalPlaywrightSelectorEvaluation {
    const state = waitForStateFromExpression(expression)
    const attached = elements.length > 0
    switch (state) {
      case "attached":
        return attached
          ? localSelectorValue(true)
          : localSelectorException("Element is not attached")
      case "detached":
        return !attached
          ? localSelectorValue(true)
          : localSelectorException("Element is still attached")
      case "hidden":
        return !attached
          ? localSelectorValue(true)
          : localSelectorException("Element is not hidden")
      case "visible":
        return attached ? localSelectorValue(true) : localSelectorException("Element is not attached")
      default:
        return localSelectorValue(undefined)
    }
  }

  private evaluateLocalReadOnlyExpression(expression: string): unknown {
    const source = extractPlaywrightUserScriptSource(expression)
    const wantsTitle = source.includes("document.title")
    const wantsHref =
      source.includes("location.href") || source.includes("window.location.href")
    const wantsReadyState = source.includes("document.readyState")
    const wantsText = source.includes("innerText") || source.includes("textContent")
    const wantsHtml = source.includes("innerHTML") || source.includes("outerHTML")

    if (wantsTitle || wantsHref || wantsReadyState || wantsText || wantsHtml) {
      const value: Record<string, unknown> = {}
      if (wantsTitle) value.title = this.currentTitle()
      if (wantsHref) value.href = this.currentUrl()
      if (wantsReadyState) value.readyState = "complete"
      if (wantsText) value.text = this.tab.documentText
      if (wantsHtml) value.html = this.tab.documentHtml
      const keys = Object.keys(value)
      return keys.length === 1 ? value[keys[0]] : value
    }

    return undefined
  }

  private async dispatchMouseEvent(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, never>> {
    const type = stringValue(commandParams?.type)
    const x = numberValue(commandParams?.x)
    const y = numberValue(commandParams?.y)
    if (x === undefined || y === undefined) return {}
    const button = mouseButtonValue(commandParams?.button)
    const clickCount = positiveIntegerValue(commandParams?.clickCount, 1)

    switch (type) {
      case "mouseMoved":
        await this.getService()?.moveMouse(this.context.sessionId, { x, y })
        break
      case "mousePressed":
        await this.getService()?.mouseDown(this.context.sessionId, { x, y }, button, clickCount)
        break
      case "mouseReleased":
        await this.getService()?.mouseUp(this.context.sessionId, { x, y }, button, clickCount)
        break
    }
    return {}
  }

  private async dispatchKeyEvent(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, never>> {
    const type = stringValue(commandParams?.type)
    if (!isKeyboardDownEvent(type)) return {}

    const text = stringValue(commandParams?.text)
    if (isPrintableKeyboardText(text)) {
      await this.getService()?.typeText(this.context.sessionId, text)
      return {}
    }

    const key = stringValue(commandParams?.key) ?? stringValue(commandParams?.code)
    if (key) {
      await this.getService()?.press(this.context.sessionId, key)
    }
    return {}
  }

  private async insertText(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, never>> {
    const text = stringValue(commandParams?.text)
    if (text) {
      const service = this.getService()
      if (service) {
        await service.typeText(this.context.sessionId, text)
      } else if (this.localFocusedElementKey) {
        const element = this.localElementByKey(this.localFocusedElementKey)
        const current =
          this.localInputValues.get(this.localFocusedElementKey) ?? element?.attributes.value ?? ""
        this.localInputValues.set(this.localFocusedElementKey, current + text)
      }
    }
    return {}
  }

  private async synthesizeScrollGesture(
    commandParams: Record<string, unknown> | undefined
  ): Promise<Record<string, never>> {
    const x = numberValue(commandParams?.x)
    const y = numberValue(commandParams?.y)
    if (x === undefined || y === undefined) return {}
    const xDistance = numberValue(commandParams?.xDistance) ?? 0
    const yDistance = numberValue(commandParams?.yDistance) ?? 0
    await this.getService()?.scroll(this.context.sessionId, {
      x,
      y,
      deltaX: -xDistance,
      deltaY: -yDistance
    })
    return {}
  }

  private async moveMouse(params: unknown): Promise<Record<string, never>> {
    const request = asRecord(params)
    const tabId = request.tabId
    if (tabId !== undefined) tabIdFromValue(tabId)
    await this.ensureTab()
    const x = numberValue(request.x)
    const y = numberValue(request.y)
    if (x !== undefined && y !== undefined) {
      await this.getService()?.moveMouse(this.context.sessionId, { x, y })
    }
    return {}
  }

  private async captureScreenshotBase64(): Promise<string> {
    const result = await this.getService()?.captureScreenshot(this.context.sessionId)
    if (result?.success && result.dataUrl) {
      return normalizeDataUrlBase64(result.dataUrl) ?? FALLBACK_SCREENSHOT_BASE64
    }
    return FALLBACK_SCREENSHOT_BASE64
  }

  private getFrameTree(tabId: number): Record<string, unknown> {
    return {
      frameTree: {
        frame: this.framePayload(tabId)
      }
    }
  }

  private getLayoutMetrics(): Record<string, unknown> {
    const cssVisualViewport = {
      clientHeight: DEFAULT_VIEWPORT.height,
      clientWidth: DEFAULT_VIEWPORT.width,
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 0,
      scale: 1,
      zoom: 1
    }
    return {
      contentSize: {
        height: DEFAULT_VIEWPORT.height,
        width: DEFAULT_VIEWPORT.width,
        x: 0,
        y: 0
      },
      cssContentSize: {
        height: DEFAULT_VIEWPORT.height,
        width: DEFAULT_VIEWPORT.width,
        x: 0,
        y: 0
      },
      cssLayoutViewport: {
        clientHeight: DEFAULT_VIEWPORT.height,
        clientWidth: DEFAULT_VIEWPORT.width,
        pageX: 0,
        pageY: 0
      },
      cssVisualViewport,
      layoutViewport: {
        clientHeight: DEFAULT_VIEWPORT.height,
        clientWidth: DEFAULT_VIEWPORT.width,
        pageX: 0,
        pageY: 0
      },
      visualViewport: cssVisualViewport
    }
  }

  private getNavigationHistory(): Record<string, unknown> {
    return {
      currentIndex: this.tab.historyIndex,
      entries: this.tab.history.map((url, index) => ({
        id: index + 1,
        title: titleForUrl(url),
        transitionType: "typed",
        url
      }))
    }
  }

  private getTargets(): Record<string, unknown> {
    return {
      targetInfos: this.tab.created
        ? [
            {
              attached: true,
              browserContextId: this.context.sessionId,
              targetId: `target-${PRIMARY_TAB_ID}`,
              title: this.currentTitle(),
              type: "page",
              url: this.currentUrl()
            }
          ]
        : []
    }
  }

  private emitNavigationEvents(transport: BrowserNativePipeTransport, tabId: number): void {
    const frame = this.framePayload(tabId)
    this.emitCdpEvent(transport, {
      method: "Page.frameStartedLoading",
      params: { frameId: frame.id },
      source: { tabId }
    })
    this.emitCdpEvent(transport, {
      method: "Page.frameNavigated",
      params: { frame },
      source: { tabId }
    })
    this.emitCdpEvent(transport, {
      method: "Page.domContentEventFired",
      params: { timestamp: Date.now() / 1000 },
      source: { tabId }
    })
    this.emitCdpEvent(transport, {
      method: "Page.loadEventFired",
      params: { timestamp: Date.now() / 1000 },
      source: { tabId }
    })
  }

  private emitCdpEvent(
    transport: BrowserNativePipeTransport,
    event: BrowserOfficialCdpEvent
  ): void {
    transport.sendNotification("onCDPEvent", event)
  }

  private framePayload(_tabId: number): Record<string, unknown> {
    return {
      id: this.frameId(),
      loaderId: this.loaderId(),
      mimeType: "text/html",
      securityOrigin: this.securityOrigin(),
      url: frameUrl(this.currentUrl())
    }
  }

  private frameId(): string {
    return `frame-${PRIMARY_TAB_ID}`
  }

  private loaderId(): string {
    return `loader-${this.tab.loaderSequence}`
  }

  private securityOrigin(): string {
    try {
      return new URL(this.currentUrl()).origin
    } catch {
      return "://"
    }
  }

  private currentUrl(): string {
    const state = this.getServiceState()
    return state?.url || this.tab.url
  }

  private currentTitle(): string {
    const state = this.getServiceState()
    return state?.title || this.tab.title
  }

  private async ensureTab(): Promise<void> {
    const wasCreated = this.tab.created
    this.tab.created = true
    const service = this.getService()
    if (!service) return

    service.attach(this.context.sessionId, {
      workspacePath: this.context.workspacePath,
      visible: false
    })
    if (!this.panelRequested) {
      service.requestPanel(this.context.sessionId, this.context.threadId)
      this.panelRequested = true
      console.info(`[BrowserOfficialBackend] Requested Browser panel for ${this.context.sessionId}.`)
    } else if (!wasCreated) {
      console.info(`[BrowserOfficialBackend] Reused Browser panel for ${this.context.sessionId}.`)
    }
  }

  private getServiceState(): BrowserState | null {
    const service = this.getService()
    if (!service) return null
    return service.getState(this.context.sessionId)
  }

  private getService(): BrowserService | null {
    return this.context.getService?.() ?? getGlobalBrowserService()
  }
}

export function createBrowserOfficialBackendAdapter(
  context: BrowserOfficialBackendAdapterContext
): BrowserOfficialBackendAdapter {
  return new BrowserOfficialBackendAdapter(context)
}
