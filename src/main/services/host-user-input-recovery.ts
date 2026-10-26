import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import {
  matchesThreadIncarnation,
  type ThreadIncarnation,
  type ThreadIncarnationRow
} from "./thread-incarnation"
import type { HostUserInputRecord } from "./host-user-input-store"

/** Read-only recovery admission. Success permits saving an answer, never restarting execution. */
export function isHostUserInputRecoverable(
  record: HostUserInputRecord,
  statePath: string,
  thread: ThreadIncarnationRow | null | undefined,
  isInstallationEnabled: (id: string) => boolean
): boolean {
  if (!existsSync(statePath)) return false
  const binding = record.binding
  let db: DatabaseSync | undefined
  try {
    if (!matchesThreadIncarnation(thread, JSON.parse(binding.incarnationKey) as ThreadIncarnation))
      return false
    const metadata = JSON.parse(thread?.metadata ?? "{}")
    const runtime = metadata.hostProjectRuntime
    if (
      runtime?.projectId !== binding.projectId ||
      runtime.operationId !== binding.operationId ||
      runtime.stageId !== binding.stageId ||
      runtime.pluginDigest !== binding.pluginDigest
    )
      return false
    if (!isInstallationEnabled(binding.installedPluginId)) return false
    db = new DatabaseSync(statePath, { readOnly: true })
    const projectRow = db
      .prepare("SELECT data FROM host_projects WHERE id=?")
      .get(binding.projectId)
    const operationRow = db
      .prepare("SELECT data FROM host_operations WHERE id=?")
      .get(binding.operationId)
    if (!projectRow || !operationRow) return false
    const project = JSON.parse(String(projectRow.data))
    const operation = JSON.parse(String(operationRow.data))
    return (
      project.projectId === binding.projectId &&
      project.version === binding.expectedVersion &&
      project.status === "active" &&
      typeof metadata.workspacePath === "string" &&
      isSameWorkspacePath(metadata.workspacePath, project.workspace) &&
      project.pluginDigest === binding.pluginDigest &&
      project.installedPluginId === binding.installedPluginId &&
      project.manifest.stages[project.stageIndex]?.id === binding.stageId &&
      operation.projectId === binding.projectId &&
      operation.operationId === binding.operationId &&
      operation.expectedVersion === binding.expectedVersion &&
      operation.stageId === binding.stageId &&
      operation.pluginDigest === binding.pluginDigest &&
      operation.inputFingerprint === binding.inputFingerprint &&
      operation.execution?.threadId === record.request.threadId &&
      operation.cancelRequestedAt === null &&
      ["started", "unknown"].includes(operation.status)
    )
  } catch {
    return false
  } finally {
    db?.close()
  }
}
