import { createHash } from "node:crypto"
import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"
import type { CreatorTrialProjectReference } from "./creator-trial-journey"
import { readProjectTrialReference } from "./project-trial-archive"

export interface ProjectSourceVersion {
  revision: number
  name: string
  source: AuthoringSourceBundle
  resourcePaths?: string[]
  continuedFrom?: { id: string; revision: number; sourceDigest: string }
  /** References to original native journals, never frozen success or restored execution authority. */
  trialEvidence?: CreatorTrialProjectReference[]
}
export type ProjectSourceHistory = Map<string, ProjectSourceVersion[]>
export const PROJECT_HISTORY_IDENTITIES = 16
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const validId = (id: string) => /^[a-z][a-z0-9-]{0,47}$/.test(id)

/** Deduplicated source text only. Never stores runtime configuration, grants or execution state. */
export function encodeProjectHistory(history: ProjectSourceHistory) {
  const blobs = new Map<string, string>()
  const drafts = [...history].map(([id, versions]) => ({ id,
    versions: versions.map(version => ({ ...version, source: {
      digest: version.source.digest,
      files: version.source.files.map(file => {
        const digest = hash(file.text)
        blobs.set(digest, file.text)
        return { path: file.path, digest }
      })
    } }))
  }))
  return { schemaVersion: 1, blobs: [...blobs].map(([digest, text]) => ({ digest, text })), drafts }
}

export function decodeProjectHistory(value: unknown): ProjectSourceHistory {
  const fail = (): never => { throw Error("PROJECT_DRAFT_STORAGE_INVALID") }
  if (!value || typeof value !== "object") return fail()
  const raw = value as ReturnType<typeof encodeProjectHistory>
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.blobs) || raw.blobs.length > 8192 ||
    !Array.isArray(raw.drafts) || raw.drafts.length > PROJECT_HISTORY_IDENTITIES) return fail()
  const blobs = new Map<string, string>()
  for (const blob of raw.blobs) {
    if (!blob || typeof blob.text !== "string" || Buffer.byteLength(blob.text) > 65536 ||
      typeof blob.digest !== "string" || hash(blob.text) !== blob.digest || blobs.has(blob.digest))
      return fail()
    blobs.set(blob.digest, blob.text)
  }
  const history: ProjectSourceHistory = new Map()
  for (const draft of raw.drafts) {
    if (!draft || typeof draft.id !== "string" || !validId(draft.id) || history.has(draft.id) ||
      !Array.isArray(draft.versions) || !draft.versions.length || draft.versions.length > 8) return fail()
    const versions: ProjectSourceVersion[] = []
    for (const version of draft.versions) {
      if (!version || !Number.isSafeInteger(version.revision) || version.revision < 1 ||
        version.revision > 8 || version.revision <= (versions.at(-1)?.revision ?? 0) ||
        typeof version.name !== "string" || !version.name.trim() || version.name.length > 100 ||
        !Array.isArray(version.source?.files)) return fail()
      const source = createAuthoringSourceBundle(version.source.files.map(file => {
        const text = blobs.get(file.digest)
        if (text === undefined) return fail()
        return { path: file.path, text }
      }))
      if (source.digest !== version.source.digest) return fail()
      const origin = version.continuedFrom
      if (origin && (!validId(origin.id) || !Number.isSafeInteger(origin.revision) ||
        origin.revision < 1 || origin.revision > 8 || !/^[a-f0-9]{64}$/.test(origin.sourceDigest)))
        return fail()
      if (version.trialEvidence !== undefined && (!Array.isArray(version.trialEvidence) ||
        version.trialEvidence.length > 8192)) return fail()
      const trialEvidence = version.trialEvidence?.map(reference => {
        const parsed = readProjectTrialReference(reference)
        if (!parsed || parsed.draftId !== draft.id) return fail()
        return parsed
      })
      versions.push({ revision: version.revision, name: version.name, source,
        ...(version.resourcePaths === undefined ? {} : { resourcePaths: version.resourcePaths }),
        ...(origin ? { continuedFrom: origin } : {}),
        ...(trialEvidence?.length ? { trialEvidence } : {}) })
    }
    history.set(draft.id, versions)
  }
  return history
}

/** Bounded, paged real file comparison; text is returned only for an explicitly selected file. */
export function compareProjectSource(before: ProjectSourceVersion, after: ProjectSourceVersion,
  assetPath?: string, cursor = 0) {
  const left = new Map(before.source.files.map(file => [file.path, file.text]))
  const right = new Map(after.source.files.map(file => [file.path, file.text]))
  const changed = [...new Set([...left.keys(), ...right.keys()])].sort().filter(path =>
    left.get(path) !== right.get(path))
  const files = changed.map(path => ({ path,
    kind: !left.has(path) ? "added" : !right.has(path) ? "removed" : "modified",
    beforeDigest: left.has(path) ? hash(left.get(path)!) : null,
    afterDigest: right.has(path) ? hash(right.get(path)!) : null }))
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("DEVELOPMENT_CATALOG_CURSOR")
  if (assetPath === undefined) {
    if (cursor > files.length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
    return { equal: !files.length, changedFileCount: files.length,
      files: files.slice(cursor, cursor + 16), nextCursor: cursor + 16 < files.length ? cursor + 16 : null }
  }
  if (!left.has(assetPath) && !right.has(assetPath)) throw Error("AUTHORING_FILE_MISSING")
  const beforeText = left.get(assetPath) ?? ""
  const afterText = right.get(assetPath) ?? ""
  const length = Math.max(beforeText.length, afterText.length)
  if (cursor > length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
  return { path: assetPath, beforePresent: left.has(assetPath), afterPresent: right.has(assetPath),
    before: beforeText.slice(cursor, cursor + 4000), after: afterText.slice(cursor, cursor + 4000),
    nextCursor: cursor + 4000 < length ? cursor + 4000 : null,
    note: "These are exact corresponding character windows, not a line-aligned patch." }
}
