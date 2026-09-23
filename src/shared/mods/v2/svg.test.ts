import { expect, it } from "vitest"
import { validateFunctionTree } from "./ui"

const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10"/></svg>'
it("accepts isolated vector leaves including the upstream 128 KiB source limit", () => {
  for (const props of [
    { source, alt: "Diagram" },
    { source, alt: "Diagram", width: 120, height: 80, isInteractive: true },
    { source: source + " ".repeat(131072 - source.length), alt: "Large diagram" }
  ])
    expect(() => validateFunctionTree({ type: "Svg", props })).not.toThrow()
})

it("rejects malformed vector dimensions, missing alt, oversized markup and authority fields", () => {
  for (const props of [
    { source },
    { source, alt: 1 },
    { source, alt: "", isInteractive: "true" },
    { source, alt: "A", width: "100%" },
    { source, alt: "A", height: -1 },
    { source, alt: "A", width: Infinity },
    { source, alt: "A", width: 10001 },
    { source: "x".repeat(131073), alt: "A" },
    { source, alt: "A", onClick: "code" }
  ])
    expect(() => validateFunctionTree({ type: "Svg", props })).toThrow()
  expect(() =>
    validateFunctionTree({ type: "Svg", props: { source, alt: "A" }, children: [] })
  ).toThrow()
})
