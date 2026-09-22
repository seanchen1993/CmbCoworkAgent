import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { runAutobizValidator } from "./autobiz-validation"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })) ) })

it("runs the pinned validator as a read-only failure when the real state is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-autobiz-"))
  roots.push(root)
  const result = await runAutobizValidator(root)
  expect(result.passed).toBe(false)
  expect(result.validator).toBe("failed")
  expect(result.reason).toMatch(/ENOENT|state|AUTOBIZ/i)
})
