import { FUNCTION_CODE_MAX_DRAW_CHARS, functionCodeSource } from "../../../shared/mods/v2/code"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import { functionUiTextProjection } from "../../../shared/mods/v2/ui-text"

/** A display budget belongs to one drawing, not to a shared node object or a render order. */
export function functionCodeDrawing(
  root: FunctionUiElement | string,
  rootPath: readonly number[] = []
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>()
  let remaining = FUNCTION_CODE_MAX_DRAW_CHARS
  function visit(node: FunctionUiElement | string, path: readonly number[]): void {
    if (typeof node === "string" || node.type === "engine") return
    if (node.type === "Code") {
      // Validate the complete source before spending the presentation-only budget.
      const fullSource = functionCodeSource(node.props.source)
      const source = functionUiTextProjection(
        fullSource.slice(0, remaining),
        FUNCTION_CODE_MAX_DRAW_CHARS
      )
      sources.set(path.join("."), source)
      remaining -= source.length
      return
    }
    node.children?.forEach((child, index) => visit(child, [...path, index]))
  }
  visit(root, rootPath)
  return sources
}
