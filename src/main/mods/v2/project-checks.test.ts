import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { runProjectCheck } from "./project-checks"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it("does not accept a project without a package manifest as a passing test", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-project-check-"))
  roots.push(root)
  const result = await runProjectCheck(root, "unit-test")
  expect(result.passed).toBe(false)
  expect(result.reason).toMatch(/ENOENT|package|manifest/i)
})
