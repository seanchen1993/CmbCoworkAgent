import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  advanceAutobizCheckpoint,
  fingerprintAutobizWorkflow,
  runAutobizValidator
} from "./autobiz-validation"
import { withPinnedAutobiz } from "./autobiz-source"

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

it("changes the workflow evidence fingerprint when a dynamic workflow overlay changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-autobiz-workflow-fingerprint-"))
  roots.push(root)
  const overlay = join(root, ".autobizdevops", "workflow.d", "feature.json")
  await mkdir(join(root, ".autobizdevops", "workflow.d"), { recursive: true })
  await writeFile(overlay, JSON.stringify({ profile: "standard", nodes: [] }))
  const before = await fingerprintAutobizWorkflow(root)
  await writeFile(overlay, JSON.stringify({ profile: "standard", nodes: [{ id: "review" }] }))
  const after = await fingerprintAutobizWorkflow(root)
  expect(after).not.toBe(before)
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

it("rejects a reused transition receipt key when its transition arguments change", async () => {
  const { root, directory } = await featureFixture()
  await writeFile(join(directory, "REQUIREMENTS_EVAL.md"), "verdict: PASS\ncontract fixture only")
  await withPinnedAutobiz(undefined, (source) => promisify(execFile)("python", [
    "-I", "-B", "-c",
    "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from board_core.state_store import check_or_fix_state_sync; check_or_fix_state_sync(Path(sys.argv[2]), fix=True)",
    source, root
  ], { windowsHide: true }))
  const state = await readFile(join(root, ".autobizdevops/state.json"))
  const before = createHash("sha256").update(state).digest("hex")
  const first = await advanceAutobizCheckpoint({
    workspace: root, feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", expectedStateFingerprint: before, idempotencyKey: "same-key"
  })
  expect(first.applied, first.reason).toBe(true)
  const second = await advanceAutobizCheckpoint({
    workspace: root, feature: "order-export", from: "requirements_eval_done",
    to: "implementation_in_progress", expectedStateFingerprint: first.stateFingerprint,
    idempotencyKey: "same-key"
  })
  expect(second.applied).toBe(false)
  expect(second.duplicate).toBe(false)
  expect(second.reason).toContain("RECEIPT_MISMATCH")
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

it("does not write state when host evidence becomes invalid during checkpoint preparation", async () => {
  const { root, directory } = await featureFixture()
  await writeFile(join(directory, "REQUIREMENTS_EVAL.md"), "verdict: PASS\ncontract fixture only")
  await withPinnedAutobiz(undefined, (source) => promisify(execFile)("python", [
    "-I", "-B", "-c",
    "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from board_core.state_store import check_or_fix_state_sync; check_or_fix_state_sync(Path(sys.argv[2]), fix=True)",
    source, root
  ], { windowsHide: true }))
  const statePath = join(root, ".autobizdevops/state.json")
  const before = await readFile(statePath)
  const result = await advanceAutobizCheckpoint({
    workspace: root, feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", expectedStateFingerprint: createHash("sha256").update(before).digest("hex"),
    idempotencyKey: "revoked-during-prepare",
    verifyEvidence: async () => { throw Error("COMPLETION_EVIDENCE_STALE") }
  })
  expect(result.applied).toBe(false)
  expect(result.reason).toContain("COMPLETION_EVIDENCE_STALE")
  expect(await readFile(statePath)).toEqual(before)
})

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
