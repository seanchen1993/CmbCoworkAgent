export interface FunctionMessageViewport {
  top: number
  height: number
  layoutWidth: number
  pieces: Array<{ text: string; top: number; left: number; width: number; font: string }>
}

/** Inert text only; every retained character must occur in the protected host body. */
export function captureFunctionMessageViewport(
  section: HTMLElement,
  protectedText: string
): FunctionMessageViewport | undefined {
  const document = section.ownerDocument
  const viewport = section.closest<HTMLElement>("[data-radix-scroll-area-viewport]")
  if (!viewport || !section.isConnected) return
  const bounds = document.createRange()
  bounds.selectNodeContents(section)
  const origin = bounds.getBoundingClientRect()
  bounds.detach()
  const area = viewport.getBoundingClientRect()
  if (origin.bottom <= area.top || origin.top >= area.bottom || area.height <= 0) return
  const left = Math.max(origin.left, area.left, 0),
    right = Math.min(origin.right, area.right)
  const top = Math.max(origin.top, area.top, 0),
    bottom = Math.min(origin.bottom, area.bottom)
  if (right - left <= 2 || bottom - top <= 2) return
  const points: Range[] = []
  for (const y of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    for (const x of [0.125, 0.5, 0.875]) {
      const point = document.caretRangeFromPoint(
        left + (right - left) * x,
        top + (bottom - top) * y
      )
      if (
        point &&
        point.startContainer.nodeType === Node.TEXT_NODE &&
        section.contains(point.startContainer) &&
        point.startContainer.parentElement?.closest("[data-chat-search-text]")
      )
        points.push(point)
      else point?.detach()
    }
  }
  if (!points.length) return
  points.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b))
  const first = points[0],
    last = points[points.length - 1]
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
  walker.currentNode = first.startContainer
  const pieces: FunctionMessageViewport["pieces"] = []
  let remaining = 8192
  for (
    let count = 0, node: Node | null = walker.currentNode;
    node && count < 128 && remaining > 0;
    node = walker.nextNode(), count++
  ) {
    const parent = node.parentElement
    if (parent?.closest("[data-chat-search-text]")) {
      const start = node === first.startContainer ? first.startOffset : 0
      const end = Math.min(
        node.textContent?.length ?? 0,
        node === last.startContainer ? last.startOffset : Number.MAX_SAFE_INTEGER,
        start + remaining
      )
      const text = node.textContent?.slice(start, end) ?? ""
      if (text.trim() && protectedText.includes(text)) {
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, end)
        const rect = range.getBoundingClientRect()
        range.detach()
        const font = document.defaultView?.getComputedStyle(parent).font ?? ""
        if (rect.height > 0 && rect.width > 0 && font.length <= 160) {
          pieces.push({
            text,
            top: Math.max(0, rect.top - origin.top),
            left: Math.max(0, rect.left - origin.left),
            width: rect.width,
            font
          })
          remaining -= text.length
          if (pieces.length === 64) break
        }
      }
    }
    if (node === last.startContainer) break
  }
  for (const point of points) point.detach()
  if (!pieces.length) return
  return {
    top: Math.max(0, top - origin.top),
    height: bottom - top,
    layoutWidth:
      section.closest<HTMLElement>("[data-chat-message-row]")?.clientWidth ?? viewport.clientWidth,
    pieces
  }
}

/** No arbitrary DOM, markup, link targets or callback identities enter the cache. */
export function checkedFunctionMessageViewport(
  value: FunctionMessageViewport | undefined,
  protectedText: string
): FunctionMessageViewport | undefined {
  if (!value) return
  const { top, height, layoutWidth, pieces: source } = value
  if (
    !Number.isFinite(top) ||
    top < 0 ||
    top > 100000 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    height > 20000 ||
    !Number.isFinite(layoutWidth) ||
    layoutWidth <= 0 ||
    layoutWidth > 100000 ||
    !Array.isArray(source) ||
    !source.length ||
    source.length > 64
  )
    return
  let characters = 0
  const pieces: FunctionMessageViewport["pieces"] = []
  for (const item of source) {
    if (!item) return
    // Validate and retain the same primitive snapshot, including for accessor inputs.
    const { text, top, left, width, font } = item
    if (
      typeof text !== "string" ||
      !text ||
      !protectedText.includes(text) ||
      (characters += text.length) > 8192 ||
      typeof font !== "string" ||
      font.length > 160 ||
      ![top, left, width].every(Number.isFinite) ||
      top < 0 ||
      top > 100000 ||
      left < 0 ||
      left > 100000 ||
      width <= 0 ||
      width > 100000
    )
      return
    pieces.push({ text, top, left, width, font })
  }
  return { top, height, layoutWidth, pieces }
}
