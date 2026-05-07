import {
  getEnabledPluginHookMetadata,
  getEnabledSkillHookMetadata,
  getEnabledHooks
} from "../storage"
import type { HookContext } from "./runner"
import type { HookConfig, HookEvent } from "./types"

export interface HookScopeSnapshot {
  activePluginIds: string[]
  activeSkillNames: string[]
  activeSkillPaths: string[]
}

export interface HookScopeController {
  readonly activePluginIds: ReadonlySet<string>
  readonly activeSkillNames: ReadonlySet<string>
  readonly activeSkillPaths: ReadonlySet<string>
  activatePlugin(pluginId?: string | null): void
  activateSkill(
    skillName?: string | null,
    pluginId?: string | null,
    skillPath?: string | null
  ): void
  snapshot(): HookScopeSnapshot
}

function normalizeSkillName(name: string | undefined | null): string {
  return name?.trim().toLowerCase() ?? ""
}

function normalizePluginId(pluginId: string | undefined | null): string {
  // Plugin ids come from manifests, UI input and providerKey parsing — keep
  // them comparable by lowercasing in line with skill-name normalization.
  return pluginId?.trim().toLowerCase() ?? ""
}

function normalizePathKey(path: string | undefined | null): string {
  const normalized = path?.trim().replace(/\\/g, "/").replace(/\/+$/, "") ?? ""
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
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

function pathSetIntersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true
  }
  return false
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

  return {
    activePluginIds,
    activeSkillNames,
    activeSkillPaths,
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
      if (normalizedPath) activeSkillPaths.add(normalizedPath)
    },
    snapshot() {
      return {
        activePluginIds: [...activePluginIds],
        activeSkillNames: [...activeSkillNames],
        activeSkillPaths: [...activeSkillPaths]
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
  const filteredPluginHooks =
    allowedPluginIds.size === 0
      ? []
      : pluginHooks.filter((hook) => allowedPluginIds.has(normalizePluginId(hook.pluginId)))

  const filteredSkillHooks =
    allowedSkillNames.size === 0 && allowedSkillPaths.size === 0
      ? []
      : skillHooks.filter((hook) => {
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
