import { createHash, randomUUID } from "node:crypto"
import { HARNESS_NAME_PATTERN } from "../../shared/harness-name"
import { realpathSync, lstatSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type {
  HarnessProjectCreateInput,
  HarnessNativeFeatureBinding,
  HarnessProjectMetadataUpdateInput
} from "../../shared/harness-board-types"
import type {
  HarnessProjectUseReview,
  HarnessProjectUseReviewInput
} from "../../shared/project-use-authorization"
import type { FunctionModsManager, RuntimeFunctionGrantScope } from "../mods/v2/manager"
import type { ModControlStore, ProjectUsePolicy } from "../mods/control-store"
import { SESSION_CAPABILITIES } from "../../shared/mods/v2/session-capabilities"
import { FUNCTION_HOST_REVISION } from "../../shared/mods/v2/contracts"
import { getOpenworkDir, getPlugins, getUserInfo } from "../storage"
import { userIdentityKey } from "../../shared/user-identity"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import {
  HostPackageSnapshots,
  capturePackageMetadataGuard
} from "./project-runtime/package-snapshots"
import { readProjectActionLock } from "./project-runtime/action-input"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import type { IpcMainInvokeEvent } from "electron"
import { runtimeDirectoryIdentity } from "./project-runtime/safe-files"

export interface ProjectUseWorkspaceControl {
  settingsStamp(workspace: string): string
  applicationStamp(): string
  globallyEnabled(): boolean
  enabled(workspace: string): boolean
  enable(workspace: string): void
  initialize(workspace: string): void
  enableApplication(): void
}
interface Runtime {
  manager: FunctionModsManager
  store: ModControlStore
  workspaceKey(workspace: string): string
  control: ProjectUseWorkspaceControl
}
export interface ProjectUseParentAuthority {
  projectId: string
  workspace: string
  installedPluginId: string
  active: boolean
  identity: string
}
interface Authority {
  parent(projectId: string): ProjectUseParentAuthority | undefined
  child(hostRunId: string): HarnessNativeFeatureBinding | undefined
  assertChild(binding: HarnessNativeFeatureBinding): void
}
let runtime: Runtime | undefined
let authority: Authority | undefined
let trustedOwner: ((event: IpcMainInvokeEvent) => object) | undefined
const ownerGuards = new WeakMap<object, () => void>()
const frameOwners = new WeakMap<object, { identity: string; owner: object }>()
const capabilityDigest = createHash("sha256")
  .update(JSON.stringify([FUNCTION_HOST_REVISION, SESSION_CAPABILITIES]))
  .digest("hex")
const pending = new Map<
  string,
  {
    owner: object
    input: string
    review: HarnessProjectUseReview
    policy: ProjectUsePolicy
    assertSources(): void
    applicationStamp: string
    settingsStamp: string
    expectedEpoch: number
    parentIdentity?: string
    existing: boolean
  }
>()
function fail(code = "PROJECT_USE_REVIEW_CHANGED"): never {
  throw Error(code)
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function configureProjectUseAuthority(value: Authority): void {
  authority = value
}

export function configureProjectUseIpcTrust(read: (event: IpcMainInvokeEvent) => object): void {
  trustedOwner = read
}

export function projectUseIpcOwner(event: IpcMainInvokeEvent): object {
  if (!trustedOwner) fail("PROJECT_USE_AUTHORIZATION_UNAVAILABLE")
  const frame = trustedOwner(event)
  const identity = userIdentityKey(getUserInfo() ?? null)
  let current = frameOwners.get(frame)
  if (!current || current.identity !== identity) {
    current = { identity, owner: {} }
    frameOwners.set(frame, current)
  }
  const { owner } = current
  ownerGuards.set(owner, () => {
    if (trustedOwner?.(event) !== frame || userIdentityKey(getUserInfo() ?? null) !== identity)
      fail("PROJECT_UNTRUSTED_SENDER")
  })
  return owner
}

export function configureProjectUseRuntime(value: Runtime): void {
  runtime = value
  value.manager.setProjectUseGrantResolver((input) => {
    const captured = projectUseScope(input.scope, input.workspace)
    if (!captured) return undefined
    const source = captured.receipt.policy.sources.find(
      (item) => item.name === input.name && item.pluginId === input.pluginId
    )
    if (!source || source.configurationOnly) return null
    return value.store.delegateProjectFunctionGrant(
      captured.receipt,
      input.workspace,
      source.pluginId,
      source.name,
      source.digest,
      captured.assertCurrent
    )
  })
}

function requireRuntime(): Runtime {
  if (!runtime) fail("PROJECT_USE_AUTHORIZATION_UNAVAILABLE")
  return runtime
}
function canonicalTarget(input: HarnessProjectUseReviewInput): string {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.adapterType !== "plugin" ||
    typeof input.adapterId !== "string" ||
    !input.adapterId ||
    input.adapterId.length > 512 ||
    typeof input.workspacePath !== "string" ||
    typeof input.projectDir !== "string" ||
    input.workspacePath.length > 4096 ||
    !isAbsolute(input.workspacePath) ||
    !HARNESS_NAME_PATTERN.test(input.projectDir) ||
    input.projectDir.length > 128
  )
    fail("PROJECT_INVALID_INPUT")
  const parent = realpathSync(input.workspacePath)
  if (!lstatSync(parent).isDirectory()) fail("PROJECT_INVALID_INPUT")
  const root = resolve(parent, input.projectDir)
  if (dirname(root) !== parent || root === parent) fail("PROJECT_INVALID_INPUT")
  return root
}
function reviewInput(input: HarnessProjectUseReviewInput): string {
  return JSON.stringify([
    input.adapterId,
    input.adapterType,
    canonicalTarget(input),
    input.expectedNativeTemplate,
    input.existingProjectId ?? null
  ])
}
/** Only this review accepts an absent child; ordinary runtime admission remains strict. */
function reviewWorkspace(input: HarnessProjectUseReviewInput, rt: Runtime) {
  const target = canonicalTarget(input)
  const parent = dirname(target)
  const parentIdentity = runtimeDirectoryIdentity(parent)
  const parentKey = rt.workspaceKey(parent)
  if (parentKey !== (process.platform === "win32" ? parent.toLowerCase() : parent)) fail()
  const planned = resolve(parentKey, basename(target))
  const workspace = process.platform === "win32" ? planned.toLowerCase() : planned
  let targetIdentity: string | undefined
  const assertCurrent = () => {
    if (runtimeDirectoryIdentity(parent) !== parentIdentity) fail()
    try {
      const current = runtimeDirectoryIdentity(target)
      if (targetIdentity !== undefined && current !== targetIdentity) fail()
      if (rt.workspaceKey(target) !== workspace) fail()
      targetIdentity = current
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error
      if (targetIdentity !== undefined || input.existingProjectId) fail()
    }
  }
  assertCurrent()
  return { workspace, assertCurrent }
}
function assertInstalled(policy: ProjectUsePolicy): void {
  if (policy.capabilityDigest !== capabilityDigest) fail("PROJECT_USE_SOURCE_CHANGED")
  const installed = getPlugins()
  for (const expected of policy.installedSources) {
    const current = installed.find((item) => item.id === expected.pluginId)
    if (
      !current?.enabled ||
      current.path !== expected.path ||
      current.name !== expected.name ||
      (current.version ?? "") !== expected.version
    )
      fail("PROJECT_USE_SOURCE_CHANGED")
  }
}

/** Static retained-source review only. No Guest, model, configuration or grant is created. */
export async function reviewProjectUse(
  input: HarnessProjectUseReviewInput,
  owner: object
): Promise<HarnessProjectUseReview> {
  ownerGuards.get(owner)?.()
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "adapterId",
          "adapterType",
          "workspacePath",
          "projectDir",
          "expectedNativeTemplate",
          "existingProjectId"
        ].includes(key)
    ) ||
    (input.existingProjectId !== undefined &&
      (typeof input.existingProjectId !== "string" ||
        !input.existingProjectId ||
        input.existingProjectId.length > 256))
  )
    fail("PROJECT_INVALID_INPUT")
  const rt = requireRuntime()
  const workspaceProof = reviewWorkspace(input, rt)
  const { workspace } = workspaceProof
  const parent = input.existingProjectId ? authority?.parent(input.existingProjectId) : undefined
  if (
    input.existingProjectId &&
    (!parent?.active ||
      parent.installedPluginId !== input.adapterId ||
      !isSameWorkspacePath(parent.workspace, workspace))
  )
    fail("PROJECT_USE_AUTHORIZATION_INVALID")
  const plugin = getPlugins().find((item) => item.id === input.adapterId)
  if (!plugin?.enabled) fail("PROJECT_PACKAGE_IDENTITY_MISMATCH")
  const original = await snapshotDerivationSource(plugin.path)
  const liveIdentity = {
    pluginId: plugin.id,
    name: plugin.name,
    version: plugin.version ?? "",
    digest: derivationContentIdentity(original.files)
  }
  const expected =
    input.expectedNativeTemplate ?? (input.existingProjectId ? liveIdentity : undefined)
  if (
    !expected ||
    expected.pluginId !== liveIdentity.pluginId ||
    expected.name !== liveIdentity.name ||
    expected.version !== liveIdentity.version ||
    expected.digest !== liveIdentity.digest
  )
    fail("PROJECT_PACKAGE_IDENTITY_MISMATCH")
  const inputKey = reviewInput({ ...input, expectedNativeTemplate: expected })
  const snapshots = new HostPackageSnapshots(join(getOpenworkDir(), "local-projects", "packages"))
  const snapshot = snapshots.capture(plugin.path)
  if (
    snapshot.manifest.mode !== "host" ||
    snapshot.manifest.plugin.id !== plugin.name ||
    snapshot.manifest.plugin.version !== plugin.version
  )
    fail("PROJECT_PACKAGE_IDENTITY_MISMATCH")
  const guards = [
    workspaceProof.assertCurrent,
    capturePackageMetadataGuard(plugin.path),
    capturePackageMetadataGuard(snapshot.root)
  ]
  const sources: HarnessProjectUseReview["sources"] = []
  const installedSources: ProjectUsePolicy["installedSources"] = [
    { pluginId: plugin.id, path: plugin.path, name: plugin.name, version: plugin.version ?? "" }
  ]
  const own = await rt.manager.projectUseSourceFacts({
    id: plugin.id,
    name: plugin.name,
    path: snapshot.root,
    enabled: true
  })
  if (own) {
    const { assertCurrent, ...facts } = own
    guards.push(assertCurrent)
    sources.push({ pluginId: plugin.id, ...facts, actionIds: [] })
  }
  const lock = readProjectActionLock(snapshot.root, snapshot.manifest)
  const providers = new Map<string, { name: string; digest: string; actionIds: string[] }>()
  for (const binding of lock.bindings) {
    const { ref } = binding
    const previous = providers.get(ref.pluginId)
    if (previous && (previous.name !== ref.plugin || previous.digest !== ref.digest))
      fail("PROJECT_ACTION_LOCK_MISMATCH")
    if (previous) previous.actionIds.push(ref.actionId)
    else
      providers.set(ref.pluginId, {
        name: ref.plugin,
        digest: ref.digest,
        actionIds: [ref.actionId]
      })
  }
  for (const [pluginId, provider] of [...providers].sort(([a], [b]) => a.localeCompare(b))) {
    const installed = getPlugins().find((item) => item.id === pluginId)
    if (!installed?.enabled) fail("PROJECT_DEPENDENCY_UNAVAILABLE")
    const facts = await rt.manager.projectUseSourceFacts(installed)
    if (
      !facts ||
      facts.configurationOnly ||
      facts.name !== provider.name ||
      facts.digest !== provider.digest
    )
      fail("PROJECT_DEPENDENCY_CHANGED")
    const { assertCurrent, ...metadata } = facts
    guards.push(assertCurrent)
    sources.push({ pluginId, ...metadata, actionIds: [...new Set(provider.actionIds)].sort() })
    installedSources.push({
      pluginId,
      path: installed.path,
      name: installed.name,
      version: installed.version ?? ""
    })
    guards.push(capturePackageMetadataGuard(installed.path))
  }
  if (new Set(sources.map((item) => item.name)).size !== sources.length)
    fail("PROJECT_ACTION_SOURCES_INVALID")
  const policyData = {
    projectId: input.existingProjectId ?? randomUUID(),
    workspace,
    plugin: structuredClone(expected),
    packageDigest: snapshot.digest,
    capabilityDigest,
    sources,
    installedSources
  }
  const policy: ProjectUsePolicy = { ...policyData, reviewDigest: hash(policyData) }
  const assertSources = () => {
    assertInstalled(policy)
    for (const guard of guards) guard()
  }
  assertSources()
  ownerGuards.get(owner)?.()
  const previous = rt.store.getProjectUseAuthorization(policy.projectId)
  if (parent && authority?.parent(parent.projectId)?.identity !== parent.identity) fail()
  const authorizationCurrent =
    !!input.existingProjectId &&
    previous?.enabled === true &&
    previous.policy.reviewDigest === policy.reviewDigest
  const now = Date.now()
  for (const [id, item] of pending) if (item.review.expiresAt <= now) pending.delete(id)
  if (pending.size >= 64) fail("PROJECT_USE_REVIEW_LIMIT")
  const executable = sources.some((source) => !source.configurationOnly)
  const requiresApplicationEnable =
    !authorizationCurrent && executable && !rt.control.globallyEnabled()
  const review: HarnessProjectUseReview = {
    reviewId: randomUUID(),
    reviewDigest: policy.reviewDigest,
    projectId: policy.projectId,
    workspace,
    plugin: structuredClone(expected),
    packageDigest: snapshot.digest,
    sources: structuredClone(sources),
    requiresApplicationEnable,
    ...(input.existingProjectId ? { authorizationCurrent } : {}),
    scopeNotice: executable
      ? "授权仅用于本项目通过原界面选择并由宿主登记的特性目录。确认将启用当前目录，可能恢复同目录其他聊天此前已授权的功能。" +
        (requiresApplicationEnable
          ? "本次还将开启应用插件功能，可能恢复此前已授权的其他功能。"
          : "")
      : (sources.length ? "本项目仅使用原生参数配置" : "此插件未声明额外插件代码") +
        "，不申请插件代码运行权限，也不更改应用或目录开关。",
    expiresAt: now + 15 * 60_000
  }
  pending.set(review.reviewId, {
    owner,
    input: inputKey,
    review,
    policy,
    assertSources,
    applicationStamp: rt.control.applicationStamp(),
    settingsStamp: rt.control.settingsStamp(workspace),
    expectedEpoch: previous?.epoch ?? 0,
    parentIdentity: parent?.identity,
    existing: !!input.existingProjectId
  })
  return structuredClone(review)
}

