import { afterEach, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessProjectMetadata } from "../../../shared/harness-board-types"
import type { PluginMetadata } from "../../types"
import type { HostProjectService } from "./host-service"
import type { CompositionLegacyDependencies } from "./composition-legacy-adapter"
import { ProjectCompositionService } from "./composition-service"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { runtimeDigest } from "./safe-files"
import * as directoryFacts from "./safe-files"
import {
  captureInternalHarnessProjectIdentityGuard,
  readInternalHarnessProject,
  readInternalHarnessProjectWorkspaceIndex
} from "../internal-project-context"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  vi.restoreAllMocks()
})

async function fixture(cheap = true) {
  const root = mkdtempSync(join(tmpdir(), "composition-authority-read-"))
  cleanup.push(() => rmSync(root, { force: true, recursive: true }))
  const workspace = join(root, "parent"), unitWorkspace = join(root, "unit")
  const installed = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(unitWorkspace)
  mkdirSync(join(installed, "board_core"), { recursive: true })
  writeFileSync(join(installed, "board_core/board_config.json"), "{}")
  const snapshot = new RetainedPackageSnapshots(join(root, "packages")).capture(installed)
  const plugin = { id: "installed", name: "source", version: "1", path: snapshot.root,
    enabled: true } as PluginMetadata
  const parent = { projectId: "parent", name: "Parent", workspacePath: root, projectDir: "parent",
    projectCode: "parent", description: "", projectFromLean: false, systemId: "", systemName: "",
    "harness-adapter": { id: plugin.id, name: plugin.name, version: plugin.version, type: "plugin" },
    lifecycle: { status: "active", createAt: "2026-10-17T00:00:00Z" } } as HarnessProjectMetadata
  let enabled = true
  const full = vi.fn(() => { if (!enabled) throw Error("original-source-revoked") })
  const authority = vi.fn(() => { if (!enabled) throw Error("original-source-revoked") })
  const legacy = { assertCurrent: full, ...(cheap ? { assertAuthorityCurrent: authority } : {}) }
  const database = join(root, "composition.sqlite")
  const service = new ProjectCompositionService(database, {} as HostProjectService, {
    resolveSource: async () => { throw Error("No engine is launched by a classification read") },
    authorizeDefinition: async () => {}, authorizeParent: async () => {},
    authorize: async () => {}, beforeStart: () => {}, assertWorkspaceIdle: () => {},
    legacy: legacy as unknown as CompositionLegacyDependencies
  })
  cleanup.push(() => service.close())
  const created = service.store.create({ apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent", workspace, units: [{ id: "unit", kind: "flow",
      source: { pluginId: plugin.id, capabilityId: "flow", packageDigest: snapshot.digest },
      inputs: [], outputs: [] }] }, "request").run
  const run = service.store.claim(created.id, created.version)
  service.store.registerUnitWorkspace(run.id, "unit", unitWorkspace)
  const projects = service.legacy!.projects
  await projects.prepare(plugin, snapshot.digest)
  const record = service.store.withWorkspaceOwner(run.id, () => projects.create({
    parentProjectId: "parent", compositionRunId: run.id, unitId: "unit", featureId: "feature",
    goal: "Original user request", workspace: unitWorkspace, plugin, packageDigest: snapshot.digest
  }, parent))
  const mutate = (change: (run: typeof created) => void) => {
    const db = new DatabaseSync(database)
    try {
      const value = service.store.get(run.id)!
      change(value)
      db.prepare("UPDATE composition_runs SET data=? WHERE id=?")
        .run(JSON.stringify(value), run.id)
    } finally { db.close() }
  }
  const read = () => service.store.withWorkspaceOwner(run.id,
    () => readInternalHarnessProjectWorkspaceIndex(record.projectId))
  return { root, run, service, record, snapshot, projects, unitWorkspace, full, authority, mutate,
    read, revoke: () => { enabled = false } }
}

