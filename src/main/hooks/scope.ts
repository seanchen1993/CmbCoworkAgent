import {
  getEnabledPluginHookMetadata,
  getEnabledSkillHookMetadata,
  getEnabledHooks
} from "../storage"
import type { HookContext } from "./runner"
import type { HookConfig, HookEvent } from "./types"
export { normalizePathKey } from "./path-key"
import { normalizePathKey } from "./path-key"

export interface HookScopeSnapshot {
  activePluginIds: string[]
  activeSkillNames: string[]
  activeSkillPaths: string[]
  persistentHookKeys?: string[]
}

export interface HookScopeController {
  readonly activePluginIds: ReadonlySet<string>
  readonly activeSkillNames: ReadonlySet<string>
  readonly activeSkillPaths: ReadonlySet<string>
  readonly persistentHookKeys: ReadonlySet<string>
  activatePlugin(pluginId?: string | null): void
  activateSkill(
    skillName?: string | null,
    pluginId?: string | null,
    skillPath?: string | null
  ): void
  activatePersistentHooks(hooks: readonly HookConfig[]): void
  activatePersistentHookKeys(keys: readonly string[]): void
  /**
   * Drop activations whose `shouldKeep` predicate returns false. Called at
   * HITL interrupt boundaries so that scopes without any opt-in
   * `persistAfterInterrupt` hook are reset back to the per-invoke default.
   *
   * Skill names are kept iff the corresponding skill (matched by name OR
   * path) is kept — name-only activation has no path to vote against, so we
   * only drop a name when no kept activation references it.
   */
  pruneActivations(predicates: {
    keepPluginId: (pluginId: string) => boolean
    keepSkillPath: (skillPath: string) => boolean
    keepSkillName: (skillName: string) => boolean
  }): void
  snapshot(): HookScopeSnapshot
}

// Normalizers are exported so other modules (e.g. ipc/agent prune-at-interrupt
// logic) can produce keys in the exact same shape that hookScope stores
// internally. Keep these functions strictly pure / deterministic.
export function normalizeSkillName(name: string | undefined | null): string {
  return name?.trim().toLowerCase() ?? ""
}

export function normalizePluginId(pluginId: string | undefined | null): string {
  // Plugin ids come from manifests, UI input and providerKey parsing — keep
  // them comparable by lowercasing in line with skill-name normalization.
  return pluginId?.trim().toLowerCase() ?? ""
}

function addNormalizedPathAlias(target: Set<string>, normalizedPath: string): void {
  if (!normalizedPath) return
  target.add(normalizedPath)
  const skillDocDir = normalizedPath.replace(/\/skill\.md$/i, "")
  if (skillDocDir !== normalizedPath) target.add(skillDocDir)
}

function addPathAliases(target: Set<string>, path: string | undefined | null): void {
  const normalized = normalizePathKey(path)
  if (!normalized) return
  addNormalizedPathAlias(target, normalized)
}

function addActiveSkillPath(target: Set<string>, normalizedPath: string): void {
  if (!normalizedPath) return
  target.add(normalizedPath)
  // macOS temp paths commonly round-trip through /var/folders/.../T while some
  // call sites compare pre-normalized lower-case keys. Keep this as an alias
  // rather than making all POSIX skill paths case-insensitive.
  if (process.platform === "darwin" && normalizedPath.startsWith("/var/folders/")) {
    target.add(normalizedPath.toLowerCase())
  }
}

function pathSetIntersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true
  }
  return false
}

function getPersistentHookKey(hook: HookConfig): string {
  const scopedHook = hook as HookConfig & {
    pluginId?: string
    skillPath?: string
    skillRoot?: string
  }
  return [
    hook.hookSourceType ?? "",
    normalizePathKey(hook.hookSourceRoot),
    normalizePathKey(hook.hookSourcePath),
    normalizePluginId(scopedHook.pluginId),
    normalizePathKey(scopedHook.skillPath ?? scopedHook.skillRoot),
    hook.id
  ].join("\u001f")
}

export function extractPluginIdFromProviderKey(providerKey?: string): string | undefined {
  if (!providerKey?.startsWith("plugin:")) return undefined
  const rest = providerKey.slice("plugin:".length)
  const slashIndex = rest.indexOf("/")
  const pluginId = (slashIndex >= 0 ? rest.slice(0, slashIndex) : rest).trim()
  return pluginId || undefined
}

