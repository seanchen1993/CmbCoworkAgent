import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectCompositionStore } from "./composition-store"
import { HostProjectStore } from "./host-store"
import { LegacyOperationStore } from "./legacy-operation-store"
import { hostProjectFixture, prepareFixture } from "./host-fixtures.test-helper"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

it("shares composition ownership with real host and legacy admission transactions across connections", () => {
  const root = mkdtempSync(join(tmpdir(), "composition-shared-guard-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const composition = new ProjectCompositionStore(join(root, "composition.sqlite"))
  const other = new ProjectCompositionStore(join(root, "composition.sqlite"))
  const guard = <T>(workspace: string, work: () => T) =>
    composition.guardWorkspaceMutation(workspace, work)
  const host = new HostProjectStore(join(root, "host.sqlite"), undefined, undefined, guard)
  const legacy = new LegacyOperationStore(join(root, "legacy.sqlite"), undefined, undefined, guard)
  cleanup.push(
    () => composition.close(),
    () => other.close(),
    () => host.close(),
    () => legacy.close()
  )
  host.create(hostProjectFixture(root))
  legacy.enable({
    projectId: "legacy",
    workspace: root,
    installedPluginId: "installed",
    packageId: "author",
    packageVersion: "1",
    mods: null,
    packageDigest: "a".repeat(64)
  })
  const definition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent",
    workspace: root,
    units: [
      {
        id: "first",
        kind: "flow",
        source: { pluginId: "installed", capabilityId: "route", packageDigest: "a".repeat(64) },
        inputs: [],
        outputs: []
      }
    ]
  }
  const run = composition.create(definition, "request").run
  expect(() => host.prepare(prepareFixture())).toThrow("COMPOSITION_WORKSPACE_BUSY")
  expect(() =>
    legacy.admit({
      projectId: "legacy",
      featureId: "feature",
      workspace: root,
      installedPluginId: "installed",
      packageDigest: "a".repeat(64),
      threadId: "thread",
      threadIncarnation: "one",
      requestId: "request",
      inputDigest: "b".repeat(64)
    })
  ).toThrow("COMPOSITION_WORKSPACE_BUSY")
  expect(() => other.guardWorkspaceMutation(root, () => "other connection")).toThrow(
    "WORKSPACE_BUSY"
  )
  const prepared = composition.withWorkspaceOwner(run.id, () => host.prepare(prepareFixture()))
  expect(prepared.status).toBe("prepared")
  expect(() => host.start(prepared.operationId, prepared.inputFingerprint)).toThrow(
    "WORKSPACE_BUSY"
  )
  expect(
    composition.withWorkspaceOwner(run.id, () =>
      host.start(prepared.operationId, prepared.inputFingerprint)
    ).projectId
  ).toBe("local-docs")
})

it("checks existing original work under the composition mutex before taking a new lease", () => {
  const root = mkdtempSync(join(tmpdir(), "composition-original-busy-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let active = true
  const store = new ProjectCompositionStore(join(root, "composition.sqlite"), undefined, () => {
    if (active) throw Error("ORIGINAL_ENGINE_BUSY")
  })
  cleanup.push(() => store.close())
  const definition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent",
    workspace: root,
    units: [
      {
        id: "first",
        kind: "flow",
        source: { pluginId: "installed", capabilityId: "route", packageDigest: "a".repeat(64) },
        inputs: [],
        outputs: []
      }
    ]
  }
  expect(() => store.create(definition, "request")).toThrow("ORIGINAL_ENGINE_BUSY")
  active = false
  expect(store.create(definition, "request").created).toBe(true)
})

it("leaves unconfigured and unrelated original paths alone while rejecting leased aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "composition-compat-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectCompositionStore(join(root, "composition.sqlite"))
  cleanup.push(() => store.close())
  expect(store.guardWorkspaceMutation(join(root, "missing"), () => "old-path")).toBe("old-path")
  const workspace = join(root, "active")
  mkdirSync(workspace)
  const alias = join(root, "alias")
  symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir")
  store.create(
    {
      apiVersion: "devclaw.project-composition/v1",
      parentProjectId: "parent",
      workspace,
      units: [
        {
          id: "flow",
          kind: "flow",
          source: { pluginId: "plugin", capabilityId: "flow", packageDigest: "a".repeat(64) },
          inputs: [],
          outputs: []
        }
      ]
    },
    "request"
  )
  expect(store.guardWorkspaceMutation(join(root, "unrelated-missing"), () => "old-path")).toBe(
    "old-path"
  )
  expect(() => store.guardWorkspaceMutation(alias, () => "bypass")).toThrow("WORKSPACE_BUSY")
})
