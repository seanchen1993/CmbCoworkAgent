import type {
  FunctionSelection,
  FunctionPaneDrawing
} from "../../../shared/mods/v2/desktop-actions"

export function desktopElementVisible(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']"))
    return false
  const style = getComputedStyle(element)
  if (style.visibility === "hidden" || style.display === "none") return false
  return Boolean(
    element.getClientRects().length ||
    (style.display === "contents" &&
      [...element.children].some(
        (child) => child instanceof HTMLElement && desktopElementVisible(child)
      ))
  )
}
export function desktopChatRegions(root: HTMLElement, threadId: string): HTMLElement[] {
  return [
    root,
    ...document.querySelectorAll<HTMLElement>(
      `[data-claw-sidebar-host="${CSS.escape(threadId)}"] [data-claw-results]`
    )
  ]
}

/** DOM layout eligibility, including scroll clipping; not a proof of OS paint. */
export function desktopElementPresented(element: HTMLElement | null): element is HTMLElement {
  if (!desktopElementVisible(element) || document.visibilityState !== "visible") return false
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top),
    right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom)
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden" ||
      style.visibility === "collapse" || Number(style.opacity) === 0) return false
    if (node !== element) {
      const clip = node.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, clip.left + node.clientLeft)
        right = Math.min(right, clip.left + node.clientLeft + node.clientWidth)
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, clip.top + node.clientTop)
        bottom = Math.min(bottom, clip.top + node.clientTop + node.clientHeight)
      }
    }
  }
  return right > left && bottom > top
}
export interface CapturedDesktopSelection {
  text: string
  row?: HTMLElement
  requestId?: string
  range?: Range
  rangeText?: string
  startNode?: Node
  endNode?: Node
}
/** No document-wide text harvesting: both ends must lie inside the actual chat regions. */
export function readDesktopSelection(regions: HTMLElement[]): CapturedDesktopSelection | undefined {
  const active = document.activeElement
  if (
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    active.type !== "password" &&
    !active.closest("[data-desktop-selection-excluded]") &&
    regions.some((region) => region.contains(active)) &&
    desktopElementVisible(active)
  ) {
    const start = active.selectionStart,
      end = active.selectionEnd
    if (start !== null && end !== null && end > start) {
      const text = active.value.slice(start, end)
      return new TextEncoder().encode(text).length <= 64 * 1024 ? { text } : undefined
    }
  }
  const selection = document.getSelection()
  const eligible = (node: Node | null) => {
    const element = node instanceof HTMLElement ? node : node?.parentElement
    return (
      element &&
      !element.closest("[data-desktop-selection-excluded]") &&
      desktopElementVisible(element)
    )
  }
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !eligible(selection.anchorNode) ||
    !eligible(selection.focusNode) ||
    !regions.some(
      (region) =>
        desktopElementVisible(region) &&
        region.contains(selection.anchorNode) &&
        region.contains(selection.focusNode)
    )
  )
    return undefined
  const range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined
  if (
    !range ||
    regions.some((region) =>
      [
        ...region.querySelectorAll<HTMLElement>(
          "[data-desktop-selection-excluded], input[type='password']"
        )
      ].some((element) => range.intersectsNode(element))
    )
  )
    return undefined
  const text = selection.toString()
  if (!text || new TextEncoder().encode(text).length > 64 * 1024) return undefined
  const rowOf = (node: Node) =>
    (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>(
      "[data-function-request-id], [data-chat-message-id]"
    )
  const start = rowOf(selection.anchorNode),
    end = rowOf(selection.focusNode)
  let requestId =
    start === end ? (start?.dataset.functionRequestId ?? start?.dataset.chatMessageId) : undefined
  if (
    requestId &&
    start &&
    range &&
    [
      ...start.querySelectorAll<HTMLElement>("[data-function-request-id], [data-chat-message-id]")
    ].some(
      (row) =>
        (row.dataset.functionRequestId ?? row.dataset.chatMessageId) !== requestId &&
        desktopElementVisible(row) &&
        range.intersectsNode(row)
    )
  )
    requestId = undefined
  return {
    text,
    ...(requestId && start && range
      ? {
          row: start,
          requestId,
          range,
          rangeText: range.toString(),
          startNode: range.startContainer,
          endNode: range.endContainer
        }
      : {})
  }
}
export function publishDesktopSelection(
  captured: CapturedDesktopSelection | undefined,
  regions: HTMLElement[]
): FunctionSelection | undefined {
  if (!captured) return undefined
  const row = captured.row
  const stillDrawn =
    row &&
    desktopElementVisible(row) &&
    regions.some((region) => region.contains(row)) &&
    (row.dataset.functionRequestId ?? row.dataset.chatMessageId) === captured.requestId &&
    captured.range &&
    captured.startNode &&
    captured.endNode &&
    row.contains(captured.startNode) &&
    row.contains(captured.endNode) &&
    captured.range.toString() === captured.rangeText
  return { text: captured.text, ...(stillDrawn ? { requestId: captured.requestId } : {}) }
}
export function readDesktopPaneDrawings(regions: HTMLElement[]): FunctionPaneDrawing[] {
  const nodes = new Set(
    regions.flatMap((region) => [
      ...region.querySelectorAll<HTMLElement>("[data-function-pane-key]")
    ])
  )
  const modal = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"]'
    )
  ].some(desktopElementVisible)
  return [...nodes].slice(0, 64).map((node) => {
    const visible = desktopElementVisible(node)
    return {
      key: node.dataset.functionPaneKey!,
      generation: node.dataset.functionPaneGeneration ?? "",
      isPlaced: visible,
      isShown: visible,
      isFocused:
        visible &&
        !modal &&
        document.hasFocus() &&
        Boolean(document.activeElement && node.contains(document.activeElement))
    }
  })
}
