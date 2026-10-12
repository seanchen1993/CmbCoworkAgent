import {
  getEnabledPluginHookMetadata,
  getEnabledSkillHookMetadata,
  getEnabledHooks,
  getEnabledPluginSkillSourceMetadata
} from "../storage"
import type { HookContext } from "./runner-core"
import type { HookConfig, HookEvent } from "./types"
import {
  isSkillVisibleForProjectMode,
  type ProjectModeSkillScope
} from "../../shared/skill-visibility"
import { normalizePathKey } from "./path-key"
import { filterScopedHooks, type HookScopeController, type ScopeSkipCallback } from "./scope-core"
export * from "./scope-core"

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

export function isSkillPathVisibleForProjectMode(
  skillPath: string | undefined | null,
  visibilityScope: ProjectModeSkillScope
): boolean {
  const key = normalizePathKey(skillPath)
  if (!key || !visibilityScope.projectMode) return true
  for (const source of getEnabledPluginSkillSourceMetadata()) {
    const root = normalizePathKey(source.pluginRoot)
    if (root && (key === root || key.startsWith(`${root}/`))) {
      return isSkillVisibleForProjectMode(source, visibilityScope)
    }
  }
  return true
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
