import { clawActionObject, type ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import {
  parseProjectRuntimeManifest,
  preserveProjectRuntimeEnvelope
} from "../../../shared/project-runtime"
import {
  PROJECT_ACTION_LOCK_PATH,
  type ProjectActionBinding
} from "../../../shared/project-runtime/action-bindings"
import {
  assertProjectActionLock,
  createProjectActionBinding
} from "../../harness-board/project-runtime/action-input"
import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"

/** Bind only a descriptor read from the host's installed public action catalogue. No grant is created. */
export function bindProjectPublicAction(input: {
  source: AuthoringSourceBundle
  stageId: string
  localActionId: string
  action: ClawActionDescriptor
  constants: unknown
  config?: unknown
  inputFrom?: ProjectActionBinding["inputFrom"]
}): AuthoringSourceBundle {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.localActionId)) throw Error("PROJECT_REUSE_ID_INVALID")
  const binding = createProjectActionBinding(
    input.localActionId,
    input.action,
    clawActionObject(input.constants),
    clawActionObject(input.config ?? {}),
    input.inputFrom
  )
  const sourceFile = input.source.files.find((file) => file.path === "devclaw.project-runtime.json")
  const manifest = parseProjectRuntimeManifest(JSON.parse(sourceFile?.text ?? "null"))
  const stage = manifest.stages.find((stage) => stage.id === input.stageId)
  if (!stage || manifest.actions.some((action) => action.id === input.localActionId))
    throw Error("PROJECT_REUSE_BINDING_INVALID")
  const existing = input.source.files.find((file) => file.path === PROJECT_ACTION_LOCK_PATH)
  const lock = assertProjectActionLock(
    manifest,
    existing
      ? JSON.parse(existing.text)
      : {
          apiVersion: "devclaw.project-actions-lock/v1",
          bindings: []
        }
  )
  manifest.actions.push({ id: input.localActionId, ref: binding.ref })
  stage.actionIds.push(input.localActionId)
  parseProjectRuntimeManifest(manifest)
  lock.bindings.push(binding)
  assertProjectActionLock(manifest, lock)
  return createAuthoringSourceBundle([
    ...input.source.files
      .filter((file) => file.path !== PROJECT_ACTION_LOCK_PATH)
      .map((file) =>
        file.path === sourceFile!.path
          ? {
              path: file.path,
              text: `${JSON.stringify(
                preserveProjectRuntimeEnvelope(JSON.parse(sourceFile!.text), manifest),
                null,
                2
              )}\n`
            }
          : file
      ),
    { path: PROJECT_ACTION_LOCK_PATH, text: `${JSON.stringify(lock, null, 2)}\n` }
  ])
}
