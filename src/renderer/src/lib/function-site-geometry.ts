export interface FunctionSiteGeometry {
  height: number
  width: number
}

interface GeometryBatch {
  frame: number | null
  reads: Set<{
    read(): FunctionSiteGeometry | undefined
    publish(value: FunctionSiteGeometry): void
  }>
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
  const read = (): FunctionSiteGeometry | undefined => {
    if (!live || !node.isConnected) return
    // Message sites use display:contents. Their section's own box has no usable geometry.
    const range = document.createRange()
    range.selectNodeContents(node)
    const bounds = range.getBoundingClientRect()
    range.detach()
    if (Number.isFinite(bounds.height) && Number.isFinite(bounds.width))
      return { height: bounds.height, width: bounds.width }
    return undefined
  }
  const sample = {
    read,
    publish: (value: FunctionSiteGeometry) => {
      if (live && node.isConnected) measured(value)
    }
  }
  const schedule = (): void => {
    if (!live) return
    queue.reads.add(sample)
    if (queue.frame !== null) return
    queue.frame = view.requestAnimationFrame(() => {
      queue.frame = null
      const pending = [...queue.reads]
      queue.reads.clear()
      // A subscriber may set React state or write styles. Finish every layout
      // read before publishing any value, instead of read/write/read interleaving.
      const values = pending.map((sample) => ({ sample, value: sample.read() }))
      for (const { sample, value } of values) if (value) sample.publish(value)
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
    queue.reads.delete(sample)
    if (queue.frame !== null && queue.reads.size === 0) {
      view.cancelAnimationFrame(queue.frame)
      queue.frame = null
    }
  }
}
