import { isSameWorkspacePath, normalizeWorkspacePathKey } from "../../../shared/workspace-path"

export const WORKSPACE_TASK_CARD_CHANGED_EVENT = "cmb:workspace-task-card-changed"

export interface WorkspaceTaskCardChangedDetail {
  workspacePath: string
  cardNumber: string
}

export { isSameWorkspacePath }

/** @deprecated use normalizeWorkspacePathKey from shared/workspace-path */
export const normalizeWorkspacePathForCompare = normalizeWorkspacePathKey

export function emitWorkspaceTaskCardChanged(detail: WorkspaceTaskCardChangedDetail): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceTaskCardChangedDetail>(WORKSPACE_TASK_CARD_CHANGED_EVENT, {
      detail
    })
  )
}
