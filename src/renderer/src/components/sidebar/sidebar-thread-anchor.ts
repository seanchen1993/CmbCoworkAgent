export function revealSidebarThread(viewport: HTMLElement, threadId: string): boolean {
  const row = viewport.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${CSS.escape(threadId)}"]`
  )
  if (!row || !viewport.clientHeight || !row.getClientRects().length) return false

  const viewportRect = viewport.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  if (rowRect.top < viewportRect.top) {
    viewport.scrollTop += rowRect.top - viewportRect.top
  } else if (rowRect.bottom > viewportRect.bottom) {
    viewport.scrollTop += rowRect.bottom - viewportRect.bottom
  }
  return true
}
