import { createHash } from "node:crypto"
import { types } from "node:util"
import { readAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"

interface AuthoringSettingsStore {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting(key: string, expected: string | undefined, value: string): boolean
}
export interface AuthoringVersion {
  revision: number
  createdAt: number
  source: AuthoringSourceBundle
  restoredFrom?: number
  restoredFromDigest?: string
}
export interface AuthoringDraft {
  id: string
  name: string
  currentRevision: number
  versions: AuthoringVersion[]
}
const MAX_DRAFTS = 16
const MAX_VERSIONS = 16
const MAX_STORAGE_BYTES = 4 * 1024 * 1024
const ABSENT = "\u0000authoring-absent"
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id)
const validName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.trim().length > 0 &&
  name.length <= 100 &&
  ![...name].some((character) => character.charCodeAt(0) < 32)
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function captureInput<T extends object>(input: T): Readonly<T> {
  if (!record(input) || types.isProxy(input)) throw Error("AUTHORING_DRAFT_INVALID")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== null && prototype !== Object.prototype) throw Error("AUTHORING_DRAFT_INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(input).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable)
  )
    throw Error("AUTHORING_DRAFT_INVALID")
  const captured = Object.fromEntries(
    Object.entries(descriptors).map(([key, item]) => [key, item.value])
  )
  if (typeof captured.assertCurrent !== "function") throw Error("AUTHORING_DRAFT_INVALID")
  return Object.freeze(captured) as Readonly<T>
}

/** Draft source history only: never installs a plugin, changes grants or applies a Claw. */
export class AuthoringDraftStore {
  constructor(private readonly settings: AuthoringSettingsStore) {}

  private key(workspace: string): string {
    if (
      typeof workspace !== "string" ||
      !workspace ||
      workspace.length > 4096 ||
      workspace.includes("\0")
    )
      throw Error("AUTHORING_SCOPE_REQUIRED")
    return "mods-authoring-v1:" + createHash("sha256").update(workspace).digest("hex")
  }

  private snapshot(workspace: string): {
    raw: string | undefined
    drafts: AuthoringDraft[]
    revisionFloor: number
  } {
    const stored = this.settings.getSetting(this.key(workspace), ABSENT)
    if (stored === ABSENT) return { raw: undefined, drafts: [], revisionFloor: 0 }
    if (Buffer.byteLength(stored, "utf8") > MAX_STORAGE_BYTES)
      throw Error("AUTHORING_STORAGE_LIMIT")
    const value: unknown = JSON.parse(stored)
    if (
      !record(value) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      !Array.isArray(value.drafts) ||
      value.drafts.length > MAX_DRAFTS ||
      (value.revisionFloor !== undefined &&
        (!Number.isSafeInteger(value.revisionFloor) || Number(value.revisionFloor) < 0))
    )
      throw Error("AUTHORING_STORAGE_INVALID")
    const ids = new Set<string>()
    const drafts = value.drafts.map((row): AuthoringDraft => {
      if (
        !record(row) ||
        !validId(row.id) ||
        ids.has(row.id) ||
        !validName(row.name) ||
        !positive(row.currentRevision) ||
        !Array.isArray(row.versions) ||
        row.versions.length < 1 ||
        row.versions.length > MAX_VERSIONS
      )
        throw Error("AUTHORING_STORAGE_INVALID")
      ids.add(row.id)
      const versions = row.versions.map((version, index): AuthoringVersion => {
        if (
          !record(version) ||
          !positive(version.revision) ||
          (value.schemaVersion === 1 ? version.revision !== index + 1 :
            index > 0 && Number(version.revision) <= Number(((row.versions as unknown[])[index - 1] as AuthoringVersion).revision)) ||
          !Number.isSafeInteger(version.createdAt) ||
          Number(version.createdAt) < 0 ||
          (version.restoredFrom !== undefined &&
            (!positive(version.restoredFrom) || version.restoredFrom >= version.revision)) ||
          (version.restoredFromDigest !== undefined &&
            (version.restoredFrom === undefined || typeof version.restoredFromDigest !== "string" ||
              !/^[0-9a-f]{64}$/.test(version.restoredFromDigest)))
        )
          throw Error("AUTHORING_STORAGE_INVALID")
        return {
          revision: version.revision,
          createdAt: Number(version.createdAt),
          source: readAuthoringSourceBundle(version.source),
          ...(version.restoredFrom === undefined ? {} : { restoredFrom: version.restoredFrom }),
          ...(version.restoredFromDigest === undefined ? {} :
            { restoredFromDigest: String(version.restoredFromDigest) })
        }
      })
      if (row.currentRevision !== versions.at(-1)!.revision) throw Error("AUTHORING_STORAGE_INVALID")
      for (const version of versions)
        if (
          version.restoredFrom !== undefined &&
          (version.source.digest !== (versions.find(item => item.revision === version.restoredFrom)
            ?.source.digest ?? (value.schemaVersion === 2 ? version.restoredFromDigest : undefined)) ||
            (version.restoredFromDigest !== undefined && version.restoredFromDigest !== version.source.digest))
        )
          throw Error("AUTHORING_RESTORE_SOURCE_CHANGED")
      return { id: row.id, name: row.name, currentRevision: row.currentRevision, versions }
    })
    return { raw: stored, drafts, revisionFloor: Number(value.revisionFloor ?? 0) }
  }

