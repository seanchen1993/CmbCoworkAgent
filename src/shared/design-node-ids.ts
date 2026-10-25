import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5"

export const designAttr = (el: Tree.Element, key: string): string | undefined =>
  el.attrs.find((a) => a.name === key)?.value
export interface DesignSourceNode {
  id: string
  element: Tree.Element
  parentId?: string
  sectionId: string
  variationId: string | null
  start: number
  end: number
}
function fingerprint(value: string): string {
  let n = 2166136261
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619)
  return (n >>> 0).toString(36)
}

/** IDs decorate the preview without serializing runtime DOM back to canonical source. */
export function designSourceNodes(html: string): DesignSourceNode[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const result: DesignSourceNode[] = []
  const used = new Set<string>()
  function walk(
    node: Tree.Node,
    path: string,
    parent?: DesignSourceNode,
    inBody = false,
    variation: string | null = null
  ) {
    let current = parent
    if ("tagName" in node) {
      inBody ||= node.tagName === "body"
      const businessId = designAttr(node, "id")
      const variant = businessId?.match(/^variation-([a-z0-9][\w-]{0,40})$/i)
      if (variant) variation = variant[1]
      const loc = node.sourceCodeLocation
      if (
        inBody &&
        node.tagName !== "body" &&
        ![
          "script",
          "style",
          "template",
          "noscript",
          "link",
          "meta",
          "iframe",
          "object",
          "embed"
        ].includes(node.tagName) &&
        loc?.startTag &&
        loc.endOffset
      ) {
        const explicit = designAttr(node, "data-design-node")
        const id = explicit || `n_${fingerprint(`${path}:${node.tagName}:${businessId ?? ""}`)}`
        if (used.has(id)) throw new Error("页面包含重复编辑节点 ID")
        used.add(id)
        current = {
          id,
          element: node,
          parentId: parent?.id,
          sectionId: designAttr(node, "data-design-section") || parent?.sectionId || id,
          variationId: variation,
          start: loc.startOffset,
          end: loc.endOffset
        }
        result.push(current)
      }
    }
    if (
      "childNodes" in node &&
      !("tagName" in node && ["script", "style", "template", "noscript"].includes(node.tagName))
    ) {
      let i = 0
      for (const child of node.childNodes) {
        if ("tagName" in child) i++
        walk(child, `${path}/${i}`, current, inBody, variation)
      }
    }
  }
  walk(doc, "")
  return result
}

export function decorateDesignNodes(html: string): string {
  const edits = designSourceNodes(html)
    .filter((n) => !designAttr(n.element, "data-design-node"))
    .map((n) => ({
      offset:
        n.element.sourceCodeLocation!.startTag!.endOffset -
        (html[n.element.sourceCodeLocation!.startTag!.endOffset - 2] === "/" ? 2 : 1),
      id: n.id
    }))
  for (const edit of edits.sort((a, b) => b.offset - a.offset))
    html = html.slice(0, edit.offset) + ` data-design-node="${edit.id}"` + html.slice(edit.offset)
  return html
}

export function stripDesignHostRuntime(html: string): string {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const ranges: Array<{ start: number; end: number }> = []
  function visit(node: Tree.Node) {
    if (
      "tagName" in node &&
      designAttr(node, "data-design-host-runtime") !== undefined &&
      node.sourceCodeLocation
    )
      ranges.push({
        start: node.sourceCodeLocation.startOffset,
        end: node.sourceCodeLocation.endOffset
      })
    else if ("childNodes" in node) node.childNodes.forEach(visit)
  }
  visit(doc)
  for (const r of ranges.sort((a, b) => b.start - a.start))
    html = html.slice(0, r.start) + html.slice(r.end)
  return html
}