it("keeps repeated workspace and opaque authority reads free of mutation transactions and full callbacks", async () => {
  const f = await fixture()
  const mutation = vi.spyOn(f.service.store, "guardWorkspaceMutation")
  const readonly = vi.spyOn(f.service.store, "assertWorkspaceAuthority")
  const observations = vi.spyOn(directoryFacts, "runtimeDirectoryIdentity")
  f.full.mockClear()
  f.authority.mockClear()
  f.service.store.withWorkspaceOwner(f.run.id, () => {
    const guard = captureInternalHarnessProjectIdentityGuard(f.record.projectId)
    for (let index = 0; index < 100; index++) {
      expect(readInternalHarnessProjectWorkspaceIndex(f.record.projectId)?.workspace).toBe(f.unitWorkspace)
      guard()
    }
  })
  expect(f.authority).toHaveBeenCalledTimes(201)
  expect(readonly).toHaveBeenCalledTimes(201)
  expect(f.full).not.toHaveBeenCalled()
  expect(mutation).not.toHaveBeenCalled()
  expect(observations.mock.calls.filter(([path]) => path === f.unitWorkspace)).toHaveLength(201)
  expect(observations.mock.calls.filter(([path]) => path === f.snapshot.root)).toHaveLength(100)
  f.service.store.withWorkspaceOwner(f.run.id, () => readInternalHarnessProject(f.record.projectId))
  expect(f.full).toHaveBeenCalledTimes(1)
  expect(mutation).toHaveBeenCalledTimes(1)
  writeFileSync(join(f.snapshot.root, "board_core/board_config.json"), "changed")
  expect(f.read()?.workspace).toBe(f.unitWorkspace)
  expect(() => f.service.store.withWorkspaceOwner(f.run.id,
    () => readInternalHarnessProject(f.record.projectId))).toThrow("PACKAGE_CHANGED")
})

it("keeps old providers on their original current-source callback", async () => {
  const f = await fixture(false)
  f.full.mockClear()
  for (let index = 0; index < 20; index++) f.read()
  expect(f.full).toHaveBeenCalledTimes(20)
  expect(f.authority).not.toHaveBeenCalled()
})

it("rejects source revocation, missing async owner and physical directory replacement on the next read", async () => {
  const f = await fixture()
  expect(() => readInternalHarnessProjectWorkspaceIndex(f.record.projectId))
    .toThrow("COMPOSITION_WORKSPACE_OWNER_CHANGED")
  f.revoke()
  expect(() => f.read()).toThrow("original-source-revoked")
})

it.each(["parent", "digest", "unit-state", "unit-source"])("revalidates the real %s row, not a cached authority result", async kind => {
  const f = await fixture()
  f.read()
  f.mutate(run => {
    if (kind === "parent") run.definition.parentProjectId = "other"
    if (kind === "digest") run.definitionDigest = "b".repeat(64)
    if (kind === "unit-state") run.units[0].status = "unknown"
    if (kind === "unit-source") {
      run.definition.units[0].source.pluginId = "another-uuid"
      run.definitionDigest = runtimeDigest(JSON.stringify(run.definition))
    }
  })
  expect(() => f.read()).toThrow()
})

it("rejects same-path unit directory replacement in the read-only lease check", async () => {
  const f = await fixture()
  renameSync(f.unitWorkspace, f.unitWorkspace + "-original")
  mkdirSync(f.unitWorkspace)
  expect(() => f.service.store.withWorkspaceOwner(f.run.id,
    () => f.service.store.assertWorkspaceAuthority(f.unitWorkspace)))
    .toThrow("COMPOSITION_WORKSPACE_OWNER_CHANGED")
})

it("observes removal of the original lease without relying on a previously successful read", async () => {
  const f = await fixture()
  expect(f.read()?.workspace).toBe(f.unitWorkspace)
  const db = new DatabaseSync(join(f.root, "composition.sqlite"))
  try {
    db.prepare("DELETE FROM composition_leases WHERE run_id=?").run(f.run.id)
  } finally { db.close() }
  expect(() => f.read()).toThrow("COMPOSITION_WORKSPACE_OWNER_CHANGED")
})

