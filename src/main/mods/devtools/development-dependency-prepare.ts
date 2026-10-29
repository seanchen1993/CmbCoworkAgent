import type { AuthoringDocument } from "../../../shared/mods/authoring"
import type { DevelopmentReuseStatus } from "../../../shared/mods/development"
import type { ModDevelopmentService } from "./development-service"
import {
  PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES,
  readDevelopmentDependencySource
} from "./development-dependency-catalog"
import { runtimeDigest } from "../../harness-board/project-runtime/safe-files"

type Service = Pick<ModDevelopmentService, "read" | "save" | "check" | "requestReuse" | "status">
type Check = Awaited<ReturnType<Service["check"]>>
const draftView = (draft: AuthoringDocument) => ({
  id: draft.id,
  name: draft.name,
  revision: draft.revision,
  sourceDigest: draft.source.digest
})
/** Bound public diagnostics, including JSON escaping, without changing native classification. */
function publicReuseError(error: string) {
  let text = ""
  for (const character of error) {
    const next = text + character
    if (next.length > 512 || Buffer.byteLength(JSON.stringify(next)) > 1024) break
    text = next
  }
  return { error: text, ...(text !== error ? { errorTruncated: true } : {}) }
}
const planView = (plan: DevelopmentReuseStatus) => ({
  phase: plan.phase,
  planId: plan.planId,
  draftId: plan.draftId,
  revision: plan.revision,
  sourceDigest: plan.sourceDigest,
  compiledDigest: plan.compiledDigest,
  targetProfileDigest: plan.targetProfileDigest,
  capabilityCount: plan.capabilities.length,
  ...(plan.error ? publicReuseError(plan.error) : {})
})

export class DependencyPreparationError extends Error {
  constructor(
    code: string,
    readonly currentDraft?: ReturnType<typeof draftView>,
    readonly reuse?: ReturnType<typeof planView>
  ) {
    super(code)
  }
}

function assertReuseKnown(plan: DevelopmentReuseStatus | undefined, draft?: AuthoringDocument) {
  if (
    plan?.phase === "unknown" ||
    /UNKNOWN|UNCONFIRMED|^CREATOR_REUSE_FAILED$/.test(plan?.error ?? "")
  )
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_REUSE_UNCONFIRMED",
      draft && draftView(draft),
      plan && planView(plan)
    )
  if (plan && ["preparing", "applying"].includes(plan.phase))
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_REUSE_BUSY",
      draft && draftView(draft),
      planView(plan)
    )
}

/** Fixed Host source -> existing CAS/check/reuse only. No installation, grant or trial. */
export async function prepareDevelopmentDependency(input: {
  service: Service
  mainDirectory: string
  threadId: string
  sourceId: string
  id?: string
  name?: string
  revision?: number
  expectedDigest?: string
  turnId: string
  signal: AbortSignal
  assertCurrent(): void
  claimCandidate(): void
}) {
  const guard = () => {
    input.signal.throwIfAborted()
    input.assertCurrent()
  }
  guard()
  const source = readDevelopmentDependencySource({
    mainDirectory: input.mainDirectory,
    sourceId: input.sourceId,
    expectedDigest: input.expectedDigest
  })
  guard()
  const id = input.id ?? input.sourceId
  let document: AuthoringDocument | undefined
  try {
    document = input.service.read(input.threadId, id)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "AUTHORING_VERSION_MISSING") throw error
  }
  guard()
  const previous = input.service.status(input.threadId).reuse
  assertReuseKnown(previous, document)
  if (document && document.source.digest !== source.digest)
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_DRAFT_CONFLICT",
      draftView(document)
    )
  if (input.revision !== undefined && input.revision !== (document?.revision ?? 0))
    throw new DependencyPreparationError(
      "AUTHORING_VERSION_CHANGED",
      document && draftView(document)
    )
  if (
    previous?.phase === "needs-approval" &&
    (previous.draftId !== id ||
      previous.revision !== document?.revision ||
      previous.sourceDigest !== source.digest ||
      (input.name && input.name !== document?.name))
  )
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_REVIEW_PENDING",
      document && draftView(document),
      planView(previous)
    )
  const plugin = JSON.parse(source.files.find((file) => file.path === "plugin.json")!.text)
  const name = input.name ?? document?.name ?? plugin.name
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_INVALID")
  input.claimCandidate()
  guard()
  if (!document || document.name !== name)
    document = input.service.save(input.threadId, {
      id,
      name,
      expectedRevision: document?.revision ?? 0,
      files: source.files
    })
  const current = { ...document }
  const exact = () => {
    guard()
    const latest = input.service.read(input.threadId, id)
    if (latest.revision !== current.revision || latest.source.digest !== source.digest)
      throw new DependencyPreparationError("AUTHORING_VERSION_CHANGED", draftView(latest))
  }
  exact()
  const check = await input.service.check(input.threadId, id, current.revision, input.signal)
  exact()
  if (check.digest !== source.digest)
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_CHECK_UNCONFIRMED",
      draftView(current)
    )
  if (!check.valid) return dependencyPreparationView(input.sourceId, current, check)
  const beforeRequest = input.service.status(input.threadId).reuse
  assertReuseKnown(beforeRequest, current)
  if (JSON.stringify(beforeRequest) !== JSON.stringify(previous))
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_REUSE_CHANGED",
      draftView(current),
      beforeRequest && planView(beforeRequest)
    )
  const samePlan =
    beforeRequest &&
    beforeRequest.draftId === id &&
    beforeRequest.revision === current.revision &&
    beforeRequest.sourceDigest === source.digest &&
    ["needs-approval", "active"].includes(beforeRequest.phase)
  const plan = samePlan
    ? beforeRequest
    : (
        await input.service.requestReuse(
          input.threadId,
          id,
          current.revision,
          input.turnId,
          input.signal,
          exact
        )
      ).reuse
  exact()
  if (
    !plan ||
    plan.draftId !== id ||
    plan.revision !== current.revision ||
    plan.sourceDigest !== source.digest
  )
    throw new DependencyPreparationError(
      "DEVELOPMENT_DEPENDENCY_REUSE_UNCONFIRMED",
      draftView(current)
    )
  assertReuseKnown(plan, current)
  return dependencyPreparationView(input.sourceId, current, check, plan)
}

