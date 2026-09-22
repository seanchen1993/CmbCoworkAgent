import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const matrix = JSON.parse(readFileSync(resolve("docs/mods-v2-compatibility-matrix.json"), "utf8")) as Record<string, unknown>
const allowed = new Set(["full", "adapted", "partial", "unsupported"])

function collect(value: unknown, output: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, output))
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.target === "string") output.push(item)
  Object.values(item).forEach((child) => collect(child, output))
}

it("marks every compatibility declaration with an honest implementation status", () => {
  const declarations: Array<Record<string, unknown>> = []
  collect(matrix, declarations)
  expect(declarations.length).toBeGreaterThan(100)
  expect(declarations.every((item) => allowed.has(item.implementationStatus as string))).toBe(true)
})
