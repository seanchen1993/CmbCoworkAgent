interface WidthRead {
  read(): number | undefined
  publish(width: number): void
}

interface WidthBatch {
  frame: number | null
  reads: Set<WidthRead>
}

const batches = new WeakMap<Document, WidthBatch>()

/** Reserve pending rows with a read phase followed by a write phase, never per-row reflow. */
export function observeFunctionSiteLayoutWidth(
  node: HTMLElement,
  measured: (width: number) => void
): { refresh(): void; dispose(): void } {
  const document = node.ownerDocument
  const view = document.defaultView
  if (!view) return { refresh: () => {}, dispose: () => {} }
  let batch = batches.get(document)
  if (!batch) {
    batch = { frame: null, reads: new Set() }
    batches.set(document, batch)
  }
  const queue = batch
  let live = true
  const sample: WidthRead = {
    read: () => {
      if (!live || !node.isConnected) return
      const width = node.clientWidth
      return Number.isFinite(width) && width >= 0 ? width : undefined
    },
    publish: (width) => {
      if (live && node.isConnected) measured(width)
    }
  }
  const refresh = (): void => {
    if (!live) return
    queue.reads.add(sample)
    if (queue.frame !== null) return
    queue.frame = view.requestAnimationFrame(() => {
      queue.frame = null
      const pending = [...queue.reads]
      queue.reads.clear()
      const values = pending.map((read) => ({ read, width: read.read() }))
      for (const { read, width } of values) if (width !== undefined) read.publish(width)
    })
  }
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh)
  observer?.observe(node)
  refresh()
  return {
    refresh,
    dispose: () => {
      live = false
      observer?.disconnect()
      queue.reads.delete(sample)
      if (queue.frame !== null && queue.reads.size === 0) {
        view.cancelAnimationFrame(queue.frame)
        queue.frame = null
      }
    }
  }
}
