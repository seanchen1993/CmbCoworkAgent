import {
  getEnabledPluginHookMetadata,
  getEnabledSkillHookMetadata,
  getEnabledHooks,
  getEnabledPluginSkillSourceMetadata
} from "../storage"
import { hookMatchesRunCriteria, type HookContext } from "./runner"
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

export interface HookScopeOptions {
  initialPersistentHookKeys?: readonly string[]
  onPersistentHookKeysChanged?: (keys: readonly string[]) => void
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

export function createHookScope(options: HookScopeOptions = {}): HookScopeController {
  const activePluginIds = new Set<string>()
  const activeSkillNames = new Set<string>()
  const activeSkillPaths = new Set<string>()
  const persistentHookKeys = new Set<string>(
    options.initialPersistentHookKeys?.filter((key) => key.length > 0) ?? []
  )
  const notifyPersistentHookKeysChanged = (): void => {
    if (!options.onPersistentHookKeysChanged) return
    try {
      options.onPersistentHookKeysChanged([...persistentHookKeys])
    } catch (error) {
      console.warn("[Hooks] failed to persist hook scope keys:", error)
    }
  }

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
      let changed = false
      for (const hook of hooks) {
        if (hook.persistAfterInterrupt === true && hook.id) {
          const key = getPersistentHookKey(hook)
          if (!persistentHookKeys.has(key)) {
            persistentHookKeys.add(key)
            changed = true
          }
        }
      }
      if (changed) notifyPersistentHookKeysChanged()
    },
    activatePersistentHookKeys(keys) {
      let changed = false
      for (const key of keys) {
        if (key && !persistentHookKeys.has(key)) {
          persistentHookKeys.add(key)
          changed = true
        }
      }
      if (changed) notifyPersistentHookKeysChanged()
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

/**
 * Build a fresh child scope that inherits a point-in-time copy of `parent`'s
 * plugin/skill activations. Used when spawning a runtime that should see the
 * parent's hook scope (e.g. a coordinator worker inheriting the coordinator's
 * activations), so the child sees what the parent had active the same way a
 * task-tool subagent does — but isolated, since unlike a subagent (which shares
 * the parent's mutable scope instance) workers can run in parallel.
 *
 * The child is a deep, independent copy: it is seeded from `parent.snapshot()`
 * but backed by its own Sets, so later activations on either side never leak
 * into the other. This makes it safe to hand to concurrently-running children
 * without cross-contamination. The flip side is that activations the child
 * makes during its run stay local — they are never reflected back to the
 * parent or visible to sibling children.
 */
export function createInheritedHookScope(parent: HookScopeController): HookScopeController {
  const child = createHookScope()
  mergeHookScopeSnapshot(child, parent.snapshot())
  return child
}

/**
 * Resolve which enabled plugin owns a given skill path by matching it against
 * each plugin's skill-source roots. Returns the owning pluginId, or undefined
 * for a standalone / workspace skill.
 *
 * Used so a coordinator can activate a plugin's scope when the user
 * slash-selects one of its skills — without that pluginId, only the skill scope
 * would activate and the plugin's own (plugin-scoped) hooks would stay gated.
 */
export function resolvePluginIdForSkillPath(
  skillPath: string | undefined | null
): string | undefined {
  const key = normalizePathKey(skillPath)
  if (!key) return undefined
  for (const source of getEnabledPluginSkillSourceMetadata()) {
    const root = normalizePathKey(source.pluginRoot)
    if (root && (key === root || key.startsWith(`${root}/`))) return source.pluginId
  }
  return undefined
}

export interface ScopedHookCandidates {
  baseHooks: HookConfig[]
  /** Plugin hook entries also carry pluginName so the UI can show a friendly label. */
  pluginHooks: Array<HookConfig & { pluginId?: string; pluginName?: string }>
  skillHooks: Array<
    HookConfig & {
      pluginId?: string
      pluginName?: string
      skillName?: string
      skillPath?: string
    }
  >
}

export type ScopeSkipReason =
  | "plugin-not-active"
  | "skill-name-only-shadowed"
  | "skill-not-in-scope"

/**
 * Callback for diagnostic logging: notified when a hook MATCHED the event +
 * matcher but was filtered out by the scope rules. Lets us surface "the hook
 * exists but didn't fire here because <reason>" — the #1 source of confusion
 * when a user's plugin hook silently doesn't run.
 *
 * Wiring is opt-in: the renderer only enables this in Hook diagnostic mode so
 * normal runs don't accumulate the extra UI rows.
 */
export type ScopeSkipCallback = (
  hook: HookConfig & {
    pluginId?: string
    pluginName?: string
    skillName?: string
    skillPath?: string
  },
  reason: ScopeSkipReason
) => void

/**
 * Pure scope-filter step — split out so tests can drive every branch without
 * touching storage. `resolveEnabledHooksForRun` is a thin wrapper that pulls
 * the candidate lists from storage and delegates here.
 */
export function filterScopedHooks(
  candidates: ScopedHookCandidates,
  context: HookContext,
  scope?: HookScopeController,
  onSkipped?: ScopeSkipCallback,
  event?: HookEvent
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

  // Scope membership is the only criterion for inclusion; skipped diagnostics
  // additionally mirror runHooks' event/matcher/once checks so a run doesn't
  // report unrelated hooks as skipped for the current event.
  const shouldIncludePersistentHook = (hook: HookConfig): boolean =>
    hook.persistAfterInterrupt === true && scope.persistentHookKeys.has(getPersistentHookKey(hook))
  const notifySkipped = (
    hook: HookConfig & {
      pluginId?: string
      pluginName?: string
      skillName?: string
      skillPath?: string
    },
    reason: ScopeSkipReason
  ): void => {
    if (!onSkipped) return
    if (event && !hookMatchesRunCriteria(hook, event, context)) return
    onSkipped(hook, reason)
  }

  const filteredPluginHooks: typeof pluginHooks = []
  for (const hook of pluginHooks) {
    if (shouldIncludePersistentHook(hook)) {
      filteredPluginHooks.push(hook)
      continue
    }
    const isAllowed =
      allowedPluginIds.size > 0 && allowedPluginIds.has(normalizePluginId(hook.pluginId))
    if (isAllowed) {
      filteredPluginHooks.push(hook)
    } else {
      notifySkipped(hook, "plugin-not-active")
    }
  }

  const filteredSkillHooks: typeof skillHooks = []
  for (const hook of skillHooks) {
    if (shouldIncludePersistentHook(hook)) {
      filteredSkillHooks.push(hook)
      continue
    }
    if (allowedSkillNames.size === 0 && allowedSkillPaths.size === 0) {
      notifySkipped(hook, "skill-not-in-scope")
      continue
    }
    const hookSkillPaths = new Set<string>()
    addPathAliases(hookSkillPaths, hook.skillPath)
    const pathMatches = pathSetIntersects(hookSkillPaths, allowedSkillPaths)
    const hookPluginId = normalizePluginId(hook.pluginId)
    if (hookPluginId) {
      if (allowedPluginIds.has(hookPluginId) && pathMatches) {
        filteredSkillHooks.push(hook)
      } else {
        notifySkipped(hook, "skill-not-in-scope")
      }
      continue
    }
    if (pathMatches) {
      filteredSkillHooks.push(hook)
      continue
    }
    // Once any skill activation has contributed a path, fall back to name-only
    // matching is disabled — otherwise a name-only standalone hook could fire
    // for a different skill that just happens to share the name (the bug the
    // plugin/path scoping was added to fix). Only allow name fallback when
    // no path scope is active for this run.
    if (allowedSkillPaths.size > 0) {
      notifySkipped(hook, "skill-name-only-shadowed")
      continue
    }
    if (allowedSkillNames.has(normalizeSkillName(hook.skillName))) {
      filteredSkillHooks.push(hook)
    } else {
      notifySkipped(hook, "skill-not-in-scope")
    }
  }

  return [...baseHooks, ...filteredPluginHooks, ...filteredSkillHooks]
}

export function resolveEnabledHooksForRun(
  workspacePath: string | undefined,
  event: HookEvent,
  context: HookContext,
  scope?: HookScopeController,
  onSkipped?: ScopeSkipCallback
): HookConfig[] {
  return filterScopedHooks(
    {
      baseHooks: getEnabledHooks(workspacePath),
      pluginHooks: getEnabledPluginHookMetadata(),
      skillHooks: getEnabledSkillHookMetadata()
    },
    context,
    scope,
    onSkipped,
    event
  )
}
