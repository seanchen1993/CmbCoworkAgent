import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { advanceAutobizCheckpoint, runAutobizValidator } from "./autobiz-validation"

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

it("refuses a checkpoint transition when the state fingerprint is not current", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-autobiz-transition-"))
  roots.push(root)
  const result = await advanceAutobizCheckpoint({
    workspace: root, feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", expectedStateFingerprint: "stale", idempotencyKey: "once"
  })
  expect(result.applied).toBe(false)
  expect(result.duplicate).toBe(false)
  expect(result.reason).toMatch(/state|ENOENT|AUTOBIZ/i)
})
