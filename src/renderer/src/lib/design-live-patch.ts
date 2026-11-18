export interface DesignLiveDelta {
  frameId?: string
  nodes: Array<{
    id: string
    attributes: Array<[string, string | null]>
    text?: string
    textSlots?: Array<{ index: number; value: string }>
  }>
  styles: Array<{ id: string; css: string | null }>
  removes?: string[]
  orders?: Array<{ parentId: string | null; ids: string[] }>
  move?: {
    id: string
    sibling: { id: string; frame: boolean }
    before: boolean
  }
}

/** Compare canonical preview documents, never serialize or replace the running DOM. */
export function createDesignLiveDelta(
  before: string,
  after: string,
  frameTarget?: { frameId: string; nodeId: string }
): DesignLiveDelta | null {
  const parser = new DOMParser()
  const documentFor = (html: string): Document | null => {
    const root = parser.parseFromString(html, "text/html")
    if (!frameTarget) return root
    const documents = [root]
    for (const doc of documents)
      for (const iframe of doc.querySelectorAll("iframe[data-design-frame-preview][srcdoc]")) {
        const source = iframe.getAttribute("srcdoc")!
        if (iframe.getAttribute("data-design-frame-preview") === frameTarget.frameId)
          return parser.parseFromString(source, "text/html")
        if (source.includes("data-design-frame-preview"))
          documents.push(parser.parseFromString(source, "text/html"))
      }
    return null
  }
  const old = documentFor(before), fresh = documentFor(after)
  if (!old || !fresh) return null
  const executable = (doc: Document) =>
    [...doc.querySelectorAll("script")]
      .filter(
        (el) =>
          !el.hasAttribute("data-design-host-runtime") &&
          el.type !== "application/design-tweaks+json"
      )
      .map((el) => el.outerHTML)
  if (JSON.stringify(executable(old)) !== JSON.stringify(executable(fresh))) return null
  const nodes: DesignLiveDelta["nodes"] = []
  const orders: NonNullable<DesignLiveDelta["orders"]> = []
  const previous = new Map(
    [...old.querySelectorAll("[data-design-node]")].map((e) => [
      e.getAttribute("data-design-node")!,
      e
    ])
  )
  const next = new Map(
    [...fresh.querySelectorAll("[data-design-node]")].map((e) => [
      e.getAttribute("data-design-node")!,
      e
    ])
  )
  if ([...next.keys()].some((id) => !previous.has(id))) return null
  const missing = new Set([...previous.keys()].filter((id) => !next.has(id)))
  const removes = [...missing].filter(
    (id) =>
      !previous.get(id)!.parentElement?.closest("[data-design-node]") ||
      !missing.has(
        previous
          .get(id)!
          .parentElement!.closest("[data-design-node]")!
          .getAttribute("data-design-node")!
      )
  )
  for (const [id, el] of next) {
    const original = previous.get(id)!
    const survivingChildren = [...original.children].filter(
      (e) => !missing.has(e.getAttribute("data-design-node") ?? "")
    )
    const childIds = new Set(survivingChildren.map((child) => child.getAttribute("data-design-node")))
    if (
      el.tagName !== original.tagName ||
      el.children.length !== survivingChildren.length ||
      [...el.children].some((child) => !childIds.has(child.getAttribute("data-design-node")))
    )
      return null
    const attributes: Array<[string, string | null]> = []
    for (const name of new Set([...el.attributes, ...original.attributes].map((a) => a.name))) {
      if (el.getAttribute(name) === original.getAttribute(name)) continue
      if (/^on/i.test(name) || name === "id" || name === "data-design-node") return null
      attributes.push([name, el.getAttribute(name)])
    }
    const text =
      !el.children.length && el.textContent !== original.textContent
        ? (el.textContent ?? "")
        : undefined
    const textSlots: Array<{ index: number; value: string }> = []
    if (el.children.length) {
      const beforeNodes = [...original.childNodes]
      const afterNodes = [...el.childNodes]
      if (
        missing.size &&
        JSON.stringify(
          beforeNodes.filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue)
        ) !==
          JSON.stringify(
            afterNodes.filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue)
          )
      )
        return null
      if (!missing.size && beforeNodes.length !== afterNodes.length) return null
      if (!missing.size)
        afterNodes.forEach((node, index) => {
          if (
            node.nodeType === Node.TEXT_NODE &&
            beforeNodes[index]?.nodeType === Node.TEXT_NODE &&
            node.nodeValue !== beforeNodes[index].nodeValue
          )
            textSlots.push({ index, value: node.nodeValue ?? "" })
        })
    }
    if (attributes.length || text !== undefined || textSlots.length)
      nodes.push({ id, attributes, text, textSlots })
  }
  let move: DesignLiveDelta["move"]
  // Move only the edited item. Re-inserting an unaffected sibling that contains
  // an iframe can navigate that iframe even when the outer document stays mounted.
  const moved = frameTarget && next.get(frameTarget.nodeId)
  const priorMoved = frameTarget && previous.get(frameTarget.nodeId)
  const siblingRef = (el: Element | null): { id: string; frame: boolean } | null => {
    const id = el?.getAttribute("data-design-node")
    if (id) return { id, frame: false }
    const frame = el?.getAttribute("data-design-frame-preview")
    return frame ? { id: frame, frame: true } : null
  }
  if (moved && priorMoved) {
    const placement = (el: Element) => {
      let sibling = el.nextElementSibling
      while (sibling && !siblingRef(sibling)) sibling = sibling.nextElementSibling
      if (sibling) return { sibling: siblingRef(sibling)!, before: true }
      sibling = el.previousElementSibling
      while (sibling && !siblingRef(sibling)) sibling = sibling.previousElementSibling
      return sibling ? { sibling: siblingRef(sibling)!, before: false } : undefined
    }
    const desired = placement(moved)
    if (desired && JSON.stringify(desired) !== JSON.stringify(placement(priorMoved)))
      move = { id: frameTarget.nodeId, ...desired }
  }
  for (const parent of [fresh.body, ...next.values()]) {
    const id = parent.getAttribute("data-design-node")
    const prior = id ? previous.get(id)! : old.body
    const ids = [...parent.children]
      .map((e) => e.getAttribute("data-design-node"))
      .filter((v): v is string => !!v)
    const oldIds = [...prior.children]
      .map((e) => e.getAttribute("data-design-node"))
      .filter((v): v is string => !!v && !missing.has(v))
    const oldIdSet = new Set(oldIds)
    if (ids.length !== oldIds.length || ids.some((v) => !oldIdSet.has(v))) return null
    if (ids.some((v, i) => v !== oldIds[i])) {
      if (move && moved && parent === moved.parentElement) {
        const stationary = oldIds.filter((item) => item !== move!.id)
        if (ids.filter((item) => item !== move!.id).some((item, i) => item !== stationary[i]))
          return null
      } else orders.push({ parentId: id, ids })
    }
  }
  const oldStyles = new Map(
    [...old.querySelectorAll("style[data-design-patch-style]")].map((e) => [
      e.getAttribute("data-design-patch-style")!,
      e.textContent ?? ""
    ])
  )
  const newStyles = new Map(
    [...fresh.querySelectorAll("style[data-design-patch-style]")].map((e) => [
      e.getAttribute("data-design-patch-style")!,
      e.textContent ?? ""
    ])
  )
  const styles = [...new Set([...oldStyles.keys(), ...newStyles.keys()])]
    .filter((id) => oldStyles.get(id) !== newStyles.get(id))
    .map((id) => ({ id, css: newStyles.get(id) ?? null }))
  return { nodes, styles, removes, orders, move, frameId: frameTarget?.frameId }
}

