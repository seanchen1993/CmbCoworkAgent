import { createHash } from "node:crypto"
import type { AuthoringInstallationInspection } from "../../../shared/mods/authoring-install"
import type { AuthoringRetentionInspection } from "../../../shared/mods/authoring-install"
import {
  AuthoringRetentionStore,
  retentionDigest,
  readRetirementVersionIds
} from "./authoring-retention-state"
import { randomUUID } from "node:crypto"
import { join, relative, resolve, isAbsolute } from "node:path"
import type { PluginMetadata } from "../../types"
import { PluginCatalogIndex, type PluginCatalogSnapshot } from "../../plugins/catalog-index"
import { pluginCatalogGate } from "../../plugins/catalog-gate"
import { withPluginCatalogMutation } from "../../plugins/catalog-mutation"
import { AuthoringDraftStore } from "./authoring-store"
import {
  AuthoringVersionRepository,
  AUTHORING_VERSION_LIMITS,
  type AuthoringPreparationToken,
  type PreparedAuthoringVersion
} from "./authoring-version-repository"
import {
  AuthoringInstallJournal,
  isAuthoringInstallTerminal,
  authoringCatalogDigest,
  authoringRetirementClosure,
  type AuthoringInstallJournalRecord
} from "./authoring-install-journal"
import {
  authoringPlainRecord,
  captureRawFunctionConfigSnapshot,
  restoreRawFunctionConfigSnapshot,
  type AuthoringAtomicSettings,
  type AuthoringConfigSnapshot
} from "./authoring-config-snapshot"

export interface AuthoringInstallScope {
  workspace: string
  signal: AbortSignal
  assertCurrent(): void
}
export interface AuthoringInstallDependencies {
  settings: AuthoringAtomicSettings
  drafts: AuthoringDraftStore
  versions: AuthoringVersionRepository
  versionsRoot: string
  index: PluginCatalogIndex
  assertIdle(): void
  isVersionReferenced(directory: string): boolean
  changed(): void
  inspectNames(): Promise<{ names: Array<{ id: string; name: string }>; assertCurrent(): void }>
}
interface Candidate {
  record: PreparedAuthoringVersion
  token: AuthoringPreparationToken
  snapshot: PluginCatalogSnapshot
  directory: string
  current?: PreparedAuthoringVersion
  configuration: "unchanged" | "restore"
  configTarget?: AuthoringConfigSnapshot
  configBefore: AuthoringConfigSnapshot
  assertCurrent(): void
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
// Shared by every host service using this repository, including late preparation callbacks.
const liveRepositories = new Map<string, { preparing: number; candidates: Set<Candidate> }>()
function identity(record: PreparedAuthoringVersion) {
  const plugin = JSON.parse(record.source.files.find((file) => file.path === "plugin.json")!.text)
  const manifest = JSON.parse(
    record.source.files.find((file) => file.path === "mods/manifest.json")!.text
  )
  if (manifest.id !== plugin.name) throw Error("AUTHORING_INSTALL_IDENTITY")
  return {
    name: String(plugin.name),
    version: String(plugin.version ?? "0.1.0"),
    description: String(plugin.description ?? "")
  }
}
function catalog(snapshot: PluginCatalogSnapshot): PluginMetadata[] {
  const rows: unknown = snapshot.raw === null ? [] : JSON.parse(snapshot.raw)
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        typeof row.path !== "string"
    ) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw Error("AUTHORING_INSTALL_CATALOG_INVALID")
  return rows as PluginMetadata[]
}
function scope(input: AuthoringInstallScope) {
  const captured = authoringPlainRecord(input)
  if (
    typeof captured.workspace !== "string" ||
    !captured.workspace ||
    captured.workspace.length > 4096 ||
    !(captured.signal instanceof AbortSignal) ||
    typeof captured.assertCurrent !== "function"
  )
    throw Error("AUTHORING_INSTALL_SCOPE")
  const workspace = captured.workspace,
    signal = captured.signal,
    check = captured.assertCurrent
  const assertCurrent = () => {
    signal.throwIfAborted()
    check()
    signal.throwIfAborted()
  }
  assertCurrent()
  return { workspace, signal, assertCurrent }
}

/** Host service: immutable preparation never mutates installed plugins, grants or Claw selection. */
export class AuthoringInstallService {
  private readonly journal: AuthoringInstallJournal
  private readonly retention: AuthoringRetentionStore
  private readonly candidates = new Map<string, Candidate>()
  private readonly live: { preparing: number; candidates: Set<Candidate> }
  constructor(private readonly deps: AuthoringInstallDependencies) {
    this.journal = new AuthoringInstallJournal(deps.settings)
    this.retention = new AuthoringRetentionStore(deps.settings)
    const root = resolve(deps.versionsRoot).toLowerCase()
    this.live = liveRepositories.get(root) ?? { preparing: 0, candidates: new Set() }
    liveRepositories.set(root, this.live)
  }

