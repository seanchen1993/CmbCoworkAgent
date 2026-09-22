import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

async function featureFixture(record: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mods-autobiz-contract-"))
  roots.push(root)
  const directory = join(root, ".autobizdevops/features/order-export")
  await mkdir(join(directory, "specs"), { recursive: true })
  await writeFile(join(root, ".autobizdevops/state.json"), JSON.stringify({
    schemaVersion: "autobizdevops.state.v3",
    features: { "order-export": {
      feature: "order-export", checkpoint: "requirements_eval_in_progress",
      workflowProfile: "standard", workflowTemplate: "standard", workflowDecisions: {}, ...record
    } }
  }))
  for (const file of ["proposal.md", "design.md", "PLAN.md", "specs/orders.md"])
    await writeFile(join(directory, file), "contract fixture, not a business acceptance report")
  return { root, directory }
}

it("uses compiled checkpoint skill even when the state tries to select another validator", async () => {
  const { root } = await featureFixture({ skill: "autodev-e2e", slug: "other" })
  const result = await runAutobizValidator(root, "order-export")
  expect(result.compiler).toBe("passed")
  expect(result.passed).toBe(false)
  expect(result.reason).toContain("REQUIREMENTS_EVAL.md")
})

it("runs real artifact validation and exposes which precheck failed", async () => {
  const { root, directory } = await featureFixture()
  await writeFile(join(directory, "REQUIREMENTS_EVAL.md"), "verdict: PASS\nfixture only")
  await rm(join(directory, "proposal.md"))
  const result = await runAutobizValidator(root, "order-export")
  expect(result.passed).toBe(false)
  expect(result.reason).toContain("proposal.md")
})
