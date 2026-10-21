import type { HarnessProjectListItem } from "../../../shared/harness-board-types"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"

export interface InstalledProjectPlugin {
  id: string
  name: string
  version: string
  enabled: boolean
  path?: string
  updatedAt?: string
}

export const installedProjectPluginIdentity = (plugin: InstalledProjectPlugin) =>
  JSON.stringify([
    plugin.id,
    plugin.name,
    plugin.version,
    plugin.path,
    plugin.updatedAt,
    plugin.enabled
  ])

/** Diagnostic projection only. Native catalog/create still owns eligibility and identity checks. */
export function nativeProjectBindings(
  pluginId: string,
  workspace: string,
  available: readonly HarnessProjectListItem[],
  projects: readonly HarnessProjectListItem[],
  installed: InstalledProjectPlugin | undefined
) {
  const active = projects.filter(
    (project) =>
      project.lifecycle?.status !== "archived" &&
      project.harnessAdapter?.type === "plugin" &&
      project.harnessAdapter.id === pluginId
  )
  const eligible = new Set(available.map((project) => project.projectId))
  return active.map((project) => {
    const base = normalizeWorkspacePathKey(project.workspacePath)
    const directory = normalizeWorkspacePathKey(project.projectDir)
    const current = normalizeWorkspacePathKey(workspace)
    const sameWorkspace = !!base && (current === base || current === `${base}/${directory}`)
    const reason = !installed
      ? "missing"
      : !installed.enabled
        ? "disabled"
        : eligible.has(project.projectId)
          ? "available"
          : !project.boardCompatibility?.compatible
            ? "incompatible"
            : !sameWorkspace
              ? "other-workspace"
              : "unavailable"
    const boundVersion = project.harnessAdapter.boundVersion
    return {
      project,
      reason,
      sameWorkspace,
      versionChanged: !!installed && !!boundVersion && boundVersion !== installed.version,
      boundVersion
    }
  })
}
