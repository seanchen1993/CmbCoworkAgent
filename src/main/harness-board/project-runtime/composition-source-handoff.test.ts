import { afterEach, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  captureSourceHandoffBaseline,
  collectSourceHandoffEvidence,
  readSourceHandoffContract
} from "./composition-source-handoff"
import { CompositionStageCheckStore } from "./composition-stage-check-store"
import { runtimeDigest } from "./safe-files"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "source-handoff-"))
  roots.push(workspace)
  mkdirSync(join(workspace, "src"))
  writeFileSync(join(workspace, "src/same.ts"), "export const stable = 1")
  writeFileSync(join(workspace, "src/modify.ts"), "export const before = 1")
  writeFileSync(join(workspace, "src/delete.ts"), "export const obsolete = 1")
  writeFileSync(join(workspace, "private-outside.txt"), "DO_NOT_EXPORT_OUTSIDE_DECLARED_SCOPE")
  return {
    workspace,
    contract: { apiVersion: "devclaw.source-handoff/v1" as const, scopes: ["src"] },
    packageDigest: "a".repeat(64)
  }
}
it("hands off actual added/modified code and deletion evidence only inside declared baseline scope", async () => {
  const f = fixture(),
    baseline = await captureSourceHandoffBaseline(f.workspace, f.packageDigest, f.contract)
  writeFileSync(join(f.workspace, "src/modify.ts"), "export const after = 2")
  writeFileSync(join(f.workspace, "src/new.ts"), "export const generated = 3")
  rmSync(join(f.workspace, "src/delete.ts"))
  const result = await collectSourceHandoffEvidence(
    f.workspace,
    f.packageDigest,
    f.contract,
    baseline
  )
  expect(result.changes).toEqual([
    {
      path: "src/delete.ts",
      change: "deleted",
      beforeDigest: runtimeDigest("export const obsolete = 1")
    },
    {
      path: "src/modify.ts",
      change: "modified",
      beforeDigest: runtimeDigest("export const before = 1"),
      digest: runtimeDigest("export const after = 2"),
      content: "export const after = 2"
    },
    {
      path: "src/new.ts",
      change: "added",
      digest: runtimeDigest("export const generated = 3"),
      content: "export const generated = 3"
    }
  ])
  expect(JSON.stringify(result)).not.toMatch(/same.ts|private-outside|DO_NOT_EXPORT/)
  expect(result.scope).toMatch(/not per-file acceptance/)
  expect(
    await collectSourceHandoffEvidence(f.workspace, f.packageDigest, f.contract, baseline)
  ).toEqual(result)
})
it("keeps native baselines immutable, package/run scoped and durable across reopening", async () => {
  const f = fixture(),
    path = join(f.workspace, "native.sqlite")
  const baseline = await captureSourceHandoffBaseline(f.workspace, f.packageDigest, f.contract)
  const store = new CompositionStageCheckStore(path)
  try {
    store.freezeSourceBaseline("run", "producer", baseline)
    store.freezeSourceBaseline("run", "producer", baseline)
    expect(store.sourceBaseline("other", "producer")).toBeUndefined()
    writeFileSync(join(f.workspace, "src/new.ts"), "actual code")
    const changed = await captureSourceHandoffBaseline(f.workspace, f.packageDigest, f.contract)
    expect(() => store.freezeSourceBaseline("run", "producer", changed)).toThrow("BASELINE_CHANGED")
  } finally {
    store.close()
  }
  const reopened = new CompositionStageCheckStore(path)
  try {
    expect(reopened.sourceBaseline("run", "producer")).toEqual(baseline)
    await expect(
      collectSourceHandoffEvidence(f.workspace, "b".repeat(64), f.contract, baseline)
    ).rejects.toThrow("BASELINE_CHANGED")
    await expect(
      collectSourceHandoffEvidence(
        f.workspace,
        f.packageDigest,
        { ...f.contract, scopes: ["other"] },
        baseline
      )
    ).rejects.toThrow("BASELINE_CHANGED")
    await expect(
      collectSourceHandoffEvidence(f.workspace, f.packageDigest, f.contract, undefined)
    ).rejects.toThrow("BASELINE_REQUIRED")
  } finally {
    reopened.close()
  }
})
it("never invents a baseline at terminal and refuses no-change, binary and oversized source sets", async () => {
  const f = fixture(),
    baseline = await captureSourceHandoffBaseline(f.workspace, f.packageDigest, f.contract)
  await expect(
    collectSourceHandoffEvidence(f.workspace, f.packageDigest, f.contract, baseline)
  ).rejects.toThrow("CHANGES_REQUIRED")
  writeFileSync(join(f.workspace, "src/binary.ts"), Buffer.from([0xff, 0, 0xfe]))
  await expect(
    collectSourceHandoffEvidence(f.workspace, f.packageDigest, f.contract, baseline)
  ).rejects.toThrow("TEXT_REQUIRED")
  rmSync(join(f.workspace, "src/binary.ts"))
  for (let i = 0; i < 129; i++) writeFileSync(join(f.workspace, `src/file-${i}.ts`), "bounded")
  await expect(
    captureSourceHandoffBaseline(f.workspace, f.packageDigest, f.contract)
  ).rejects.toThrow("ARTIFACT_LIMIT")
})
it("validates new explicit source contracts and leaves old packages without one unchanged", async () => {
  const f = fixture(),
    path = join(f.workspace, "devclaw.source-handoff.json")
  expect(await readSourceHandoffContract(f.workspace)).toBeUndefined()
  writeFileSync(path, JSON.stringify(f.contract))
  expect(await readSourceHandoffContract(f.workspace)).toEqual(f.contract)
  for (const scopes of [
    [".."],
    ["."],
    [".autobizdevops"],
    ["src", "SRC"],
    ["../outside"],
    ["src/**"]
  ]) {
    writeFileSync(path, JSON.stringify({ ...f.contract, scopes }))
    await expect(readSourceHandoffContract(f.workspace)).rejects.toThrow("CONTRACT_INVALID")
  }
})