  private async collectUnused(workspace: string, assertCurrent: () => void) {
    try {
      await withPluginCatalogMutation(async () =>
        pluginCatalogGate.commit(this.deps.assertIdle, () => {
          assertCurrent()
          if (this.live.preparing || this.retention.read().value.pending) return
          this.deps.versions.collectUnreferenced(workspace, (record) => {
            assertCurrent()
            this.deps.assertIdle()
            if (
              this.deps.isVersionReferenced(
                join(this.deps.versionsRoot, record.versionId, "source")
              )
            )
              return true
            if (
              this.live.preparing ||
              [...this.live.candidates].some(
                (candidate) => candidate.record.versionId === record.versionId
              )
            )
              return true
            // Keep every durable operation, not just the current workspace or settled installs.
            if (
              this.journal
                .listAll()
                .some(
                  (operation) =>
                    operation.versionId === record.versionId ||
                    operation.reconciliation?.observedVersionId === record.versionId
                )
            )
              return true
            const directory = resolve(this.deps.versionsRoot, record.versionId)
            const overlaps = (a: string, b: string) => {
              const path = relative(a, b)
              return (
                path === "" ||
                (!isAbsolute(path) &&
                  path !== ".." &&
                  !path.startsWith("..\\") &&
                  !path.startsWith("../"))
              )
            }
            return catalog(this.deps.index.capture()).some(
              (plugin) =>
                overlaps(directory, resolve(plugin.path)) ||
                overlaps(resolve(plugin.path), directory)
            )
          })
        })
      )
    } catch (error) {
      // Preparation remains available during ordinary runtime activity. Cleanup retries when idle.
      if (
        !["PLUGIN_CATALOG_BUSY", "PLUGIN_CATALOG_APPLYING", "AUTHORING_VERSION_BUSY"].includes(
          error instanceof Error ? error.message : ""
        )
      )
        throw error
    }
  }

  private records(workspace: string) {
    return this.journal.list(workspace)
  }

