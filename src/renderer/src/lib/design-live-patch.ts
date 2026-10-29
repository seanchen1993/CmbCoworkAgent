export interface DesignLiveDelta {
  nodes: Array<{
    id: string
    attributes: Array<[string, string | null]>
    text?: string
    textSlots?: Array<{ index: number; value: string }>
  }>
  styles: Array<{ id: string; css: string | null }>
  removes?: string[]
}

/** Compare canonical preview documents, never serialize or replace the running DOM. */
export function createDesignLiveDelta(before: string, after: string): DesignLiveDelta | null {
  const parser = new DOMParser()
  const old = parser.parseFromString(before, "text/html"),
    fresh = parser.parseFromString(after, "text/html")
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
    if (
      el.tagName !== original.tagName ||
      el.children.length !== survivingChildren.length ||
      [...el.children].some(
        (child, i) =>
          child.getAttribute("data-design-node") !==
          survivingChildren[i]?.getAttribute("data-design-node")
      )
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
  return { nodes, styles, removes }
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
    const targets: Array<{ el: Element; change: DesignLiveDelta["nodes"][number] }> = []
    for (const change of message.delta.nodes as DesignLiveDelta["nodes"]) {
      const el = [...document.querySelectorAll("[data-design-node]")].find(
        (e) => e.getAttribute("data-design-node") === change.id
      )
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
    const removed = (message.delta.removes ?? []).map((id: string) =>
      [...document.querySelectorAll("[data-design-node]")].find(
        (e) => e.getAttribute("data-design-node") === id
      )
    )
    if (removed.some((el: Element | undefined) => !el)) {
      reply("__design_live_resync")
      return
    }
    const x = window.scrollX,
      y = window.scrollY
    for (const el of removed) el!.remove()
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
        } else el.appendChild(document.createTextNode(change.text))
      }
      for (const slot of change.textSlots ?? []) el.childNodes[slot.index].nodeValue = slot.value
      el.animate?.([{ outline: "2px solid #d97706" }, { outline: "2px solid transparent" }], {
        duration: 700
      })
    }
    for (const style of message.delta.styles as DesignLiveDelta["styles"]) {
      let el = [
        ...document.querySelectorAll<HTMLStyleElement>("style[data-design-patch-style]")
      ].find((e) => e.getAttribute("data-design-patch-style") === style.id)
      if (style.css === null) el?.remove()
      else {
        if (!el) {
          el = document.createElement("style")
          el.setAttribute("data-design-patch-style", style.id)
          document.head.appendChild(el)
        }
        el.textContent = style.css
      }
    }
    root.dataset.designArtifactRevision = String(message.revision)
    requestAnimationFrame(() => {
      window.scrollTo(x, y)
      reply("__design_live_applied")
    })
  })
}
