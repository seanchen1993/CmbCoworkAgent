import { expect, it } from "vitest"
import type { FunctionUiElement, FunctionUiNode } from "../../../shared/mods/v2/ui"
import { functionCodeDrawing } from "./function-code-drawing"

const code = (source: string): FunctionUiNode => ({ type: "Code", props: { source } })

it("shares one drawing budget across stable paths without mutating the original tree", () => {
  const root: FunctionUiElement = {
    type: "fragment",
    children: [
      code("a".repeat(30000)),
      { type: "Box", props: {}, children: [code("b".repeat(80000)), code("tail")] }
    ]
  }
  const before = JSON.stringify(root)
  expect([...functionCodeDrawing(root)]).toEqual([
    ["0", "a".repeat(30000)],
    ["1.0", "b".repeat(70000)],
    ["1.1", ""]
  ])
  expect(JSON.stringify(root)).toBe(before)
})

it("counts repeated object references at each actual position and resets for another drawing", () => {
  const shared = code("x".repeat(70000))
  const root: FunctionUiElement = { type: "fragment", children: [shared, shared] }
  expect([...functionCodeDrawing(root, [4])]).toEqual([
    ["4.0", "x".repeat(70000)],
    ["4.1", "x".repeat(30000)]
  ])
  expect(functionCodeDrawing(shared).get("")).toHaveLength(70000)
  expect(shared.props.source).toHaveLength(70000)
})

it("validates the whole tail even after the budget is spent and repairs a split surrogate", () => {
  expect(() =>
    functionCodeDrawing({
      type: "fragment",
      children: [code("x".repeat(100000)), code("tail\u0000")]
    })
  ).toThrow("MODS_UI_CODE_INVALID")
  const root: FunctionUiElement = {
    type: "fragment",
    children: [code("x".repeat(99999)), code("🙂tail")]
  }
  expect(functionCodeDrawing(root).get("1")).toBe("\uFFFD")
})
