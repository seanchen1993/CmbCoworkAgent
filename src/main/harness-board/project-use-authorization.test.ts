import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import type {
  HarnessNativeFeatureBinding,
  HarnessProjectCreateInput
} from "../../shared/harness-board-types"
import type { HarnessProjectUseReviewInput } from "../../shared/project-use-authorization"
import type { PluginMetadata } from "../types"
import type { IpcMainInvokeEvent } from "electron"
import type { FunctionModsManager } from "../mods/v2/manager"
import { ModControlStore, type ModGrant } from "../mods/control-store"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import {
  configureProjectUseAuthority,
  configureProjectUseRuntime,
  reviewProjectUse,
  prepareProjectUseCreation,
  prepareProjectUseUpdate,
  admitProjectUseFeature,
  revokeProjectUseAuthorization,
  captureProjectUseFeature,
  configureProjectUseIpcTrust,
  projectUseIpcOwner,
  type ProjectUseParentAuthority
} from "./project-use-authorization"

const state = vi.hoisted(() => ({
  root: "",
  plugins: [] as PluginMetadata[],
  user: null as { sapId: string; token?: string } | null
}))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => state.plugins,
  getUserInfo: () => state.user
}))
let store: ModControlStore
let applicationEnabled: boolean
let applicationEpoch: number
let applicationEnables: number
let directoryEpoch: number
let parent: ProjectUseParentAuthority | undefined
let directories: Map<string, boolean>
let children: Map<string, HarnessNativeFeatureBinding>
let resolveGrant: (input: {
  workspace: string
  name: string
  pluginId?: string
  scope: { projectId: string; packageDigest: string }
}) => ModGrant | null | undefined
let input: HarnessProjectUseReviewInput
let configurationOnly: boolean
const owner = {}

