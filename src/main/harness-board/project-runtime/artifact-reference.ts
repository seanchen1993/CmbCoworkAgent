import type { ModObject } from "../../../shared/mods/types"
import { clawActionObject } from "../../../shared/mods/claw-actions"
import type { ProjectActionLock } from "../../../shared/project-runtime/action-bindings"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import {
  PROJECT_ARTIFACT_INLINE_BYTES,
  PROJECT_ARTIFACT_REFERENCE_FORMAT,
  PROJECT_ARTIFACT_REFERENCE_INPUT_BYTES,
  PROJECT_ARTIFACT_REFERENCE_MAX_FILES,
  PROJECT_ARTIFACT_REFERENCE_PROTOCOL,
  PROJECT_ARTIFACT_REFERENCE_TOTAL_BYTES,
  type ProjectArtifactReference,
  type ProjectArtifactReferenceInput
} from "../../../shared/project-runtime/artifact-reference"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectoryIdentity } from "./safe-files"

export function assertProjectArtifactPath(path: string): void {
  if (
    path
      .split("/")
      .some(
        (part) =>
          /^(?:\.env.*|\.git|\.git-credentials|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|credentials.*|secrets?.*|id_(?:rsa|dsa|ecdsa|ed25519).*)$/iu.test(
            part
          ) || /\.(?:pem|key|pfx|p12|kdbx)$/iu.test(part)
      )
  )
    throw Error("PROJECT_ACTION_INPUT_FORBIDDEN")
}

/** The caller must supply an already checked package lock, never data supplied by a Guest. */
export function projectArtifactReferenceBudget(lock: ProjectActionLock, artifactId: string) {
  const limits = lock.bindings.flatMap((binding) => {
    const from = binding.inputFrom
    return from?.kind === "artifact" &&
      from.artifactId === artifactId &&
      from.format === PROJECT_ARTIFACT_REFERENCE_FORMAT
      ? [from.maxBytes]
      : []
  })
  return limits.length ? Math.min(...limits) : PROJECT_ARTIFACT_INLINE_BYTES
}

/** Only captures declared current/prior files. These descriptors grant no independent authority. */
export function captureProjectArtifactReference(
  project: HostProjectState,
  lock: ProjectActionLock,
  currentId: string,
  maxBytes: number
): { input: ModObject; files: Array<[string, string]>; bytes: number } {
  const stage = project.manifest.stages[project.stageIndex]
  if (!stage?.artifactIds.includes(currentId)) throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
  const priorIds = [
    ...new Set(
      project.manifest.stages.slice(0, project.stageIndex).flatMap((item) => item.artifactIds)
    )
  ].filter((id) => id !== currentId)
  if (priorIds.length + 1 > PROJECT_ARTIFACT_REFERENCE_MAX_FILES)
    throw Error("PROJECT_ARTIFACT_REFERENCE_LIMIT")
  const files: Array<[string, string]> = []
  let bytes = 0
  const read = (artifactId: string, limit: number): ProjectArtifactReference => {
    const artifact = project.manifest.artifacts.find((item) => item.id === artifactId)
    if (!artifact) throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
    assertProjectArtifactPath(artifact.path)
    const file = readRuntimeScopedFile(project.workspace, artifact.path, limit)
    if (!file.bytes) throw Error("PROJECT_ACTION_INPUT_MISSING")
    bytes += file.bytes.length
    if (bytes > PROJECT_ARTIFACT_REFERENCE_TOTAL_BYTES)
      throw Error("PROJECT_ARTIFACT_REFERENCE_LIMIT")
    files.push([artifact.path, file.fingerprint])
    return {
      artifactId,
      path: artifact.path,
      bytes: file.bytes.length,
      sha256: runtimeDigest(file.bytes),
      maxBytes: limit
    }
  }
  const reference: ProjectArtifactReferenceInput = {
    protocol: PROJECT_ARTIFACT_REFERENCE_PROTOCOL,
    projectId: project.projectId,
    stageId: stage.id,
    version: project.version,
    pluginDigest: project.pluginDigest,
    workspaceIdentity: runtimeDigest(runtimeDirectoryIdentity(project.workspace)),
    current: read(currentId, maxBytes),
    sources: priorIds.map((id) => read(id, projectArtifactReferenceBudget(lock, id)))
  }
  if (Buffer.byteLength(JSON.stringify(reference)) > PROJECT_ARTIFACT_REFERENCE_INPUT_BYTES)
    throw Error("PROJECT_ARTIFACT_REFERENCE_LIMIT")
  return { input: clawActionObject(reference), files, bytes }
}
