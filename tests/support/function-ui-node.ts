import type { FunctionUiElement, FunctionUiNode } from "../../src/shared/mods/v2/ui"

/** Fixture assertion: an ordinary node must not silently become another distinct UI branch. */
export function ordinaryFunctionNode(
  value: FunctionUiElement | string | undefined
): FunctionUiNode {
  if (
    !value || typeof value === "string" || value.type === "engine" ||
    value.type === "fragment" || value.type === "Markdown"
  )
    throw Error("Expected an ordinary Function UI node in this fixture")
  return value
}
