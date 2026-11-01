import {
  onWorkspaceFilesChanged,
  onWorkspaceWatchStateChanged
} from "../../services/workspace-change-events"
import { workspaceWatchState } from "../../services/workspace-watcher"
import type { ModsManager } from "../manager"
import { createWorkspaceReadPolicy } from "./platform-workspace-policy"
import { createWorkspacePlatformProvider } from "./platform-workspace-provider"

/** Reuses the existing native watcher. Discovery and subscription never create one. */
export function createDesktopWorkspacePlatformProvider(manager: ModsManager) {
  const policy = createWorkspaceReadPolicy(manager)
  return createWorkspacePlatformProvider({
    state: workspaceWatchState,
    changed: onWorkspaceFilesChanged,
    lifecycle: onWorkspaceWatchStateChanged,
    authorizePath: policy,
    capturePolicy: policy.capture
  })
}
