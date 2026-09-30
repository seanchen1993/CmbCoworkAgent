import type { DrawPoint } from "./types"

/** Padding (page px) around a stroke's bounding box that still counts as "inside" it. */
export const DRAW_NOTE_ATTACH_PADDING = 24

export interface DrawStrokeBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function getStrokeBounds(points: DrawPoint[]): DrawStrokeBounds | null {
  if (points.length === 0) return null
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  }
}

/** A stroke reduced to what the binding rule needs — already resolved to current page coords. */
export interface StrokeHitCandidate {
  id: string
  points: DrawPoint[]
  anchorElement?: Element | null
}

/**
 * Pick the stroke a note at `point` explains.
 *
 * Preference order:
 *  1. Strokes whose padded bounding box contains the point, smallest area first — so a note
 *     dropped inside a small box nested in a big box binds to the small one.
 *  2. The first stroke anchored to the same element as the note.
 *
 * Returns undefined when the note belongs to no stroke, i.e. it stands on its own.
 */
/**
 * Decide which stroke (if any) a draw-mode note should bind to.
 *
 * Rule 1 (geometry): If the note point falls inside any stroke's bounding box
 *   (with a forgiving 24px padding), bind to the smallest-area match. This ensures
 *   nested frames obey "smallest-area wins" regardless of draw order.
 *
 * Rule 2 (anchor fallback): If no geometric match, fall back to same-element binding:
 *   if the note and stroke both resolved to the same DOM element (via resolveAnchorElement,
 *   which tries selector → label → text), bind them. This survives DOM mutations that
 *   change CSS selectors but preserve the semantic element match.
 *
 * Fixed issues:
 *   - P2: Nested-frame binding no longer depends on draw order. A note inside overlapping
 *     frames now binds to the smallest frame, even if the large frame was drawn first.
 *     Callers must re-evaluate ALL notes against ALL strokes whenever a new stroke appears.
 *   - P2: Anchor fallback now compares resolved Element references (via resolveAnchorElement),
 *     not raw selector strings. This leverages label/text fallback when selectors change.
 */
export function pickStrokeIdForNotePoint(
  candidates: StrokeHitCandidate[],
  point: DrawPoint,
  anchorElement?: Element | null
): string | undefined {
  const containing = candidates
    .map((candidate) => {
      const bounds = getStrokeBounds(candidate.points)
      if (!bounds) return null
      const inside =
        point.x >= bounds.minX - DRAW_NOTE_ATTACH_PADDING &&
        point.x <= bounds.maxX + DRAW_NOTE_ATTACH_PADDING &&
        point.y >= bounds.minY - DRAW_NOTE_ATTACH_PADDING &&
        point.y <= bounds.maxY + DRAW_NOTE_ATTACH_PADDING
      if (!inside) return null
      const area = Math.max(1, bounds.maxX - bounds.minX) * Math.max(1, bounds.maxY - bounds.minY)
      return { id: candidate.id, area }
    })
    .filter((entry): entry is { id: string; area: number } => entry !== null)
    .sort((left, right) => left.area - right.area)

  if (containing.length > 0) return containing[0].id

  if (anchorElement) {
    const sameAnchor = candidates.find((candidate) => candidate.anchorElement === anchorElement)
    if (sameAnchor) return sameAnchor.id
  }
  return undefined
}

export function getDrawElementLabel(element: Element | null): string {
  if (!element) return ""
  if (element === element.ownerDocument?.documentElement || element === element.ownerDocument?.body) return "page"

  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ""
  const classes = Array.from(element.classList ?? [])
    .filter((className) => !className.startsWith("__"))
    .slice(0, 2)
    .map((className) => `.${className}`)
    .join("")
  const label = element.getAttribute("aria-label") || element.getAttribute("alt") || ""
  const text = (label || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)
  return `${tag}${id}${classes}${text ? ` '${text}'` : ""}`
}
