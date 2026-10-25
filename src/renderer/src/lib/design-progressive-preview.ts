import { DESIGN_TWEAKS_RUNTIME } from "../../../shared/design-tweaks"
import { designLivePatchRuntime } from "./design-live-patch"

export interface DesignSectionPatch {
  sections: Array<{ id: string; html: string }>
  head: string
  bodyAttributes: Array<[string, string]>
  htmlAttributes: Array<[string, string]>
}

/** Section deltas cover the common path; topology changes use a complete inert snapshot. */
export function createDesignSectionPatch(
  previousHtml: string,
  nextHtml: string
): DesignSectionPatch | null {
  const parser = new DOMParser()
  const previous = parser.parseFromString(sanitizeDesignDraft(previousHtml), "text/html")
  const next = parser.parseFromString(sanitizeDesignDraft(nextHtml), "text/html")
  const topSections = (doc: Document) =>
    [...doc.querySelectorAll<HTMLElement>("[data-design-section]")].filter(
      (el) => !el.parentElement?.closest("[data-design-section]")
    )
  const old = topSections(previous),
    fresh = topSections(next)
  if (
    !fresh.length ||
    old.length !== fresh.length ||
    fresh.some((el, index) => el.dataset.designSection !== old[index].dataset.designSection)
  )
    return null
  const sections = fresh
    .filter((el, index) => !el.isEqualNode(old[index]))
    .map((el) => ({ id: el.dataset.designSection!, html: el.outerHTML }))
  const shell = (doc: Document) => {
    const body = doc.body.cloneNode(true) as HTMLElement
    body.querySelectorAll("[data-design-section]").forEach((el) => {
      const slot = doc.createElement("template")
      slot.dataset.designSlot = el.getAttribute("data-design-section")!
      el.replaceWith(slot)
    })
    return body.innerHTML
  }
  if (shell(previous) !== shell(next)) return null
  return {
    sections,
    head: next.head.innerHTML,
    bodyAttributes: [...next.body.attributes].map((a) => [a.name, a.value]),
    htmlAttributes: [...next.documentElement.attributes].map((a) => [a.name, a.value])
  }
}

