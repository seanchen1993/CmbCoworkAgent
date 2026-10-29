import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type { HostProjectOperation, HostProjectState } from "../../../shared/project-runtime/host-types"
import { projectCreatorTrialJourney, type CreatorTrialProjectReference } from "./creator-trial-journey"

/** Observation provenance only. Parsing this never recreates a preview, approval or execution lease. */
export function readProjectTrialReference(value: unknown): CreatorTrialProjectReference | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as CreatorTrialProjectReference
  if (!/^[a-f0-9-]{36}$/.test(row.requestId) || !/^[a-z][a-z0-9-]{0,47}$/.test(row.draftId) ||
    !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 8 ||
    !/^[a-f0-9]{64}$/.test(row.candidateDigest) || !/^[a-f0-9-]{36}$/.test(row.projectId) ||
    !/^dev-project-preview:[a-f0-9-]{36}$/.test(row.installedPluginId) ||
    !/^[a-f0-9]{64}$/.test(row.pluginDigest) || typeof row.workspace !== "string" ||
    !row.workspace || row.workspace.length > 8000) return undefined
  if (row.untrackedDraftIds !== undefined && (!Array.isArray(row.untrackedDraftIds) ||
    row.untrackedDraftIds.length > 16 || row.untrackedDraftIds.some(id =>
      typeof id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(id)) ||
    new Set(row.untrackedDraftIds).size !== row.untrackedDraftIds.length)) return undefined
  return { requestId: row.requestId, draftId: row.draftId, revision: row.revision,
    candidateDigest: row.candidateDigest, projectId: row.projectId,
    installedPluginId: row.installedPluginId, pluginDigest: row.pluginDigest, workspace: row.workspace,
    ...(row.untrackedDraftIds?.length ? { untrackedDraftIds: [...row.untrackedDraftIds] } : {}) }
}

/** Only known terminal native facts admit source archiving. No cancellation or state change occurs. */
export function projectTrialEnded(reference: CreatorTrialProjectReference,
  observed: { project?: HostProjectState; operations: HostProjectOperation[] }, creatorThreadId: string) {
  const { project, operations } = observed
  if (!project || project.projectId !== reference.projectId ||
    project.installedPluginId !== reference.installedPluginId || project.pluginDigest !== reference.pluginDigest ||
    !isSameWorkspacePath(project.workspace, reference.workspace) || !operations.length || operations.length >= 100)
    return false
  if (operations.some(operation => operation.projectId !== project.projectId ||
    operation.pluginDigest !== project.pluginDigest ||
    !["transitioned", "failed", "cancelled"].includes(operation.status) ||
    (operation.execution && (!operation.execution.terminal || operation.execution.terminal.outcome === "unknown"))))
    return false
  const journey = projectCreatorTrialJourney({ reference, creatorThreadId, candidateCurrent: false, ...observed })
  if (project.status === "completed") return journey.phase === "passed"
  const current = project.manifest.stages[project.stageIndex]
  return !!current && journey.phase === "failed" && operations.some(operation =>
    operation.stageId === current.id && ["failed", "cancelled"].includes(operation.status))
}
