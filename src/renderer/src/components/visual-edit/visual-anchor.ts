import type { ClawVisualAnchor, ClawVisualPoint } from "./visual-edit-types"

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value)
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
}

function compactText(value: string | null | undefined, limit = 48): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return undefined
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text
}

export function getElementLabel(element: Element | null): string {
  if (!element || !(element instanceof HTMLElement)) return ""
  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ""
  const classes = Array.from(element.classList)
    .filter((item) => item && !item.startsWith("__"))
    .slice(0, 2)
    .map((item) => `.${item}`)
    .join("")
  const role = element.getAttribute("role")
  const aria = compactText(element.getAttribute("aria-label"), 32)
  const text = compactText(element.innerText || element.textContent, 32)
  const label = aria || text
  const roleText = role ? `[role=${role}]` : ""
  return `${tag}${id}${classes}${roleText}${label ? ` "${label}"` : ""}`
}

export function getSelector(element: Element): string {
  if (!(element instanceof HTMLElement)) return element.tagName.toLowerCase()
  if (element.id) return `#${cssEscape(element.id)}`

  const parts: string[] = []
  let current: Element | null = element
  while (current && current instanceof HTMLElement && current !== current.ownerDocument.body) {
    const tag = current.tagName.toLowerCase()
    const className = Array.from(current.classList)
      .filter((item) => item && !item.startsWith("__"))
      .slice(0, 2)
      .map((item) => `.${cssEscape(item)}`)
      .join("")
    let part = `${tag}${className}`
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current?.tagName
      )
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
    }
    parts.unshift(part)
    if (parts.length >= 5) break
    current = current.parentElement
  }

  return parts.join(" > ") || element.tagName.toLowerCase()
}

export function getElementAnchor(
  element: Element | null,
  point: ClawVisualPoint,
  options: { targetPath?: string; targetUrl?: string } = {}
): ClawVisualAnchor | undefined {
  if (!element || !(element instanceof HTMLElement)) return undefined
  const rect = element.getBoundingClientRect()
  const win = element.ownerDocument.defaultView
  const scrollX = win?.scrollX ?? 0
  const scrollY = win?.scrollY ?? 0
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const text = compactText(element.innerText || element.textContent)
  const aria = compactText(element.getAttribute("aria-label"))
  const role = element.getAttribute("role") || undefined

  return {
    selector: getSelector(element),
    tagName: element.tagName.toLowerCase(),
    role,
    text,
    className: element.className || undefined,
    screenLabel: aria || text || getElementLabel(element),
    bbox: {
      x: Math.round(rect.left + scrollX),
      y: Math.round(rect.top + scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    offsetRatio: {
      x: Math.max(0, Math.min(1, (point.x - (rect.left + scrollX)) / width)),
      y: Math.max(0, Math.min(1, (point.y - (rect.top + scrollY)) / height))
    },
    targetPath: options.targetPath,
    targetUrl: options.targetUrl
  }
}

export function elementFromPagePoint(
  iframe: HTMLIFrameElement | null,
  point: ClawVisualPoint
): Element | null {
  const doc = iframe?.contentDocument
  const win = iframe?.contentWindow
  if (!doc || !win) return null
  return doc.elementFromPoint(Math.round(point.x - win.scrollX), Math.round(point.y - win.scrollY))
}

export function collectNearbyElements(
  iframe: HTMLIFrameElement | null,
  points: ClawVisualPoint[],
  maxItems = 8
): string[] {
  const doc = iframe?.contentDocument
  const win = iframe?.contentWindow
  if (!doc || !win || points.length === 0) return []

  const sampleCount = Math.min(6, points.length)
  const step = Math.max(1, Math.floor(points.length / sampleCount))
  const sampled = points.filter((_, index) => index % step === 0).slice(0, sampleCount)
  const seen = new Set<string>()

  for (const point of sampled) {
    const element = doc.elementFromPoint(
      Math.round(point.x - win.scrollX),
      Math.round(point.y - win.scrollY)
    )
    const label = getElementLabel(element)
    if (label) seen.add(label)
  }

  return Array.from(seen).slice(0, maxItems)
}