/** Closure-free, host-owned runtime. It never evaluates source scripts or replaces interactive nodes. */
export function designLivePatchRuntime(): void {
  const root = document.documentElement
  const instance = root.dataset.designPreviewInstance
  window.addEventListener("message", (event) => {
    const message = event.data
    if (
      event.source !== window.parent ||
      message?.type !== "__design_live_patch" ||
      message.previewInstanceId !== instance
    )
      return
    const reply = (type: string) =>
      window.parent.postMessage(
        {
          type,
          previewInstanceId: instance,
          revision: Number(root.dataset.designArtifactRevision),
          patchId: message.patchId
        },
        "*"
      )
    if (message.revision === Number(root.dataset.designArtifactRevision)) {
      reply("__design_live_applied")
      return
    }
    if (message.baseRevision !== Number(root.dataset.designArtifactRevision)) {
      reply("__design_live_resync")
      return
    }
    const delta = message.delta as DesignLiveDelta
    let targetDocument = document
    if (delta.frameId) {
      const documents = [document]
      let found: Document | undefined
      for (const current of documents) {
        for (const frame of current.querySelectorAll<HTMLIFrameElement>(
          "iframe[data-design-frame-preview][srcdoc]"
        )) {
          const child = frame.contentDocument
          if (child?.URL !== "about:srcdoc") continue
          if (frame.getAttribute("data-design-frame-preview") === delta.frameId) found = child
          else documents.push(child)
        }
        if (found) break
      }
      if (!found) {
        reply("__design_live_resync")
        return
      }
      targetDocument = found
    }
    const nodes = new Map<string, Element | null>()
    for (const el of targetDocument.querySelectorAll("[data-design-node]")) {
      const id = el.getAttribute("data-design-node")!
      nodes.set(id, nodes.has(id) ? null : el)
    }
    const targets: Array<{ el: Element; change: DesignLiveDelta["nodes"][number] }> = []
    for (const change of delta.nodes) {
      const el = nodes.get(change.id)
      if (
        !el ||
        (change.text !== undefined && el.children.length) ||
        change.textSlots?.some((slot) => el.childNodes[slot.index]?.nodeType !== Node.TEXT_NODE)
      ) {
        reply("__design_live_resync")
        return
      }
      targets.push({ el, change })
    }
    const removed = (delta.removes ?? []).map((id) => nodes.get(id))
    if (removed.some((el) => !el)) {
      reply("__design_live_resync")
      return
    }
    const targetWindow = targetDocument.defaultView
    const x = targetWindow?.scrollX ?? 0
    const y = targetWindow?.scrollY ?? 0
    const reorders: Array<{ parent: Element; children: Element[] }> = []
    for (const order of delta.orders ?? []) {
      const parent = order.parentId ? nodes.get(order.parentId) : targetDocument.body
      const children = order.ids.map((id) => nodes.get(id))
      if (!parent || children.some((el) => el?.parentElement !== parent)) {
        reply("__design_live_resync")
        return
      }
      reorders.push({ parent, children: children as Element[] })
    }
    let placement: { item: Element; sibling: Element; before: boolean } | undefined
    if (delta.move) {
      const item = nodes.get(delta.move.id)
      const sibling = delta.move.sibling.frame
        ? [...(item?.parentElement?.children ?? [])].find(
            (el) => el.getAttribute("data-design-frame-preview") === delta.move!.sibling.id
          )
        : nodes.get(delta.move.sibling.id)
      if (!item?.parentElement || !sibling || item.parentElement !== sibling.parentElement) {
        reply("__design_live_resync")
        return
      }
      placement = { item, sibling, before: delta.move.before }
    }
    for (const el of removed) el!.remove()
    for (const { parent, children } of reorders) {
      const changed = new Set(children)
      const current = [...parent.children].filter((el) => changed.has(el))
      if (current.every((el, i) => el === children[i])) continue
      const slots = current
        .map((el) => {
          const slot = targetDocument.createComment("design-move")
          el.before(slot)
          return slot
        })
      slots.forEach((slot, i) => slot.replaceWith(children[i]))
    }
    if (placement) {
      const { item, sibling, before } = placement
      if (before ? sibling.previousElementSibling !== item : sibling.nextElementSibling !== item) {
        if (before) sibling.before(item)
        else sibling.after(item)
      }
    }
    for (const { el, change } of targets) {
      for (const [name, value] of change.attributes) {
        if (value === null) el.removeAttribute(name)
        else el.setAttribute(name, value)
      }
      if (change.text !== undefined) {
        const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)
        if (text) {
          text.nodeValue = change.text
          for (const n of [...el.childNodes])
            if (n !== text && n.nodeType === Node.TEXT_NODE) n.remove()
        } else el.appendChild(targetDocument.createTextNode(change.text))
      }
      for (const slot of change.textSlots ?? []) el.childNodes[slot.index].nodeValue = slot.value
      el.animate?.([{ outline: "2px solid #d97706" }, { outline: "2px solid transparent" }], {
        duration: 700
      })
    }
    for (const style of delta.styles) {
      let el = [
        ...targetDocument.querySelectorAll<HTMLStyleElement>("style[data-design-patch-style]")
      ].find((e) => e.getAttribute("data-design-patch-style") === style.id)
      if (style.css === null) el?.remove()
      else {
        if (!el) {
          el = targetDocument.createElement("style")
          el.setAttribute("data-design-patch-style", style.id)
          targetDocument.head.appendChild(el)
        }
        el.textContent = style.css
      }
    }
    root.dataset.designArtifactRevision = String(message.revision)
    requestAnimationFrame(() => {
      targetWindow?.scrollTo({ left: x, top: y, behavior: "instant" })
      reply("__design_live_applied")
    })
  })
}