it("does not reuse a previous physical observation across calls or an await", async () => {
  const f = await fixture()
  let guard!: () => void
  f.service.store.withWorkspaceOwner(f.run.id, () => {
    guard = captureInternalHarnessProjectIdentityGuard(f.record.projectId)
    guard()
  })
  await Promise.resolve()
  renameSync(f.unitWorkspace, f.unitWorkspace + "-original")
  mkdirSync(f.unitWorkspace)
  expect(() => f.read()).toThrow("COMPOSITION_WORKSPACE_OWNER_CHANGED")
  expect(() => f.service.store.withWorkspaceOwner(f.run.id, guard))
    .toThrow("COMPOSITION_WORKSPACE_OWNER_CHANGED")
})

it("rejects a symlink replacement through the original physical directory policy", async () => {
  const f = await fixture()
  renameSync(f.unitWorkspace, f.unitWorkspace + "-original")
  symlinkSync(f.unitWorkspace + "-original", f.unitWorkspace,
    process.platform === "win32" ? "junction" : "dir")
  expect(() => f.read()).toThrow("DIRECTORY_INVALID")
})

it.each(["unit", "path", "lease-owner", "record-inode"])("compares the same fresh observation against original %s bindings", async kind => {
  const f = await fixture()
  f.read()
  let foreignRunId: string | undefined
  if (kind === "lease-owner") {
    const otherWorkspace = join(f.root, "foreign-parent")
    mkdirSync(otherWorkspace)
    foreignRunId = f.service.store.create({ ...f.run.definition,
      parentProjectId: "foreign-parent", workspace: otherWorkspace }, "foreign-request").run.id
  }
  const db = new DatabaseSync(join(f.root, kind === "record-inode"
    ? "internal-projects.sqlite" : "composition.sqlite"))
  try {
    if (kind === "unit") db.prepare("UPDATE composition_unit_workspaces SET unit_id='foreign' WHERE run_id=?").run(f.run.id)
    else if (kind === "path") db.prepare("UPDATE composition_unit_workspaces SET directory_path=? WHERE run_id=?")
      .run(f.root, f.run.id)
    else if (kind === "lease-owner") {
      db.prepare("DELETE FROM composition_leases WHERE run_id=?").run(foreignRunId!)
      db.prepare("UPDATE composition_leases SET run_id=? WHERE run_id=?").run(foreignRunId!, f.run.id)
    }
    else {
      const row = db.prepare("SELECT data FROM internal_projects WHERE id=?").get(f.record.projectId)!
      const record = JSON.parse(String(row.data))
      record.workspaceIdentity = "another-original-inode"
      const data = JSON.stringify(record)
      db.prepare("UPDATE internal_projects SET data=?,digest=? WHERE id=?")
        .run(data, runtimeDigest(data), f.record.projectId)
    }
  } finally { db.close() }
  expect(() => f.read()).toThrow(kind === "unit" || kind === "path"
    ? "COMPOSITION_INTERNAL_SCOPE_CHANGED" : "COMPOSITION_WORKSPACE_OWNER_CHANGED")
})

it("keeps old identity-less records on the original full-content fallback", async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.root, "internal-projects.sqlite"))
  try {
    const row = db.prepare("SELECT data FROM internal_projects WHERE id=?").get(f.record.projectId)!
    const record = JSON.parse(String(row.data))
    delete record.workspaceIdentity
    const data = JSON.stringify(record)
    db.prepare("UPDATE internal_projects SET data=?,digest=? WHERE id=?")
      .run(data, runtimeDigest(data), f.record.projectId)
  } finally { db.close() }
  f.full.mockClear()
  expect(f.read()?.workspace).toBe(f.unitWorkspace)
  expect(f.full).toHaveBeenCalledTimes(1)
  f.service.store.withWorkspaceOwner(f.run.id, () => {
    const guard = captureInternalHarnessProjectIdentityGuard(f.record.projectId)
    writeFileSync(join(f.snapshot.root, "board_core/board_config.json"), "changed")
    expect(guard).toThrow("PACKAGE_CHANGED")
  })
})
