import { afterEach, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { runtimeDigest } from "./safe-files"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CompositionInternalProjects } from "./composition-internal-projects"
import { RetainedPackageSnapshots } from "./package-snapshots"
import {
  readInternalHarnessProject,
  captureInternalHarnessProjectIdentityGuard
} from "../internal-project-context"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource,
  currentRuntimePluginSource,
  assertCurrentRuntimePluginSourceContent
} from "../../plugins/runtime-source-scope"
import type { HarnessProjectMetadata } from "../../../shared/harness-board-types"
import type { PluginMetadata } from "../../types"
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  vi.restoreAllMocks()
})
it("persists owned internal identity without a visible project and fences all original context reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "internal-legacy-project-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const installed = join(root, "installed")
  const workspace = join(root, "units", "unit")
  mkdirSync(join(installed, "board_core"), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(installed, "plugin.json"), '{"name":"original","version":"1"}')
  writeFileSync(join(installed, "board_core/board_config.json"), '{"apiVersion":1}')
  const snapshot = new RetainedPackageSnapshots(join(root, "snapshots")).capture(installed)
  let authorized = true
  const store = new CompositionInternalProjects(join(root, "internal.sqlite"), () => {
    if (!authorized) throw Error("owner-replaced")
  })
  cleanup.push(() => store.close())
  cleanup.push(store.register())
  const parent = {
    projectId: "visible-parent",
    name: "Project",
    description: "",
    projectCode: "P",
    projectFromLean: false,
    projectDir: "P",
    systemId: "system",
    systemName: "System",
    workspacePath: root,
    "harness-adapter": { id: "original", name: "original", version: "1", type: "plugin" },
    lifecycle: { status: "active", createAt: "2026-10-14T00:00:00Z" }
  } as HarnessProjectMetadata
  let guardReads = 0
  const capture = RetainedPackageSnapshots.prototype.captureGuardAsync
  vi.spyOn(RetainedPackageSnapshots.prototype, "captureGuardAsync").mockImplementation(
    async function (this: RetainedPackageSnapshots, digest, signal) {
      const guard = await capture.call(this, digest, signal)
      return () => {
        guardReads++
        guard()
      }
    }
  )
  await store.prepare({ path: snapshot.root } as PluginMetadata, snapshot.digest)
  const created = store.create(
    {
      parentProjectId: parent.projectId,
      compositionRunId: "run",
      unitId: "unit",
      featureId: "work",
      goal: "User's requested result",
      contextSelection: { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "e".repeat(64) },
      workspace,
      packageDigest: snapshot.digest,
      plugin: {
        id: "original",
        name: "original",
        version: "1",
        enabled: true,
        path: snapshot.root
      } as PluginMetadata
    },
    parent
  )
  expect(created.projectId).toBe("composition-legacy:run:unit")
  expect(readInternalHarnessProject(created.projectId)?.context.selectedDeployUnits).toMatchObject([
    { deployUnitId: "UNIT.ONE", localRepoPath: workspace }
  ])
  expect(readInternalHarnessProject(created.projectId)?.featureBinding.selectedDeployUnitMappings)
    .toEqual(readInternalHarnessProject(created.projectId)?.context.selectedDeployUnits)
  expect(readInternalHarnessProject(created.projectId)?.context.plugin?.path).toBe(snapshot.root)
  expect(readInternalHarnessProject(parent.projectId)).toBeUndefined()
  expect(parent.projectId).toBe("visible-parent")
  const identity = captureInternalHarnessProjectIdentityGuard(created.projectId)
  const sourceGuard = await new RetainedPackageSnapshots(join(root, "snapshots")).captureGuardAsync(
    snapshot.digest
  )
  const token = issueRuntimePluginSourceToken(
    {
      mode: "legacy",
      threadId: "thread",
      incarnationKey: "incarnation",
      projectId: created.projectId,
      operationId: "run",
      workspace,
      packageDigest: snapshot.digest,
      stageId: "stage",
      plugin: created.plugin
    },
    sourceGuard,
    identity
  )
  const before = guardReads
  withRuntimePluginSource(token, () => {
    for (let i = 0; i < 100; i++)
      expect(currentRuntimePluginSource()?.projectId).toBe(created.projectId)
    expect(guardReads - before).toBe(1)
    assertCurrentRuntimePluginSourceContent()
    expect(guardReads - before).toBe(2)
  })
  store.advance(created.projectId, "registered", "initializing")
  expect(() => identity()).not.toThrow()
  expect(() => store.advance(created.projectId, "registered", "initialized")).toThrow(
    "PHASE_CHANGED"
  )
  // Fresh identity checks are not a time cache. Ownership and immutable record changes fail immediately.
  authorized = false
  expect(() => identity()).toThrow("owner-replaced")
  expect(() => readInternalHarnessProject(created.projectId)).toThrow("owner-replaced")
  authorized = true
  const db = new DatabaseSync(join(root, "internal.sqlite"))
  const row = db.prepare("SELECT data FROM internal_projects WHERE id=?").get(created.projectId)!
  const value = JSON.parse(String(row.data))
  value.goal = "replaced goal"
  const changed = JSON.stringify(value)
  db.prepare("UPDATE internal_projects SET data=?,digest=? WHERE id=?").run(
    changed,
    runtimeDigest(changed),
    created.projectId
  )
  db.close()
  expect(() => identity()).toThrow("COMPOSITION_INTERNAL_IDENTITY_CHANGED")
  const currentIdentity = captureInternalHarnessProjectIdentityGuard(created.projectId)
  writeFileSync(join(snapshot.root, "plugin.json"), '{"name":"replacement"}')
  expect(() => currentIdentity()).not.toThrow()
  expect(() => sourceGuard()).toThrow("PACKAGE_CHANGED")
  expect(() => readInternalHarnessProject(created.projectId)).toThrow("PACKAGE_CHANGED")
})
