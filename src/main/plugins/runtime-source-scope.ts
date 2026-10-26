import { resolve, dirname, join, isAbsolute } from "node:path"
import type { AgentProfile } from "../agent/agent-registry"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { AsyncLocalStorage } from "node:async_hooks"
import type { PluginCapability } from "../../shared/plugin-capabilities"
import type { PluginMetadata } from "../types"
import type { StageRecoveryCommandPolicy } from "../harness-board/project-runtime/stage-recovery-policy"
import {
  acquireSnapshotPathLeases, withSnapshotPathRetention, type SnapshotLease
} from "../harness-board/project-runtime/snapshot-retention"

export interface RuntimeCapabilitySource {
  plugin: PluginMetadata
  capability: PluginCapability
  packageDigest: string
}

/** Host resolves these from retained package declarations and approved directory bindings. */
export interface RuntimeExecutionResources {
  profiles: AgentProfile[]
  workspaces: readonly { id: string; path: string }[]
  fingerprint: string
}

export interface RuntimePluginSourceBinding {
  /** Main-issued stage execution declaration and original input identity. */
  executionMode?: "normal" | "workflow"
  inputFingerprint?: string
  executionResources?: RuntimeExecutionResources
  /** Main-issued file-only debug admission, never reconstructed from thread metadata. */
  stageDebug?: { workspace: string; baselineId: string; allowPromptHooks?: boolean;
    commandHooks?: StageRecoveryCommandPolicy }
  /** Host-validated requirements belonging to the exact retained parent package. */
  requiredHooks?: readonly string[]
  mode?: "host" | "legacy" | "capabilities"
  capabilitySources?: readonly RuntimeCapabilitySource[]
  preserveParentContext?: boolean
  featureId?: string
  threadId: string
  incarnationKey: string
  projectId: string
  operationId: string
  workspace: string
  packageDigest: string
  stageId: string
  /** Host-generated stage instructions, never a renderer-supplied system prompt. */
  stagePrompt?: string
  /** Host-generated inheritable background/constraints, excluding the parent stage task. */
  subagentContextPrompt?: string
  /** Host-resolved required project context, retained through original model/child boundaries. */
  requiredContextText?: string
  plugin: PluginMetadata
}

export interface RuntimePluginSourceToken {
  readonly kind: "host-plugin-source"
}
const tokens = new WeakMap<RuntimePluginSourceToken, Readonly<RuntimePluginSourceBinding>>()
const bindingTokens = new WeakMap<Readonly<RuntimePluginSourceBinding>, RuntimePluginSourceToken>()
const assertions = new WeakMap<RuntimePluginSourceToken, () => void>()
const runtimeAssertions = new WeakMap<RuntimePluginSourceToken, () => void>()
const children = new WeakMap<RuntimePluginSourceToken, Map<string, () => void>>()
const custody = new WeakMap<RuntimePluginSourceToken, SnapshotLease>()
const retainedTokens = new FinalizationRegistry<SnapshotLease>((lease) => {
  try { lease.release() } catch { /* An uncertain lease is retained on disk. */ }
})
function snapshotPaths(binding: RuntimePluginSourceBinding): string[] {
  return [binding.plugin.path, ...(binding.capabilitySources ?? []).map((item) => item.plugin.path)]
}

/** Hold a deferred native owner until its physical work/close completes. */
export function retainRuntimePluginSourceToken(
  token: RuntimePluginSourceToken | undefined,
  reason: string,
  passive = false
): SnapshotLease {
  const binding = token && tokens.get(token)
  if (token && !binding) throw Error("PROJECT_PLUGIN_SOURCE_TOKEN_INVALID")
  return acquireSnapshotPathLeases(binding ? snapshotPaths(binding) : [], reason, passive)
}

