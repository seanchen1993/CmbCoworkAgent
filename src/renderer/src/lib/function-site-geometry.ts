export interface FunctionSiteGeometry {
  height: number
  width: number
}

interface GeometryBatch {
  frame: number | null
  reads: Set<() => void>
}

const batches = new WeakMap<Document, GeometryBatch>()

/** Measure mounted drawings together, outside React's interleaved deletion/layout phase. */
export function observeFunctionSiteGeometry(
  node: HTMLElement,
  measured: (geometry: FunctionSiteGeometry) => void
): () => void {
  const document = node.ownerDocument
  const view = document.defaultView
  if (!view) return () => {}
  let batch = batches.get(document)
  if (!batch) {
    batch = { frame: null, reads: new Set() }
    batches.set(document, batch)
  }
  const queue = batch
  let live = true
  const read = (): void => {
    if (!live || !node.isConnected) return
    // Message sites use display:contents. Their section's own box has no usable geometry.
    const range = document.createRange()
    range.selectNodeContents(node)
    const bounds = range.getBoundingClientRect()
    range.detach()
    if (Number.isFinite(bounds.height) && Number.isFinite(bounds.width))
      measured({ height: bounds.height, width: bounds.width })
  }
  const schedule = (): void => {
    if (!live) return
    queue.reads.add(read)
    if (queue.frame !== null) return
    queue.frame = view.requestAnimationFrame(() => {
      queue.frame = null
      const pending = [...queue.reads]
      queue.reads.clear()
      for (const sample of pending) sample()
    })
  }
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule)
  resize?.observe(node)
  // A display:contents section has a zero box; its containing message owns width and height.
  if (node.parentElement) resize?.observe(node.parentElement)
  const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule)
  mutations?.observe(node, { subtree: true, childList: true, characterData: true })
  schedule()
  return () => {
    live = false
    resize?.disconnect()
    mutations?.disconnect()
    queue.reads.delete(read)
    if (queue.frame !== null && queue.reads.size === 0) {
      view.cancelAnimationFrame(queue.frame)
      queue.frame = null
    }
  }
}
