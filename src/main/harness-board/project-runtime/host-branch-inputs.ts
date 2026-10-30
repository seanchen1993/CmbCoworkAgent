import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import { hostDigest, hostInteger, hostRecord, hostStateError, hostText } from "./host-state-protocol"
import { readRuntimeScopedFile, runtimeRelativePath } from "./safe-files"

/** Private branch admission evidence, never an upstream execution receipt or runtime grant. */
export interface HostBranchInputs {
  projectId: string
  sourceProjectId: string
  sourceVersion: number
  pluginDigest: string
  stageIndex: number
  inputs: Array<{ path: string; fingerprint: string }>
}

export function parseHostBranchInputs(value: unknown): HostBranchInputs {
  const row = hostRecord(value,
    ["projectId", "sourceProjectId", "sourceVersion", "pluginDigest", "stageIndex", "inputs"])
  if (!Array.isArray(row.inputs) || row.inputs.length > 128)
    hostStateError("BRANCH_INPUT_BASELINE_INVALID")
  const inputs = row.inputs.map((value) => {
    const item = hostRecord(value, ["path", "fingerprint"])
    return { path: runtimeRelativePath(hostText(item.path)), fingerprint: hostDigest(item.fingerprint) }
  })
  if (new Set(inputs.map(item => item.path)).size !== inputs.length)
    hostStateError("BRANCH_INPUT_BASELINE_INVALID")
  return { projectId: hostText(row.projectId), sourceProjectId: hostText(row.sourceProjectId),
    sourceVersion: hostInteger(row.sourceVersion, 1), pluginDigest: hostDigest(row.pluginDigest),
    stageIndex: hostInteger(row.stageIndex), inputs }
}

/** Capture only required declared prefix artifacts, after the existing branch admission. */
export function captureHostBranchInputs(candidate: HostProjectState, source: HostProjectState): HostBranchInputs {
  const prefix = new Set(candidate.manifest.stages.slice(0, candidate.stageIndex)
    .flatMap(stage => stage.artifactIds))
  const paths = [...new Set(candidate.manifest.artifacts.filter(artifact =>
    artifact.required && prefix.has(artifact.id)).map(artifact => artifact.path))]
  return parseHostBranchInputs({ projectId: candidate.projectId, sourceProjectId: source.projectId,
    sourceVersion: source.version, pluginDigest: candidate.pluginDigest, stageIndex: candidate.stageIndex,
    inputs: paths.map(path => {
      const file = readRuntimeScopedFile(candidate.workspace, path)
      if (!file.bytes) hostStateError("BRANCH_INPUT_BASELINE_MISSING")
      return { path, fingerprint: file.fingerprint }
    }) })
}