beforeEach(async () => {
  state.root = await mkdtemp(join(canonicalTmpdir(), "project-use-api-"))
  state.user = null
  const root = join(state.root, "plugin")
  const template = createProjectTemplate({
    packageId: "generic-project",
    name: "Generic project",
    version: "1.0.0"
  })
  for (const file of template.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.text)
  }
  state.plugins = [
    {
      id: "exact-main-id",
      path: root,
      name: "generic-project",
      version: "1.0.0",
      enabled: true,
      description: "",
      author: "",
      skillCount: 1,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  store = new ModControlStore(join(state.root, "control.sqlite"))
  applicationEnabled = false
  applicationEpoch = 1
  applicationEnables = 0
  directoryEpoch = 1
  parent = undefined
  directories = new Map()
  children = new Map()
  configurationOnly = false
  configureProjectUseAuthority({
    parent: (id) => (parent?.projectId === id ? parent : undefined),
    child: (id) => children.get(id),
    assertChild: (binding) => {
      if (JSON.stringify(children.get(binding.hostRunId)) !== JSON.stringify(binding))
        throw Error("CHILD_CHANGED")
    }
  })
  const manager = {
    setProjectUseGrantResolver: (value: typeof resolveGrant) => {
      resolveGrant = value
    },
    projectUseSourceFacts: async () => ({
      name: "generic-project",
      digest: "d".repeat(64),
      configurationOnly,
      capabilities: configurationOnly ? [] : ["read_file"],
      assertCurrent: () => {}
    })
  } as unknown as FunctionModsManager
  configureProjectUseRuntime({
    manager,
    store,
    workspaceKey: (value) => {
      const actual = realpathSync(value)
      return process.platform === "win32" ? actual.toLowerCase() : actual
    },
    control: {
      applicationStamp: () => JSON.stringify([applicationEnabled, applicationEpoch]),
      settingsStamp: (workspace) =>
        JSON.stringify([directories.get(workspace) ?? null, directoryEpoch]),
      globallyEnabled: () => applicationEnabled,
      enabled: (workspace) => applicationEnabled && directories.get(workspace) === true,
      enableApplication: () => {
        applicationEnabled = true
        applicationEpoch++
        applicationEnables++
      },
      enable: (workspace) => {
        directories.set(workspace, true)
        directoryEpoch++
      },
      initialize: (workspace) => {
        if (!directories.has(workspace)) directories.set(workspace, true)
      }
    }
  })
  const snapshot = await snapshotDerivationSource(root)
  input = {
    adapterId: state.plugins[0].id,
    adapterType: "plugin",
    workspacePath: state.root,
    projectDir: "one",
    expectedNativeTemplate: {
      pluginId: state.plugins[0].id,
      name: state.plugins[0].name,
      version: "1.0.0",
      digest: derivationContentIdentity(snapshot.files)
    }
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  const root = await realpath(state.root)
  expect(dirname(root)).toBe(canonicalTmpdir())
  await rm(root, { recursive: true, force: true })
})
function creation(review: Awaited<ReturnType<typeof reviewProjectUse>>): HarnessProjectCreateInput {
  return {
    ...input,
    name: "One",
    projectCode: "ONE",
    projectFromLean: false,
    description: "",
    systemId: "system",
    systemName: "System",
    projectUseApproval: { reviewId: review.reviewId, reviewDigest: review.reviewDigest }
  }
}
async function publish(review: Awaited<ReturnType<typeof reviewProjectUse>>) {
  await mkdir(review.workspace, { recursive: true })
  parent = {
    projectId: review.projectId,
    workspace: review.workspace,
    installedPluginId: input.adapterId,
    active: true,
    identity: "published-parent"
  }
}
function child(review: Awaited<ReturnType<typeof reviewProjectUse>>, workspace = review.workspace) {
  const binding: HarnessNativeFeatureBinding = {
    engine: "host",
    projectId: review.projectId,
    featureId: "feature",
    hostRunId: `harness-feature:${review.projectId}`,
    title: "Feature",
    workspace,
    repositoryWorkspace: workspace,
    installedPluginId: input.adapterId,
    expectedPlugin: review.plugin,
    packageDigest: review.packageDigest
  }
  children.set(binding.hostRunId, binding)
  return binding
}

it("reviews without grants, Guest loading, enabling settings or requiring Feature configuration", async () => {
  const review = await reviewProjectUse(input, owner)
  expect(review.requiresApplicationEnable).toBe(true)
  expect(review.scopeNotice).toContain("原界面选择")
  expect(review.sources[0].digest).toBe("d".repeat(64))
  expect(store.getProjectUseAuthorization(review.projectId)).toBeUndefined()
  expect(applicationEnables).toBe(0)
  expect(directories.size).toBe(0)
})

it("keeps pure native configuration usable without opening application or directory execution", async () => {
  configurationOnly = true
  const review = await reviewProjectUse(input, owner)
  expect(review.requiresApplicationEnable).toBe(false)
  expect(review.scopeNotice).toContain("不更改")
  const prepared = prepareProjectUseCreation(creation(review), owner)
  prepared.commit()
  await publish(review)
  expect(prepared.complete().state).toBe("ready")
  admitProjectUseFeature(child(review))
  expect(applicationEnabled).toBe(false)
  expect(applicationEnables).toBe(0)
  expect(directories.size).toBe(0)
})

it("invalidates pending consent when retained source or original directory settings change", async () => {
  const first = await reviewProjectUse(input, owner)
  directoryEpoch++
  expect(() => prepareProjectUseCreation(creation(first), owner)).toThrow(
    "PROJECT_USE_REVIEW_CHANGED"
  )
  const next = await reviewProjectUse(input, owner)
  state.plugins[0] = { ...state.plugins[0], enabled: false }
  expect(() => prepareProjectUseCreation(creation(next), owner)).toThrow(
    "PROJECT_USE_SOURCE_CHANGED"
  )
  expect(store.getProjectUseAuthorization(next.projectId)).toBeUndefined()
  expect(applicationEnables).toBe(0)
})

it("captures owner revocation for pure Host stages and rejects an absent registered child", async () => {
  const review = await reviewProjectUse(input, owner)
  const prepared = prepareProjectUseCreation(creation(review), owner)
  prepared.commit()
  await publish(review)
  prepared.complete()
  const binding = child(review)
  const guard = captureProjectUseFeature(binding)!
  expect(() => guard()).not.toThrow()
  revokeProjectUseAuthorization(review.projectId)
  expect(() => guard()).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
  children.delete(binding.hostRunId)
  expect(() =>
    resolveGrant({
      workspace: binding.workspace,
      name: "generic-project",
      pluginId: input.adapterId,
      scope: { projectId: binding.hostRunId, packageDigest: review.packageDigest }
    })
  ).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
})

it("rejects different windows, changed directories, absent consent and changed global epochs", async () => {
  const review = await reviewProjectUse(input, owner)
  expect(() => prepareProjectUseCreation(creation(review), {})).toThrow(
    "PROJECT_USE_REVIEW_REQUIRED"
  )
  expect(() =>
    prepareProjectUseCreation({ ...creation(review), projectDir: "other" }, owner)
  ).toThrow("PROJECT_USE_REVIEW_REQUIRED")
  expect(() =>
    prepareProjectUseCreation({ ...creation(review), projectUseApproval: undefined }, owner)
  ).toThrow("PROJECT_USE_REVIEW_REQUIRED")
  applicationEpoch++ // Even off -> off invalidates the original consent.
  expect(() => prepareProjectUseCreation(creation(review), owner)).toThrow(
    "PROJECT_USE_REVIEW_CHANGED"
  )
  expect(applicationEnables).toBe(0)
})

it("publishes a durable owner before enabling and delegates exact sources without ordinary grants", async () => {
  const review = await reviewProjectUse(input, owner)
  const prepared = prepareProjectUseCreation(creation(review), owner)
  prepared.commit()
  expect(applicationEnables).toBe(0)
  await publish(review)
  expect(prepared.complete()).toEqual({ state: "ready" })
  expect(applicationEnables).toBe(1)
  const binding = child(review)
  admitProjectUseFeature(binding)
  const grant = resolveGrant({
    workspace: binding.workspace,
    name: "generic-project",
    pluginId: input.adapterId,
    scope: { projectId: binding.hostRunId, packageDigest: review.packageDigest }
  })!
  expect(grant?.sourceScope).toContain("project-use:")
  expect(store.getGrant(binding.workspace, "function:generic-project")).toBeNull()
  expect(() => store.assertGrant(grant)).not.toThrow()
  expect(
    resolveGrant({
      workspace: binding.workspace,
      name: "generic-project",
      pluginId: "same-name-other-install",
      scope: { projectId: binding.hostRunId, packageDigest: review.packageDigest }
    })
  ).toBeNull()
  parent = { ...parent!, active: false }
  expect(() => store.assertGrant(grant)).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
  expect(() =>
    resolveGrant({
      workspace: binding.workspace,
      name: "generic-project",
      pluginId: input.adapterId,
      scope: { projectId: binding.hostRunId, packageDigest: review.packageDigest }
    })
  ).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
})

it("does not enable on rollback or an unpublished project and reports partial publication honestly", async () => {
  const review = await reviewProjectUse(input, owner)
  const prepared = prepareProjectUseCreation(creation(review), owner)
  prepared.commit()
  expect(prepared.complete().state).toBe("enable-unconfirmed")
  expect(applicationEnables).toBe(0)
  const next = await reviewProjectUse({ ...input, projectDir: "two" }, owner)
  const failed = prepareProjectUseCreation({ ...creation(next), projectDir: "two" }, owner)
  failed.commit()
  failed.rollback()
  expect(store.getProjectUseAuthorization(next.projectId)?.enabled).toBe(false)
  expect(applicationEnables).toBe(0)
})

it("keeps explicit directory/global off when a later Feature is registered", async () => {
  const review = await reviewProjectUse(input, owner)
  const prepared = prepareProjectUseCreation(creation(review), owner)
  prepared.commit()
  await publish(review)
  prepared.complete()
  const path = join(state.root, "selected-feature")
  await mkdir(path)
  const key = process.platform === "win32" ? path.toLowerCase() : path
  directories.set(key, false)
  applicationEnabled = false
  applicationEpoch++
  admitProjectUseFeature(child(review, path))
  expect(directories.get(key)).toBe(false)
  expect(applicationEnabled).toBe(false)
  expect(applicationEnables).toBe(1)
})

it("reauthorizes an existing exact project only through its original update and advances its epoch", async () => {
  const first = await reviewProjectUse(input, owner)
  const created = prepareProjectUseCreation(creation(first), owner)
  created.commit()
  await publish(first)
  created.complete()
  const before = store.getProjectUseAuthorization(first.projectId)!
  revokeProjectUseAuthorization(first.projectId)
  const review = await reviewProjectUse(
    { ...input, expectedNativeTemplate: undefined, existingProjectId: first.projectId },
    owner
  )
  expect(review.projectId).toBe(first.projectId)
  expect(review.authorizationCurrent).toBe(false)
  const edit = prepareProjectUseUpdate(first.projectId, creation(review), owner)
  edit.commit()
  expect(edit.complete().state).toBe("ready")
  expect(store.getProjectUseAuthorization(first.projectId)!.epoch).toBeGreaterThan(before.epoch)
  expect(() => prepareProjectUseCreation(creation(review), owner)).toThrow(
    "PROJECT_USE_REVIEW_REQUIRED"
  )
  expect(applicationEnables).toBe(1)
})

it("recognizes existing consent without reopening explicit application or directory switches", async () => {
  const first = await reviewProjectUse(input, owner)
  expect(first.authorizationCurrent).toBeUndefined()
  const created = prepareProjectUseCreation(creation(first), owner)
  created.commit()
  await publish(first)
  created.complete()
  const before = store.getProjectUseAuthorization(first.projectId)!
  applicationEnabled = false
  applicationEpoch++
  directories.set(first.workspace, false)
  directoryEpoch++
  const review = await reviewProjectUse(
    { ...input, expectedNativeTemplate: undefined, existingProjectId: first.projectId },
    owner
  )
  expect(review.authorizationCurrent).toBe(true)
  expect(review.requiresApplicationEnable).toBe(false)
  expect(applicationEnabled).toBe(false)
  expect(directories.get(first.workspace)).toBe(false)
  expect(applicationEnables).toBe(1)
  expect(store.getProjectUseAuthorization(first.projectId)).toEqual(before)
})

it("binds pending reviews to account identity in the same frame while allowing token refresh", async () => {
  const frame = {}
  configureProjectUseIpcTrust(() => frame)
  const event = {} as IpcMainInvokeEvent
  state.user = { sapId: "account-a", token: "first" }
  const trusted = projectUseIpcOwner(event)
  const first = await reviewProjectUse(input, trusted)
  state.user = { sapId: "account-a", token: "refreshed" }
  expect(projectUseIpcOwner(event)).toBe(trusted)
  expect(() => prepareProjectUseCreation(creation(first), trusted)).not.toThrow()
  state.user = { sapId: "account-b" }
  const other = projectUseIpcOwner(event)
  expect(other).not.toBe(trusted)
  expect(() => prepareProjectUseCreation(creation(first), trusted)).toThrow(
    "PROJECT_UNTRUSTED_SENDER"
  )
  expect(() => prepareProjectUseCreation(creation(first), other)).toThrow(
    "PROJECT_USE_REVIEW_REQUIRED"
  )
  expect(applicationEnables).toBe(0)
})

it("does not enable after owner revocation or an account change during structural publication", async () => {
  const first = await reviewProjectUse(input, owner)
  const prepared = prepareProjectUseCreation(creation(first), owner)
  prepared.commit()
  await publish(first)
  revokeProjectUseAuthorization(first.projectId)
  expect(prepared.complete().state).toBe("enable-unconfirmed")
  expect(applicationEnables).toBe(0)
  expect(directories.size).toBe(0)
  configureProjectUseIpcTrust(() => owner)
  const event = {} as IpcMainInvokeEvent
  const trusted = projectUseIpcOwner(event)
  const next = await reviewProjectUse({ ...input, projectDir: "another" }, trusted)
  const second = prepareProjectUseCreation({ ...creation(next), projectDir: "another" }, trusted)
  second.commit()
  await publish(next)
  state.user = { sapId: "another-account" }
  expect(second.complete().state).toBe("enable-unconfirmed")
  expect(applicationEnables).toBe(0)
  expect(directories.size).toBe(0)
})
