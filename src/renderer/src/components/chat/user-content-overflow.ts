/** Observe only the authorized, uncapped inner box; geometry is delivered by layout. */
export function observeUserContentOverflow(
  outer: HTMLElement,
  layout: HTMLElement,
  maximum: number,
  changed: (overflow: boolean) => void
): () => void {
  let height: number | undefined
  let live = true
  const pending = () => Boolean(layout.querySelector("[data-function-site-pending]"))
  const publish = () => {
    if (!live) return
    if (pending()) changed(false)
    else if (height !== undefined) changed(height > maximum + 8)
  }
  const fallback = () => {
    if (!live) return
    if (pending()) changed(false)
    else {
      height = outer.scrollHeight
      publish()
    }
  }
  const modern = typeof ResizeObserver !== "undefined"
  const observer = modern
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target !== layout) continue
          const border = entry.borderBoxSize?.[0]
          height = border?.blockSize ?? entry.contentRect.height
          publish()
        }
      })
    : undefined
  if (observer) observer.observe(layout)
  else fallback()
  // Authorization can replace a pending slot with equal-sized content. Reuse
  // the last observer geometry rather than forcing another synchronous layout.
  const mutations =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (modern) publish()
          else fallback()
        })
      : undefined
  mutations?.observe(layout, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-function-site-pending"]
  })
  if (!modern) window.addEventListener("resize", fallback)
  return () => {
    live = false
    observer?.disconnect()
    mutations?.disconnect()
    if (!modern) window.removeEventListener("resize", fallback)
  }
}
