import type { HarnessDeployUnitMapping, HarnessSessionWorkspace } from "./harness-board-types"

export const MISSING_FEATURE_WORKSPACE =
  "该特性尚未配置会话工作区，请在「编辑特性配置」中配置后重试。"

export function resolveFeatureWorkspace(
  workspace: HarnessSessionWorkspace | undefined,
  selectedDeployUnits: readonly HarnessDeployUnitMapping[]
): string | undefined {
  if (workspace?.source === "directory") return workspace.path.trim() || undefined
  if (workspace?.source === "deployUnit") {
    return (
      selectedDeployUnits
        .find((item) => item.deployUnitId === workspace.deployUnitId)
        ?.localRepoPath.trim() || undefined
    )
  }
  return undefined
}
