import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

export function functionTextContent(
  children: readonly (FunctionUiElement | string)[]
): string | undefined {
  let text = ""
  for (const child of children) {
    if (typeof child === "string") text += child
    else if (child.type === "Text" && Array.isArray(child.children)) {
      const nested = functionTextContent(child.children)
      if (nested === undefined) return undefined
      text += nested
    } else return undefined
  }
  return text
}
