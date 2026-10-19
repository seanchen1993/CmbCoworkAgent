import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CompositionStageCheckStore } from "./composition-stage-check-store"
import { runtimeDigest } from "./safe-files"
import {
  canonicalStageCheckJson,
  parseStageCheckReceipt,
  stageCheckArtifactAllowed,
  type StageCheckReceipt
} from "../../../shared/project-runtime/stage-check-receipt"
const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-check-store-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new CompositionStageCheckStore(join(root, "receipt.sqlite"))
  cleanup.push(() => store.close())
  const identity = {
    runId: "run",
    unitId: "unit",
    engineRunId: "managed",
    packageDigest: "a".repeat(64),
    threadId: "thread",
    incarnationKey: "incarnation",
    hookId: "original-check"
  }
  const contract = {
    nodeId: "review",
    checkId: "postcheck",
    contractDigest: "b".repeat(64),
    artifacts: [{ id: "report", path: "report.md" }]
  }
  const receipt: StageCheckReceipt = {
    apiVersion: "devclaw.stage-check/v1",
    nodeId: "review",
    checkId: "postcheck",
    contractDigest: contract.contractDigest,
    outcome: "passed",
    artifacts: [{ id: "report", path: "report.md", digest: runtimeDigest("passed bytes") }]
  }
  writeFileSync(join(root, "report.md"), "passed bytes")
  store.freezeContracts("run", "unit", [contract])
  return { root, store, identity, contract, receipt }
}
it("freezes effective contracts before running and persists only exact current artifact bytes", async () => {
  const f = fixture()
  await f.store.append(f.root, f.identity, [f.receipt])
  expect(f.store.read("run", "unit")[0].receipt).toEqual(f.receipt)
  expect(() =>
    f.store.freezeContracts("run", "unit", [{ ...f.contract, contractDigest: "c".repeat(64) }])
  ).toThrow("CONTRACT_CHANGED")
  writeFileSync(join(f.root, "report.md"), "changed")
  await expect(f.store.append(f.root, f.identity, [f.receipt])).rejects.toThrow("ARTIFACT_CHANGED")
  expect(f.store.read("run", "unit")).toHaveLength(1)
})
it("rejects same-id wrong path and cross-contract receipts", async () => {
  const f = fixture()
  await expect(
    f.store.append(f.root, f.identity, [
      { ...f.receipt, artifacts: [{ ...f.receipt.artifacts[0], path: "another.md" }] }
    ])
  ).rejects.toThrow("CONTRACT_MISMATCH")
  await expect(
    f.store.append(f.root, f.identity, [{ ...f.receipt, contractDigest: "c".repeat(64) }])
  ).rejects.toThrow("CONTRACT_MISMATCH")
  await expect(
    f.store.append(f.root, f.identity, [{ ...f.receipt, artifacts: [] }])
  ).rejects.toThrow("CONTRACT_MISMATCH")
  expect(() => parseStageCheckReceipt({ ...f.receipt, permission: "allow" })).toThrow()
})
it("bounds receipts per unit and validates anchored safe patterns", async () => {
  const f = fixture()
  for (let i = 0; i < 8; i++)
    await f.store.append(
      f.root,
      f.identity,
      Array.from({ length: 32 }, () => f.receipt)
    )
  await expect(f.store.append(f.root, f.identity, [f.receipt])).rejects.toThrow("RECEIPT_LIMIT")
  const contract = {
    ...f.contract,
    artifacts: [{ id: "report", path: "reports/*.md", pattern: true }]
  }
  expect(stageCheckArtifactAllowed(contract, { id: "report", path: "reports/a.md" })).toBe(true)
  expect(stageCheckArtifactAllowed(contract, { id: "report", path: "other/a.md" })).toBe(false)
  expect(stageCheckArtifactAllowed(contract, { id: "report", path: "reports/nested/a.md" })).toBe(
    false
  )
  expect(canonicalStageCheckJson({ z: 1, a: { b: 2, a: 1 } })).toBe('{"a":{"a":1,"b":2},"z":1}')
})

it("persists transition intent and never replays an unknown interrupted writer", () => {
  const f = fixture()
  const first = f.store.beginTransition("run", "unit", "review.done", "c".repeat(64))
  expect(first.prior).toBeUndefined()
  expect(f.store.beginTransition("run", "unit", "review.done", "c".repeat(64)).prior?.status).toBe(
    "unknown"
  )
  expect(() => f.store.beginTransition("run", "unit", "other.done", "d".repeat(64))).toThrow(
    "UNRESOLVED"
  )
  f.store.settleTransition(first.id, {
    status: "committed",
    stateDigest: "e".repeat(64),
    receipts: [f.receipt]
  })
  expect(f.store.beginTransition("run", "unit", "review.done", "c".repeat(64)).prior?.status).toBe(
    "committed"
  )
})

it("matches recursive patterns at both direct and nested file levels and permits only declared pure checks", async () => {
  const f = fixture()
  const contract = {
    ...f.contract,
    artifacts: [{ id: "report", path: "folder/**/*", pattern: true }]
  }
  expect(stageCheckArtifactAllowed(contract, { id: "report", path: "folder/a.md" })).toBe(true)
  expect(stageCheckArtifactAllowed(contract, { id: "report", path: "folder/nested/a.md" })).toBe(
    true
  )
  f.store.freezeContracts("pure", "unit", [{ ...f.contract, artifacts: [], checkOnly: true }])
  await f.store.append(f.root, { ...f.identity, runId: "pure" }, [{ ...f.receipt, artifacts: [] }])
  expect(f.store.read("pure", "unit")).toHaveLength(1)
  const controller = new AbortController()
  controller.abort()
  await expect(
    f.store.append(f.root, f.identity, [f.receipt], { signal: controller.signal })
  ).rejects.toThrow()
  expect(f.store.read("run", "unit")).toHaveLength(0)
})
it("bounds the total unique file bytes in one validation batch", async () => {
  const f = fixture()
  const bytes = Buffer.alloc(4 * 1024 * 1024, 1)
  const artifacts = Array.from({ length: 5 }, (_, index) => ({
    id: "report",
    path: `file${index}.bin`,
    digest: runtimeDigest(bytes)
  }))
  for (const artifact of artifacts) writeFileSync(join(f.root, artifact.path), bytes)
  f.store.freezeContracts("large", "unit", [
    { ...f.contract, artifacts: [{ id: "report", path: "*.bin", pattern: true }] }
  ])
  await expect(
    f.store.append(f.root, { ...f.identity, runId: "large" }, [{ ...f.receipt, artifacts }])
  ).rejects.toThrow()
  expect(f.store.read("large", "unit")).toHaveLength(0)
})

it("deduplicates repeated artifact paths and rechecks authority before persisting", async () => {
  const f = fixture()
  const bytes = Buffer.alloc(4 * 1024 * 1024, 2)
  writeFileSync(join(f.root, "report.md"), bytes)
  const receipt = {
    ...f.receipt,
    artifacts: [{ ...f.receipt.artifacts[0], digest: runtimeDigest(bytes) }]
  }
  await f.store.validateReceipts(
    f.root,
    "run",
    "unit",
    Array.from({ length: 32 }, () => receipt)
  )
  await expect(
    f.store.append(f.root, f.identity, [receipt], {
      assertCurrent: () => {
        throw Error("REVOKED")
      }
    })
  ).rejects.toThrow("REVOKED")
  expect(f.store.read("run", "unit")).toHaveLength(0)
})
