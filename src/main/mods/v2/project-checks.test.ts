import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { planProjectCheck } from "./project-check-plan"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("does not accept a project without a package manifest as a passing test", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-project-check-"))
  roots.push(root)
  await expect(planProjectCheck(root, "unit-test")).rejects.toThrow(/ENOENT|package|manifest/i)
})
