import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { CreatorProjectDeliveryStatus } from "../../../shared/mods/development"
import type { DevelopmentContext } from "./development-service"
import type { DevelopmentScope } from "../v2/development-session"
import type { ProjectAuthoringSessions } from "./project-authoring-session"
import type { BusinessDraftSettings } from "./creator-business-draft"
import type { DerivationServiceDependencies } from "../../plugins/derivation-service"
import {
  derivationContentIdentity,
  renameDerivation,
  snapshotDerivationSource,
  writeDerivationFiles
} from "../../plugins/derivation-source"
import { packProjectPlugin } from "./project-tooling"
import { getProjectActionCatalog } from "../../harness-board/project-action-runtime"
import { businessCreatorScopeKey } from "./creator-business-draft"

type Record = {
  scope: DevelopmentScope
  status: CreatorProjectDeliveryStatus
  draftId: string
  revision: number
  resourcePaths: string[]
  pluginId: string
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** Native explicit delivery of a checked project source. No business execution or approval transfer. */
export class CreatorProjectDeliveries {
  private readonly live = new Set<string>()
  private readonly busy = new Set<string>()
  constructor(
    private readonly deps: {
      root: string
      settings: BusinessDraftSettings
      sessions: ProjectAuthoringSessions
      context(threadId: string): DevelopmentContext
      occupied(threadId: string): boolean
      plugins: DerivationServiceDependencies["plugins"]
      install: DerivationServiceDependencies["install"]
      invalidate(): void
      changed(threadId: string): void
      actions?: typeof getProjectActionCatalog
    }
  ) {}

  private key(scope: DevelopmentScope) {
    return `creator-project-delivery-v1:${businessCreatorScopeKey(scope)}`
  }
  private read(scope: DevelopmentScope): { record: Record; raw: string } | undefined {
    const raw = this.deps.settings.getSetting(this.key(scope), "")
    if (!raw) return undefined
    if (Buffer.byteLength(raw) > 32000) throw Error("PROJECT_DELIVERY_RECORD_INVALID")
    const record = JSON.parse(raw) as Record
    if (
      !same(record.scope, scope) ||
      !/^[a-f0-9-]{36}$/.test(record.status?.id) ||
      !/^[a-f0-9]{64}$/.test(record.status.digest) ||
      !/^[a-f0-9]{64}$/.test(record.status.sourceDigest) ||
      !/^[a-f0-9-]{36}$/.test(record.pluginId) ||
      !Array.isArray(record.resourcePaths) ||
      ![
        "needs-confirmation",
        "installing",
        "installed",
        "exporting",
        "exported",
        "failed",
        "unknown"
      ].includes(record.status.phase)
    )
      throw Error("PROJECT_DELIVERY_RECORD_INVALID")
    return { record, raw }
  }
  private persist(record: Record, previous: string | undefined, guard: () => void) {
    guard()
    const raw = JSON.stringify(record)
    if (!this.deps.settings.compareAndSetSetting(this.key(record.scope), previous, raw))
      throw Error("PROJECT_DELIVERY_CHANGED")
    this.deps.changed(record.scope.threadId)
    return raw
  }
  status(threadId: string): CreatorProjectDeliveryStatus | undefined {
    const context = this.deps.context(threadId)
    const saved = this.read(context.scope)
    if (!saved) return undefined
    const state = structuredClone(saved.record.status)
    const request = this.deps.sessions.trialRequest(context.scope)
    let current = request?.id === state.requestId && request.digest === state.sourceDigest
    try {
      const draft = this.deps.sessions.read(context.scope, saved.record.draftId)
      current =
        current &&
        draft.revision === saved.record.revision &&
        draft.source.digest === state.sourceDigest
    } catch {
      current = false
    }
    const available =
      current &&
      this.live.has(state.id) &&
      !this.busy.has(threadId) &&
      !this.deps.occupied(threadId)
    state.canInstall =
      available && !state.pluginId && ["needs-confirmation", "exported"].includes(state.phase)
    state.canExport =
      available && ["needs-confirmation", "installed", "exported"].includes(state.phase)
    if (
      !this.live.has(state.id) &&
      ["needs-confirmation", "installing", "exporting"].includes(state.phase)
    ) {
      state.phase = "unknown"
      state.error = "PROJECT_DELIVERY_REVIEW_REQUIRED"
    }
    return state
  }
  async prepare(
    threadId: string,
    workspace: string,
    input: { requestId: string; digest: string; name: string; version: string }
  ) {
    const context = this.deps.context(threadId)
    context.assertCurrent()
    if (
      context.scope.workspace !== workspace ||
      this.deps.occupied(threadId) ||
      this.busy.has(threadId)
    )
      throw Error("PROJECT_DELIVERY_BUSY_OR_SCOPE_CHANGED")
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(input.name) ||
      input.version.length > 64 ||
      !/^\d+\.\d+\.\d+$/.test(input.version)
    )
      throw Error("PROJECT_DELIVERY_IDENTITY_INVALID")
    const request = this.deps.sessions.trialRequest(context.scope)
    if (!request || request.id !== input.requestId || request.digest !== input.digest)
      throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
    const previous = this.read(context.scope)
    if (previous && ["installing", "exporting", "unknown"].includes(previous.record.status.phase))
      throw Error("PROJECT_DELIVERY_OUTCOME_UNCONFIRMED")
    const draft = this.deps.sessions.read(context.scope, request.draftId)
    if (draft.revision !== request.revision || draft.source.digest !== request.digest)
      throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
    const guard = () => {
      context.assertCurrent()
      const current = this.deps.sessions.trialRequest(context.scope)
      if (current?.id !== request.id || current.digest !== request.digest)
        throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
      const currentDraft = this.deps.sessions.read(context.scope, request.draftId)
      if (
        currentDraft.revision !== request.revision ||
        currentDraft.source.digest !== request.digest
      )
        throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
      if (
        this.deps.plugins().some((plugin) => plugin.name.toLowerCase() === input.name.toLowerCase())
      )
        throw Error("PROJECT_DELIVERY_NAME_ALREADY_INSTALLED")
    }
    this.busy.add(threadId)
    try {
      guard()
      const snapshot = await snapshotDerivationSource(draft.directory)
      guard()
      const expected = draft.source.files
        .map((file) => [file.path, digest(Buffer.from(file.text))])
        .sort(([left], [right]) => left.localeCompare(right))
      const actual = snapshot.files
        .map((file) => [file.path, file.digest])
        .sort(([left], [right]) => left.localeCompare(right))
      if (!same(expected, actual)) throw Error("PROJECT_DELIVERY_SOURCE_CHANGED")
      const files = renameDerivation(snapshot, input.name, input.version)
      await mkdir(this.deps.root, { recursive: true })
      const id = randomUUID()
      const directory = join(this.deps.root, id)
      await mkdir(directory)
      await writeDerivationFiles(directory, files)
      guard()
      const actions = await (this.deps.actions ?? getProjectActionCatalog)(workspace, threadId)
      const validationDirectory = await mkdtemp(join(this.deps.root, "check-"))
      await packProjectPlugin(
        directory,
        join(validationDirectory, "checked.zip"),
        undefined,
        guard,
        actions,
        draft.resourcePaths
      )
      guard()
      const candidate = await snapshotDerivationSource(directory)
      const record: Record = {
        scope: context.scope,
        draftId: request.draftId,
        revision: draft.revision,
        resourcePaths: [...(draft.resourcePaths ?? [])],
        pluginId: randomUUID(),
        status: {
          id,
          requestId: request.id,
          sourceDigest: request.digest,
          name: input.name,
          version: input.version,
          digest: derivationContentIdentity(candidate.files),
          phase: "needs-confirmation",
          canInstall: false,
          canExport: false
        }
      }
      this.persist(record, previous?.raw, guard)
      this.live.add(id)
    } finally {
      this.busy.delete(threadId)
    }
    return this.status(threadId)
  }
  private async confirmed(
    threadId: string,
    workspace: string,
    input: { deliveryId: string; digest: string }
  ) {
    const context = this.deps.context(threadId)
    const saved = this.read(context.scope)
    const status = this.status(threadId)
    if (
      context.scope.workspace !== workspace ||
      !saved ||
      !status ||
      status.id !== input.deliveryId ||
      status.digest !== input.digest ||
      !this.live.has(input.deliveryId) ||
      this.busy.has(threadId) ||
      this.deps.occupied(threadId)
    )
      throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
    const directory = join(this.deps.root, saved.record.status.id)
    const guard = () => {
      context.assertCurrent()
      const request = this.deps.sessions.trialRequest(context.scope)
      if (
        request?.id !== saved.record.status.requestId ||
        request.digest !== saved.record.status.sourceDigest
      )
        throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
      const currentDraft = this.deps.sessions.read(context.scope, saved.record.draftId)
      if (
        currentDraft.revision !== saved.record.revision ||
        currentDraft.source.digest !== saved.record.status.sourceDigest
      )
        throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
    }
    guard()
    const snapshot = await snapshotDerivationSource(directory)
    guard()
    if (derivationContentIdentity(snapshot.files) !== input.digest)
      throw Error("PROJECT_DELIVERY_PACKAGE_CHANGED")
    const original = this.deps.sessions.read(context.scope, saved.record.draftId)
    const originalSnapshot = await snapshotDerivationSource(original.directory)
    guard()
    const expected = original.source.files
      .map((file) => [file.path, digest(Buffer.from(file.text))])
      .sort(([left], [right]) => left.localeCompare(right))
    const observed = originalSnapshot.files
      .map((file) => [file.path, file.digest])
      .sort(([left], [right]) => left.localeCompare(right))
    if (!same(expected, observed)) throw Error("PROJECT_DELIVERY_SOURCE_CHANGED")
    return { ...saved, context, directory, guard, status }
  }
  async install(
    threadId: string,
    workspace: string,
    input: { deliveryId: string; digest: string }
  ) {
    const checked = await this.confirmed(threadId, workspace, input)
    if (!checked.status.canInstall) throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
    const { record, guard } = checked
    if (
      record.status.pluginId ||
      this.busy.has(threadId) ||
      this.deps
        .plugins()
        .some((plugin) => plugin.name.toLowerCase() === record.status.name.toLowerCase())
    )
      throw Error("PROJECT_DELIVERY_NAME_ALREADY_INSTALLED")
    this.busy.add(threadId)
    let raw = checked.raw
    try {
      record.status.phase = "installing"
      raw = this.persist(record, raw, guard)
      const result = await this.deps.install(
        checked.directory,
        record.status.name,
        record.pluginId,
        guard,
        async (directory) => {
          guard()
          if (
            derivationContentIdentity((await snapshotDerivationSource(directory)).files) !==
            record.status.digest
          )
            throw Error("PROJECT_DELIVERY_PACKAGE_CHANGED")
          guard()
        }
      )
      if (!result.success) throw Error("PROJECT_DELIVERY_INSTALL_UNCONFIRMED")
      guard()
      record.status.phase = "installed"
      record.status.pluginId = record.pluginId
      this.persist(record, raw, guard)
      this.deps.invalidate()
    } catch (cause) {
      record.status.phase = "unknown"
      record.status.error = "PROJECT_DELIVERY_INSTALL_UNCONFIRMED"
      this.live.delete(record.status.id)
      this.persist(record, raw, () => checked.context.assertCurrent())
      throw cause
    } finally {
      this.busy.delete(threadId)
    }
    return this.status(threadId)
  }
  async export(
    threadId: string,
    workspace: string,
    input: { deliveryId: string; digest: string },
    output: string
  ) {
    const checked = await this.confirmed(threadId, workspace, input)
    if (!checked.status.canExport) throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
    const { record, guard } = checked
    if (this.busy.has(threadId)) throw Error("PROJECT_DELIVERY_BUSY")
    this.busy.add(threadId)
    let raw = checked.raw
    const previousPhase = record.status.phase
    try {
      record.status.phase = "exporting"
      raw = this.persist(record, raw, guard)
      const actions = await (this.deps.actions ?? getProjectActionCatalog)(workspace, threadId)
      await packProjectPlugin(
        checked.directory,
        output,
        undefined,
        guard,
        actions,
        record.resourcePaths
      )
      guard()
      record.status.phase = "exported"
      record.status.output = output
      this.persist(record, raw, guard)
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (
        error.code === "EEXIST" &&
        typeof error.path === "string" &&
        resolve(error.path) === resolve(output)
      ) {
        record.status.phase = previousPhase
        this.persist(record, raw, guard)
        throw Object.assign(Error("PROJECT_DELIVERY_EXPORT_TARGET_EXISTS"), { code: "EEXIST" })
      }
      record.status.phase = "unknown"
      record.status.error = "PROJECT_DELIVERY_EXPORT_UNCONFIRMED"
      this.live.delete(record.status.id)
      this.persist(record, raw, () => checked.context.assertCurrent())
      throw cause
    } finally {
      this.busy.delete(threadId)
    }
    return this.status(threadId)
  }
}