/** The pending review is window-owned and authorizes only the original project creation. */
export function prepareProjectUseCreation(input: HarnessProjectCreateInput, owner?: object) {
  return prepareProjectUseCommit(input, owner)
}

export function prepareProjectUseUpdate(
  projectId: string,
  input: HarnessProjectMetadataUpdateInput,
  owner?: object
) {
  return prepareProjectUseCommit(input, owner, projectId)
}

function prepareProjectUseCommit(
  input: HarnessProjectCreateInput | HarnessProjectMetadataUpdateInput,
  owner?: object,
  existingProjectId?: string
) {
  const rt = requireRuntime()
  const approval = input.projectUseApproval
  if (
    approval &&
    (typeof approval !== "object" ||
      Array.isArray(approval) ||
      Object.keys(approval).sort().join(",") !== "reviewDigest,reviewId" ||
      typeof approval.reviewId !== "string" ||
      !/^[a-f0-9]{64}$/.test(approval.reviewDigest))
  )
    fail("PROJECT_INVALID_INPUT")
  const item = approval && pending.get(approval.reviewId)
  const checked = item && {
    ...input,
    expectedNativeTemplate: item.policy.plugin,
    existingProjectId
  }
  if (
    !item ||
    !owner ||
    item.owner !== owner ||
    item.review.expiresAt <= Date.now() ||
    item.existing !== !!existingProjectId ||
    (existingProjectId && item.policy.projectId !== existingProjectId) ||
    item.review.reviewDigest !== approval!.reviewDigest ||
    item.input !== reviewInput(checked as HarnessProjectUseReviewInput)
  )
    fail("PROJECT_USE_REVIEW_REQUIRED")
  const assertCurrent = () => {
    ownerGuards.get(owner)?.()
    if (
      pending.get(item.review.reviewId) !== item ||
      item.review.expiresAt <= Date.now() ||
      (item.policy.sources.some((source) => !source.configurationOnly) &&
        (rt.control.applicationStamp() !== item.applicationStamp ||
          rt.control.settingsStamp(item.policy.workspace) !== item.settingsStamp))
    )
      fail()
    if (item.existing && authority?.parent(item.policy.projectId)?.identity !== item.parentIdentity)
      fail()
    item.assertSources()
  }
  assertCurrent()
  let committed = false
  let committedEpoch: number | undefined
  return {
    projectId: item.policy.projectId,
    assertCurrent,
    commit() {
      assertCurrent()
      committedEpoch = rt.store.saveProjectUseAuthorization(item.policy, item.expectedEpoch).epoch
      committed = true
    },
    rollback() {
      if (committed) rt.store.revokeProjectUseAuthorization(item.policy.projectId, committedEpoch)
      pending.delete(item.review.reviewId)
    },
    complete(): { state: "ready" | "enable-unconfirmed"; message?: string } {
      try {
        const assertPublished = () => {
          ownerGuards.get(owner)?.()
          item.assertSources()
          const receipt = rt.store.getProjectUseAuthorization(item.policy.projectId)
          const parent = authority?.parent(item.policy.projectId)
          if (
            !committed ||
            !receipt?.enabled ||
            receipt.epoch !== committedEpoch ||
            receipt.policy.reviewDigest !== item.policy.reviewDigest ||
            !parent?.active ||
            parent.installedPluginId !== item.policy.plugin.pluginId ||
            !isSameWorkspacePath(parent.workspace, item.policy.workspace)
          )
            fail()
        }
        assertPublished()
        const executable = item.policy.sources.some((source) => !source.configurationOnly)
        if (
          executable &&
          (rt.control.applicationStamp() !== item.applicationStamp ||
            rt.control.settingsStamp(item.policy.workspace) !== item.settingsStamp)
        )
          fail()
        if (!executable) return { state: "ready" }
        // Structural publication and the durable receipt precede both settings mutations.
        rt.control.enable(item.policy.workspace)
        assertPublished()
        if (item.review.requiresApplicationEnable) rt.control.enableApplication()
        if (!rt.control.globallyEnabled() || !rt.control.enabled(item.policy.workspace))
          fail("PROJECT_USE_ENABLE_UNCONFIRMED")
        return { state: "ready" }
      } catch {
        return {
          state: "enable-unconfirmed",
          message: "项目已创建，插件启用结果尚未确认。请重新打开项目核对应用及目录开关。"
        }
      } finally {
        pending.delete(item.review.reviewId)
      }
    }
  }
}

