import type { VirtuosoHandle } from "react-virtuoso"

/** Refresh only before correcting stale geometry, including Virtuoso's native initial probe. */
export function needsChatItemSizeRefresh(
  viewport: HTMLElement,
  target: HTMLElement,
  destination: { element: HTMLElement; offset: number } | null
): boolean {
  if (
    target.closest<HTMLElement>('[data-testid="virtuoso-item-list"]')?.style.visibility === "hidden"
  ) {
    return true
  }
  return Boolean(
    destination &&
    Math.abs(
      destination.element.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        destination.offset
    ) > 1
  )
}

/** Preserve CSS layout precision so the native index model agrees with fractional row heights. */
export function measureChatVirtualItem(element: HTMLElement): number {
  return Math.round(element.getBoundingClientRect().height * 64) / 64
}

/** Use the current model rather than a spacer DOM tree whose commit may still be pending. */
export function positionChatVirtualAnchor(
  element: HTMLElement,
  offsetFromViewportTop: number,
  handle: VirtuosoHandle | null
): boolean {
  const item = element.closest<HTMLElement>("[data-index]")
  if (!handle || !item || item.parentElement?.dataset.testid !== "virtuoso-item-list") return false
  const index = Number(item.dataset.index)
  if (!Number.isInteger(index) || index < 0) return false
  const inset = element.getBoundingClientRect().top - item.getBoundingClientRect().top
  // Pinned Virtuoso rounds scroll targets with Math.ceil. Remove its upward half-pixel bias
  // so fractional rows settle within the existing 0.5px detached-anchor tolerance.
  handle.scrollToIndex({ index, align: "start", offset: inset - offsetFromViewportTop - 0.5, behavior: "auto" })
  // The owning restoration loop handles later measurements; no native retry may outlive it.
  handle.cancelScrollToIndex()
  return true
}

/** After publication, only a still-hidden probe waits for its measured item DOM to commit. */
export function hasUncommittedChatItemSizes(target: HTMLElement): boolean {
  const list = target.closest<HTMLElement>('[data-testid="virtuoso-item-list"]')
  if (!list || list.style.visibility !== "hidden") return false
  for (const child of Array.from(list.children)) {
    if (!(child instanceof HTMLElement) || !child.hasAttribute("data-index")) continue
    const known = child.dataset.knownSize
    if (!known || !Number.isFinite(Number(known)) ||
      Number(known) !== measureChatVirtualItem(child)) return true
  }
  return false
}
