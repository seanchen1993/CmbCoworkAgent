import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { CreatorProjectDeliveryStatus } from "../../../shared/mods/development"
import type { DevelopmentContext } from "./development-service"
import type { DevelopmentScope } from "../v2/development-session"
import type { ProjectAuthoringSessions } from "./project-authoring-session"
import type { BusinessDraftSettings } from "./creator-business-draft"
import type { DerivationServiceDependencies } from "../../plugins/derivation-service"
import {
  derivationContentIdentity,
  snapshotDerivationSource,
  writeDerivationFiles
} from "../../plugins/derivation-source"
import { packProjectPlugin } from "./project-tooling"
import { getProjectActionCatalog } from "../../harness-board/project-action-runtime"
import { renameNativeComposition } from "../../plugins/native-composition-derivation"
import { businessCreatorScopeKey } from "./creator-business-draft"
import {
  observeProjectDeliveryExport,
  readProjectDeliveryArchive,
  type ProjectDeliveryObservation
} from "../../plugins/plugin-delivery-observation"

type Record = {
  scope: DevelopmentScope
  status: CreatorProjectDeliveryStatus
  draftId: string
  revision: number
  resourcePaths: string[]
  pluginId: string
  effect?: { kind: "install" } | { kind: "export"; output: string; digest: string; bytes: number }
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
      normalizeWorkspace?(workspace: string): string
      observeInstallation?(
        input: { pluginId: string; name: string; version: string; digest: string },
        guard: () => void
      ): Promise<ProjectDeliveryObservation>
    }
  ) {}

  private sameWorkspace(expected: string, actual: string) {
    return (this.deps.normalizeWorkspace?.(expected) ?? expected) === actual
  }

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
    state.operation = saved.record.effect?.kind
    if (saved.record.effect?.kind === "export" && ["unknown", "exporting"].includes(state.phase))
      state.pendingOutput = saved.record.effect.output
    state.canReconcile =
      state.phase === "unknown" && !this.busy.has(threadId) && !this.deps.occupied(threadId)
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
      !this.sameWorkspace(workspace, context.scope.workspace) ||
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
    if (previous && this.status(threadId)?.phase === "unknown")
      throw Error("PROJECT_DELIVERY_OUTCOME_UNCONFIRMED")
    const draft = this.deps.sessions.read(context.scope, request.draftId)
    if (draft.revision !== request.revision || draft.source.digest !== request.digest)
      throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
    const recheckInstalled =
      previous?.record.status.pluginId === previous?.record.pluginId &&
      previous?.record.status.requestId === request.id &&
      previous?.record.status.sourceDigest === request.digest &&
      previous?.record.status.name === input.name &&
      previous?.record.status.version === input.version &&
      ["installed", "exported"].includes(previous?.record.status.phase ?? "")
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
        this.deps
          .plugins()
          .some(
            (plugin) =>
              plugin.name.toLowerCase() === input.name.toLowerCase() &&
              !(recheckInstalled && plugin.id === previous?.record.pluginId)
          )
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
      if (recheckInstalled && previous) {
        const frozen = await snapshotDerivationSource(
          join(this.deps.root, previous.record.status.id)
        )
        guard()
        if (derivationContentIdentity(frozen.files) !== previous.record.status.digest)
          throw Error("PROJECT_DELIVERY_PACKAGE_CHANGED")
        const observation = await this.deps.observeInstallation?.(
          {
            pluginId: previous.record.pluginId,
            name: input.name,
            version: input.version,
            digest: previous.record.status.digest
          },
          guard
        )
        guard()
        if (observation?.outcome !== "installed")
          throw Error("PROJECT_DELIVERY_INSTALLED_CONTENT_CHANGED")
        delete previous.record.status.error
        this.persist(previous.record, previous.raw, guard)
        this.live.add(previous.record.status.id)
      } else {
        const actions = await (this.deps.actions ?? getProjectActionCatalog)(workspace, threadId)
        guard()
        const files = renameNativeComposition(snapshot, input.name, input.version, actions)
        guard()
        await mkdir(this.deps.root, { recursive: true })
        const id = randomUUID()
        const directory = join(this.deps.root, id)
        await mkdir(directory)
        await writeDerivationFiles(directory, files)
        guard()
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
      }
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
      !this.sameWorkspace(workspace, context.scope.workspace) ||
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
      record.effect = { kind: "install" }
      delete record.status.reconciliation
      delete record.status.error
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
    if (!output.toLowerCase().endsWith(".zip")) throw Error("PROJECT_PACK_ZIP_REQUIRED")
    const checked = await this.confirmed(threadId, workspace, input)
    if (!checked.status.canExport) throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
    const { record, guard } = checked
    if (this.busy.has(threadId)) throw Error("PROJECT_DELIVERY_BUSY")
    this.busy.add(threadId)
    let raw = checked.raw
    const previousPhase = record.status.phase
    const previousEffect = record.effect
    let attempted = false
    try {
      const actions = await (this.deps.actions ?? getProjectActionCatalog)(workspace, threadId)
      const staging = await mkdtemp(join(this.deps.root, "export-"))
      const archive = join(staging, "checked.zip")
      await packProjectPlugin(
        checked.directory,
        archive,
        undefined,
        guard,
        actions,
        record.resourcePaths
      )
      guard()
      const bytes = await readProjectDeliveryArchive(archive, guard)
      record.status.phase = "exporting"
      record.effect = {
        kind: "export",
        output: resolve(output),
        digest: digest(bytes),
        bytes: bytes.length
      }
      delete record.status.reconciliation
      delete record.status.error
      raw = this.persist(record, raw, guard)
      attempted = true
      await writeFile(output, bytes, { flag: "wx" })
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
        record.effect = previousEffect
        this.persist(record, raw, guard)
        throw Object.assign(Error("PROJECT_DELIVERY_EXPORT_TARGET_EXISTS"), { code: "EEXIST" })
      }
      record.status.phase = attempted ? "unknown" : previousPhase
      record.status.error = attempted
        ? "PROJECT_DELIVERY_EXPORT_UNCONFIRMED"
        : "PROJECT_DELIVERY_EXPORT_PREPARATION_FAILED"
      if (!attempted) record.effect = previousEffect
      if (attempted) this.live.delete(record.status.id)
      this.persist(record, raw, () => checked.context.assertCurrent())
      throw cause
    } finally {
      this.busy.delete(threadId)
    }
    return this.status(threadId)
  }

  /** Readback grants no execution permission. A new preparation and explicit confirmation are
   * required after an absent result; conflicts and unreadable evidence remain blocked. */
  async reconcile(
    threadId: string,
    workspace: string,
    input: { deliveryId: string; digest: string }
  ) {
    const context = this.deps.context(threadId)
    context.assertCurrent()
    const saved = this.read(context.scope)
    if (
      !this.sameWorkspace(workspace, context.scope.workspace) ||
      !saved ||
      saved.record.status.id !== input.deliveryId ||
      saved.record.status.digest !== input.digest
    )
      throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
    if (this.busy.has(threadId) || this.deps.occupied(threadId))
      throw Error("PROJECT_DELIVERY_BUSY")
    if (!this.status(threadId)?.canReconcile) throw Error("PROJECT_DELIVERY_OUTCOME_NOT_UNKNOWN")
    this.busy.add(threadId)
    try {
      const { record } = saved
      const guard = () => {
        context.assertCurrent()
        if (this.read(context.scope)?.raw !== saved.raw) throw Error("PROJECT_DELIVERY_CHANGED")
      }
      let observed: ProjectDeliveryObservation
      try {
        const candidate = await snapshotDerivationSource(join(this.deps.root, record.status.id))
        guard()
        if (derivationContentIdentity(candidate.files) !== record.status.digest)
          observed = { outcome: "conflict", reason: "PROJECT_DELIVERY_PACKAGE_CHANGED" }
        else if (record.effect?.kind === "install")
          observed = this.deps.observeInstallation
            ? await this.deps.observeInstallation(
                {
                  pluginId: record.pluginId,
                  name: record.status.name,
                  version: record.status.version,
                  digest: record.status.digest
                },
                guard
              )
            : { outcome: "unknown", reason: "PROJECT_DELIVERY_INSTALL_OBSERVER_UNAVAILABLE" }
        else if (record.effect?.kind === "export") {
          const effect = record.effect
          observed =
            typeof effect.output === "string" &&
            /^[a-f0-9]{64}$/.test(effect.digest) &&
            Number.isSafeInteger(effect.bytes) &&
            effect.bytes >= 0 &&
            effect.bytes <= 70 * 1024 * 1024
              ? await observeProjectDeliveryExport(effect, guard)
              : { outcome: "unknown", reason: "PROJECT_DELIVERY_EXPORT_IDENTITY_MISSING" }
        } else if (record.status.phase === "needs-confirmation")
          observed = { outcome: "not-executed", reason: "PROJECT_DELIVERY_NOT_STARTED" }
        else
          observed = { outcome: "unknown", reason: "PROJECT_DELIVERY_OPERATION_IDENTITY_MISSING" }
        const fresh = await snapshotDerivationSource(join(this.deps.root, record.status.id))
        guard()
        if (fresh.digest !== candidate.digest)
          observed = { outcome: "conflict", reason: "PROJECT_DELIVERY_PACKAGE_CHANGED" }
      } catch {
        guard()
        observed = { outcome: "unknown", reason: "PROJECT_DELIVERY_OBSERVATION_UNAVAILABLE" }
      }
      guard()
      record.status.reconciliation = { ...observed, checkedAt: Date.now() }
      this.live.delete(record.status.id)
      if (observed.outcome === "installed") {
        record.status.phase = "installed"
        record.status.pluginId = record.pluginId
        delete record.status.error
      } else if (observed.outcome === "exported") {
        record.status.phase = "exported"
        if (record.effect?.kind === "export") record.status.output = record.effect.output
        delete record.status.error
      } else if (observed.outcome === "not-executed") {
        record.status.phase = record.status.pluginId ? "installed" : "failed"
        record.status.error = observed.reason
      } else {
        record.status.phase = "unknown"
        record.status.error = observed.reason
      }
      this.persist(record, saved.raw, guard)
      if (observed.outcome === "installed") this.deps.invalidate()
    } finally {
      this.busy.delete(threadId)
    }
    return this.status(threadId)
  }
}
