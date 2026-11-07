/** Viewport chrome can resize without changing Virtuoso's measured content height. */
export function observeChatViewportResize(
  viewport: HTMLElement,
  onResize: () => void
): () => void {
  const Observer = viewport.ownerDocument.defaultView?.ResizeObserver
  if (!Observer) return () => undefined
  let width = viewport.clientWidth
  let height = viewport.clientHeight
  let disposed = false
  const observer = new Observer(() => {
    if (disposed || !viewport.isConnected) return
    const nextWidth = viewport.clientWidth
    const nextHeight = viewport.clientHeight
    if (width === nextWidth && height === nextHeight) return
    width = nextWidth
    height = nextHeight
    // Hidden panels must not consume their follow intent; showing them triggers a fresh resize.
    if (width > 0 && height > 0) onResize()
  })
  observer.observe(viewport)
  return () => {
    disposed = true
    observer.disconnect()
  }
}
