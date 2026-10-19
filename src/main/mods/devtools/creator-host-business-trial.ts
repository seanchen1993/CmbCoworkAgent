import { createHash } from "node:crypto"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import type { DevelopmentProjectTrialRequest } from "../../../shared/mods/development"
import type { DevelopmentScope } from "../v2/development-session"
import { getProjectActionCatalog } from "../../harness-board/project-action-runtime"
import { isProjectSourcePath, readProjectSource } from "./project-source"
import { normalizeProjectResourcePaths } from "./project-resource-paths"
import {
  projectAuthoringSessions,
  type ProjectAuthoringSessions
} from "./project-authoring-session"

/** Import exact, checked source into the original native Host authoring/trial boundary.
 * Preparing a request performs no business execution and gives no native approval. */
export async function requestCreatorHostBusinessTrial(input: {
  root: string
  scope: DevelopmentScope
  name: string
  goal: string
  origin: NonNullable<DevelopmentProjectTrialRequest["origin"]>
  expectedFiles: readonly { path: string; digest: string }[]
  guard(): void
  sessions?: ProjectAuthoringSessions
}) {
  input.guard()
  const resourcePaths = normalizeProjectResourcePaths(
    input.expectedFiles.filter((file) => !isProjectSourcePath(file.path)).map((file) => file.path)
  )
  const source = await readProjectSource(input.root, resourcePaths)
  input.guard()
  // Dropping a knowledge resource, Hook or executable would change the candidate. Never
  // silently turn a partially imported assembly into an approved Host trial.
  if (source.excluded.length) throw Error("BUSINESS_TRIAL_HOST_SOURCE_UNSUPPORTED")
  const expected = input.expectedFiles
    .map((file) => [file.path, file.digest])
    .sort(([left], [right]) => left.localeCompare(right))
  const observed = source.bundle.files
    .map((file) => [file.path, createHash("sha256").update(file.text, "utf8").digest("hex")])
    .sort(([left], [right]) => left.localeCompare(right))
  if (JSON.stringify(expected) !== JSON.stringify(observed))
    throw Error("BUSINESS_TRIAL_CANDIDATE_CHANGED")
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(
      source.bundle.files.find((file) => file.path === "devclaw.project-runtime.json")?.text ??
        "null"
    )
  )
  if (manifest.mode !== "host" || manifest.stateOwner !== "host")
    throw Error("BUSINESS_TRIAL_ADAPTER_UNSUPPORTED")
  const sessions = input.sessions ?? projectAuthoringSessions
  const id = `business-${createHash("sha256").update(input.origin.planId).digest("hex").slice(0, 32)}`
  const previous = sessions.list(input.scope).find((draft) => draft.id === id)
  if (previous && previous.source.digest !== source.bundle.digest)
    throw Error("BUSINESS_TRIAL_CANDIDATE_CHANGED")
  const draft =
    previous ??
    (await sessions.save(
      input.scope,
      { id, name: input.name, revision: 0, files: source.bundle.files },
      input.guard,
      resourcePaths
    ))
  input.guard()
  const existingRequest = sessions.trialRequest(input.scope)
  if (existingRequest?.draftId === draft.id && existingRequest.revision === draft.revision &&
    existingRequest.digest === draft.source.digest && existingRequest.goal === input.goal.trim() &&
    JSON.stringify(existingRequest.origin) === JSON.stringify(input.origin)) {
    // Reopening the exact candidate returns its original request and observation. It must
    // not detach the running project by manufacturing another authoring request identity.
    return { phase: "needs-approval" as const, executed: false as const, request: existingRequest }
  }
  const actions = source.bundle.files.some(
    (file) => file.path === "devclaw.project-actions.lock.json"
  )
    ? await getProjectActionCatalog(input.scope.workspace, input.scope.threadId)
    : []
  input.guard()
  return sessions.requestTrial(
    input.scope,
    draft.id,
    draft.revision,
    input.goal,
    input.guard,
    actions,
    input.origin
  )
}