  list(workspace: string): AuthoringDraft[] {
    return this.snapshot(workspace).drafts
  }

  save(input: {
    workspace: string
    id: string
    name: string
    source: AuthoringSourceBundle
    expectedRevision: number
    assertCurrent(): void
  }): AuthoringDraft {
    const captured = captureInput(input)
    const source = readAuthoringSourceBundle(captured.source)
    return this.append(captured, source)
  }

  restore(input: {
    workspace: string
    id: string
    expectedRevision: number
    sourceRevision: number
    assertCurrent(): void
  }): AuthoringDraft {
    const captured = captureInput(input)
    captured.assertCurrent()
    const draft = this.list(captured.workspace).find((row) => row.id === captured.id)
    const source = draft?.versions.find(
      (version) => version.revision === captured.sourceRevision
    )?.source
    if (!draft || !source) throw Error("AUTHORING_VERSION_MISSING")
    return this.append(
      Object.freeze({ ...captured, name: draft.name }),
      source,
      captured.sourceRevision
    )
  }

  /** Explicitly discard source copies only. Installed/preview materialized sources are independent. */
  prune(input: {
    workspace: string; id: string; expectedRevision: number; expectedSourceDigest: string;
    acknowledgeHistoryLoss: boolean; assertCurrent(): void
  }): AuthoringDraft {
    return this.discard(input, false)!
  }

  remove(input: {
    workspace: string; id: string; expectedRevision: number; expectedSourceDigest: string;
    acknowledgeHistoryLoss: boolean; assertCurrent(): void
  }): void {
    this.discard(input, true)
  }

  /** Host lifecycle policy for private development scopes; never exposed through renderer IPC. */
  compact(input: {
    workspace: string; id: string; retainRevisions: readonly number[]; assertCurrent(): void
  }): void {
    const request = captureInput(input)
    if (!Array.isArray(request.retainRevisions) || types.isProxy(request.retainRevisions) ||
      !request.retainRevisions.every(positive)) throw Error("AUTHORING_DRAFT_INVALID")
    const keep = [...request.retainRevisions]
    request.assertCurrent()
    const draft = this.list(request.workspace).find(row => row.id === request.id)
    if (!draft || draft.versions.length <= 2) return
    this.discard({ workspace: request.workspace, id: request.id,
      expectedRevision: draft.currentRevision,
      expectedSourceDigest: draft.versions.at(-1)!.source.digest,
      acknowledgeHistoryLoss: true, assertCurrent: request.assertCurrent }, false, keep)
  }

