import { expect, it } from "vitest"
import {
  authoringCompileDiagnostics,
  readAuthoringCompileDiagnostics
} from "./authoring-compile-diagnostics"

it("bounds nested compiler failures globally and terminates cycles", () => {
  const item = { text: "x".repeat(900), location: { file: "mods/main.ts", line: 1, column: 0 } }
  const nested = {
    errors: Array.from({ length: 20 }, () => ({ detail: { errors: Array(20).fill(item) } }))
  }
  expect(authoringCompileDiagnostics(nested, process.cwd())).toHaveLength(20)
  const cyclic: { errors: Array<{ detail: unknown }> } = { errors: [] }
  cyclic.errors.push({ detail: { errors: [{ detail: cyclic }] } })
  expect(authoringCompileDiagnostics(cyclic, process.cwd())).toEqual([])
})

it("keeps only bounded public diagnostic fields at the Worker boundary", () => {
  const item = {
    code: "compile",
    message: "x".repeat(900),
    file: "mods/main.ts",
    line: 1,
    column: 2,
    stack: "private",
    detail: { any: "private" }
  }
  const result = readAuthoringCompileDiagnostics(Array(30).fill(item))
  expect(result).toHaveLength(20)
  expect(result[0]).toEqual({
    code: "compile",
    message: "x".repeat(500),
    file: "mods/main.ts",
    line: 1,
    column: 2
  })
  for (const file of ["../other.ts", "C:/private.ts", "/private.ts", "a/../other.ts"])
    expect(readAuthoringCompileDiagnostics([{ ...item, file }])).toEqual([])
})
