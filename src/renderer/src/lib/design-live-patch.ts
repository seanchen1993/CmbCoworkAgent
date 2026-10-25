export interface DesignLiveDelta {
  nodes: Array<{ id: string; attributes: Array<[string, string | null]>; text?: string }>
  styles: Array<{ id: string; css: string | null }>
}

/** Compare canonical preview documents, never serialize or replace the running DOM. */
export function createDesignLiveDelta(before: string, after: string): DesignLiveDelta | null {
  const parser = new DOMParser()
  const old = parser.parseFromString(before, "text/html"),
    fresh = parser.parseFromString(after, "text/html")
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
  if (previous.size !== next.size || [...previous.keys()].some((id) => !next.has(id))) return null
  for (const [id, el] of next) {
    const original = previous.get(id)!
    if (el.tagName !== original.tagName || el.children.length !== original.children.length)
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
    if (attributes.length || text !== undefined) nodes.push({ id, attributes, text })
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
  return { nodes, styles }
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
      if (!el || (change.text !== undefined && el.children.length)) {
        reply("__design_live_resync")
        return
      }
      targets.push({ el, change })
    }
    const x = window.scrollX,
      y = window.scrollY
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
