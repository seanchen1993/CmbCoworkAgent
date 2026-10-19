import type { HarnessProjectListItem } from "../../../../shared/harness-board-types"

export function findExistingPluginProject(
  projects: HarnessProjectListItem[],
  intent: { projectId?: string; pluginId: string }
): HarnessProjectListItem | null {
  if (!intent.projectId || !intent.pluginId) return null
  return (
    projects.find(
      (project) =>
        project.projectId === intent.projectId &&
        project.harnessAdapter.type === "plugin" &&
        project.harnessAdapter.id === intent.pluginId
    ) ?? null
  )
}
