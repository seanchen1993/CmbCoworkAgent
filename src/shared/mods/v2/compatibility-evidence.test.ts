import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it("describes partial SDK members with concrete availability and a source boundary", () => {
  const matrix = JSON.parse(
    readFileSync(resolve("docs/mods-v2-compatibility-matrix.json"), "utf8")
  ) as { sdk: Array<{ members: Array<Record<string, unknown>> }> }
  const incomplete = matrix.sdk
    .flatMap((group) => group.members)
    .filter((row) => {
      if (row.implementationStatus !== "partial") return false
      return (
        typeof row.note !== "string" ||
        !row.note.trim() ||
        !["bounded", "unavailable", "metadata"].includes(String(row.availability)) ||
        !Array.isArray(row.implementation) ||
        !row.implementation.length ||
        !row.implementation.every((path) => typeof path === "string" && existsSync(resolve(path)))
      )
    })
  expect(incomplete.map((row) => row.name)).toEqual([])
})

it("links every implemented compatibility claim to existing test evidence and its scope", () => {
  const matrix: unknown = JSON.parse(
    readFileSync(resolve("docs/mods-v2-compatibility-matrix.json"), "utf8")
  )
  const claims: Array<Record<string, unknown>> = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return
    const row = value as Record<string, unknown>
    if (row.implementationStatus === "adapted" || row.implementationStatus === "full")
      claims.push(row)
    Object.values(row).forEach(visit)
  }
  visit(matrix)
  expect(claims.length).toBeGreaterThan(20)
  const missing = claims.filter((row) => {
    const scope = row.note ?? row.notes
    return (
      !Array.isArray(row.evidence) ||
      !row.evidence.some(
        (path) => typeof path === "string" && /(?:\.test\.ts|e2e.*\.ts)$/.test(path)
      ) ||
      !row.evidence.every(
        (path) =>
          typeof path === "string" && (path.startsWith("https://") || existsSync(resolve(path)))
      ) ||
      typeof scope !== "string" ||
      !scope.trim()
    )
  })
  expect(missing.map((row) => row.name)).toEqual([])
})
