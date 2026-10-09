/** Keep the complete document for a variation: shared dialogs, templates,
 * body attributes and scripts may be referenced by either design. */
export function buildDesignVariationDocument(doc: Document, primary: Element): string {
  const preview = doc.cloneNode(true) as Document
  const inactiveIds = ["a", "b"].filter((id) => primary.id !== `variation-${id}`)
  const style = preview.createElement("style")
  style.setAttribute("data-design-variation", primary.id)
  style.textContent = inactiveIds
    .map((id) => `#variation-${id}{display:none!important;}`)
    .join("\n")
  preview.head.append(style)
  return `<!DOCTYPE ${doc.doctype?.name || "html"}>\n${preview.documentElement.outerHTML}`
}
