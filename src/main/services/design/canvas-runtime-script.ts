import { DESIGN_TWEAKS_RUNTIME } from "../../../shared/design-tweaks"
import { DESIGN_PREVIEW_NAVIGATION_SCRIPT } from "../../../renderer/src/lib/design-preview-navigation"
import { designLivePatchRuntime } from "../../../renderer/src/lib/design-live-patch"
import { designDirectEditRuntime } from "../../../renderer/src/lib/design-direct-edit-runtime"
import { draftRuntime } from "../../../renderer/src/lib/design-progressive-preview"

/** Closure-free host bridge executed inside the single-layer cross-origin canvas iframe. */
function designCanvasBridge(
  tweaksCode: string,
  navCode: string,
  livePatchFnSource: string,
  draftFnSource: string,
  directEditFnSource: string
): void {
  const w = window as unknown as {
    __cmbCanvasInstalled?: boolean
    __designEditor?: {
      update: (doc: unknown, mode?: string) => void
      cleanup: () => void
      flush: () => Promise<void>
      editSelected: () => void
      deleteSelected: () => void
      clearSelection: () => void
      takeCommand: () => unknown
    }
  }
  if (w.__cmbCanvasInstalled) return
  w.__cmbCanvasInstalled = true

  const root = document.documentElement
  const previewInstanceId = root.dataset.designPreviewInstance || ""
  const isDraft = root.dataset.designPreviewDraft === "1"

  const runCode = (code: string) => {
    try {
      ;(0, eval)(code)
    } catch (error) {
      console.error("[DesignCanvas] runtime eval failed:", error)
    }
  }

  runCode(tweaksCode)

  if (isDraft) {
    runCode(";(" + draftFnSource + ")();")
  } else {
    runCode(navCode)
    runCode(";(" + livePatchFnSource + ")();")
  }

  const installDirectEdit = new Function("return (" + directEditFnSource + ")")() as (
    initial: unknown,
    initialMode?: string,
    frameId?: string,
    frameDepth?: number,
    previewInstance?: string
  ) => void

  const postToParent = (payload: Record<string, unknown>) => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ previewInstanceId, ...payload }, "*")
    }
  }

  const measureDocument = () => {
    const de = document.documentElement
    const body = document.body
    const width = Math.max(
      de ? de.scrollWidth : 0,
      body ? body.scrollWidth : 0,
      de ? de.offsetWidth : 0,
      body ? body.offsetWidth : 0,
      window.innerWidth || 0
    )
    const height = Math.max(
      de ? de.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      de ? de.offsetHeight : 0,
      body ? body.offsetHeight : 0,
      window.innerHeight || 0
    )
    return {
      x: window.scrollX || 0,
      y: window.scrollY || 0,
      width,
      height,
      viewportW: window.innerWidth || 0,
      viewportH: window.innerHeight || 0
    }
  }

  const reportScroll = () => {
    const m = measureDocument()
    postToParent({
      type: "__iframe_scroll",
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
      viewportW: m.viewportW,
      viewportH: m.viewportH
    })
  }

  let scrollQueued = false
  const scheduleScrollReport = () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      reportScroll()
      scheduleAnnotationResolve()
    })
  }

  window.addEventListener("scroll", scheduleScrollReport, { passive: true })
  window.addEventListener("resize", scheduleScrollReport)
  const startObservers = () => {
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(scheduleScrollReport)
      ro.observe(document.documentElement)
      if (document.body) ro.observe(document.body)
    }
    const m = measureDocument()
    postToParent({
      type: "__design_canvas_ready",
      scrollX: m.x,
      scrollY: m.y,
      contentW: m.width,
      contentH: m.height,
      viewportW: m.viewportW,
      viewportH: m.viewportH,
      artifactRevision: Number(root.dataset.designArtifactRevision || 0)
    })
    reportScroll()
  }

  // ── Element Anchoring & Geometry (for comments, draw, and patches) ──
  const getDrawElementLabel = (element: Element | null): string => {
    if (!element) return ""
    if (element === document.documentElement || element === document.body) return "page"
    const tag = element.tagName.toLowerCase()
    const id = element.id ? `#${element.id}` : ""
    const classes = Array.from(element.classList || [])
      .filter((c) => !c.startsWith("__"))
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join("")
    const label = element.getAttribute("aria-label") || element.getAttribute("alt") || ""
    const text = (label || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)
    return `${tag}${id}${classes}${text ? ` '${text}'` : ""}`
  }

  const getElementTextSignature = (element: Element): string =>
    (element.getAttribute("aria-label") || element.getAttribute("alt") || element.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 48)

  const getScreenLabelForElement = (element: Element): string | undefined => {
    const screen = element.closest("[data-screen-label],[data-design-anchor],[data-dm-screen]")
    return (
      screen?.getAttribute("data-screen-label") ||
      screen?.getAttribute("data-design-anchor") ||
      screen?.getAttribute("data-dm-screen") ||
      undefined
    )
  }

  const escapeCssIdent = (value: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")

  const attrSelector = (element: Element, attr: string, value: string): string =>
    `${element.tagName.toLowerCase()}[${attr}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`

  const buildElementSelector = (element: Element): string => {
    const preferredAttrs = [
      "data-design-anchor",
      "data-screen-label",
      "data-dm-ref",
      "data-cc-id",
      "aria-label",
      "role"
    ]
    for (const attr of preferredAttrs) {
      const value = element.getAttribute(attr)
      if (value) {
        const selector = attrSelector(element, attr, value)
        if (document.querySelectorAll(selector).length === 1) return selector
      }
    }
    if (element.id) {
      const selector = `#${escapeCssIdent(element.id)}`
      if (document.querySelectorAll(selector).length === 1) return selector
    }
    const parts: string[] = []
    let current: Element | null = element
    while (current && current !== document.documentElement && current !== document.body) {
      let part = current.tagName.toLowerCase()
      const anchorAttr = ["data-design-anchor", "data-screen-label", "data-dm-ref", "data-cc-id"]
        .map((attr) => ({ attr, value: current?.getAttribute(attr) || "" }))
        .find((item) => item.value)
      if (anchorAttr && current) {
        parts.unshift(attrSelector(current, anchorAttr.attr, anchorAttr.value))
        break
      }
      if (current.id) {
        part += `#${escapeCssIdent(current.id)}`
        parts.unshift(part)
        break
      }
      const className = Array.from(current.classList)
        .filter((value) => value && !value.startsWith("__"))
        .slice(0, 2)
        .map((value) => `.${escapeCssIdent(value)}`)
        .join("")
      part += className
      const parent: Element | null = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current?.tagName
        )
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
      parts.unshift(part)
      current = parent
      if (parts.length >= 5) break
    }
    return parts.join(" > ")
  }

  const elementAtPagePoint = (point: { x: number; y: number }): Element | null => {
    const vx = point.x - (window.scrollX || 0)
    const vy = point.y - (window.scrollY || 0)
    const el = document.elementFromPoint(vx, vy)
    if (
      !el ||
      el === document.body ||
      el === document.documentElement ||
      el.localName === "iframe" ||
      el.closest("[data-design-host-runtime]")
    ) {
      return null
    }
    return el
  }

  const pageRectForElement = (el: Element) => {
    const r = el.getBoundingClientRect()
    return {
      x: r.left + (window.scrollX || 0),
      y: r.top + (window.scrollY || 0),
      width: r.width,
      height: r.height
    }
  }

  const getPointAnchor = (point: { x: number; y: number }) => {
    const element = elementAtPagePoint(point)
    if (!element) return undefined
    const rect = pageRectForElement(element)
    if (rect.width <= 0 || rect.height <= 0) return undefined
    const nodeId = element.getAttribute("data-design-node")
    return {
      nodeId: nodeId || undefined,
      sectionId:
        element.closest("[data-design-section]")?.getAttribute("data-design-section") || undefined,
      artifactRevision: Number(root.dataset.designArtifactRevision || 0),
      selector: buildElementSelector(element),
      tagName: element.tagName.toLowerCase(),
      label: getDrawElementLabel(element),
      role: element.getAttribute("role") || undefined,
      text: getElementTextSignature(element) || undefined,
      screenLabel: getScreenLabelForElement(element),
      offsetXRatio: Math.min(1, Math.max(0, (point.x - rect.x) / rect.width)),
      offsetYRatio: Math.min(1, Math.max(0, (point.y - rect.y) / rect.height))
    }
  }

  const getDominantPointAnchor = (points: Array<{ x: number; y: number }>) => {
    if (!points.length) return undefined
    const sampleCount = Math.min(8, points.length)
    const step = Math.max(1, Math.floor(points.length / sampleCount))
    const anchors = points
      .filter((_, index) => index % step === 0)
      .slice(0, sampleCount)
      .map(getPointAnchor)
      .filter((a): a is NonNullable<ReturnType<typeof getPointAnchor>> => Boolean(a))
    if (!anchors.length) return undefined
    const counts = new Map<string, { anchor: NonNullable<ReturnType<typeof getPointAnchor>>; count: number }>()
    for (const anchor of anchors) {
      const key = anchor.nodeId || anchor.selector || anchor.label || `${anchor.tagName}:${anchor.text || ""}`
      const cur = counts.get(key)
      counts.set(key, { anchor, count: (cur?.count ?? 0) + 1 })
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count)[0]?.anchor
  }

  const collectDrawElementLabels = (points: Array<{ x: number; y: number }>): string[] => {
    if (!points.length) return []
    const sampleCount = Math.min(6, points.length)
    const step = Math.max(1, Math.floor(points.length / sampleCount))
    const sampled = points.filter((_, index) => index % step === 0).slice(0, sampleCount)
    const seen = new Set<string>()
    for (const pt of sampled) {
      const label = getDrawElementLabel(elementAtPagePoint(pt))
      if (label) seen.add(label)
    }
    return Array.from(seen).slice(0, 8)
  }

  type SyncAnchor = {
    nodeId?: string
    artifactRevision?: number
    selector: string
    tagName: string
    label?: string
    text?: string
    offsetXRatio: number
    offsetYRatio: number
  }

  const resolveAnchorElement = (anchor: SyncAnchor | undefined): Element | null => {
    if (!anchor?.selector) return null
    if (
      anchor.artifactRevision !== undefined &&
      anchor.artifactRevision !== Number(root.dataset.designArtifactRevision || 0)
    ) {
      return null
    }
    if (anchor.nodeId) {
      const stable = Array.from(document.querySelectorAll("[data-design-node]")).find(
        (el) => el.getAttribute("data-design-node") === anchor.nodeId
      )
      if (stable) return stable
    }
    try {
      const direct = document.querySelector(anchor.selector)
      if (direct) return direct
    } catch {
      // Fallback below.
    }
    const candidates = Array.from(document.querySelectorAll(anchor.tagName || "*"))
    if (anchor.label) {
      const byLabel = candidates.find((el) => getDrawElementLabel(el) === anchor.label)
      if (byLabel) return byLabel
    }
    if (anchor.text) {
      const byText = candidates.find((el) => getElementTextSignature(el) === anchor.text)
      if (byText) return byText
    }
    return null
  }

  const resolveAnchorPagePoint = (anchor: SyncAnchor | undefined) => {
    const el = resolveAnchorElement(anchor)
    if (!el || !anchor) return null
    const rect = pageRectForElement(el)
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: rect.x + rect.width * anchor.offsetXRatio,
      y: rect.y + rect.height * anchor.offsetYRatio
    }
  }

  const resolveStrokePoints = (stroke: {
    points: Array<{ x: number; y: number }>
    anchor?: SyncAnchor
    anchoredPoints?: Array<{ xRatio: number; yRatio: number }>
  }) => {
    const el = resolveAnchorElement(stroke.anchor)
    if (!el || !stroke.anchoredPoints?.length) {
      return { points: stroke.points, orphaned: Boolean(stroke.anchor) }
    }
    const rect = pageRectForElement(el)
    if (rect.width <= 0 || rect.height <= 0) {
      return { points: stroke.points, orphaned: Boolean(stroke.anchor) }
    }
    return {
      points: stroke.anchoredPoints.map((pt) => ({
        x: rect.x + rect.width * pt.xRatio,
        y: rect.y + rect.height * pt.yRatio
      })),
      orphaned: false
    }
  }

  // ── Comment interaction mode ──
  let commentActive = false
  let commentHover: Element | null = null
  const commentLabel = (t: Element) => {
    if (t.id) return "#" + t.id
    const tag = t.tagName.toLowerCase()
    const cls = Array.from(t.classList)
      .filter((c) => !c.startsWith("__cm"))
      .slice(0, 2)
      .join(".")
    const txt = (t.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28)
    return tag + (cls ? "." + cls : "") + (txt ? " '" + txt + "'" : "")
  }
  const onCommentOver = (e: Event) => {
    if (commentHover) commentHover.classList.remove("__cm_h")
    const t = e.target as Element | null
    if (
      t &&
      t !== document.body &&
      t !== document.documentElement &&
      !t.closest("[data-design-host-runtime]")
    ) {
      commentHover = t
      t.classList.add("__cm_h")
    }
  }
  const onCommentOut = () => {
    if (commentHover) {
      commentHover.classList.remove("__cm_h")
      commentHover = null
    }
  }
  const onCommentClick = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (target?.closest("[data-design-host-runtime]")) return
    e.preventDefault()
    e.stopPropagation()
    const anchor = getPointAnchor({ x: e.pageX, y: e.pageY })
    postToParent({
      type: "__comment_click",
      pageX: e.pageX,
      pageY: e.pageY,
      winW: window.innerWidth,
      winH: window.innerHeight,
      elementDesc: anchor?.label || (target ? commentLabel(target) : "元素"),
      anchor
    })
  }
  const setCommentActive = (active: boolean) => {
    if (commentActive === active) return
    commentActive = active
    if (active) {
      if (!document.getElementById("__cm_sty")) {
        const sty = document.createElement("style")
        sty.id = "__cm_sty"
        sty.setAttribute("data-design-host-runtime", "comment")
        sty.textContent =
          ".__cm_h{outline:2px solid rgba(245,158,11,0.7)!important;outline-offset:1px!important;cursor:crosshair!important;transition:outline 0.08s;}"
        document.head.appendChild(sty)
      }
      document.addEventListener("mouseover", onCommentOver, true)
      document.addEventListener("mouseout", onCommentOut, true)
      document.addEventListener("click", onCommentClick, true)
    } else {
      document.removeEventListener("mouseover", onCommentOver, true)
      document.removeEventListener("mouseout", onCommentOut, true)
      document.removeEventListener("click", onCommentClick, true)
      document.getElementById("__cm_sty")?.remove()
      if (commentHover) {
        commentHover.classList.remove("__cm_h")
        commentHover = null
      }
    }
  }

  // ── Synced Annotation Coordinate Resolver ──
  let syncedAnnotations: {
    comments: Array<{ id: string; pageX: number; pageY: number; anchor?: SyncAnchor }>
    draftComment: { pageX: number; pageY: number; anchor?: SyncAnchor } | null
    strokes: Array<{
      id: string
      points: Array<{ x: number; y: number }>
      anchor?: SyncAnchor
      anchoredPoints?: Array<{ xRatio: number; yRatio: number }>
    }>
    notes: Array<{ id: string; pageX: number; pageY: number; anchor?: SyncAnchor }>
    draftDrawNote: { pageX: number; pageY: number; anchor?: SyncAnchor } | null
  } | null = null
  let lastResolvedSignature = ""
  let annotationRaf = 0

  const publishResolvedAnnotations = (force = false) => {
    if (!syncedAnnotations) return
    const resolved = {
      comments: syncedAnnotations.comments.map((c) => {
        const pt = resolveAnchorPagePoint(c.anchor)
        return { id: c.id, point: pt, orphaned: Boolean(c.anchor && !pt) }
      }),
      draftComment: syncedAnnotations.draftComment
        ? (() => {
            const pt = resolveAnchorPagePoint(syncedAnnotations.draftComment.anchor)
            return { point: pt, orphaned: Boolean(syncedAnnotations.draftComment.anchor && !pt) }
          })()
        : null,
      strokes: syncedAnnotations.strokes.map((s) => ({
        id: s.id,
        ...resolveStrokePoints(s)
      })),
      notes: syncedAnnotations.notes.map((n) => {
        const pt = resolveAnchorPagePoint(n.anchor)
        return { id: n.id, point: pt, orphaned: Boolean(n.anchor && !pt) }
      }),
      draftDrawNote: syncedAnnotations.draftDrawNote
        ? (() => {
            const pt = resolveAnchorPagePoint(syncedAnnotations.draftDrawNote.anchor)
            return { point: pt, orphaned: Boolean(syncedAnnotations.draftDrawNote.anchor && !pt) }
          })()
        : null
    }
    const signature = JSON.stringify(resolved)
    if (!force && signature === lastResolvedSignature) return
    lastResolvedSignature = signature
    postToParent({ type: "__design_annotations_resolved", resolved })
  }

  function scheduleAnnotationResolve() {
    if (!syncedAnnotations || annotationRaf) return
    annotationRaf = requestAnimationFrame(() => {
      annotationRaf = 0
      publishResolvedAnnotations(false)
    })
  }

  if (!isDraft && typeof MutationObserver !== "undefined") {
    const domObserver = new MutationObserver(() => scheduleAnnotationResolve())
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "data-design-artifact-revision"]
    })
  }

  // ── App -> Canvas Message Handler ──
  window.addEventListener("message", (event) => {
    const msg = event.data
    if (event.source !== window.parent || !msg || msg.previewInstanceId !== previewInstanceId) {
      return
    }
    if (msg.type === "__design_scroll_to") {
      window.scrollTo(Number(msg.x) || 0, Number(msg.y) || 0)
      return
    }
    if (msg.type === "__design_scroll_by") {
      window.scrollBy({
        left: Number(msg.left) || 0,
        top: Number(msg.top) || 0,
        behavior: "auto"
      })
      reportScroll()
      return
    }
    if (isDraft) return

    if (msg.type === "__design_set_mode") {
      setCommentActive(msg.mode === "comment")
      if (msg.mode !== "edit" && msg.mode !== "move") {
        w.__designEditor?.cleanup()
      }
      return
    }
    if (msg.type === "__design_editor_config") {
      installDirectEdit(msg.config, msg.mode || "edit", undefined, 0, previewInstanceId)
      return
    }
    if (msg.type === "__design_editor_action") {
      const editor = w.__designEditor
      if (msg.action === "editSelected") editor?.editSelected()
      else if (msg.action === "deleteSelected") editor?.deleteSelected()
      else if (msg.action === "clearSelection") editor?.clearSelection()
      else if (msg.action === "cleanup") editor?.cleanup()
      else if (msg.action === "flush") {
        if (!editor) {
          postToParent({ type: "__design_editor_flush_reply", requestId: msg.requestId })
          return
        }
        const pendingCommand = editor.takeCommand()
        editor
          .flush()
          .then(() => {
            postToParent({ type: "__design_editor_flush_reply", requestId: msg.requestId })
          })
          .catch((error) => {
            postToParent({
              type: "__design_editor_flush_reply",
              requestId: msg.requestId,
              command: pendingCommand,
              error: error instanceof Error ? error.message : String(error)
            })
          })
      }
      return
    }
    if (msg.type === "__design_query_point_anchor") {
      const point = msg.point as { x: number; y: number }
      const anchor = getPointAnchor(point)
      const elements = anchor?.label ? [anchor.label] : collectDrawElementLabels([point])
      postToParent({
        type: "__design_point_anchor_reply",
        requestId: msg.requestId,
        anchor,
        elements
      })
      return
    }
    if (msg.type === "__design_query_stroke_anchor") {
      const points = (msg.points || []) as Array<{ x: number; y: number }>
      const anchor = getDominantPointAnchor(points)
      let anchoredPoints: Array<{ xRatio: number; yRatio: number }> | undefined
      if (anchor) {
        const el = resolveAnchorElement(anchor)
        if (el) {
          const rect = pageRectForElement(el)
          if (rect.width > 0 && rect.height > 0) {
            anchoredPoints = points.map((pt) => ({
              xRatio: (pt.x - rect.x) / rect.width,
              yRatio: (pt.y - rect.y) / rect.height
            }))
          }
        }
      }
      const elements = collectDrawElementLabels(points)
      const step = Math.max(1, Math.floor(points.length / 12))
      const sampledRaw = points
        .filter((_, index) => index % step === 0)
        .slice(0, 12)
        .map(getPointAnchor)
        .filter((a): a is NonNullable<ReturnType<typeof getPointAnchor>> => Boolean(a))
      const dedup = new Map<string, NonNullable<ReturnType<typeof getPointAnchor>>>()
      for (const item of sampledRaw) {
        dedup.set(item.nodeId || item.selector, item)
      }
      if (!dedup.size && anchor) {
        dedup.set(anchor.nodeId || anchor.selector, anchor)
      }
      postToParent({
        type: "__design_stroke_anchor_reply",
        requestId: msg.requestId,
        anchor,
        anchoredPoints,
        elements,
        sampledAnchors: Array.from(dedup.values())
      })
      return
    }
    if (msg.type === "__design_sync_annotations") {
      syncedAnnotations = msg.annotations
      publishResolvedAnnotations(true)
      return
    }
    if (msg.type === "__design_query_observations") {
      const requestedIds = Array.isArray(msg.nodeIds) ? (msg.nodeIds as string[]) : []
      const byNodeId = new Map<string, HTMLElement>()
      for (const el of document.querySelectorAll<HTMLElement>("[data-design-node]")) {
        const id = el.dataset.designNode
        if (id) byNodeId.set(id, el)
      }
      const seen = new Set<string>()
      const observations: Array<{
        nodeId: string
        box: { width: number; height: number }
        computed: Record<string, string>
      }> = []
      const props = [
        "display",
        "position",
        "width",
        "height",
        "gap",
        "padding",
        "margin",
        "grid-template-columns",
        "flex-direction",
        "font-size",
        "line-height",
        "color",
        "background-color"
      ]
      for (const id of requestedIds) {
        const el = byNodeId.get(id)
        if (!el) continue
        for (const node of [el, el.parentElement]) {
          if (!node || !(node instanceof HTMLElement) || !node.dataset.designNode) continue
          const nid = node.dataset.designNode
          if (seen.has(nid)) continue
          seen.add(nid)
          const style = getComputedStyle(node)
          const box = node.getBoundingClientRect()
          observations.push({
            nodeId: nid,
            box: { width: box.width, height: box.height },
            computed: Object.fromEntries(props.map((key) => [key, style.getPropertyValue(key)]))
          })
        }
      }
      postToParent({
        type: "__design_observations_reply",
        requestId: msg.requestId,
        observations
      })
    }
  })

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObservers, { once: true })
  } else {
    startObservers()
  }
}

let cachedCanvasRuntimeScript: string | null = null

export function buildDesignCanvasRuntimeScript(): string {
  if (cachedCanvasRuntimeScript) return cachedCanvasRuntimeScript
  const args = [
    JSON.stringify(DESIGN_TWEAKS_RUNTIME),
    JSON.stringify(DESIGN_PREVIEW_NAVIGATION_SCRIPT),
    JSON.stringify(designLivePatchRuntime.toString()),
    JSON.stringify(draftRuntime.toString()),
    JSON.stringify(designDirectEditRuntime.toString())
  ].join(",")
  cachedCanvasRuntimeScript = `;(${designCanvasBridge.toString()})(${args});\n`
  return cachedCanvasRuntimeScript
}
