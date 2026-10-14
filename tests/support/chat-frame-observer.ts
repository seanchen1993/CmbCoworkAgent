/** Read-only DOM diagnostics. Does not read storage, IPC, React state or message bodies into logs. */
export function installChatFrameObserver(options: { maxSamples?: number } = {}) {
  const limit = Math.max(30, Math.min(options.maxSamples ?? 6000, 60000))
  const nodes = new WeakMap<Element, number>()
  let nextNode = 0
  let phase = "unspecified"
  let stopped = false
  let frame = 0
  let dropped = 0
  let frames = 0
  let mutations = 0
  let captureMs = 0
  let maxCaptureMs = 0
  let lastSignature = ""
  let styles = new WeakMap<Element, CSSStyleDeclaration>()
  let boxes = new WeakMap<Element, DOMRect>()
  const styleOf = (node: Element) => {
    let style = styles.get(node)
    if (!style) {
      style = getComputedStyle(node)
      styles.set(node, style)
    }
    return style
  }
  const boundsOf = (node: Element): DOMRect => {
    const cached = boxes.get(node)
    if (cached) return cached
    let box = node.getBoundingClientRect()
    if (styleOf(node).display === "contents") {
      const children = Array.from(node.children)
        .filter((child) => styleOf(child).visibility !== "hidden" && styleOf(child).opacity !== "0")
        .map(boundsOf)
        .filter((rect) => rect.width > 0 && rect.height > 0)
      for (const child of node.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNode(child)
        children.push(...Array.from(range.getClientRects()))
      }
      if (children.length) {
        const left = Math.min(...children.map((rect) => rect.left)),
          top = Math.min(...children.map((rect) => rect.top))
        box = new DOMRect(
          left,
          top,
          Math.max(...children.map((rect) => rect.right)) - left,
          Math.max(...children.map((rect) => rect.bottom)) - top
        )
      }
    }
    boxes.set(node, box)
    return box
  }
  const effectiveBounds = (node: Element): DOMRect => {
    const box = boundsOf(node)
    if ((box.width > 0 && box.height > 0) || styleOf(node).display !== "contents") return box
    // A cleared protected contents slot must not disappear from diagnostics merely
    // because it has no box. Its still-visible message row supplies the observation area.
    const host = node.closest("[data-chat-message-row]") ?? node.parentElement
    return host && host !== node ? boundsOf(host) : box
  }
  const nodeId = (node: Element) => {
    let id = nodes.get(node)
    if (id === undefined) nodes.set(node, (id = ++nextNode))
    return id
  }
  const visible = (node: Element, ignoreClipping = false) => {
    const box = effectiveBounds(node)
    const style = styleOf(node)
    if (
      !(
        box.width > 0 &&
        box.height > 0 &&
        !node.closest("[hidden]") &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0"
      )
    )
      return false
    // Virtualized overscan rows can intersect the window while clipped by the chat viewport.
    let left = Math.max(0, box.left),
      right = Math.min(innerWidth, box.right)
    let top = Math.max(0, box.top),
      bottom = Math.min(innerHeight, box.bottom)
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = styleOf(parent)
      if (
        parentStyle.opacity === "0" ||
        parentStyle.display === "none" ||
        parentStyle.visibility === "hidden"
      )
        return false
      const clipX = /hidden|clip|auto|scroll/.test(parentStyle.overflowX)
      const clipY = /hidden|clip|auto|scroll/.test(parentStyle.overflowY)
      if (!ignoreClipping && (clipX || clipY)) {
        const bounds = boundsOf(parent)
        if (clipX) {
          left = Math.max(left, bounds.left)
          right = Math.min(right, bounds.right)
        }
        if (clipY) {
          top = Math.max(top, bounds.top)
          bottom = Math.min(bottom, bounds.bottom)
        }
      }
    }
    return ignoreClipping || (right > left && bottom > top)
  }
  // Non-cryptographic comparison token, not an identity or a reason to merge messages.
  const textToken = (node: Element) => {
    const text = (node as HTMLElement).innerText ?? node.textContent ?? ""
    let hash = 2166136261
    for (let index = 0; index < text.length; index++) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
    }
    return { length: text.length, hash: (hash >>> 0).toString(16) }
  }
  const boxOf = (node: Element) => {
    const box = effectiveBounds(node)
    return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10) / 10)
  }
  const select = (selector: string) =>
    Array.from(document.querySelectorAll(selector)).filter((node) => visible(node))
  const read = () => {
    styles = new WeakMap()
    boxes = new WeakMap()
    const rows = select("[data-chat-message-row]").map((node) => ({
      node: nodeId(node),
      id: node.getAttribute("data-chat-message-id"),
      role: node.getAttribute("data-message-role"),
      text: textToken(node),
      box: boxOf(node)
    }))
    const sites = select("[data-function-site]").map((node) => ({
      node: nodeId(node),
      name: node.getAttribute("data-function-site"),
      messageId:
        node.closest("[data-chat-message-row]")?.getAttribute("data-chat-message-id") ?? null,
      text: textToken(node),
      statuses: Array.from(node.querySelectorAll('[role="status"]')).filter((status) =>
        visible(status)
      ).length,
      childNodes: Array.from(node.children).map(nodeId),
      boundsSource:
        styleOf(node).display === "contents"
          ? boundsOf(node).width > 0
            ? "contents-descendants"
            : "contents-empty-host"
          : "own",
      box: boxOf(node)
    }))
    const clippedSites = Array.from(document.querySelectorAll("[data-function-site]"))
      .filter((node) => !visible(node) && visible(node, true))
      .map((node) => ({
        name: node.getAttribute("data-function-site"),
        messageId:
          node.closest("[data-chat-message-row]")?.getAttribute("data-chat-message-id") ?? null,
        text: textToken(node),
        box: boxOf(node)
      }))
    const bodies = sites.filter(
      (site) => site.name === "AssistantMessage" && site.statuses === 0 && site.text.length > 20
    )
    const sameContentBodyCandidates = bodies.flatMap((site, index) =>
      bodies
        .slice(0, index)
        .filter(
          (prior) =>
            prior.messageId !== site.messageId &&
            prior.text.length === site.text.length &&
            prior.text.hash === site.text.hash
        )
        .map((prior) => ({ ids: [prior.messageId, site.messageId], token: site.text }))
    )
    const composer = select("textarea.composer-textarea").map((node) => ({
      node: nodeId(node),
      box: boxOf(node)
    }))
    const tools = select("[data-function-request-id]").map((node) => ({
      node: nodeId(node),
      id: node.getAttribute("data-function-request-id"),
      messageId:
        node.closest("[data-chat-message-row]")?.getAttribute("data-chat-message-id") ?? null
    }))
    const duplicateRowIds = rows.flatMap((row, index) =>
      row.id && rows.slice(0, index).some((prior) => prior.id === row.id && prior.role === row.role)
        ? [row.id]
        : []
    )
    return {
      phase,
      visibility: document.visibilityState,
      rows,
      sites,
      clippedSites,
      sameContentBodyCandidates,
      composer,
      tools,
      duplicateRowIds: [...new Set(duplicateRowIds)],
      scroll: select("[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]").map(
        (node) => ({ node: nodeId(node), top: node.scrollTop, height: node.scrollHeight })
      ),
      guideVisible: select('[aria-label="新功能导览"]').length > 0
    }
  }
  type Sample = ReturnType<typeof read> & {
    at: number
    lastAt: number
    repeat: number
    source: "frame" | "mutation" | "phase" | "stop"
  }
  const samples: Sample[] = []
  const capture = (source: Sample["source"]) => {
    if (stopped) return
    const started = performance.now()
    const state = read()
    const signature = JSON.stringify(state)
    const elapsed = performance.now() - started
    captureMs += elapsed
    maxCaptureMs = Math.max(maxCaptureMs, elapsed)
    const previous = samples.at(-1)
    if (source === "frame" && previous?.source === "frame" && signature === lastSignature) {
      previous.lastAt = performance.now()
      previous.repeat++
      return
    }
    // Every frame is inspected; identical adjacent frames use repeat/lastAt, while
    // between-frame DOM changes remain separate records rather than painted-frame claims.
    if (source !== "frame" && source !== "stop" && signature === lastSignature) return
    lastSignature = signature
    if (samples.length >= limit) {
      samples.shift()
      dropped++
    }
    const at = performance.now()
    samples.push({ ...state, at, lastAt: at, repeat: 1, source })
  }
  const observer = new MutationObserver(() => {
    mutations++
    capture("mutation")
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "hidden",
      "inert",
      "data-chat-message-id",
      "data-message-role"
    ]
  })
  const tick = () => {
    if (stopped) return
    frames++
    capture("frame")
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return {
    stats() {
      return {
        sampleCount: samples.length,
        frames,
        mutations,
        dropped,
        stopped,
        captureMs,
        maxCaptureMs
      }
    },
    readSamples(offset: number, count = 100) {
      return samples.slice(
        Math.max(0, offset),
        Math.max(0, offset) + Math.max(1, Math.min(count, 500))
      )
    },
    mark(nextPhase: string) {
      phase = nextPhase
      capture("phase")
    },
    snapshot() {
      return { samples: samples.slice(), frames, mutations, dropped, stopped }
    },
    stop() {
      capture("stop")
      stopped = true
      observer.disconnect()
      cancelAnimationFrame(frame)
      return { samples: samples.slice(), frames, mutations, dropped, stopped }
    }
  }
}
