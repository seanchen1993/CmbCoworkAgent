import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ModControlStore } from "../control-store"
import { decodeProjectHistory, encodeProjectHistory } from "./project-authoring-history"
import type { DevelopmentScope } from "../v2/development-session"

const scope: DevelopmentScope = { threadId: "continuous-project", workspace: "workspace",
  incarnation: { token: "same", legacyCreatedAt: 1 } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "continuous-project-"))
  const settings = new ModControlStore(join(root, "control.sqlite"))
  const make = () => {
    const sessions = new ProjectAuthoringSessions()
    sessions.configurePersistence(settings, join(root, "source"))
    return sessions
  }
  cleanups.push(async () => { settings.close(); await rm(root, { recursive: true, force: true }) })
  return { root, settings, make, sessions: make() }
}

it("continues eight revisions without transcription, changing source identity or restoring trial authority", async () => {
  const f = await fixture()
  let draft = await f.sessions.scaffold(scope, "original", "原项目", () => {}, "native-modular")
  const original = draft
  while (draft.revision < 8) draft = await f.sessions.patch(scope, { id: draft.id,
    revision: draft.revision, sourceDigest: draft.source.digest,
    files: [{ path: "README.md", text: `真实修订 ${draft.revision + 1}` }] }, () => {})
  await expect(f.sessions.patch(scope, { id: draft.id, revision: 8,
    sourceDigest: draft.source.digest, files: [{ path: "README.md", text: "不能暗中第九版" }] }, () => {}))
    .rejects.toMatchObject({ message: "PROJECT_DRAFT_LIMIT", reason: "revision" })
  const continued = await f.sessions.continue(scope, { id: draft.id, revision: 8,
    sourceDigest: draft.source.digest, newId: "continued" }, () => {})
  expect(continued).toMatchObject({ revision: 1, name: draft.name, source: draft.source,
    executed: false, previousTrialPreserved: true })
  expect(continued.directory).not.toBe(draft.directory)
  expect(continued.development).toBeUndefined()
  expect(f.sessions.trialRequest(scope)).toBeUndefined()
  expect(f.sessions.read(scope, draft.id).source).toEqual(draft.source)
  expect(f.sessions.compare(scope, { id: draft.id, revision: 8,
    otherId: continued.id, otherRevision: 1 })).toMatchObject({ equal: true })
  expect(f.sessions.compare(scope, { id: draft.id, revision: 1, otherRevision: 8 }))
    .toMatchObject({ changedFileCount: 1, files: [{ path: "README.md", kind: "added" }] })
  expect(f.sessions.compare(scope, { id: draft.id, revision: 1,
    otherRevision: 8, assetPath: "README.md" })).toMatchObject({ after: "真实修订 8" })
  const restored = f.make()
  expect(restored.versions(scope, draft.id).versions).toHaveLength(8)
  expect(restored.versions(scope, continued.id).versions[0]).toMatchObject({
    continuedFrom: { id: draft.id, revision: 8, sourceDigest: draft.source.digest } })
  expect(restored.compare(scope, { id: draft.id, revision: 1, otherRevision: 8 }))
    .toMatchObject({ changedFileCount: 1 })
  expect(restored.read(scope, original.id).source).toEqual(draft.source)
  expect(restored.developmentStatus(scope, continued.id)).toBeUndefined()
})

