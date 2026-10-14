import {
  validateFunctionTree,
  validFunctionLink,
  type FunctionUiElement,
  type FunctionUiEngine,
  type FunctionUiFragment,
  type FunctionUiMarkdown,
  type FunctionUiNode
} from "./ui"

/** Preserve safe trees and callback identities; unsupported addresses have no clickable DOM. */
export function normalizeFunctionLinks(tree: FunctionUiNode): FunctionUiNode
export function normalizeFunctionLinks(tree: FunctionUiEngine): FunctionUiEngine
export function normalizeFunctionLinks(tree: FunctionUiFragment): FunctionUiFragment
export function normalizeFunctionLinks(tree: FunctionUiMarkdown): FunctionUiMarkdown
export function normalizeFunctionLinks(tree: FunctionUiElement): FunctionUiElement
export function normalizeFunctionLinks(tree: FunctionUiElement): FunctionUiElement {
  validateFunctionTree(tree)
  const visit = (node: FunctionUiElement): FunctionUiElement => {
    if (node.type === "engine" || node.type === "Markdown") return node
    let children: FunctionUiNode["children"]
    for (let index = 0; index < (node.children?.length ?? 0); index++) {
      const original = node.children![index]
      const normalized = typeof original === "string" ? original : visit(original)
      if (normalized !== original) {
        children ??= node.children!.slice()
        children[index] = normalized
      }
    }
    if (node.type === "Link" && !validFunctionLink(node.props.href)) {
      const content = children ?? node.children
      const fallback =
        typeof node.props.label === "string"
          ? node.props.label
          : typeof node.props.href === "string"
            ? node.props.href
            : ""
      return { type: "Text", props: {}, children: content?.length ? content : [fallback] }
    }
    return children ? { ...node, children } : node
  }
  const result = visit(tree)
  if (result !== tree) validateFunctionTree(result)
  return result
}
