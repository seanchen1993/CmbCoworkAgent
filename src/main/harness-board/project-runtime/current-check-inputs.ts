import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import type { ProjectActionLock } from "../../../shared/project-runtime/action-bindings"
import { PROJECT_ARTIFACT_INLINE_BYTES, PROJECT_ARTIFACT_REFERENCE_FORMAT } from "../../../shared/project-runtime/artifact-reference"
import { assertProjectArtifactPath, projectArtifactReferenceBudget } from "./artifact-reference"
import { readRuntimeScopedFile } from "./safe-files"

/** A missing current output is a file-validation failure, never proof of an action result. */
export function hasMissingCurrentCheckInput(project: HostProjectState, lock: ProjectActionLock): boolean {
  const stage = project.manifest.stages[project.stageIndex]
  if (!stage) throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
  const preceding = new Set(project.manifest.stages.slice(0, project.stageIndex)
    .flatMap(item => item.artifactIds))
  let missing = false
  for (const check of project.manifest.checks.filter(item =>
    stage.checkIds.includes(item.id) && item.kind === "action")) {
    const from = lock.bindings.find(binding => binding.id === check.actionId)?.inputFrom
    if (from?.kind !== "artifact" || from.artifactId !== check.artifactId || from.pointer !== "" ||
        !stage.artifactIds.includes(from.artifactId)) continue
    if (from.format === PROJECT_ARTIFACT_REFERENCE_FORMAT) {
      const inputs = stage.inputArtifactIds ?? [...preceding]
      if (!Array.isArray(inputs) || new Set(inputs).size !== inputs.length ||
          inputs.some(id => !preceding.has(id))) throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
      for (const id of inputs) {
        const artifact = project.manifest.artifacts.find(item => item.id === id)
        if (!artifact) throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
        assertProjectArtifactPath(artifact.path)
        const file = readRuntimeScopedFile(project.workspace, artifact.path,
          projectArtifactReferenceBudget(lock, id))
        if (!file.bytes) throw Error("PROJECT_ACTION_INPUT_MISSING")
      }
    }
    const artifact = project.manifest.artifacts.find(item => item.id === from.artifactId)
    if (!artifact) throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
    assertProjectArtifactPath(artifact.path)
    const file = readRuntimeScopedFile(project.workspace, artifact.path,
      from.format === PROJECT_ARTIFACT_REFERENCE_FORMAT ? from.maxBytes : PROJECT_ARTIFACT_INLINE_BYTES)
    if (!file.present) missing = true
  }
  return missing
}