export function revokeProjectUseAuthorization(projectId: string): void {
  runtime?.store.revokeProjectUseAuthorization(projectId)
}

function projectUseScope(scope: RuntimeFunctionGrantScope, workspace: string) {
  const rt = requireRuntime()
  const child = authority?.child(scope.projectId)
  if (!child) {
    if (scope.projectId.startsWith("harness-feature:")) fail("PROJECT_USE_AUTHORIZATION_INVALID")
    return undefined // Ordinary/legacy/standalone sources retain their original contract.
  }
  const receipt = rt.store.getProjectUseAuthorization(child.projectId)
  if (!receipt) return undefined // Historical native projects have no fabricated owner consent.
  const parent = authority?.parent(child.projectId)
  const original = JSON.stringify(child)
  const parentIdentity = parent?.identity
  const assertCurrent = () => {
    const currentReceipt = rt.store.getProjectUseAuthorization(child.projectId)
    const currentParent = authority?.parent(child.projectId)
    const currentChild = authority?.child(scope.projectId)
    if (
      !receipt.enabled ||
      !currentReceipt?.enabled ||
      currentReceipt.epoch !== receipt.epoch ||
      currentReceipt.policy.reviewDigest !== receipt.policy.reviewDigest ||
      !currentParent?.active ||
      !currentChild ||
      currentParent.identity !== parentIdentity ||
      currentParent.installedPluginId !== receipt.policy.plugin.pluginId ||
      !isSameWorkspacePath(currentParent.workspace, receipt.policy.workspace) ||
      JSON.stringify(currentChild) !== original ||
      child.hostRunId !== scope.projectId ||
      scope.packageDigest !== receipt.policy.packageDigest ||
      !isSameWorkspacePath(rt.workspaceKey(child.workspace), workspace) ||
      child.installedPluginId !== receipt.policy.plugin.pluginId ||
      JSON.stringify(child.expectedPlugin) !== JSON.stringify(receipt.policy.plugin)
    )
      fail("PROJECT_USE_AUTHORIZATION_INVALID")
    assertInstalled(receipt.policy)
    authority!.assertChild(child)
  }
  assertCurrent()
  return { receipt, assertCurrent }
}