  private discard(input: {
    workspace: string; id: string; expectedRevision: number; expectedSourceDigest: string;
    acknowledgeHistoryLoss: boolean; assertCurrent(): void
  }, remove: boolean, retained: readonly number[] = []): AuthoringDraft | undefined {
    const request = captureInput(input)
    request.assertCurrent()
    if (!validId(request.id) || !positive(request.expectedRevision) ||
      request.acknowledgeHistoryLoss !== true ||
      !/^[0-9a-f]{64}$/.test(request.expectedSourceDigest)) throw Error("AUTHORING_DRAFT_INVALID")
    const { raw, drafts, revisionFloor } = this.snapshot(request.workspace)
    const draft = drafts.find(row => row.id === request.id)
    if (!draft || draft.currentRevision !== request.expectedRevision ||
      draft.versions.at(-1)!.source.digest !== request.expectedSourceDigest)
      throw Error("AUTHORING_VERSION_CHANGED")
    const keep = new Set([...retained, ...draft.versions.slice(-2).map(version => version.revision)])
    const next = remove ? undefined : { ...draft, versions: draft.versions.filter(version =>
      keep.has(version.revision)).map(version => ({
      ...version, ...(version.restoredFrom === undefined ? {} : {
        restoredFromDigest: version.source.digest
      })
    })) }
    const text = JSON.stringify({ schemaVersion: 2,
      revisionFloor: remove ? Math.max(revisionFloor, draft.currentRevision) : revisionFloor,
      drafts: drafts.flatMap(row =>
      row.id !== request.id ? [row] : next ? [next] : []) })
    request.assertCurrent()
    if (!this.settings.compareAndSetSetting(this.key(request.workspace), raw, text))
      throw Error("AUTHORING_VERSION_CHANGED")
    return next ? structuredClone(next) : undefined
  }

  private append(
    input: {
      workspace: string
      id: string
      name: string
      expectedRevision: number
      assertCurrent(): void
    },
    source: AuthoringSourceBundle,
    restoredFrom?: number
  ): AuthoringDraft {
    input.assertCurrent()
    if (
      !validId(input.id) ||
      !validName(input.name) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw Error("AUTHORING_DRAFT_INVALID")
    const key = this.key(input.workspace)
    const { raw, drafts, revisionFloor } = this.snapshot(input.workspace)
    const previous = drafts.find((row) => row.id === input.id)
    if ((previous?.currentRevision ?? 0) !== input.expectedRevision)
      throw Error("AUTHORING_VERSION_CHANGED")
    if (!previous && drafts.length >= MAX_DRAFTS) throw Error("AUTHORING_DRAFT_LIMIT")
    // Source versions may be referenced by in-flight previews or runs. Never silently evict them.
    if ((previous?.versions.length ?? 0) >= MAX_VERSIONS) throw Error("AUTHORING_VERSION_LIMIT")
    if (
      restoredFrom !== undefined &&
      previous?.versions.find(version => version.revision === restoredFrom)?.source.digest !== source.digest
    )
      throw Error("AUTHORING_VERSION_CHANGED")
    // Deleted IDs must never reuse a revision that an old editor can still submit.
    // A workspace-wide floor stays bounded even after deleting the entire library.
    const currentRevision = (previous?.currentRevision ?? revisionFloor) + 1
    if (!positive(currentRevision)) throw Error("AUTHORING_VERSION_LIMIT")
    const next: AuthoringDraft = {
      id: input.id,
      name: input.name,
      currentRevision,
      versions: [
        ...(previous?.versions ?? []),
        {
          revision: currentRevision,
          createdAt: Date.now(),
          source,
          ...(restoredFrom === undefined ? {} : { restoredFrom, restoredFromDigest: source.digest })
        }
      ]
    }
    const text = JSON.stringify({
      schemaVersion: 2,
      revisionFloor,
      drafts: [...drafts.filter((row) => row.id !== input.id), next]
    })
    if (Buffer.byteLength(text, "utf8") > MAX_STORAGE_BYTES) throw Error("AUTHORING_STORAGE_LIMIT")
    input.assertCurrent()
    if (!this.settings.compareAndSetSetting(key, raw, text))
      throw Error("AUTHORING_VERSION_CHANGED")
    return structuredClone(next)
  }
}