  private retentionObservation(active: ReturnType<typeof scope>) {
    active.assertCurrent()
    const state = this.retention.read(),
      snapshot = this.deps.index.capture()
    const operations = this.journal.listAll()
    const pending = state.value.pending?.records ?? []
    const pendingIds = new Set(pending.map((record) => record.versionId))
    const records = [...this.deps.versions.listRecords(pendingIds), ...pending]
    const current = new Set<string>()
    for (const record of records) {
      const directory = resolve(this.deps.versionsRoot, record.versionId)
      if (
        catalog(snapshot).some((plugin) => {
          const a = relative(directory, resolve(plugin.path)),
            b = relative(resolve(plugin.path), directory)
          return [a, b].some(
            (path) =>
              path === "" ||
              (!isAbsolute(path) &&
                path !== ".." &&
                !path.startsWith("..\\") &&
                !path.startsWith("../"))
          )
        })
      )
        current.add(record.versionId)
    }
    const rollback = new Set<string>(),
      seen = new Set<string>()
    for (const operation of [...operations].reverse()) {
      const id =
        operation.phase === "settled"
          ? operation.versionId
          : operation.reconciliation?.observedVersionId
      if (id && !current.has(id) && !seen.has(operation.installationId) && !pendingIds.has(id)) {
        rollback.add(id)
        seen.add(operation.installationId)
      }
    }
    let busy = this.live.preparing > 0 || pluginCatalogGate.activityCount > 0
    try {
      this.deps.assertIdle()
    } catch {
      busy = true
    }
    const versions: AuthoringRetentionInspection["versions"] = records.map((record) => {
      const reason = busy
        ? "busy"
        : current.has(record.versionId)
          ? "current"
          : [...this.live.candidates].some(
                (candidate) => candidate.record.versionId === record.versionId
              ) ||
              this.deps.isVersionReferenced(
                join(this.deps.versionsRoot, record.versionId, "source")
              )
            ? "candidate"
            : operations.some(
                  (operation) =>
                    operation.installationId === record.installationId &&
                    !isAuthoringInstallTerminal(operation.phase)
                )
              ? "uncertain"
              : pendingIds.has(record.versionId)
                ? "cleanup-failed"
                : rollback.has(record.versionId)
                  ? "rollback"
                  : "eligible"
      return {
        versionId: record.versionId,
        installationId: record.installationId,
        workspace: record.workspace,
        name: identity(record).name,
        revision: record.revision,
        createdAt: record.createdAt,
        canRetire: reason === "eligible" || reason === "cleanup-failed",
        reason
      }
    })
    const eligible = new Set(
      versions.filter((version) => version.canRetire).map((version) => version.versionId)
    )
    for (const version of versions) {
      if (!version.canRetire) continue
      const required = authoringRetirementClosure(version.versionId, operations, eligible)
      if (required) version.requiredVersionIds = required
      else {
        version.canRetire = false
        version.reason = "uncertain"
      }
    }
    const quarantine = this.deps.versions.quarantineUsage()
    const value: AuthoringRetentionInspection = {
      fingerprint: retentionDigest({
        state: state.raw,
        catalog: snapshot.raw,
        operations,
        records,
        versions,
        quarantine
      }),
      usedVersions: records.length + quarantine.count,
      limit: AUTHORING_VERSION_LIMITS.versions,
      usedBytes:
        quarantine.bytes +
        records.reduce(
          (total, record) =>
            total +
            Buffer.byteLength(JSON.stringify(record)) +
            record.source.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.text), 0),
          0
        ),
      byteLimit: AUTHORING_VERSION_LIMITS.bytes,
      protectedArtifacts: quarantine.count,
      versions,
      pendingVersionIds: [...pendingIds],
      retiredVersions: state.value.receipts.length
    }
    active.assertCurrent()
    return { value, records, state, snapshot, operations }
  }

  inspectRetention(binding: AuthoringInstallScope): AuthoringRetentionInspection {
    return this.retentionObservation(scope(binding)).value
  }

  async retireVersions(
    input: { expectedFingerprint: string; versionIds: string[]; acknowledgeLostRollback: true },
    binding: AuthoringInstallScope
  ): Promise<AuthoringRetentionInspection> {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    if (
      typeof row.expectedFingerprint !== "string" ||
      !SHA.test(row.expectedFingerprint) ||
      row.acknowledgeLostRollback !== true
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    const ids = new Set(readRetirementVersionIds(row.versionIds)),
      fingerprint = row.expectedFingerprint
    return withPluginCatalogMutation(async () =>
      pluginCatalogGate.commit(this.deps.assertIdle, () => {
        const observed = this.retentionObservation(active)
        if (
          observed.value.fingerprint !== fingerprint ||
          [...ids].some((id) => {
            const version = observed.value.versions.find((version) => version.versionId === id)
            return (
              !version?.canRetire ||
              version.requiredVersionIds?.some((required) => !ids.has(required))
            )
          })
        )
          throw Error("AUTHORING_RETENTION_CHANGED")
        const previous = observed.state.value.pending
        if (
          previous &&
          (previous.records.length !== ids.size ||
            previous.records.some((record) => !ids.has(record.versionId)))
        )
          throw Error("AUTHORING_RETENTION_CHANGED")
        const records = observed.records.filter((record) => ids.has(record.versionId))
        const kept = observed.records.filter((record) => !ids.has(record.versionId))
        const needed = new Set(kept.map((record) => record.compiledDigest))
        const configurations = [
          ...observed.state.value.configurations,
          ...observed.operations.flatMap((operation) =>
            operation.configBefore ? [operation.configBefore] : []
          )
        ].filter((config) => needed.has(config.compiledDigest))
        const unique = new Map(
          configurations.map((config) => [
            JSON.stringify([config.workspace, config.plugin, config.compiledDigest]),
            config
          ])
        )
        if (unique.size > 16) throw Error("AUTHORING_RETENTION_LIMIT")
        let saved = observed.state
        if (!previous) {
          this.retention.write(
            saved.raw,
            {
              ...saved.value,
              configurations: [...unique.values()],
              pending: { id: randomUUID(), records }
            },
            active.assertCurrent
          )
          saved = this.retention.read()
        }
        const transaction = saved.value.pending!
        const guard = () => {
          active.assertCurrent()
          this.deps.assertIdle()
          this.deps.index.assertCurrent(observed.snapshot)
          if (
            this.live.preparing ||
            [...this.live.candidates].some((candidate) => ids.has(candidate.record.versionId)) ||
            records.some((record) =>
              this.deps.isVersionReferenced(
                join(this.deps.versionsRoot, record.versionId, "source")
              )
            ) ||
            this.retention.read().value.pending?.id !== transaction.id
          )
            throw Error("AUTHORING_RETENTION_CHANGED")
        }
        // The pending snapshot is durable before removing active journal references or any source.
        this.journal.retireVersions(ids, guard)
        this.deps.versions.retireRecords(
          transaction.records,
          transaction.id,
          active.workspace,
          guard
        )
        guard()
        const latest = this.retention.read()
        this.retention.write(
          latest.raw,
          {
            schemaVersion: 1,
            configurations: latest.value.configurations,
            receipts: [
              ...latest.value.receipts,
              ...records.map((record) => ({
                versionId: record.versionId,
                installationId: record.installationId,
                retiredAt: Date.now(),
                digest: retentionDigest(record)
              }))
            ].slice(-64)
          },
          () => {
            active.assertCurrent()
            this.deps.assertIdle()
            this.deps.index.assertCurrent(observed.snapshot)
          }
        )
        return this.retentionObservation(active).value
      })
    )
  }

  private installed(workspace: string, installationId: string, snapshot: PluginCatalogSnapshot) {
    const rows = this.records(workspace).filter((row) => row.installationId === installationId)
    if (rows.some((row) => !isAuthoringInstallTerminal(row.phase)))
      throw Error("AUTHORING_INSTALL_PENDING")
    const item = catalog(snapshot).find((plugin) => plugin.id === installationId)
    if (!item) return undefined
    const versionIds = rows.flatMap((row) =>
      row.phase === "settled"
        ? [row.versionId]
        : row.reconciliation?.observedVersionId
          ? [row.reconciliation.observedVersionId]
          : []
    )
    const versionId = versionIds.find(
      (id) => item.path === join(this.deps.versionsRoot, id, "source")
    )
    if (!versionId) throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    const record = this.deps.versions.read(versionId)
    if (
      record.installationId !== installationId ||
      record.workspace !== workspace ||
      item.path !== join(this.deps.versionsRoot, record.versionId, "source") ||
      item.name !== identity(record).name
    )
      throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    return record
  }

  list(input: AuthoringInstallScope) {
    const active = scope(input),
      snapshot = this.deps.index.capture()
    const rows = this.records(active.workspace),
      grouped = new Map<string, AuthoringInstallJournalRecord[]>()
    for (const row of rows)
      grouped.set(row.installationId, [...(grouped.get(row.installationId) ?? []), row])
    const installations = [...grouped].map(([installationId, operations]) => {
      const versions = [...new Set(operations.map((row) => row.versionId))].map((versionId) => {
        const record = this.deps.versions.read(versionId)
        if (record.workspace !== active.workspace || record.installationId !== installationId)
          throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
        return {
          versionId,
          sourceDigest: record.sourceDigest,
          compiledDigest: record.compiledDigest,
          createdAt: record.createdAt,
          revision: record.revision
        }
      })
      const last = operations.at(-1)!,
        record = this.deps.versions.read(last.versionId)
      const pending = operations.find((row) => !isAuthoringInstallTerminal(row.phase))
      const installed = pending
        ? undefined
        : this.installed(active.workspace, installationId, snapshot)
      return {
        installationId,
        name: identity(record).name,
        versions,
        ...(installed ? { currentVersionId: installed.versionId } : {}),
        ...(pending
          ? {
              pending: {
                operationId: pending.operationId,
                state: pending.phase,
                ...(pending.reason ? { reason: pending.reason } : {})
              }
            }
          : {})
      }
    })
    active.assertCurrent()
    return { workspace: active.workspace, installations }
  }

  /** Restore display context only. An observation never creates a candidate or grants authority. */
  async resolveInstalled(
    input: { draftId: string; revision: number; sourceDigest: string },
    binding: AuthoringInstallScope
  ) {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    if (
      typeof row.draftId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(row.draftId) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
      typeof row.sourceDigest !== "string" ||
      !SHA.test(row.sourceDigest)
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    const { draftId, revision, sourceDigest } = row
    const snapshot = this.deps.index.capture()
    const operations = this.records(active.workspace)
    const matching = operations.filter(
      (operation) => operation.draftId === draftId && operation.revision === revision
    )
    const ids = [...new Set(matching.map((operation) => operation.installationId))]
    const resolved: PreparedAuthoringVersion[] = []
    for (const installationId of ids) {
      // Uncertain history is deliberately not converted into a success receipt.
      if (
        operations.some(
          (operation) =>
            operation.installationId === installationId &&
            !isAuthoringInstallTerminal(operation.phase)
        )
      )
        return null
      const record = this.installed(active.workspace, installationId, snapshot)
      if (
        record &&
        record.draftId === draftId &&
        record.revision === revision &&
        record.sourceDigest === sourceDigest
      )
        resolved.push(record)
    }
    if (resolved.length !== 1) return null
    const record = resolved[0]
    this.live.preparing++
    try {
      const assertCurrent = () => {
        active.assertCurrent()
        this.deps.index.assertCurrent(snapshot)
        if (JSON.stringify(this.records(active.workspace)) !== JSON.stringify(operations))
          throw Error("AUTHORING_INSTALL_CHANGED")
      }
      const checked = await this.deps.versions.revalidate(record.versionId, {
        signal: active.signal,
        assertCurrent
      })
      assertCurrent()
      this.deps.versions.assertPrepared(checked.token)
      if (JSON.stringify(checked.record) !== JSON.stringify(record))
        throw Error("AUTHORING_VERSION_CHANGED")
      return {
        installationId: record.installationId,
        versionId: record.versionId,
        name: identity(record).name,
        sourceDigest: record.sourceDigest,
        compiledDigest: record.compiledDigest
      }
    } finally {
      this.live.preparing--
    }
  }

  async prepare(
    input: { draftId: string; revision: number; sourceDigest: string },
    binding: AuthoringInstallScope
  ) {
    const active = scope(binding),
      captured = authoringPlainRecord(input)
    const { draftId, revision, sourceDigest } = captured
    if (
      typeof draftId !== "string" ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 1 ||
      typeof sourceDigest !== "string" ||
      !SHA.test(sourceDigest)
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    const read = () => {
      active.assertCurrent()
      const draft = this.deps.drafts.list(active.workspace).find((item) => item.id === draftId)
      const version = draft?.versions.at(-1)
      if (!version || draft!.currentRevision !== revision || version.source.digest !== sourceDigest)
        throw Error("AUTHORING_INSTALL_STALE")
      return version
    }
    const version = read()
    const matching = this.records(active.workspace).filter((row) => row.draftId === draftId)
    const installationId = matching.at(-1)?.installationId ?? randomUUID()
    return this.prepareVersion(
      {
        installationId,
        workspace: active.workspace,
        draftId,
        revision: Number(revision),
        source: version.source,
        signal: active.signal,
        assertCurrent: () => {
          read()
        }
      },
      active
    )
  }

  async rollbackPrepare(
    input: { installationId: string; versionId: string; restoreConfiguration: boolean },
    binding: AuthoringInstallScope
  ) {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    const { installationId, versionId, restoreConfiguration } = row
    if (
      typeof installationId !== "string" ||
      !UUID.test(installationId) ||
      typeof versionId !== "string" ||
      !UUID.test(versionId) ||
      typeof restoreConfiguration !== "boolean"
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    const operations = this.records(active.workspace).filter(
      (item) => item.installationId === installationId
    )
    if (
      this.retention.read().value.pending?.records.some((record) => record.versionId === versionId)
    )
      throw Error("AUTHORING_INSTALL_STALE")
    if (
      !operations.some(
        (item) =>
          (item.versionId === versionId && item.phase === "settled") ||
          item.reconciliation?.observedVersionId === versionId
      )
    )
      throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    const target = this.deps.versions.read(versionId)
    if (target.installationId !== installationId || target.workspace !== active.workspace)
      throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    const configuration = restoreConfiguration
      ? [
          ...this.retention.read().value.configurations.map((configBefore) => ({ configBefore })),
          ...operations
        ]
          .reverse()
          .find((item) => item.configBefore?.compiledDigest === target.compiledDigest)?.configBefore
      : undefined
    if (restoreConfiguration && !configuration) throw Error("AUTHORING_INSTALL_CONFIG_UNAVAILABLE")
    const prepared = await this.prepareVersion(
      {
        installationId,
        workspace: active.workspace,
        draftId: target.draftId,
        revision: target.revision,
        source: target.source,
        signal: active.signal,
        assertCurrent: active.assertCurrent
      },
      active,
      configuration,
      versionId
    )
    return { ...prepared, restoredFromVersionId: versionId }
  }

  private async prepareVersion(
    input: Parameters<AuthoringVersionRepository["prepare"]>[0],
    active: ReturnType<typeof scope>,
    configTarget?: AuthoringConfigSnapshot,
    retainedVersionId?: string
  ) {
    await this.collectUnused(active.workspace, active.assertCurrent)
    this.live.preparing++
    try {
      return await this.prepareCandidate(input, active, configTarget, retainedVersionId)
    } finally {
      this.live.preparing--
    }
  }

  private async prepareCandidate(
    input: Parameters<AuthoringVersionRepository["prepare"]>[0],
    active: ReturnType<typeof scope>,
    configTarget?: AuthoringConfigSnapshot,
    retainedVersionId?: string
  ) {
    if (this.candidates.size >= 8) throw Error("AUTHORING_INSTALL_LIMIT")
    const initial = this.deps.index.capture()
    const current = this.installed(active.workspace, input.installationId, initial)
    const prepared = retainedVersionId
      ? await this.deps.versions.revalidate(retainedVersionId, {
          signal: input.signal,
          assertCurrent: input.assertCurrent
        })
      : await this.deps.versions.prepare(input)
    const record = prepared.record,
      details = identity(record)
    if (
      record.workspace !== active.workspace ||
      record.installationId !== input.installationId ||
      record.draftId !== input.draftId ||
      record.sourceDigest !== input.source.digest
    )
      throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    if (current && identity(current).name !== details.name)
      throw Error("AUTHORING_INSTALL_IDENTITY")
    const names = await this.deps.inspectNames()
    const assertCurrent = () => {
      active.assertCurrent()
      input.assertCurrent()
      names.assertCurrent()
      this.deps.index.assertCurrent(initial)
      this.deps.versions.assertPrepared(prepared.token)
      if (
        catalog(initial).some(
          (item) => item.id !== record.installationId && item.name === details.name
        ) ||
        names.names.some((item) => item.id !== record.installationId && item.name === details.name)
      )
        throw Error("AUTHORING_INSTALL_NAME_EXISTS")
    }
    assertCurrent()
    const configBefore = captureRawFunctionConfigSnapshot(
      this.deps.settings,
      {
        workspace: active.workspace,
        plugin: details.name,
        compiledDigest: current?.compiledDigest ?? record.compiledDigest
      },
      assertCurrent
    )
    if (
      configTarget &&
      (configTarget.plugin !== details.name ||
        configTarget.workspace !== active.workspace ||
        configTarget.compiledDigest !== record.compiledDigest)
    )
      throw Error("AUTHORING_INSTALL_CONFIG_UNAVAILABLE")
    if (this.candidates.size >= 8) throw Error("AUTHORING_INSTALL_LIMIT")
    const handle = randomUUID(),
      configuration: "restore" | "unchanged" = configTarget ? "restore" : "unchanged"
    this.candidates.set(handle, {
      record,
      token: prepared.token,
      snapshot: initial,
      directory: this.deps.versions.preparedSourceDirectory(prepared.token),
      current,
      configBefore,
      configuration,
      configTarget,
      assertCurrent
    })
    this.live.candidates.add(this.candidates.get(handle)!)
    const definition = JSON.parse(
      record.source.files.find((file) => file.path === "mods/manifest.json")!.text
    )
    const oldFiles = new Map(current?.source.files.map((file) => [file.path, file.text]) ?? [])
    const newFiles = new Map(record.source.files.map((file) => [file.path, file.text]))
    const changedFiles = [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
      .sort()
      .flatMap((path) =>
        oldFiles.get(path) === newFiles.get(path)
          ? []
          : [
              {
                path,
                change: !oldFiles.has(path)
                  ? ("added" as const)
                  : !newFiles.has(path)
                    ? ("removed" as const)
                    : ("changed" as const)
              }
            ]
      )
    return {
      review: {
        ...prepared.review,
        configurationKeys: Object.keys(definition.userConfig ?? {}).sort(),
        components: (definition.claw?.components ?? []).map(
          (component: { id: string; dependsOn?: string[] }) => ({
            id: component.id,
            dependsOn: component.dependsOn ?? []
          })
        ),
        changedFiles
      },
      handle,
      installationId: record.installationId,
      versionId: record.versionId,
      name: details.name,
      sourceDigest: record.sourceDigest,
      compiledDigest: record.compiledDigest,
      catalogDigest: authoringCatalogDigest(initial.raw),
      configuration,
      ...(current ? { currentVersionId: current.versionId } : {})
    }
  }

  private inspectRecord(operationId: string, active: ReturnType<typeof scope>) {
    const operation = this.journal.read(operationId, active.workspace)
    if (!operation || isAuthoringInstallTerminal(operation.phase) || !operation.configBefore)
      throw Error("AUTHORING_INSTALL_STALE")
    const snapshot = this.deps.index.capture(),
      catalogDigest = authoringCatalogDigest(snapshot.raw)
    const side =
      catalogDigest === operation.nextCatalogDigest
        ? ("after" as const)
        : catalogDigest === operation.expectedCatalogDigest
          ? ("before" as const)
          : ("different" as const)
    const config = captureRawFunctionConfigSnapshot(
      this.deps.settings,
      operation.configBefore,
      active.assertCurrent
    )
    const restored = operation.configTarget
      ? JSON.stringify({
          ...operation.configTarget.record,
          revision: operation.configBefore.record.revision + 1
        })
      : undefined
    const configuration =
      config.raw === operation.configBefore.raw
        ? ("unchanged" as const)
        : restored !== undefined && config.raw === restored
          ? ("restored" as const)
          : ("different" as const)
    const item = catalog(snapshot).find((plugin) => plugin.id === operation.installationId)
    let observedVersionId: string | undefined
    if (side !== "different" && item) {
      const permitted = this.records(active.workspace)
        .filter((row) => row.installationId === operation.installationId)
        .flatMap((row) =>
          row.phase === "settled" || row.operationId === operationId
            ? [row.versionId]
            : row.reconciliation?.observedVersionId
              ? [row.reconciliation.observedVersionId]
              : []
        )
      observedVersionId = permitted.find(
        (id) => item.path === join(this.deps.versionsRoot, id, "source")
      )
      if (!observedVersionId) throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
      const record = this.deps.versions.read(observedVersionId)
      if (
        record.workspace !== active.workspace ||
        record.installationId !== operation.installationId ||
        identity(record).name !== item.name
      )
        throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    }
    if (side === "after" && observedVersionId !== operation.versionId)
      throw Error("AUTHORING_INSTALL_OWNERSHIP_CHANGED")
    const value: AuthoringInstallationInspection = {
      operationId,
      installationId: operation.installationId,
      originalState: operation.phase,
      catalog: side,
      configuration,
      ...(observedVersionId ? { observedVersionId } : {}),
      inspectionDigest: createHash("sha256")
        .update(
          JSON.stringify({
            operation,
            catalogDigest,
            configDigest: config.digest,
            observedVersionId
          })
        )
        .digest("hex"),
      canAccept: side !== "different"
    }
    active.assertCurrent()
    return { operation, snapshot, config, catalogDigest, value }
  }

  inspectUncertain(input: { operationId: string }, binding: AuthoringInstallScope) {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    if (typeof row.operationId !== "string" || !UUID.test(row.operationId))
      throw Error("AUTHORING_INSTALL_INVALID")
    return this.inspectRecord(row.operationId, active).value
  }

  async reconcile(
    input: { operationId: string; expectedInspectionDigest: string },
    binding: AuthoringInstallScope
  ) {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    if (
      typeof row.operationId !== "string" ||
      !UUID.test(row.operationId) ||
      typeof row.expectedInspectionDigest !== "string" ||
      !SHA.test(row.expectedInspectionDigest)
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    const operationId = row.operationId,
      expected = row.expectedInspectionDigest
    const first = this.inspectRecord(operationId, active)
    if (!first.value.canAccept || first.value.inspectionDigest !== expected)
      throw Error("AUTHORING_INSTALL_CHANGED")
    const proof = first.value.observedVersionId
      ? await this.deps.versions.revalidate(first.value.observedVersionId, {
          signal: active.signal,
          assertCurrent: active.assertCurrent
        })
      : undefined
    return withPluginCatalogMutation(async () =>
      pluginCatalogGate.commit(this.deps.assertIdle, () => {
        const check = () => {
          active.assertCurrent()
          if (proof) this.deps.versions.assertPrepared(proof.token)
          this.deps.index.assertCurrent(first.snapshot)
          if (this.inspectRecord(operationId, active).value.inspectionDigest !== expected)
            throw Error("AUTHORING_INSTALL_CHANGED")
        }
        check()
        this.deps.changed()
        check()
        this.journal.reconcile({
          operationId,
          workspace: active.workspace,
          expectedRevision: first.operation.journalRevision,
          observation: {
            catalog: first.value.catalog as "before" | "after",
            configuration: first.value.configuration,
            ...(first.value.observedVersionId
              ? { observedVersionId: first.value.observedVersionId }
              : {}),
            catalogDigest: first.catalogDigest,
            configDigest: first.config.digest,
            observedAt: Date.now()
          },
          // After CAS the operation is terminal, so only scope/source/catalog/config fences apply.
          assertCurrent: () => {
            active.assertCurrent()
            if (proof) this.deps.versions.assertPrepared(proof.token)
            this.deps.index.assertCurrent(first.snapshot)
            if (
              captureRawFunctionConfigSnapshot(
                this.deps.settings,
                first.config,
                active.assertCurrent
              ).digest !== first.config.digest
            )
              throw Error("AUTHORING_CONFIG_CHANGED")
          }
        })
        return { operationId, state: "reconciled" as const }
      })
    )
  }

  inspectPreparation(binding: AuthoringInstallScope) {
    const active = scope(binding),
      result = this.deps.versions.inspectPreparation(active.workspace)
    active.assertCurrent()
    return result
  }
  async recoverPreparation(input: { expectedFingerprint: string }, binding: AuthoringInstallScope) {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    if (typeof row.expectedFingerprint !== "string" || !SHA.test(row.expectedFingerprint))
      throw Error("AUTHORING_INSTALL_INVALID")
    const expected = row.expectedFingerprint
    return withPluginCatalogMutation(async () =>
      pluginCatalogGate.commit(this.deps.assertIdle, () =>
        this.deps.versions.recoverPreparation(active.workspace, expected, active.assertCurrent)
      )
    )
  }

  async discardPrepared(handle: string): Promise<void> {
    const candidate = this.candidates.get(handle)
    if (!candidate) return
    this.candidates.delete(handle)
    this.live.candidates.delete(candidate)
    await this.collectUnused(candidate.record.workspace, () => {})
  }

  async apply(
    input: { handle: string; expectedCatalogDigest: string },
    binding: AuthoringInstallScope
  ) {
    const active = scope(binding),
      row = authoringPlainRecord(input)
    const handle = row.handle,
      expected = row.expectedCatalogDigest
    if (
      typeof handle !== "string" ||
      !UUID.test(handle) ||
      typeof expected !== "string" ||
      !SHA.test(expected)
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    const candidate = this.candidates.get(handle)
    if (
      !candidate ||
      candidate.record.workspace !== active.workspace ||
      authoringCatalogDigest(candidate.snapshot.raw) !== expected
    )
      throw Error("AUTHORING_INSTALL_STALE")
    return withPluginCatalogMutation(async () => {
      active.assertCurrent()
      candidate.assertCurrent()
      if (this.candidates.get(handle) !== candidate) throw Error("AUTHORING_INSTALL_STALE")
      return pluginCatalogGate.commitWhenIdle(this.deps.assertIdle, () => {
        active.assertCurrent()
        candidate.assertCurrent()
        const details = identity(candidate.record),
          items = catalog(candidate.snapshot)
        const prior = items.find((item) => item.id === candidate.record.installationId)
        const now = new Date().toISOString()
        const metadata: PluginMetadata = {
          id: candidate.record.installationId,
          ...details,
          author: "",
          path: candidate.directory,
          enabled: prior?.enabled ?? true,
          skillCount: 0,
          mcpServerCount: 0,
          hookCount: 0,
          modCount: 1,
          origin: "local",
          createdAt: prior?.createdAt ?? now,
          updatedAt: now
        }
        const next = JSON.stringify(
          [...items.filter((item) => item.id !== metadata.id), metadata],
          null,
          2
        )
        const configNow = captureRawFunctionConfigSnapshot(
          this.deps.settings,
          {
            workspace: active.workspace,
            plugin: details.name,
            compiledDigest: candidate.configBefore.compiledDigest
          },
          active.assertCurrent
        )
        if (configNow.digest !== candidate.configBefore.digest)
          throw Error("AUTHORING_CONFIG_CHANGED")
        const operationId = randomUUID()
        let journal = this.journal.begin({
          operationId,
          installationId: metadata.id,
          versionId: candidate.record.versionId,
          workspace: active.workspace,
          draftId: candidate.record.draftId,
          revision: candidate.record.revision,
          configuration: candidate.configuration,
          expectedCatalogRaw: candidate.snapshot.raw,
          nextCatalogRaw: next,
          configBefore: configNow,
          configTarget: candidate.configTarget,
          assertCurrent: active.assertCurrent
        })
        this.candidates.delete(handle)
        this.live.candidates.delete(candidate)
        let committed = false
        const advance = (
          phase: "catalog-committed" | "config-restoring" | "config-restored" | "settled"
        ) => {
          journal = this.journal.advance({
            operationId,
            workspace: active.workspace,
            expectedRevision: journal.journalRevision,
            next: phase,
            observedCatalogDigest: authoringCatalogDigest(this.deps.index.capture().raw),
            assertCurrent: active.assertCurrent
          })
        }
        try {
          candidate.assertCurrent()
          active.assertCurrent()
          this.deps.index.replace(candidate.snapshot, next)
          committed = true
          advance("catalog-committed")
          if (candidate.configTarget) {
            advance("config-restoring")
            restoreRawFunctionConfigSnapshot(this.deps.settings, {
              snapshot: candidate.configTarget,
              expectedCurrent: configNow,
              targetCompiledDigest: candidate.record.compiledDigest,
              assertCurrent: active.assertCurrent
            })
            advance("config-restored")
          }
          this.deps.changed()
          advance("settled")
          return {
            operationId,
            installationId: metadata.id,
            versionId: candidate.record.versionId,
            state: "settled" as const
          }
        } catch {
          const state = committed ? ("partial" as const) : ("unknown" as const)
          try {
            const observed = this.journal.read(operationId, active.workspace)!
            this.journal.advance({
              operationId,
              workspace: active.workspace,
              expectedRevision: observed.journalRevision,
              next: state,
              reason: committed ? "config-unconfirmed" : "catalog-unconfirmed",
              assertCurrent: () => {}
            })
          } catch {
            /* The durable intent remains visible as unresolved; never retry the write. */
          }
          try {
            this.deps.changed()
          } catch {
            /* Even a lost index ACK must invalidate cached sources. */
          }
          return {
            operationId,
            installationId: metadata.id,
            versionId: candidate.record.versionId,
            state
          }
        }
      }, {
        signal: active.signal,
        timeoutMs: 2000,
        assertCurrent: () => {
          active.assertCurrent()
          candidate.assertCurrent()
          if (this.candidates.get(handle) !== candidate) throw Error("AUTHORING_INSTALL_STALE")
        }
      })
    })
  }
}
