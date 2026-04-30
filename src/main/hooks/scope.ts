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
}

export interface HookScopeController {
  readonly activePluginIds: ReadonlySet<string>
  readonly activeSkillNames: ReadonlySet<string>
  activatePlugin(pluginId?: string | null): void
  activateSkill(skillName?: string | null, pluginId?: string | null): void
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

  return {
    activePluginIds,
    activeSkillNames,
    activatePlugin(pluginId) {
      const normalized = normalizePluginId(pluginId)
      if (normalized) activePluginIds.add(normalized)
    },
    activateSkill(skillName, pluginId) {
      const normalized = normalizeSkillName(skillName)
      if (normalized) activeSkillNames.add(normalized)
      const normalizedPluginId = normalizePluginId(pluginId)
      if (normalizedPluginId) activePluginIds.add(normalizedPluginId)
    },
    snapshot() {
      return {
        activePluginIds: [...activePluginIds],
        activeSkillNames: [...activeSkillNames]
      }
    }
  }
}

export function resolveEnabledHooksForRun(
  workspacePath: string | undefined,
  _event: HookEvent,
  context: HookContext,
  scope?: HookScopeController
): HookConfig[] {
  const baseHooks = getEnabledHooks(workspacePath)
  if (!scope) return baseHooks

  const allowedPluginIds = new Set(scope.activePluginIds)
  const currentPluginId = normalizePluginId(context.pluginId)
  if (currentPluginId) allowedPluginIds.add(currentPluginId)

  const allowedSkillNames = new Set(scope.activeSkillNames)
  const currentSkillName = normalizeSkillName(context.skillName)
  if (currentSkillName) allowedSkillNames.add(currentSkillName)

  // runHooks() filters by hook.enabled before dispatch, so we don't repeat that
  // here — keeping this resolver focused on scope/membership.
  const pluginHooks =
    allowedPluginIds.size === 0
      ? []
      : getEnabledPluginHookMetadata().filter((hook) =>
          allowedPluginIds.has(normalizePluginId(hook.pluginId))
        )

  const skillHooks =
    allowedSkillNames.size === 0
      ? []
      : getEnabledSkillHookMetadata().filter((hook) =>
          allowedSkillNames.has(normalizeSkillName(hook.skillName))
        )

  return [...baseHooks, ...pluginHooks, ...skillHooks]
}
