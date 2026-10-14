import type { ModWorkspaceStatus } from "../../../../shared/mods/types"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"

export interface DevelopmentSetupApi {
  globalEnabled(): Promise<boolean>
  status(threadId: string): Promise<ModWorkspaceStatus>
  configureGlobal(enabled: boolean): Promise<boolean>
  configure(threadId: string, enabled: boolean, outputPolicy: boolean,
    expectedWorkspace: string): Promise<void>
}

/** Only called after the user explicitly requests the application/project switches. */
export async function prepareDevelopmentCreation(
  api: DevelopmentSetupApi,
  threadId: string,
  workspace: string,
  assertCurrent: () => void
): Promise<void> {
  let changed = false
  const verify = (status: ModWorkspaceStatus) => {
    assertCurrent()
    if (normalizeWorkspacePathKey(status.workspace) !== normalizeWorkspacePathKey(workspace))
      throw Error("DEVELOPMENT_SCOPE_CHANGED")
    if (status.recovery) throw Error("DEVELOPMENT_SETTINGS_RECOVERY")
  }
  try {
    assertCurrent()
    const globalEnabled = await api.globalEnabled()
    assertCurrent()
    const status = await api.status(threadId)
    verify(status)
    if (!globalEnabled) {
      changed = true
      const enabled = await api.configureGlobal(true)
      assertCurrent()
      if (!enabled) throw Error("DEVELOPMENT_SETTINGS_DISABLED")
    }
    // Re-read immediately before the workspace write; retain its current output policy.
    const current = await api.status(threadId)
    verify(current)
    if (!current.enabled) {
      changed = true
      await api.configure(threadId, true, current.outputPolicy, workspace)
      assertCurrent()
      const updated = await api.status(threadId)
      verify(updated)
      if (!updated.enabled) throw Error("DEVELOPMENT_SETTINGS_DISABLED")
    }
  } catch (error) {
    if (changed) throw Error("DEVELOPMENT_SETUP_PARTIAL", { cause: error })
    throw error
  }
}
