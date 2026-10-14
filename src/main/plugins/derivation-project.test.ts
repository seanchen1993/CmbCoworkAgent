import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { assertDerivedProjectDirectory } from "./derivation-project"
import { setDerivationFamilies } from "./derivation-scope"

const roots: string[] = []
afterEach(() => {
  setDerivationFamilies([])
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("requires a fresh independent directory only for derived packages", () => {
  const root = mkdtempSync(join(tmpdir(), "derivation-project-"))
  roots.push(root)
  setDerivationFamilies([{ familyId: "f", originalId: "original", members: ["original", "copy"] }])
  mkdirSync(join(root, "old", ".autobizdevops"), { recursive: true })
  writeFileSync(join(root, "old", ".autobizdevops", "state.json"), "{}")
  expect(() => assertDerivedProjectDirectory("copy", root, "old")).toThrow("不能复用")
  expect(() => assertDerivedProjectDirectory("copy", root, "../escape")).toThrow("独立")
  expect(() => assertDerivedProjectDirectory("original", root, "old")).not.toThrow()
  expect(() => assertDerivedProjectDirectory("copy", root, "new")).not.toThrow()
})
