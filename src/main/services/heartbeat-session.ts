import {
  deleteThreadWorkerCheckpoints,
  deleteThreadWorkflowCheckpoints,
  purgeThreadCheckpointArtifacts
} from "../storage"
import { deleteThread as dbDeleteThread } from "../db"
import { deleteProjectThreadDataDirectory } from "../agent/context-history-path"
import { retireThreadCheckpointers } from "../agent/runtime"
import {
  clearTrustedToolFilePreviewSourcesForThread,
  collectTrustedToolFilePreviewScopeKeysForThread
} from "./trusted-tool-file-preview"

/** Fixed service-thread identity shared by heartbeat scheduling and cleanup. */
export const HEARTBEAT_THREAD_ID = "heartbeat"

/**
 * End the heartbeat incarnation bound to a previous workspace.
 *
 * A heartbeat workspace switch is a project boundary, not a session relocation:
 * carrying the fixed-id checkpoint forward would leave summary and large-result
 * references rooted in the previous workspace's app-managed directory. The IPC
 * owner stops scheduling and rejects active runs before calling this function.
 */
export async function resetHeartbeatSessionForWorkspaceChange(
  previousWorkDir: string
): Promise<void> {
  await retireThreadCheckpointers(HEARTBEAT_THREAD_ID)

  // Retire hot-sweeps the live parent checkpoint. These cold sweeps also remove
  // quarantine files and any crashed subagent leftovers before the fixed id is
  // revived by the next heartbeat run.
  purgeThreadCheckpointArtifacts(HEARTBEAT_THREAD_ID)
  deleteThreadWorkerCheckpoints(HEARTBEAT_THREAD_ID)
  deleteThreadWorkflowCheckpoints(HEARTBEAT_THREAD_ID)

  // Keep the DB row until filesystem cleanup succeeds. If cleanup fails, the
  // caller leaves the old config in place and the existing metadata remains a
  // truthful description of the still-configured workspace.
  await deleteProjectThreadDataDirectory(previousWorkDir, HEARTBEAT_THREAD_ID)
  const previewScopeKeys = collectTrustedToolFilePreviewScopeKeysForThread(HEARTBEAT_THREAD_ID)
  dbDeleteThread(HEARTBEAT_THREAD_ID)
  clearTrustedToolFilePreviewSourcesForThread(HEARTBEAT_THREAD_ID, previewScopeKeys)
}
