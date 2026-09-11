import { findChatTextRanges } from "../../../shared/chat-search-index"
import { chatSearchLocationKey, type ChatSearchLocation } from "../../../shared/chat-search-types"

const MAX_DOM_TEXT = 256 * 1024
const MAX_DOM_NODES = 8192
const blocks = "p,pre,li,h1,h2,h3,h4,h5,h6,blockquote,tr"

/** Build a bounded map across inline elements, preserving block separators. */
export function mapChatSearchDom(
  root: HTMLElement,
  query: string
): {
  text: string
  ranges: Array<{ start: number; end: number; range: Range }>
} {
  const entries: Array<{ node: Text; start: number; end: number }> = []
  const parts: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let length = 0
  let visited = 0
  let previousBlock: Element | null = null
  let node: Node | null
  while ((node = walker.nextNode()) && visited++ < MAX_DOM_NODES && length < MAX_DOM_TEXT) {
    const parent = node.parentElement
    if (
      !parent?.closest("[data-chat-search-text]") ||
      parent.closest(
        "[data-chat-search-ignore],[data-chat-search-context-key],script,style,noscript"
      )
    )
      continue
    const value = node.nodeValue ?? ""
    if (!value) continue
    const block = parent.closest(blocks)
    if (entries.length && block !== previousBlock) {
      parts.push("\n\n")
      length += 2
    }
    previousBlock = block
    const text = value.slice(0, Math.max(0, MAX_DOM_TEXT - length))
    entries.push({ node: node as Text, start: length, end: length + text.length })
    parts.push(text)
    length += text.length
  }
  const text = parts.join("")
  const ranges: Array<{ start: number; end: number; range: Range }> = []
  let startIndex = 0
  for (const hit of findChatTextRanges(text, query, 1000)) {
    while (startIndex < entries.length && entries[startIndex].end <= hit.start) startIndex += 1
    let endIndex = startIndex
    while (endIndex < entries.length && entries[endIndex].end < hit.end) endIndex += 1
    const start = entries[startIndex]
    const end = entries[endIndex]
    if (!start || !end || hit.start < start.start || hit.end > end.end) continue
    const range = document.createRange()
    range.setStart(start.node, hit.start - start.start)
    range.setEnd(end.node, hit.end - end.start)
    ranges.push({ ...hit, range })
  }
  return { text, ranges }
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").toLowerCase()

export function findChatSearchLocationRange(
  row: HTMLElement,
  location: ChatSearchLocation,
  query: string
): Range | null {
  const key = chatSearchLocationKey(location)
  const context = Array.from(
    row.querySelectorAll<HTMLElement>("[data-chat-search-context-key]")
  ).find((node) => node.dataset.chatSearchContextKey === key)
  const hit = context?.querySelector("[data-chat-search-context-hit]")
  if (hit) {
    const range = document.createRange()
    range.selectNodeContents(hit)
    return range.toString().toLowerCase().includes(query.trim().toLowerCase()) ? range : null
  }
  if (location.kind !== "body") return null
  const fragment = Array.from(
    row.querySelectorAll<HTMLElement>("[data-chat-search-source-start]")
  ).find(
    (node) =>
      Number(node.dataset.chatSearchSourceStart) === location.sourceStart &&
      Number(node.dataset.chatSearchSourceEnd) <= location.sourceEnd &&
      Number(
        node.closest<HTMLElement>("[data-chat-search-block-index]")?.dataset.chatSearchBlockIndex
      ) === location.blockIndex
  )
  if (!fragment) return null
  const mapped = mapChatSearchDom(fragment, query)
  const candidate = mapped.ranges[location.segmentOccurrence]
  if (!candidate) return null
  const before = normalize(location.context.slice(0, location.contextStart))
  const after = normalize(location.context.slice(location.contextEnd))
  if (
    !normalize(mapped.text.slice(0, candidate.start)).endsWith(before) ||
    !normalize(mapped.text.slice(candidate.end)).startsWith(after)
  )
    return null
  return candidate.range
}
