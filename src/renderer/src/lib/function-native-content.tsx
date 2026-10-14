import { Fragment, type ReactNode } from "react"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionNativeContent } from "../../../shared/mods/v2/engine"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import { functionUiStyle } from "./function-ui-style"

export function functionNativeProps(native: FunctionNativeContent | undefined, ref: number) {
  return (
    native?.entries.find((entry) => entry.ref === ref)?.props ??
    native?.entries.find((entry) => entry.ref === 0)?.props
  )
}

/** Only noninteractive labels belong inside the one original mode trigger. */
export function functionInlineTree(tree: FunctionUiElement): boolean {
  if (tree.type === "Markdown") return false
  if (tree.type === "engine") return true
  return (
    (tree.type === "fragment" || ["Box", "Text"].includes(tree.type)) &&
    (tree.children ?? []).every((child) => typeof child === "string" || functionInlineTree(child))
  )
}

export function functionInlineLabel(
  tree: FunctionUiElement,
  native: FunctionNativeContent | undefined,
  label: (props: ModObject) => ReactNode
): ReactNode {
  if (!functionInlineTree(tree)) return null
  const visit = (node: FunctionUiElement | string, key: number): ReactNode => {
    if (typeof node === "string") return node
    if (node.type === "engine") {
      const props = functionNativeProps(native, node.ref)
      return props ? <span key={key}>{label(props)}</span> : null
    }
    if (node.type === "fragment")
      return <Fragment key={key}>{node.children.map(visit)}</Fragment>
    if (node.type === "Markdown") return null
    return (
      <span
        key={key}
        style={{
          ...functionUiStyle(node),
          ...(node.type === "Box" ? { display: "inline-flex" } : {})
        }}
      >
        {(node.children ?? []).map(visit)}
      </span>
    )
  }
  return visit(tree, 0)
}

/** A text-only hint updates the original composer placeholder; other layouts stay separate. */
export function functionNativeHint(
  tree: FunctionUiElement,
  native: FunctionNativeContent | undefined
): string | null {
  if (!functionInlineTree(tree)) return null
  const visit = (node: FunctionUiElement | string): string | null => {
    if (typeof node === "string") return node
    if (node.type === "engine") {
      const hint = functionNativeProps(native, node.ref)?.hint
      return typeof hint === "string" ? hint : null
    }
    if (node.type === "Markdown") return null
    const values = (node.children ?? []).map(visit)
    return values.some((value) => value === null) ? null : values.join("")
  }
  return visit(tree)
}