/** Original companion text is bounded data; it is never registered or copied into a project here. */
function dependencyPreparationView(
  sourceId: string,
  draft: AuthoringDocument,
  check: Check,
  reuse?: DevelopmentReuseStatus
) {
  const companions = draft.source.files.filter(
    (file) =>
      /^modules\/[A-Za-z0-9._/-]+\/SKILL\.md$/.test(file.path) ||
      /^workflows\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.workflow\.js$/.test(file.path)
  )
  const result = {
    sourceId,
    draft: draftView(draft),
    check: {
      digest: check.digest,
      valid: check.valid,
      runtimeVerified: false,
      diagnosticCount: check.diagnostics.length,
      diagnostics: check.diagnostics.slice(0, 8)
    },
    ...(reuse ? { reuse: planView(reuse) } : {}),
    phase: !check.valid || check.digest !== draft.source.digest ? "check-failed" : reuse?.phase,
    fileIndex: draft.source.files.map((file) => file.path),
    companionIndex: companions.slice(0, 12).map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.text),
      digest: runtimeDigest(file.text),
      assetPath: `${sourceId}/${file.path}`
    })),
    companionCount: companions.length,
    companionCatalog: {
      action: "catalog",
      catalogSection: "project-dependencies",
      assetPath: sourceId,
      sourceDigest: draft.source.digest
    },
    companionCopy:
      "Companions are inert source data. To use them in a project, project_patch the exact text and composition/source.json.resources together; no project files were added here.",
    installed: false,
    grantsAuthority: false,
    executed: false,
    trialRequested: false,
    nextStep:
      reuse?.phase === "needs-approval"
        ? "End this turn now. Wait for the original native installation/permission confirmation. Then re-read project_actions and patch/compile the actual project provider."
        : reuse?.phase === "active"
          ? "Existing native reuse is active. Re-read project_actions for actual authorized provider identity."
          : "Preparation did not pass. Inspect diagnostics/current native reuse status; do not replay an unknown outcome or claim installed/authorized."
  }
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify({ ok: true, result: value }))
  while (bytes(result) > PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES && result.check.diagnostics.length)
    result.check.diagnostics.pop()
  const withText = { ...result, companionSources: companions }
  if (bytes(withText) <= PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES) return withText
  const indexOnly = { ...result, companionSourcesOmitted: true }
  while (bytes(indexOnly) > PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES && indexOnly.companionIndex.length)
    indexOnly.companionIndex.pop()
  while (bytes(indexOnly) > PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES && indexOnly.fileIndex.length)
    indexOnly.fileIndex.pop()
  if (bytes(indexOnly) > PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES)
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_LIMIT")
  return indexOnly
}
