export interface FunctionSiteGeometry {
  height: number
  width: number
  /** Allocated width, including display:contents slots whose own box is zero. */
  layoutWidth: number
}

interface GeometryBatch {
  frame: number | null
  resize?: ResizeObserver
  targets: Map<Element, Set<() => void>>
  reads: Set<{
    read(layoutWidths: Map<HTMLElement, number>): FunctionSiteGeometry | undefined
    publish(value: FunctionSiteGeometry): void
  }>
}

const batches = new WeakMap<Document, GeometryBatch>()

/** Bubble width can shrink to its skeleton; the virtual row owns the stable allocation. */
export function functionSiteLayoutContainer(node: HTMLElement): HTMLElement | null {
  return node.closest<HTMLElement>("[data-chat-message-row]") ??
    (node.clientWidth ? node : node.parentElement)
}

/** Measure mounted drawings together, outside React's interleaved deletion/layout phase. */
export function observeFunctionSiteGeometry(
  node: HTMLElement,
  measured: (geometry: FunctionSiteGeometry) => void,
  observeScroll = false
): () => void {
  const document = node.ownerDocument
  const view = document.defaultView
  if (!view) return () => {}
  let batch = batches.get(document)
  if (!batch) {
    batch = { frame: null, targets: new Map(), reads: new Set() }
    batches.set(document, batch)
  }
  const queue = batch
  let live = true
  const read = (layoutWidths: Map<HTMLElement, number>): FunctionSiteGeometry | undefined => {
    if (!live || !node.isConnected) return
    // Message sites use display:contents. Their section's own box has no usable geometry.
    const range = document.createRange()
    range.selectNodeContents(node)
    const bounds = range.getBoundingClientRect()
    range.detach()
    if (Number.isFinite(bounds.height) && Number.isFinite(bounds.width)) {
      const layout = functionSiteLayoutContainer(node)
      let layoutWidth = layout ? layoutWidths.get(layout) : undefined
      if (layout && layoutWidth === undefined) {
        layoutWidth = layout.clientWidth
        layoutWidths.set(layout, layoutWidth)
      }
      return { height: bounds.height, width: bounds.width, layoutWidth: layoutWidth || bounds.width }
    }
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
      const layoutWidths = new Map<HTMLElement, number>()
      const values = pending.map((sample) => ({ sample, value: sample.read(layoutWidths) }))
      for (const { sample, value } of values) if (value) sample.publish(value)
    })
  }
  const targets = node.parentElement ? [node, node.parentElement] : [node]
  if (typeof ResizeObserver !== "undefined") {
    // Adjacent sites in a virtual row can share a containing message. Keep the
    // box observed until the final subscriber detaches.
    const resize = queue.resize ??= new ResizeObserver(entries => {
      for (const { target } of entries)
        for (const notify of queue.targets.get(target) ?? []) notify()
    })
    for (const target of targets) {
      const subscribers = queue.targets.get(target)
      if (subscribers) subscribers.add(schedule)
      else {
        queue.targets.set(target, new Set([schedule]))
        resize.observe(target)
      }
    }
  }
  const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule)
  mutations?.observe(node, { subtree: true, childList: true, characterData: true })
  const viewport = observeScroll ? node.closest<HTMLElement>("[data-radix-scroll-area-viewport]") : null
  viewport?.addEventListener("scroll", schedule, { passive: true })
  schedule()
  return () => {
    live = false
    for (const target of targets) {
      const subscribers = queue.targets.get(target)
      if (!subscribers?.delete(schedule) || subscribers.size > 0) continue
      queue.targets.delete(target)
      queue.resize?.unobserve(target)
    }
    if (queue.targets.size === 0) {
      queue.resize?.disconnect()
      queue.resize = undefined
    }
    mutations?.disconnect()
    viewport?.removeEventListener("scroll", schedule)
    queue.reads.delete(sample)
    if (queue.frame !== null && queue.reads.size === 0) {
      view.cancelAnimationFrame(queue.frame)
      queue.frame = null
    }
  }
}