export function projectUseOwnsFeature(hostRunId: string): boolean {
  const child = authority?.child(hostRunId)
  return !!(child && runtime?.store.getProjectUseAuthorization(child.projectId))
}

/** Capture once for a physical Host stage, including stages with no executable Function Mod. */
export function captureProjectUseFeature(
  binding: HarnessNativeFeatureBinding
): (() => void) | undefined {
  const rt = requireRuntime()
  const receipt = rt.store.getProjectUseAuthorization(binding.projectId)
  if (!receipt) return undefined
  return projectUseScope(
    { projectId: binding.hostRunId, packageDigest: receipt.policy.packageDigest },
    rt.workspaceKey(binding.workspace)
  )?.assertCurrent
}

/** One initialization of a newly registered scope; an explicit directory off remains a tombstone. */
export function admitProjectUseFeature(binding: HarnessNativeFeatureBinding): void {
  const rt = requireRuntime()
  const receipt = rt.store.getProjectUseAuthorization(binding.projectId)
  if (!receipt) return
  const captured = projectUseScope(
    { projectId: binding.hostRunId, packageDigest: receipt.policy.packageDigest },
    rt.workspaceKey(binding.workspace)
  )
  if (!captured) fail("PROJECT_USE_AUTHORIZATION_INVALID")
  captured.assertCurrent()
  if (!receipt.policy.sources.some((source) => !source.configurationOnly)) return
  rt.control.initialize(rt.workspaceKey(binding.workspace))
  captured.assertCurrent()
}