it("archives exact inactive source to free a slot and can continue it after restart without reusing its id", async () => {
  const f = await fixture()
  const first = await f.sessions.scaffold(scope, "first", "项目", () => {})
  for (const id of ["second", "third", "fourth"])
    await f.sessions.save(scope, { id, name: first.name, revision: 0, files: first.source.files }, () => {})
  await expect(f.sessions.continue(scope, { id: first.id, revision: 1,
    sourceDigest: first.source.digest, newId: "fifth" }, () => {}))
    .rejects.toMatchObject({ message: "PROJECT_DRAFT_LIMIT", reason: "drafts" })
  expect(() => f.sessions.archive(scope, { id: first.id, revision: 1,
    sourceDigest: "a".repeat(64) }, () => {})).toThrow("PROJECT_DRAFT_SOURCE_CHANGED")
  f.sessions.archive(scope, { id: first.id, revision: 1, sourceDigest: first.source.digest }, () => {})
  expect(f.sessions.list(scope)).toHaveLength(3)
  expect(() => f.sessions.read(scope, first.id)).toThrow("PROJECT_DRAFT_MISSING")
  const restored = f.make()
  expect(restored.versions(scope, first.id)).toMatchObject({ archived: true, historyComplete: true })
  const continued = await restored.continue(scope, { id: first.id, revision: 1,
    sourceDigest: first.source.digest, newId: "fifth" }, () => {})
  expect(continued.source).toEqual(first.source)
  await expect(restored.save(scope, { id: first.id, revision: 0,
    name: first.name, files: first.source.files }, () => {})).rejects.toThrow("PROJECT_DRAFT_ID_ARCHIVED")
})

it("rejects archive and leaves source/preview unchanged while a native trial is prepared", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "trial", "项目", () => {})
  await f.sessions.requestTrial(scope, draft.id, 1, "真实试用", () => {})
  const before = f.sessions.trialRequest(scope)
  expect(() => f.sessions.archive(scope, { id: draft.id, revision: 1,
    sourceDigest: draft.source.digest }, () => {})).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  const copy = await f.sessions.continue(scope, { id: draft.id, revision: 1,
    sourceDigest: draft.source.digest, newId: "trial-copy" }, () => {})
  expect(copy.development).toBeUndefined()
  expect(f.sessions.trialRequest(scope)).toEqual(before)
  expect(f.sessions.developmentStatus(scope, draft.id)?.status).toBe("prepared")
})

it("migrates old latest-only storage honestly and rejects old scope, wrong digests and revoked continuation", async () => {
  const f = await fixture()
  let draft = await f.sessions.scaffold(scope, "old", "项目", () => {})
  draft = await f.sessions.save(scope, { id: draft.id, name: draft.name,
    revision: 1, files: draft.source.files }, () => {})
  const key = "project-authoring-source:" + createHash("sha256").update(JSON.stringify([
    scope.threadId, scope.workspace, scope.incarnation])).digest("hex")
  const old = { schemaVersion: 1, drafts: [{ id: draft.id, name: draft.name, revision: 2,
    source: draft.source }] }
  f.settings.setSetting(key, JSON.stringify(old))
  const restored = f.make()
  expect(restored.versions(scope, draft.id)).toMatchObject({ historyComplete: false,
    versions: [{ revision: 2 }] })
  expect(() => restored.compare(scope, { id: draft.id, revision: 1, otherRevision: 2 }))
    .toThrow("PROJECT_DRAFT_VERSION_MISSING")
  await expect(restored.continue(scope, { id: draft.id, revision: 2,
    sourceDigest: draft.source.digest, newId: "revoked" }, () => { throw Error("revoked") }))
    .rejects.toThrow("revoked")
  await expect(restored.continue({ ...scope, threadId: "other" }, { id: draft.id, revision: 2,
    sourceDigest: draft.source.digest, newId: "other" }, () => {})).rejects.toThrow("PROJECT_DRAFT_VERSION_MISSING")
  expect(restored.list(scope)).toHaveLength(1)
})

it("retains bounded identities without silently evicting old versions", async () => {
  const f = await fixture()
  for (let i = 0; i < 16; i++) {
    const draft = await f.sessions.scaffold(scope, `draft-${i}`, "项目", () => {})
    f.sessions.archive(scope, { id: draft.id, revision: 1, sourceDigest: draft.source.digest }, () => {})
  }
  await expect(f.sessions.scaffold(scope, "seventeenth", "项目", () => {}))
    .rejects.toThrow("PROJECT_DRAFT_HISTORY_LIMIT")
  expect(f.sessions.versions(scope, "draft-0").versions).toHaveLength(1)
  expect(f.sessions.list(scope)).toEqual([])
})

