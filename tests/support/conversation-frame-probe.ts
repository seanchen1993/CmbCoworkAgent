/** Diagnostic-only rAF/DOM trace. This is intentionally separate from timing benchmarks. */
export function installConversationFrameProbe(markers: string[]): void {
  const ids = new WeakMap<Node, number>()
  let sequence = 0
  const id = (node: Node | null): number | null => {
    if (!node) return null
    if (!ids.has(node)) ids.set(node, ++sequence)
    return ids.get(node)!
  }
  const describe = (element: Element | null) =>
    element
      ? {
          id: id(element),
          tag: element.tagName,
          class: element.className,
          site: element.getAttribute("data-function-site"),
          messageId: element.getAttribute("data-chat-message-id"),
          role: element.getAttribute("data-message-role"),
          item: element.getAttribute("data-item-index") ?? element.getAttribute("data-index")
        }
      : null
  const geometry = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      ...describe(element),
      connected: element.isConnected,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity
    }
  }
  const inspect = (marker: string) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? ""
      const offset = text.indexOf(marker)
      if (offset < 0 || !node.parentElement || node.parentElement.closest("script,style")) continue
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + marker.length)
      const rect = range.getBoundingClientRect()
      let left = Math.max(0, rect.left),
        top = Math.max(0, rect.top)
      let right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom)
      let hidden = false
      const ancestors = []
      for (let parent: Element | null = node.parentElement; parent; parent = parent.parentElement) {
        if (ancestors.length < 7) ancestors.push(describe(parent))
        const style = getComputedStyle(parent)
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        )
          hidden = true
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) {
          const box = parent.getBoundingClientRect()
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, box.left)
            right = Math.min(right, box.right)
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, box.top)
            bottom = Math.min(bottom, box.bottom)
          }
        }
      }
      const parent = node.parentElement
      return {
        marker,
        present: true,
        visible: !hidden && right > left && bottom > top,
        node: id(node),
        parent: describe(parent),
        site: describe(parent.closest("[data-function-site]")),
        row: describe(parent.closest("[data-item-index],[data-index]")),
        ancestors,
        textLength: text.length,
        children: parent.childNodes.length,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        clipped: { left, top, right, bottom },
        hidden
      }
    }
    return { marker, present: false, visible: false }
  }
  const samples: unknown[] = []
  const mutations: unknown[] = []
  const start = performance.now()
  let stopped = false,
    frame = 0
  const sample = (reason: string) => {
    if (stopped || samples.length >= 16000 || performance.now() - start > 120000) return
    const rows = [...document.querySelectorAll("[data-chat-message-row]")]
    samples.push({
      time: Date.now(),
      monotonic: performance.now(),
      reason,
      documentVisible: document.visibilityState === "visible",
      viewport: { width: innerWidth, height: innerHeight },
      list: {
        rows: rows.map(describe),
        count: rows.length,
        first: describe(rows[0] ?? null),
        last: describe(rows.at(-1) ?? null),
        regions: [
          ...document.querySelectorAll(
            "[data-chat-message-scroll-area], [data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
          )
        ].map(geometry),
        containers: [
          ...document.querySelectorAll(
            '[data-virtuoso-scroller],[data-testid="virtuoso-item-list"]'
          )
        ].map(geometry)
      },
      markers: markers.filter(Boolean).map(inspect),
      sites: [...document.querySelectorAll("[data-function-site]")].map((element) => ({
        ...describe(element),
        busy: element.getAttribute("aria-busy"),
        textLength: element.textContent?.length,
        children: element.childNodes.length,
        skeletons: element.querySelectorAll('[class*="animate-pulse"]').length,
        slow: element.textContent?.includes("内容加载较慢") ?? false
      }))
    })
  }
  const observer = new MutationObserver((records) => {
    if (stopped) return
    if (mutations.length < 16000) {
      const relevant = records
        .flatMap((record) => {
          const nodes = [...record.removedNodes, ...record.addedNodes]
          const matches = nodes.filter((node) =>
            markers.some((marker) => marker && node.textContent?.includes(marker))
          )
          if (!matches.length && record.type !== "characterData") return []
          return [
            {
              type: record.type,
              target: id(record.target),
              nodes: matches.map((node) => ({
                id: id(node),
                connected: node.isConnected,
                removed: [...record.removedNodes].includes(node),
                markers: markers.filter((marker) => marker && node.textContent?.includes(marker))
              }))
            }
          ]
        })
        .slice(0, 64)
      if (relevant.length) mutations.push({ time: Date.now(), records: relevant })
    }
    sample("mutation")
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-busy", "inert"]
  })
  const tick = () => {
    sample("raf")
    if (!stopped && performance.now() - start <= 120000) frame = requestAnimationFrame(tick)
  }
  sample("start")
  frame = requestAnimationFrame(tick)
  ;(window as unknown as { __stabilityFrameProbe: { stop(): unknown } }).__stabilityFrameProbe = {
    stop() {
      sample("stop")
      stopped = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      return {
        samples,
        mutations,
        limitReached: samples.length >= 16000 || performance.now() - start > 120000
      }
    }
  }
}
