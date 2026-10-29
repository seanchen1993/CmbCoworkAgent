import { isDeepStrictEqual } from "node:util"
import {
  parseProjectRuntimeManifest,
  type HostProjectState,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { readPackageProtocolFiles } from "./package-snapshots"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { hostStateError } from "./host-state-protocol"
import { runtimeDigest } from "./safe-files"
import {
  compileNativeComposition,
  nativeCompositionLegacyGeneratedPretty,
  nativeCompositionSchema,
  NATIVE_COMPOSITION_PATH
} from "../../plugins/native-composition"
import { readProjectActionLock } from "./action-input"
import {
  PROJECT_ACTION_LOCK_PATH,
  parseProjectActionLock
} from "../../../shared/project-runtime/action-bindings"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"

/** Author source paths are editable only after checking their actual generated runtime projection. */
function nativeFutureSkills(files: Map<string, Buffer>, completed: number): string[] {
  const sourceBytes = files.get(NATIVE_COMPOSITION_PATH)
  if (!sourceBytes) return []
  try {
    const source = nativeCompositionSchema.parse(JSON.parse(sourceBytes.toString("utf8")))
    const runtimeBytes = files.get("devclaw.project-runtime.json")
    if (!runtimeBytes) throw Error("missing runtime")
    const manifest = parseProjectRuntimeManifest(JSON.parse(runtimeBytes.toString("utf8")))
    // Rebuild only the retained compiler projection. These descriptors confer no runtime grant.
    const catalog = new Map<string, ClawActionDescriptor>()
    const lockBytes = files.get(PROJECT_ACTION_LOCK_PATH)
    if (lockBytes)
      for (const binding of parseProjectActionLock(JSON.parse(lockBytes.toString("utf8")))
        .bindings) {
        const descriptor: ClawActionDescriptor = {
          ...binding.ref,
          name: binding.ref.actionId,
          ...(binding.platform ? { platform: binding.platform } : { command: binding.command! }),
          inputSchema: binding.inputSchema,
          ...(binding.configSchema ? { configSchema: binding.configSchema } : {}),
          ...(binding.outputSchema ? { outputSchema: binding.outputSchema } : {})
        }
        const key = JSON.stringify(binding.ref)
        if (catalog.has(key) && !isDeepStrictEqual(catalog.get(key), descriptor))
          throw Error("inconsistent retained provider contract")
        catalog.set(key, descriptor)
      }
    const inputs = [
      ...new Set([...source.resources, ...source.modules.map((module) => module.skill)])
    ]
    const compiled = compileNativeComposition(source, {
      actionCatalog: [...catalog.values()],
      legacyGeneratedPretty: nativeCompositionLegacyGeneratedPretty(lockBytes),
      legacyInputArtifactStages: new Set(
        manifest.stages.filter((stage) => stage.inputArtifactIds === undefined).map((stage) => stage.id)
      ),
      files: inputs.map((path) => {
        const bytes = files.get(path)
        if (!bytes) throw Error("missing source")
        return { path, bytes }
      })
    })
    if (compiled.files.some((file) => !file.bytes.equals(files.get(file.path) ?? Buffer.alloc(0))))
      throw Error("stale projection")
    const preserved = new Set(source.modules.slice(0, completed).map((module) => module.skill))
    return source.modules
      .slice(completed)
      .map((module) => module.skill)
      .filter((path) => !preserved.has(path))
  } catch {
    return hostStateError("PLAN_MIGRATION_AUTHOR_SOURCE_INVALID")
  }
}

/** Future stages may change. Completed contracts and their original source remain immutable. */
export function inspectHostPlanMigration(
  project: Pick<HostProjectState, "status" | "packageId" | "stageIndex" | "manifest">,
  candidate: ProjectRuntimeManifest,
  originalRoot: string,
  candidateRoot: string
) {
  if (
    project.status !== "active" ||
    candidate.mode !== "host" ||
    candidate.stateOwner !== "host" ||
    candidate.plugin.id !== project.packageId ||
    candidate.stages.length <= project.stageIndex
  )
    hostStateError("PLAN_MIGRATION_TARGET_INVALID")
  const original = new Map(
    readPackageProtocolFiles(originalRoot).map((file) => [file.path, file.bytes])
  )
  const revised = new Map(
    readPackageProtocolFiles(candidateRoot).map((file) => [file.path, file.bytes])
  )
  const oldExtension = readPackageExtensionContract(originalRoot)
  const newExtension = readPackageExtensionContract(candidateRoot)
  if (
    !isDeepStrictEqual(oldExtension, newExtension) ||
    oldExtension?.context?.provider?.entry ||
    (oldExtension?.context?.provider?.actionId && !oldExtension.context.provider.materials)
  )
    hostStateError("PLAN_MIGRATION_RESOURCE_ADAPTER_REQUIRED")
  if (!isDeepStrictEqual(project.manifest.environment, candidate.environment))
    hostStateError("PLAN_MIGRATION_ENVIRONMENT_CHANGED")
  const oldLock = readProjectActionLock(originalRoot, project.manifest)
  const newLock = readProjectActionLock(candidateRoot, candidate)
  // Original platform actions settle their owned resources before a terminal. Command actions
  // and arbitrary stage effects need their own recovery evidence and remain blocked here.
  if (
    oldLock.bindings.some((binding) => !binding.platform) ||
    project.manifest.stages.slice(0, project.stageIndex).some((stage) => stage.actionIds.length)
  )
    hostStateError("PLAN_MIGRATION_RESOURCE_ADAPTER_REQUIRED")
  const preservedBindings = new Set<string>(
    oldExtension?.context?.provider?.actionId ? [oldExtension.context.provider.actionId] : []
  )
  for (const stage of project.manifest.stages.slice(0, project.stageIndex)) {
    const index = project.manifest.stages.indexOf(stage)
    if (!isDeepStrictEqual(stage, candidate.stages[index]))
      hostStateError("PLAN_MIGRATION_COMPLETED_STAGE_CHANGED")
    for (const id of stage.artifactIds)
      if (
        !isDeepStrictEqual(
          project.manifest.artifacts.find((item) => item.id === id),
          candidate.artifacts.find((item) => item.id === id)
        )
      )
        hostStateError("PLAN_MIGRATION_COMPLETED_CONTRACT_CHANGED")
    for (const id of stage.checkIds)
      if (
        !isDeepStrictEqual(
          project.manifest.checks.find((item) => item.id === id),
          candidate.checks.find((item) => item.id === id)
        )
      )
        hostStateError("PLAN_MIGRATION_COMPLETED_CONTRACT_CHANGED")
      else {
        const actionId = project.manifest.checks.find((item) => item.id === id)?.actionId
        if (actionId) preservedBindings.add(actionId)
      }
    if (
      !stage.skill ||
      !original.get(stage.skill)?.equals(revised.get(stage.skill) ?? Buffer.alloc(0))
    )
      hostStateError("PLAN_MIGRATION_COMPLETED_SKILL_CHANGED")
  }
  for (const id of preservedBindings) {
    if (
      !isDeepStrictEqual(
        oldLock.bindings.find((binding) => binding.id === id),
        newLock.bindings.find((binding) => binding.id === id)
      ) ||
      !isDeepStrictEqual(
        project.manifest.actions.find((action) => action.id === id),
        candidate.actions.find((action) => action.id === id)
      )
    )
      hostStateError("PLAN_MIGRATION_COMPLETED_ACTION_CHANGED")
  }
  const metadata = new Set([
    "devclaw.project-runtime.json",
    "composition/source.json",
    "composition/lock.json",
    PROJECT_ACTION_LOCK_PATH
  ])
  const futureSkills = new Set(
    [
      ...project.manifest.stages.slice(project.stageIndex),
      ...candidate.stages.slice(project.stageIndex)
    ].map((stage) => stage.skill!)
  )
  for (const path of [
    ...nativeFutureSkills(original, project.stageIndex),
    ...nativeFutureSkills(revised, project.stageIndex)
  ])
    futureSkills.add(path)
  for (const stage of project.manifest.stages.slice(0, project.stageIndex))
    futureSkills.delete(stage.skill!)
  const paths = new Set([...original.keys(), ...revised.keys()])
  // Stable migration does not replay a completed Hook. Its exact declaration and script
  // remain shared immutable resources; the service separately fences original live resources.
  for (const path of paths) {
    if (metadata.has(path) || futureSkills.has(path)) continue
    if (path === "plugin.json") {
      const before = JSON.parse(original.get(path)?.toString() ?? "null")
      const after = JSON.parse(revised.get(path)?.toString() ?? "null")
      if (
        !before ||
        !after ||
        !isDeepStrictEqual({ ...before, version: null }, { ...after, version: null })
      )
        hostStateError("PLAN_MIGRATION_CONFIGURATION_CHANGED")
    } else if (!original.get(path)?.equals(revised.get(path) ?? Buffer.alloc(0)))
      hostStateError("PLAN_MIGRATION_SHARED_RESOURCE_CHANGED")
  }
  return {
    preservedStageIds: project.manifest.stages
      .slice(0, project.stageIndex)
      .map((stage) => stage.id),
    remainingStageIds: candidate.stages.slice(project.stageIndex).map((stage) => stage.id),
    contractDigest: runtimeDigest(JSON.stringify(candidate))
  }
}