function releaseTokenCustody(token: RuntimePluginSourceToken): void {
  custody.get(token)?.release()
  custody.delete(token)
  retainedTokens.unregister(token)
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const source = new AsyncLocalStorage<Readonly<RuntimePluginSourceBinding> | undefined>()

/** Main-only opaque admission projection. No authority callbacks: safe in Mods predicates. */
export function currentStageDebugSourcePolicy():
  Readonly<{ workspace: string; baselineId: string; snapshotRoot: string; allowPromptHooks?: boolean;
    commandHooks?: StageRecoveryCommandPolicy }> | undefined {
  const binding = source.getStore()
  return binding?.stageDebug ? { ...binding.stageDebug, snapshotRoot: binding.plugin.path } : undefined
}

/** Main-process only: the caller first verifies the retained package and thread incarnation. */
export function issueRuntimePluginSourceToken(
  binding: RuntimePluginSourceBinding,
  assertSource?: () => void,
  assertRuntime?: () => void
): RuntimePluginSourceToken {
  if (binding.executionMode !== undefined &&
      (binding.mode !== "host" || !["normal", "workflow"].includes(binding.executionMode)))
    throw Error("PROJECT_EXECUTION_MODE_INVALID")
  if (binding.inputFingerprint !== undefined &&
      (binding.mode !== "host" || !/^[a-f0-9]{64}$/.test(binding.inputFingerprint)))
    throw Error("PROJECT_EXECUTION_INPUT_IDENTITY_INVALID")
  const resources = binding.executionResources
  if (resources) {
    if (binding.mode !== "host" || !/^[a-f0-9]{64}$/.test(resources.fingerprint) ||
        !Array.isArray(resources.profiles) || resources.profiles.length > 32 ||
        !Array.isArray(resources.workspaces) || resources.workspaces.length > 16)
      throw Error("PROJECT_EXECUTION_RESOURCES_INVALID")
    const names = new Set<string>(), ids = new Set<string>()
    for (const profile of resources.profiles) {
      if (!profile || typeof profile.name !== "string" || !profile.name || names.has(profile.name) ||
          typeof profile.systemPrompt !== "string" || typeof profile.description !== "string" ||
          !["none", "read_only", "full"].includes(profile.shellAccess) ||
          !Array.isArray(profile.disallowedTools) || profile.disallowedTools.some(tool => typeof tool !== "string"))
        throw Error("PROJECT_EXECUTION_PROFILE_INVALID")
      if (profile.toolAllowlist !== undefined && (!Array.isArray(profile.toolAllowlist) ||
          profile.toolAllowlist.some(tool => typeof tool !== "string" || !tool)))
        throw Error("PROJECT_EXECUTION_PROFILE_INVALID")
      names.add(profile.name)
    }
    for (const workspace of resources.workspaces) {
      if (!workspace || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(workspace.id) ||
          ids.has(workspace.id) || typeof workspace.path !== "string" || !isAbsolute(workspace.path))
        throw Error("PROJECT_EXECUTION_WORKSPACE_INVALID")
      ids.add(workspace.id)
    }
  }
  const token = Object.freeze({ kind: "host-plugin-source" as const })
  const lease = acquireSnapshotPathLeases(snapshotPaths(binding), "issued-source-token", true)
  try { tokens.set(token, freeze(structuredClone(binding))) }
  catch (error) { lease.release(); throw error }
  bindingTokens.set(tokens.get(token)!, token)
  if (assertSource) assertions.set(token, assertSource)
  if (assertRuntime) runtimeAssertions.set(token, assertRuntime)
  custody.set(token, lease)
  retainedTokens.register(token, lease, token)
  return token
}

/** Every top-level run must call this, including normal runs with an explicit undefined token. */
export function withRuntimePluginSource<T>(
  token: RuntimePluginSourceToken | undefined,
  work: () => T
): T {
  const binding = token === undefined ? undefined : tokens.get(token)
  if (token !== undefined && !binding) throw Error("PROJECT_PLUGIN_SOURCE_TOKEN_INVALID")
  return withSnapshotPathRetention(binding ? snapshotPaths(binding) : [], () => {
    if (token) {
      if (binding?.mode !== "host") assertions.get(token)?.()
      runtimeAssertions.get(token)?.()
      // Transfer provisional custody only after this execution has acquired its own lease.
      releaseTokenCustody(token)
    }
    return source.run(binding, work)
  })
}

/** Lexical authority only. Loaded VM bytes need no filesystem read for routine getters. */
export function captureRuntimePluginSourceAuthorityGuard(): (() => void) | undefined {
  const token = captureRuntimePluginSourceToken()
  return token ? () => { runtimeAssertions.get(token)?.() } : undefined
}

/** Retains the original opaque capability for deferred SessionEnd, never reconstructs from metadata. */
export function captureRuntimePluginSourceToken(): RuntimePluginSourceToken | undefined {
  const binding = source.getStore()
  return binding ? bindingTokens.get(binding) : undefined
}

/** Content checks belong at execution/read boundaries, never routine catalog getters.
 * This is a check at this instant, not an OS lock against external writers.
 */
export function captureRuntimePluginSourceContentGuard(): (() => void) | undefined {
  const token = captureRuntimePluginSourceToken()
  if (!token) return undefined
  const lease = retainRuntimePluginSourceToken(token, "captured-content-guard")
  const guard = () => {
    runtimeAssertions.get(token)?.()
    assertions.get(token)?.()
    runtimeAssertions.get(token)?.()
  }
  retainedTokens.register(guard, lease)
  return guard
}

export function assertCurrentRuntimePluginSourceContent(): void {
  const token = captureRuntimePluginSourceToken()
  if (!token) return
  runtimeAssertions.get(token)?.()
  assertions.get(token)?.()
  runtimeAssertions.get(token)?.()
}

export function currentRuntimePluginSource(): Readonly<RuntimePluginSourceBinding> | undefined {
  const binding = source.getStore()
  const token = binding ? bindingTokens.get(binding) : undefined
  if (token) runtimeAssertions.get(token)?.()
  return binding
}

/** Called only by native runtime producers after claiming their real child lifetime. */
export function registerRuntimePluginSourceChild(
  parentThreadId: string,
  childThreadId: string,
  assertCurrent: () => void
): () => void {
  const binding = currentRuntimePluginSource()
  if (!binding || (binding.mode !== "legacy" && binding.mode !== "capabilities" && binding.mode !== "host")) return () => {}
  const token = bindingTokens.get(binding)!
  const parent = parentThreadId === binding.threadId
    ? undefined : children.get(token)?.get(parentThreadId)
  if ((binding.threadId !== parentThreadId && !parent) ||
      childThreadId === parentThreadId || childThreadId === binding.threadId)
    throw Error("LEGACY_CHILD_SCOPE_CHANGED")
  const assertChild = () => {
    runtimeAssertions.get(token)?.()
    if (parent) {
      if (children.get(token)?.get(parentThreadId) !== parent)
        throw Error("LEGACY_CHILD_ADMISSION_REVOKED")
      parent()
    }
    assertCurrent()
  }
  let entries = children.get(token)
  if (!entries) {
    entries = new Map()
    children.set(token, entries)
  }
  if (entries.has(childThreadId)) throw Error("LEGACY_CHILD_ALREADY_REGISTERED")
  assertChild()
  entries.set(childThreadId, assertChild)
  return () => {
    if (entries!.get(childThreadId) === assertChild) entries!.delete(childThreadId)
  }
}

/** Captured before runtime creation; later model boundaries cannot lose the identity fence. */
export function captureRuntimePluginSourceThreadGuard(
  threadId: string,
  workspace?: string
): () => void {
  const binding = currentRuntimePluginSource()
  if (!binding || (binding.mode !== "legacy" && binding.mode !== "capabilities" && binding.mode !== "host")) return () => {}
  const token = bindingTokens.get(binding)!
  const child = threadId === binding.threadId ? undefined : children.get(token)?.get(threadId)
  if (
    !workspace ||
    !isSameWorkspacePath(resolve(workspace), resolve(binding.workspace)) ||
    (threadId !== binding.threadId && !child)
  )
    throw Error("LEGACY_CHILD_ADMISSION_REQUIRED")
  const guard = () => {
    runtimeAssertions.get(token)?.()
    if (child) {
      if (children.get(token)?.get(threadId) !== child)
        throw Error("LEGACY_CHILD_ADMISSION_REVOKED")
      child()
    }
  }
  guard()
  return guard
}

/** Runtime readers only. Never use this projection for install catalog writes. */
export function projectRuntimePluginSources(plugins: readonly PluginMetadata[]): PluginMetadata[] {
  const binding = currentRuntimePluginSource()
  if (!binding) return [...plugins]
  if (binding.capabilitySources)
    return [
      ...new Map(
        [
          ...(binding.mode === "capabilities" && !binding.preserveParentContext
            ? []
            : [binding.plugin]),
          ...binding.capabilitySources.map((item) => item.plugin)
        ].map((plugin) => [plugin.id, { ...plugin }])
      ).values()
    ]
  // Keep the run's admitted snapshot even if an update changes the mutable installation later.
  const others = plugins.filter((plugin) => plugin.id !== binding.plugin.id)
  return [...others, { ...binding.plugin }]
}

/** Only host-issued native selections may widen a project beyond its single adapter. */
export function currentRuntimeCapabilitySources(): readonly RuntimeCapabilitySource[] | undefined {
  const binding = currentRuntimePluginSource()
  return binding?.capabilitySources
}

export function runtimeCapabilityAllowsPlugin(id: string | null | undefined): boolean | undefined {
  const binding = currentRuntimePluginSource()
  const sources = binding?.capabilitySources
  return sources
    ? sources.some((item) => item.plugin.id === id) ||
        ((binding?.mode !== "capabilities" || binding?.preserveParentContext === true) &&
          binding?.plugin.id === id)
    : undefined
}

export function runtimeCapabilitySkillSources() {
  return currentRuntimeCapabilitySources()?.map((item) => ({
    sourceDir: dirname(join(item.plugin.path, item.capability.entry)),
    pluginId: item.plugin.id,
    pluginName: item.plugin.name,
    pluginRoot: item.plugin.path,
    isProjectModePlugin: true,
    maxDepth: 0
  }))
}

export function runtimeCapabilityAllowsMcp(pluginId: string, server: string): boolean | undefined {
  const binding = currentRuntimePluginSource()
  const sources = binding?.capabilitySources
  // An unextended retained parent never borrows ambient installed/global MCP providers.
  if (binding && !sources) return binding.plugin.id === pluginId
  if (
    sources &&
    (binding?.mode !== "capabilities" || binding?.preserveParentContext === true) &&
    binding?.plugin.id === pluginId
  )
    return true
  return sources
    ? sources.some(
        (item) =>
          item.plugin.id === pluginId && item.capability.requiredMcpServers?.includes(server)
      )
    : undefined
}

/** Extend a verified original engine context without dropping its guards or stage identity. */
export function extendRuntimePluginSourceToken(
  original: RuntimePluginSourceToken,
  capabilitySources: readonly RuntimeCapabilitySource[],
  assertContent: () => void,
  assertRuntime: () => void
): RuntimePluginSourceToken {
  const binding = tokens.get(original)
  if (!binding || binding.mode === "capabilities")
    throw Error("PROJECT_PLUGIN_SOURCE_TOKEN_INVALID")
  const extended = issueRuntimePluginSourceToken(
    { ...binding, capabilitySources },
    () => {
      assertions.get(original)?.()
      assertContent()
    },
    () => {
      runtimeAssertions.get(original)?.()
      assertRuntime()
    }
  )
  releaseTokenCustody(original)
  return extended
}
