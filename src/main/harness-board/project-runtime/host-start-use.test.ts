import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { HostProjectStore } from "./host-store"
import { HostProjectService, type HostProjectServiceDependencies } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  derivationContentIdentity,
  snapshotDerivationSource
} from "../../plugins/derivation-source"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((run) => run()))
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-start-use-"))
  const workspace = join(root, "workspace"),
    installed = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(installed)
  const manifest = hostProjectFixture(workspace).manifest
  writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(installed, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(join(installed, "skills", stage.id), { recursive: true })
    writeFileSync(join(installed, stage.skill!), "Keep actual stage checks.")
  }
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  let enabled = true
  const deps: HostProjectServiceDependencies = {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installed",
      root: installed,
      enabled,
      packageId: "docs",
      packageVersion: "1.0.0"
    }),
    authorize: vi.fn(async () => {}),
    executeSkill: vi.fn(async () => "succeeded" as const),
    prepareInputIdentity: vi.fn(async () => {})
  }
  const service = new HostProjectService(store, snapshots, deps)
  const expectedPlugin = {
    pluginId: "installed",
    name: "docs",
    version: "1.0.0",
    digest: derivationContentIdentity((await snapshotDerivationSource(installed)).files)
  }
  const input = {
    projectId: "new-project",
    name: "New project",
    goal: "Review actual artifacts",
    workspace,
    installedPluginId: "installed",
    expectedPlugin
  }
  return {
    root,
    installed,
    deps,
    service,
    store,
    input,
    disable: () => {
      enabled = false
    }
  }
}

it("creates an exact reviewed source without inheriting the diagnostic as execution approval", async () => {
  const f = await fixture()
  const project = await f.service.localCreate(f.input)
  expect(project).toMatchObject({
    projectId: "new-project",
    packageId: "docs",
    packageVersion: "1.0.0"
  })
  expect(project).not.toHaveProperty("expectedPlugin")
  expect(f.deps.authorize).not.toHaveBeenCalled()
  expect(f.deps.executeSkill).not.toHaveBeenCalled()
  expect(f.service.operations(project.projectId, 20)).toEqual([])
})

it("rejects same-version source changes between the start-use review and native creation", async () => {
  const f = await fixture()
  writeFileSync(join(f.installed, "skills/draft/SKILL.md"), "Changed after review")
  await expect(f.service.localCreate(f.input)).rejects.toThrow("PACKAGE_IDENTITY_MISMATCH")
  expect(f.store.listProjects(20)).toEqual([])
})

it.each(["source", "retained", "disable"])(
  "does not create after %s changes during native input preparation",
  async (change) => {
    const f = await fixture()
    f.deps.prepareInputIdentity = async (_project, retained) => {
      if (change === "disable") f.disable()
      else
        writeFileSync(
          join(change === "source" ? f.installed : retained, "skills/draft/SKILL.md"),
          "Changed during awaited native preparation"
        )
    }
    await expect(f.service.localCreate(f.input)).rejects.toThrow()
    expect(f.store.listProjects(20)).toEqual([])
    expect(f.deps.executeSkill).not.toHaveBeenCalled()
  }
)

it("does not accept another UUID, version, malformed digest or extra expected-identity field", async () => {
  const f = await fixture()
  for (const expectedPlugin of [
    { ...f.input.expectedPlugin, pluginId: "someone-else" },
    { ...f.input.expectedPlugin, version: "2.0.0" },
    { ...f.input.expectedPlugin, digest: "not-a-digest" },
    { ...f.input.expectedPlugin, grant: true }
  ])
    await expect(f.service.localCreate({ ...f.input, expectedPlugin })).rejects.toThrow()
  expect(f.store.listProjects(20)).toEqual([])
})

it("rejects an expired creator source after awaited native preparation without committing a project", async () => {
  const f = await fixture()
  let live = true
  f.deps.prepareInputIdentity = async () => {
    live = false
  }
  await expect(
    f.service.localCreate(f.input, () => {
      if (!live) throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
    })
  ).rejects.toThrow("PLUGIN_START_USE_SCOPE_CHANGED")
  expect(f.store.listProjects(20)).toEqual([])
})
