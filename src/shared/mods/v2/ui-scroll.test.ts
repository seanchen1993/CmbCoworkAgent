import { expect, it } from "vitest"
import { functionScrollInput, functionScrollGeometry, functionScrollPosition } from "./ui-scroll"

it("parses owned site targets without accepting direct offsets or extra fields", () => {
  expect(functionScrollInput({ to: "end", in: "board" })).toEqual({ to: "end", in: "board" })
  expect(functionScrollInput({ to: { key: "row" }, block: "center" })).toEqual({
    to: { key: "row" },
    block: "center"
  })
})

it.each([
  {},
  { to: "end" },
  { to: 3 },
  { to: "start", in: "" },
  { to: { key: "" } },
  { to: { key: "x", requestId: "y" } },
  { to: { key: "x" }, block: "instant" },
  { to: { key: "x" }, block: ["start"] },
  { to: "end", in: "board", offset: 10 }
])("rejects an invalid scroll request %j", (value) => {
  expect(() => functionScrollInput(value)).toThrow("MODS_UI_SCROLL_ARGUMENTS")
})

const geometry = { height: 100, content: 1000, top: 200, row: 20, width: 500 }
it("uses measured CSS rows and clamps start/end to the actual scrollable body", () => {
  expect(functionScrollPosition({ to: "start", in: "board" }, geometry)).toEqual({
    offset: 0,
    by: -10,
    bodyRows: 5,
    contentRows: 50
  })
  expect(functionScrollPosition({ to: "end", in: "board" }, geometry)).toEqual({
    offset: 45,
    by: 35,
    bodyRows: 5,
    contentRows: 50
  })
})
it.each([
  ["nearest", 200],
  ["start", 250],
  ["center", 210],
  ["end", 170]
] as const)("resolves %s using the actual target rectangle", (block, pixels) => {
  expect(
    functionScrollPosition(
      { to: { key: "row" }, block },
      {
        ...geometry,
        target: { top: 250, height: 20 }
      }
    ).offset
  ).toBe(pixels / geometry.row)
})
it.each([
  [150, 20, 150],
  [350, 20, 270],
  [250, 150, 250],
  [990, 20, 900]
])("reveals a hidden or oversized target and clamps the result: %s/%s", (top, height, pixels) => {
  expect(
    functionScrollPosition(
      { to: { key: "row" } },
      {
        ...geometry,
        target: { top, height }
      }
    ).offset
  ).toBe(pixels / geometry.row)
})
it.each([
  { ...geometry, row: 0 },
  { ...geometry, height: NaN },
  { ...geometry, top: -1 },
  { ...geometry, content: Infinity },
  { ...geometry, width: 0 },
  { ...geometry, target: { top: 10, height: -1 } },
  { ...geometry, forged: true }
])("rejects invalid or fabricated geometry %j", (value) => {
  expect(() => functionScrollGeometry(value)).toThrow("MODS_UI_SCROLL_GEOMETRY")
})
it("does not pretend a missing key rectangle was measured", () => {
  expect(() => functionScrollPosition({ to: { key: "row" } }, geometry)).toThrow(
    "MODS_UI_SCROLL_TARGET"
  )
})
