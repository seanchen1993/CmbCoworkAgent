import {
  CAPTURE_FRAME_ATTRIBUTE,
  CAPTURE_FRAME_PREVIEW_ATTRIBUTE,
  isCapturedFrameId
} from "../../../shared/design-captured-frame"

export function capturedFrameDocument(element: Element): Document | null {
  if (element.localName !== "iframe" || !element.hasAttribute("srcdoc")) return null
  const id = element.getAttribute(CAPTURE_FRAME_PREVIEW_ATTRIBUTE)
  if (!id || !isCapturedFrameId(id) || id !== element.getAttribute(CAPTURE_FRAME_ATTRIBUTE)) return null
  const doc = (element as HTMLIFrameElement).contentDocument
  return doc?.URL === "about:srcdoc" ? doc : null
}

export function previewDocuments(root: Document | null) {
  const docs: Array<{ doc: Document; frameId?: string; depth: number }> = []
  if (!root) return docs
  docs.push({ doc: root, depth: 0 })
  for (const { doc, depth } of docs) {
    if (depth >= 4) continue
    for (const frame of doc.querySelectorAll(`iframe[${CAPTURE_FRAME_PREVIEW_ATTRIBUTE}]`)) {
      const child = capturedFrameDocument(frame)
      if (child) docs.push({
        doc: child, frameId: frame.getAttribute(CAPTURE_FRAME_PREVIEW_ATTRIBUTE)!, depth: depth + 1
      })
    }
  }
  return docs
}

function frameGeometry(frame: HTMLIFrameElement) {
  const rect = frame.getBoundingClientRect()
  const styles = frame.ownerDocument.defaultView!.getComputedStyle(frame)
  const scaleX = rect.width / (frame.offsetWidth || 1)
  const scaleY = rect.height / (frame.offsetHeight || 1)
  return {
    x: rect.left + (frame.clientLeft + (parseFloat(styles.paddingLeft) || 0)) * scaleX,
    y: rect.top + (frame.clientTop + (parseFloat(styles.paddingTop) || 0)) * scaleY,
    scaleX, scaleY
  }
}

interface Point { x: number; y: number }

/** Hit testing and annotation coordinates are in the root preview's CSS pixels. */
export function designElementAtPoint(doc: Document, point: Point): Element | null {
  let x = point.x - (doc.defaultView?.scrollX ?? 0)
  let y = point.y - (doc.defaultView?.scrollY ?? 0)
  for (let depth = 0; depth <= 4; depth++) {
    const element = doc.elementFromPoint(x, y)
    if (!element || element === doc.body || element === doc.documentElement) return null
    const child = capturedFrameDocument(element)
    if (!child) return element.localName === "iframe" ? null : element
    const geometry = frameGeometry(element as HTMLIFrameElement)
    if (!geometry.scaleX || !geometry.scaleY) return null
    x = (x - geometry.x) / geometry.scaleX
    y = (y - geometry.y) / geometry.scaleY
    doc = child
  }
  return null
}

export function designRectInPage(
  root: Document,
  doc: Document,
  rect: { x: number; y: number; width: number; height: number }
) {
  let { x, y, width, height } = rect
  while (doc !== root) {
    const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null
    if (!frame || capturedFrameDocument(frame) !== doc) return null
    const geometry = frameGeometry(frame)
    x = geometry.x + x * geometry.scaleX
    y = geometry.y + y * geometry.scaleY
    width *= geometry.scaleX
    height *= geometry.scaleY
    doc = frame.ownerDocument
  }
  return { x: x + (root.defaultView?.scrollX ?? 0), y: y + (root.defaultView?.scrollY ?? 0), width, height }
}
