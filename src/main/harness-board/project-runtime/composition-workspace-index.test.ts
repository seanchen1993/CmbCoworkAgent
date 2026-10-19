import { afterEach, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessProjectMetadata } from "../../../shared/harness-board-types"
import type { PluginMetadata } from "../../types"
import { CompositionInternalProjects, type CompositionInternalProject } from "./composition-internal-projects"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { runtimeDigest } from "./safe-files"
import { readInternalHarnessProject, readInternalHarnessProjectWorkspaceIndex,
  captureInternalHarnessProjectIdentityGuard } from "../internal-project-context"
import { issueRuntimePluginSourceToken, withRuntimePluginSource,
  assertCurrentRuntimePluginSourceContent } from "../../plugins/runtime-source-scope"

const cleanup: Array<() => void> = []
afterEach(() => { for (const work of cleanup.splice(0).reverse()) work(); vi.restoreAllMocks() })
async function fixture(prepared = true) {
  const root = mkdtempSync(join(tmpdir(), "composition-workspace-index-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const installed = join(root, "installed"), workspace = join(root, "units", "unit")
  mkdirSync(join(installed, "board_core"), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(installed, "plugin.json"), '{"name":"original","version":"1.0.0"}')
  writeFileSync(join(installed, "board_core/board_config.json"), '{"apiVersion":1}')
  const snapshots = new RetainedPackageSnapshots(join(root, "snapshots"))
  const snapshot = snapshots.capture(installed)
  const plugin = { id: "installed-uuid", name: "original", version: "1.0.0", enabled: true,
    path: snapshot.root } as PluginMetadata
  let enabled = true, owner = "parent", currentUnit = "unit", fullReads = 0
  const originalCapture = RetainedPackageSnapshots.prototype.captureGuardAsync
  vi.spyOn(RetainedPackageSnapshots.prototype, "captureGuardAsync").mockImplementation(async function (this: RetainedPackageSnapshots, digest, signal) {
    const guard = await originalCapture.call(this, digest, signal)
    return () => { fullReads++; guard() }
  })
  const path = join(root, "internal.sqlite")
  const store = new CompositionInternalProjects(path, record => {
    if (!enabled || record.parentProjectId !== owner || record.unitId !== currentUnit)
      throw Error("original-owner-revoked")
  })
  cleanup.push(() => store.close())
  cleanup.push(store.register())
  if (prepared) await store.prepare(plugin, snapshot.digest)
  const parent = { projectId: "parent", name: "Original", description: "", projectCode: "P",
    projectDir: "parent", workspacePath: root, projectFromLean: false, systemId: "", systemName: "",
    "harness-adapter": { id: "parent-adapter", name: "Parent", type: "plugin" },
    lifecycle: { status: "active", createAt: "2026-10-17T00:00:00Z" } } as HarnessProjectMetadata
  const record = store.create({ parentProjectId: parent.projectId, compositionRunId: "run",
    unitId: "unit", featureId: "feature", goal: "Actual original goal", workspace, plugin,
    packageDigest: snapshot.digest }, parent)
  const change = (mutate: (record: CompositionInternalProject) => void) => {
    const db = new DatabaseSync(path)
    try {
      const row = db.prepare("SELECT data FROM internal_projects WHERE id=?").get(record.projectId)!
      const value = JSON.parse(String(row.data)) as CompositionInternalProject
      mutate(value)
      const data = JSON.stringify(value)
      db.prepare("UPDATE internal_projects SET data=?,digest=? WHERE id=?")
        .run(data, runtimeDigest(data), record.projectId)
    } finally { db.close() }
  }
  return { root, workspace, plugin, record, snapshot, snapshots, store, change,
    fullReads: () => fullReads, index: () => readInternalHarnessProjectWorkspaceIndex(record.projectId),
    disable: () => { enabled = false }, revokeParent: () => { owner = "other-parent" },
    replaceCurrentUnit: () => { currentUnit = "other-unit" } }
}

it("projects only original owner directories without re-reading retained content on routine getters", async () => {
  const f = await fixture(), before = f.fullReads()
  for (let count = 0; count < 100; count++) expect(f.index()).toEqual({
    projectId: f.record.projectId, featureId: "feature", workspace: f.workspace
  })
  expect(f.fullReads()).toBe(before)
  expect(readInternalHarnessProjectWorkspaceIndex("composition-legacy:foreign:unit")).toBeUndefined()
  expect(readInternalHarnessProjectWorkspaceIndex("ordinary-parent")).toBeUndefined()
  expect(readInternalHarnessProject(f.record.projectId)?.context.plugin?.path).toBe(f.snapshot.root)
  expect(f.fullReads()).toBeGreaterThan(before)
})

it.each(["disable", "revokeParent", "replaceCurrentUnit"] as const)("immediately rejects original %s revocation", async mode => {
  const f = await fixture()
  f[mode]()
  expect(() => f.index()).toThrow("original-owner-revoked")
})
it.each(["unit", "source"])("rejects a replaced %s directory even at the same original path", async kind => {
  const f = await fixture()
  const path = kind === "unit" ? f.workspace : f.snapshot.root
  renameSync(path, path + "-original")
  mkdirSync(path)
  expect(() => f.index()).toThrow(kind === "unit" ? "COMPOSITION_WORKSPACE_OWNER_CHANGED" : "COMPOSITION_INTERNAL_SOURCE_CHANGED")
})
it.each(["uuid", "source-digest", "unit-id"])("refuses changed %s record identity rather than guessing a directory", async kind => {
  const f = await fixture()
  f.change(record => {
    if (kind === "uuid") record.plugin.id = "another-installed-uuid"
    else if (kind === "source-digest") record.packageDigest = "e".repeat(64)
    else record.unitId = "another-unit"
  })
  expect(() => f.index()).toThrow()
})
it("requires original admitted source registration", async () => {
  const f = await fixture(false)
  expect(() => f.index()).toThrow("COMPOSITION_INTERNAL_SOURCE_NOT_ADMITTED")
})
it("retains the full original path for old rows without a captured directory identity", async () => {
  const f = await fixture()
  f.change(record => { delete record.workspaceIdentity })
  const before = f.fullReads()
  expect(f.index()?.workspace).toBe(f.workspace)
  expect(f.fullReads()).toBeGreaterThan(before)
  writeFileSync(join(f.snapshot.root, "plugin.json"), '{"name":"changed"}')
  expect(() => f.index()).toThrow("PACKAGE_CHANGED")
})
it("directory classification never replaces original opaque source checks at real execution boundaries", async () => {
  const f = await fixture()
  const guard = await f.snapshots.captureGuardAsync(f.snapshot.digest)
  const token = issueRuntimePluginSourceToken({ mode: "legacy", threadId: "original-thread",
    incarnationKey: "original-incarnation", projectId: f.record.projectId, operationId: "run",
    stageId: "stage", plugin: f.plugin, workspace: f.workspace, packageDigest: f.snapshot.digest },
  guard, captureInternalHarnessProjectIdentityGuard(f.record.projectId))
  withRuntimePluginSource(token, () => {
    writeFileSync(join(f.snapshot.root, "plugin.json"), '{"name":"changed-after-admission"}')
    expect(f.index()?.workspace).toBe(f.workspace)
    expect(() => assertCurrentRuntimePluginSourceContent()).toThrow("PACKAGE_CHANGED")
    expect(() => readInternalHarnessProject(f.record.projectId)).toThrow("PACKAGE_CHANGED")
  })
})