it("deduplicates history blobs and rejects tampered source instead of trusting stored hashes", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "codec", "项目", () => {})
  const encoded = encodeProjectHistory(new Map([[draft.id, [1, 2].map(revision => ({
    name: draft.name, source: draft.source, revision }))]]))
  expect(encoded.blobs.length).toBeLessThan(draft.source.files.length * 2)
  expect(decodeProjectHistory(encoded).get(draft.id)?.[1].source).toEqual(draft.source)
  encoded.blobs[0].text += "tamper"
  expect(() => decodeProjectHistory(encoded)).toThrow("PROJECT_DRAFT_STORAGE_INVALID")
  expect(dirname(draft.directory)).toContain(f.root)
})

it("rejects a stale session CAS without creating a new active draft or changing retained history", async () => {
  const f = await fixture()
  const first = await f.sessions.scaffold(scope, "cas", "项目", () => {})
  const stale = f.make()
  expect(stale.read(scope, first.id).revision).toBe(1)
  await f.sessions.save(scope, { id: first.id, name: first.name,
    revision: 1, files: first.source.files }, () => {})
  await expect(stale.continue(scope, { id: first.id, revision: 1,
    sourceDigest: first.source.digest, newId: "stale-copy" }, () => {}))
    .rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
  expect(stale.list(scope)).toHaveLength(1)
  const current = f.make()
  expect(current.list(scope)).toHaveLength(1)
  expect(current.versions(scope, first.id).versions.map(item => item.revision)).toEqual([1, 2])
})

it("keeps the original total storage bound and source when unique historical text exhausts it", async () => {
  const f = await fixture()
  let draft = await f.sessions.scaffold(scope, "bounded", "项目", () => {})
  for (let revision = 2; revision <= 8; revision++) {
    draft = await f.sessions.patch(scope, { id: draft.id, revision: draft.revision,
      sourceDigest: draft.source.digest, files: Array.from({ length: 4 }, (_, index) => ({
        path: `knowledge/retained-${index}.md`, text: `${revision}-${index}:` + "x".repeat(59900)
      })) }, () => {})
  }
  const copy = await f.sessions.continue(scope, { id: draft.id, revision: draft.revision,
    sourceDigest: draft.source.digest, newId: "same-source-copy" }, () => {})
  expect(copy.source).toEqual(draft.source)
  const next = await f.sessions.patch(scope, { id: copy.id, revision: 1, sourceDigest: copy.source.digest,
    files: Array.from({ length: 4 }, (_, index) => ({ path: `knowledge/retained-${index}.md`,
      text: `new-${index}:` + "y".repeat(59900) })) }, () => {})
  const before = f.sessions.versions(scope, copy.id)
  await expect(f.sessions.patch(scope, { id: next.id, revision: next.revision, sourceDigest: next.source.digest,
    files: Array.from({ length: 4 }, (_, index) => ({ path: `knowledge/retained-${index}.md`,
      text: `exhaust-${index}:` + "z".repeat(59900) })) }, () => {}))
    .rejects.toThrow("PROJECT_DRAFT_HISTORY_STORAGE_LIMIT")
  expect(f.sessions.versions(scope, copy.id)).toEqual(before)
  expect(f.make().read(scope, copy.id).source).toEqual(next.source)
  expect(f.sessions.list(scope)).toHaveLength(2)
})

it("does not treat a lost legacy trial binding as proof that a retained native preview is idle", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "legacy-preview", "项目", () => {})
  const restored = f.make()
  restored.configureTrialObservation(() => ({ operations: [] }), () => true)
  const archive = () => restored.archive(scope, { id: draft.id, revision: 1,
    sourceDigest: draft.source.digest }, () => {})
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  expect(restored.read(scope, draft.id).source).toEqual(draft.source)
  restored.configureTrialObservation(() => ({ operations: [] }), () => { throw Error("receipt-invalid") })
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  expect(restored.versions(scope, draft.id).archived).toBe(false)
})
