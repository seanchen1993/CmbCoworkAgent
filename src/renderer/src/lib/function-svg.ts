const namespace = "http://www.w3.org/2000/svg"
const tags = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "style",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "marker"
])
const attributes = new Set([
  "id",
  "class",
  "style",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "rotate",
  "textLength",
  "lengthAdjust",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "fx",
  "fy",
  "fr",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "marker-start",
  "marker-mid",
  "marker-end",
  "vector-effect"
])

/** Parse detached XML, then serialize only vector nodes. Never insert plugin markup into app DOM. */
export function scrubFunctionSvg(source: string): string | null {
  if (source.length > 131072 || /<!DOCTYPE|<!ENTITY/i.test(source)) return null
  const doc = new DOMParser().parseFromString(source, "image/svg+xml")
  const root = doc.documentElement
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== namespace ||
    doc.querySelector("parsererror")
  )
    return null
  let count = 0
  const clean = (element: Element, depth: number): boolean => {
    if (++count > 2000 || depth > 32) return false
    for (const attribute of [...element.attributes]) {
      if (attribute.name === "xmlns" && element === root) continue
      if (
        attribute.localName === "href" &&
        element.localName === "use" &&
        /^#[\w.-]{1,256}$/.test(attribute.value)
      )
        continue
      if (attribute.namespaceURI || !attributes.has(attribute.name))
        element.removeAttributeNode(attribute)
    }
    for (const child of [...element.childNodes]) {
      if (child.nodeType === 3) continue
      // XML CDATA must not become literal closing tags when embedded in an HTML srcdoc.
      if (child.nodeType === 4) {
        child.replaceWith(doc.createTextNode(child.textContent ?? ""))
        continue
      }
      if (child.nodeType !== 1) {
        child.remove()
        continue
      }
      const node = child as Element
      if (node.namespaceURI !== namespace || !tags.has(node.localName)) node.remove()
      else if (!clean(node, depth + 1)) return false
    }
    return true
  }
  if (!clean(root, 0)) return null
  return new XMLSerializer().serializeToString(root)
}

/** Opaque sandbox origin plus CSP: no scripts, navigation links, forms or external resources. */
export function functionSvgDocument(svg: string): string {
  return (
    "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><style>html,body{margin:0;overflow:hidden}svg{max-width:100%;height:auto}</style></head><body>" +
    svg +
    "</body></html>"
  )
}