export function createHookScope(): HookScopeController {
  const activePluginIds = new Set<string>()
  const activeSkillNames = new Set<string>()
  const activeSkillPaths = new Set<string>()
  const persistentHookKeys = new Set<string>()

  return {
    activePluginIds,
    activeSkillNames,
    activeSkillPaths,
    persistentHookKeys,
    activatePlugin(pluginId) {
      const normalized = normalizePluginId(pluginId)
      if (normalized) activePluginIds.add(normalized)
    },
    activateSkill(skillName, pluginId, skillPath) {
      const normalized = normalizeSkillName(skillName)
      if (normalized) activeSkillNames.add(normalized)
      const normalizedPluginId = normalizePluginId(pluginId)
      if (normalizedPluginId) activePluginIds.add(normalizedPluginId)
      const normalizedPath = normalizePathKey(skillPath)
      addActiveSkillPath(activeSkillPaths, normalizedPath)
    },
    activatePersistentHooks(hooks) {
      for (const hook of hooks) {
        if (hook.persistAfterInterrupt === true && hook.id) {
          persistentHookKeys.add(getPersistentHookKey(hook))
        }
      }
    },
    activatePersistentHookKeys(keys) {
      for (const key of keys) {
        if (key) persistentHookKeys.add(key)
      }
    },
    pruneActivations(predicates) {
      for (const id of [...activePluginIds]) {
        if (!predicates.keepPluginId(id)) activePluginIds.delete(id)
      }
      for (const path of [...activeSkillPaths]) {
        if (!predicates.keepSkillPath(path)) activeSkillPaths.delete(path)
      }
      for (const name of [...activeSkillNames]) {
        if (!predicates.keepSkillName(name)) activeSkillNames.delete(name)
      }
    },
    snapshot() {
      return {
        activePluginIds: [...activePluginIds],
        activeSkillNames: [...activeSkillNames],
        activeSkillPaths: [...activeSkillPaths],
        persistentHookKeys: [...persistentHookKeys]
      }
    }
  }
}

export function mergeHookScopeSnapshot(
  target: HookScopeController,
  snapshot: HookScopeSnapshot
): void {
  for (const pluginId of snapshot.activePluginIds) {
    target.activatePlugin(pluginId)
  }
  for (const skillPath of snapshot.activeSkillPaths) {
    target.activateSkill(undefined, undefined, skillPath)
  }
  for (const skillName of snapshot.activeSkillNames) {
    target.activateSkill(skillName)
  }
  target.activatePersistentHookKeys(snapshot.persistentHookKeys ?? [])
}

export interface ScopedHookCandidates {
  baseHooks: HookConfig[]
  pluginHooks: Array<HookConfig & { pluginId?: string }>
  skillHooks: Array<HookConfig & { pluginId?: string; skillName?: string; skillPath?: string }>
}

/**
 * Pure scope-filter step — split out so tests can drive every branch without
 * touching storage. `resolveEnabledHooksForRun` is a thin wrapper that pulls
 * the candidate lists from storage and delegates here.
 */
export function filterScopedHooks(
  candidates: ScopedHookCandidates,
  context: HookContext,
  scope?: HookScopeController
): HookConfig[] {
  const { baseHooks, pluginHooks, skillHooks } = candidates
  if (!scope) return baseHooks

  const allowedPluginIds = new Set(scope.activePluginIds)
  const currentPluginId = normalizePluginId(context.pluginId)
  if (currentPluginId) allowedPluginIds.add(currentPluginId)

  const allowedSkillNames = new Set(scope.activeSkillNames)
  const currentSkillName = normalizeSkillName(context.skillName)
  if (currentSkillName) allowedSkillNames.add(currentSkillName)
  const allowedSkillPaths = new Set<string>()
  for (const skillPath of scope.activeSkillPaths) {
    addPathAliases(allowedSkillPaths, skillPath)
  }
  addPathAliases(allowedSkillPaths, context.skillPath)
  addPathAliases(allowedSkillPaths, context.skillRoot)

  // runHooks() filters by hook.enabled before dispatch, so we don't repeat that
  // here — keeping this resolver focused on scope/membership.
  const shouldIncludePersistentHook = (hook: HookConfig): boolean =>
    hook.persistAfterInterrupt === true && scope.persistentHookKeys.has(getPersistentHookKey(hook))

  const filteredPluginHooks = pluginHooks.filter(
    (hook) =>
      shouldIncludePersistentHook(hook) ||
      (allowedPluginIds.size > 0 && allowedPluginIds.has(normalizePluginId(hook.pluginId)))
  )

  const filteredSkillHooks = skillHooks.filter((hook) => {
    if (shouldIncludePersistentHook(hook)) return true
    if (allowedSkillNames.size === 0 && allowedSkillPaths.size === 0) return false
    const hookSkillPaths = new Set<string>()
    addPathAliases(hookSkillPaths, hook.skillPath)
    const pathMatches = pathSetIntersects(hookSkillPaths, allowedSkillPaths)
    const hookPluginId = normalizePluginId(hook.pluginId)
    if (hookPluginId) {
      return allowedPluginIds.has(hookPluginId) && pathMatches
    }
    if (pathMatches) return true
    // Once any skill activation has contributed a path, fall back to name-only
    // matching is disabled — otherwise a name-only standalone hook could fire
    // for a different skill that just happens to share the name (the bug the
    // plugin/path scoping was added to fix). Only allow name fallback when
    // no path scope is active for this run.
    if (allowedSkillPaths.size > 0) return false
    return allowedSkillNames.has(normalizeSkillName(hook.skillName))
  })

  return [...baseHooks, ...filteredPluginHooks, ...filteredSkillHooks]
}

export function resolveEnabledHooksForRun(
  workspacePath: string | undefined,
  _event: HookEvent,
  context: HookContext,
  scope?: HookScopeController
): HookConfig[] {
  return filterScopedHooks(
    {
      baseHooks: getEnabledHooks(workspacePath),
      pluginHooks: getEnabledPluginHookMetadata(),
      skillHooks: getEnabledSkillHookMetadata()
    },
    context,
    scope
  )
}