/** Only this host-owned code executes in a draft. Source business scripts wait for finalization. */
function draftRuntime(): void {
  const root = document.documentElement
  const instance = root.dataset.designPreviewInstance
  let revision = Number(root.dataset.designPreviewRevision)
  const runId = root.dataset.designPreviewRun
  document.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]")
      if (link && !link.getAttribute("href")?.startsWith("#")) event.preventDefault()
    },
    true
  )
  document.addEventListener("submit", (event) => event.preventDefault(), true)
  const owned = (node: Node) =>
    node instanceof Element && node.hasAttribute("data-design-host-runtime")
  const key = (node: Node): string | null =>
    node instanceof Element
      ? node.getAttribute("data-design-section")
        ? "section:" + node.getAttribute("data-design-section")
        : node.id
          ? "id:" + node.id
          : null
      : null
  function sync(current: Node, next: Node): void {
    if (current.isEqualNode(next)) return
    if (current instanceof Element && next instanceof Element) {
      for (const attr of [...current.attributes])
        if (!next.hasAttribute(attr.name) && !attr.name.startsWith("data-design-preview"))
          current.removeAttribute(attr.name)
      for (const attr of [...next.attributes])
        if (
          !attr.name.startsWith("data-design-preview") &&
          current.getAttribute(attr.name) !== attr.value
        )
          current.setAttribute(attr.name, attr.value)
    } else if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
      current.nodeValue = next.nodeValue
      return
    }
    const previous = [...current.childNodes].filter((node) => !owned(node))
    const desired = [...next.childNodes].filter((node) => !owned(node))
    const used = new Set<Node>()
    let before: Node | null = null
    for (let index = 0; index < desired.length; index++) {
      const source = desired[index],
        sourceKey = key(source)
      let target: Node | undefined = sourceKey
        ? previous.find(
            (node) =>
              !used.has(node) && key(node) === sourceKey && node.nodeName === source.nodeName
          )
        : previous[index]
      if (
        !target ||
        used.has(target) ||
        key(target) !== sourceKey ||
        target.nodeName !== source.nodeName
      )
        target = source.cloneNode(true)
      const insertion: ChildNode | null = before ? before.nextSibling : current.firstChild
      if (insertion !== target) current.insertBefore(target, insertion)
      used.add(target)
      sync(target, source)
      before = target
    }
    for (const old of previous)
      if (!used.has(old) && old.parentNode === current) current.removeChild(old)
  }
  window.addEventListener("message", (event) => {
    const message = event.data
    if (
      event.source !== window.parent ||
      !message ||
      message.type !== "__design_preview_update" ||
      message.previewInstanceId !== instance ||
      message.runId !== runId
    )
      return
    if (message.baseRevision !== null && message.baseRevision !== revision) {
      window.parent.postMessage(
        { type: "__design_preview_resync", previewInstanceId: instance, revision },
        "*"
      )
      return
    }
    if (message.revision < revision) return
    const x = window.scrollX,
      y = window.scrollY
    const parser = new DOMParser()
    const parsed = parser.parseFromString(
      message.html ?? document.documentElement.outerHTML,
      "text/html"
    )
    if (message.patch) {
      parsed.head.innerHTML = message.patch.head
      const setAttributes = (el: Element, attrs: Array<[string, string]>) => {
        for (const attr of [...el.attributes]) el.removeAttribute(attr.name)
        for (const [name, value] of attrs) el.setAttribute(name, value)
      }
      setAttributes(parsed.body, message.patch.bodyAttributes)
      setAttributes(parsed.documentElement, message.patch.htmlAttributes)
      for (const section of message.patch.sections) {
        const target = [...parsed.querySelectorAll("[data-design-section]")].find(
          (el) => el.getAttribute("data-design-section") === section.id
        )
        const replacement = parser.parseFromString(section.html, "text/html").body.firstElementChild
        if (
          !target ||
          !replacement ||
          replacement.getAttribute("data-design-section") !== section.id
        ) {
          window.parent.postMessage(
            { type: "__design_preview_resync", previewInstanceId: instance, revision },
            "*"
          )
          return
        }
        target.replaceWith(replacement)
      }
    }
    // Defense in depth for the host's inert draft document, including event attributes.
    parsed
      .querySelectorAll(
        'script:not([type="application/design-tweaks+json"]),iframe,object,embed,meta[http-equiv]'
      )
      .forEach((el) => el.remove())
    parsed.querySelectorAll("*").forEach((el) =>
      [...el.attributes].forEach((attr) => {
        if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value.trim()))
          el.removeAttribute(attr.name)
      })
    )
    sync(document.head, parsed.head)
    sync(document.body, parsed.body)
    for (const attr of [...root.attributes])
      if (
        !attr.name.startsWith("data-design-preview") &&
        !parsed.documentElement.hasAttribute(attr.name)
      )
        root.removeAttribute(attr.name)
    for (const attr of [...parsed.documentElement.attributes])
      if (!attr.name.startsWith("data-design-preview")) root.setAttribute(attr.name, attr.value)
    revision = message.revision
    root.dataset.designPreviewRevision = String(revision)
    ;(
      window as unknown as { __designApplyTweaks?: (values: object) => void }
    ).__designApplyTweaks?.(message.keys ?? {})
    requestAnimationFrame(() => {
      window.scrollTo(x, y)
      window.parent.postMessage(
        { type: "__design_preview_applied", previewInstanceId: instance, runId, revision },
        "*"
      )
    })
  })
  window.parent.postMessage(
    { type: "__design_preview_ready", previewInstanceId: instance, runId, revision },
    "*"
  )
}

export function sanitizeDesignDraft(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc
    .querySelectorAll(
      'script:not([type="application/design-tweaks+json"]),iframe,object,embed,meta[http-equiv]'
    )
    .forEach((el) => el.remove())
  doc.querySelectorAll("*").forEach((el) =>
    [...el.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value.trim()))
        el.removeAttribute(attr.name)
    })
  )
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML
}

export function buildDesignFrameDocument(
  html: string,
  instance: string,
  draft?: { runId: string; revision: number },
  artifactRevision = 0
): string {
  const doc = new DOMParser().parseFromString(draft ? sanitizeDesignDraft(html) : html, "text/html")
  doc.documentElement.dataset.designPreviewInstance = instance
  doc.documentElement.dataset.designArtifactRevision = String(artifactRevision)
  if (draft) {
    doc.documentElement.dataset.designPreviewRun = draft.runId
    doc.documentElement.dataset.designPreviewRevision = String(draft.revision)
    const script = doc.createElement("script")
    script.setAttribute("data-design-host-runtime", "")
    script.textContent = DESIGN_TWEAKS_RUNTIME + ";(" + draftRuntime.toString() + ")();"
    doc.body.appendChild(script)
  } else {
    const script = doc.createElement("script")
    script.setAttribute("data-design-host-runtime", "")
    script.textContent = ";(" + designLivePatchRuntime.toString() + ")();"
    doc.body.appendChild(script)
  }
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML
}
