/**
 * Skill visibility rules shared by renderer projections and main-process
 * runtime source assembly. A project-mode plugin is the only plugin category
 * that is restricted to the project's bound plugin.
 */
export interface SkillPluginVisibilityMetadata {
  pluginId?: string | null
  pluginName?: string | null
  isProjectModePlugin?: boolean
}

export interface ProjectModeSkillScope {
  projectMode: boolean
  boundPluginId?: string | null
  boundPluginName?: string | null
}

function normalizePluginIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ""
}

/** Whether a skill belongs to the currently bound plugin. IDs take precedence. */
export function isSkillOwnedByBoundPlugin(
  skill: SkillPluginVisibilityMetadata,
  scope: ProjectModeSkillScope
): boolean {
  const boundPluginId = normalizePluginIdentity(scope.boundPluginId)
  const boundPluginName = normalizePluginIdentity(scope.boundPluginName)
  if (boundPluginId) {
    return normalizePluginIdentity(skill.pluginId) === boundPluginId
  }
  return Boolean(boundPluginName && normalizePluginIdentity(skill.pluginName) === boundPluginName)
}

/**
 * Apply the project-mode skill policy. Standalone skills and non-project-mode
 * plugin skills remain visible; project-mode plugin skills require the bound
 * plugin identity.
 */
export function isSkillVisibleForProjectMode(
  skill: SkillPluginVisibilityMetadata,
  scope: ProjectModeSkillScope
): boolean {
  if (!scope.projectMode || skill.isProjectModePlugin !== true) return true
  return isSkillOwnedByBoundPlugin(skill, scope)
}
