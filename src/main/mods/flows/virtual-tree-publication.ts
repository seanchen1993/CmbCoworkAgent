import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { isVirtualTreeStore, readVirtualTreeSnapshot, type VirtualTreeStore } from "./virtual-tree"
import { importVirtualTreeSource, readVirtualTreeImport } from "./virtual-tree-import"

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const MAX_PATCH_BYTES = 16 * 1024 * 1024
export interface VirtualTreeChange {
  path: string
  kind: "add" | "replace"
  beforeDigest: string | null
  afterDigest: string
  bytes: number
  encoding: "utf8" | "base64"
  content: string
}
export interface VirtualTreeReview {
  version: "virtual-tree-review-v1"
  treeId: string
  initialRoot: string
  finalRoot: string
  originDigest: string
  changes: VirtualTreeChange[]
  digest: string
  publication: "unpublished"
}
interface Plan {
  store: VirtualTreeStore
  review: VirtualTreeReview
  sourceDirectory: string
  sourceDigest: string
  serialized: string
}
const plans = new WeakMap<object, Plan>()

/** A private review token contains content only, never execution or approval authority. */
export function prepareVirtualTreeReview(input: {
  store: VirtualTreeStore
  treeId: string
  finalRoot: string
  assertCurrent(): void
}): object {
  const { store, treeId, finalRoot, assertCurrent } = input
  if (!isVirtualTreeStore(store)) throw Error("VIRTUAL_PUBLICATION_STORE")
  assertCurrent()
  const origin = store.provenance(treeId) as Record<string, unknown>
  if (
    origin.version !== "virtual-source-import-v1" ||
    origin.coverage !== "complete-selected-directory-except-root-git-metadata" ||
    typeof origin.sourceDirectory !== "string" ||
    typeof origin.initialRoot !== "string" ||
    typeof origin.digest !== "string"
  )
    throw Error("VIRTUAL_PUBLICATION_ORIGIN")
  const initial = readVirtualTreeSnapshot(
    store.captureRetainedSnapshot(treeId, origin.initialRoot, assertCurrent)
  )!
  const final = readVirtualTreeSnapshot(store.captureSnapshot(treeId, finalRoot, assertCurrent))!
  const before = new Map(initial.entries.map((entry) => [entry.path, entry]))
  const changes: VirtualTreeChange[] = []
  let bytes = 0
  for (const entry of final.entries) {
    const old = before.get(entry.path)
    before.delete(entry.path)
    if (!entry.content) {
      if (old?.content) throw Error("VIRTUAL_PUBLICATION_UNSUPPORTED_CHANGE")
      continue
    }
    if (old && !old.content) throw Error("VIRTUAL_PUBLICATION_UNSUPPORTED_CHANGE")
    if (old?.content?.equals(entry.content)) continue
    bytes += entry.content.byteLength
    if (bytes > MAX_PATCH_BYTES) throw Error("VIRTUAL_PUBLICATION_LIMIT")
    const text = entry.content.toString("utf8")
    const utf8 = Buffer.from(text, "utf8").equals(entry.content)
    changes.push({
      path: entry.path,
      kind: old ? "replace" : "add",
      beforeDigest: old?.content ? digest(old.content) : null,
      afterDigest: digest(entry.content),
      bytes: entry.content.byteLength,
      encoding: utf8 ? "utf8" : "base64",
      content: utf8 ? text : entry.content.toString("base64")
    })
  }
  if (before.size) throw Error("VIRTUAL_PUBLICATION_UNSUPPORTED_CHANGE")
  const value = {
    version: "virtual-tree-review-v1" as const,
    treeId,
    initialRoot: initial.root,
    finalRoot,
    originDigest: final.originDigest,
    changes,
    publication: "unpublished" as const
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > MAX_PATCH_BYTES) throw Error("VIRTUAL_PUBLICATION_LIMIT")
  const review = { ...value, digest: digest(serialized) }
  const token = Object.freeze({})
  plans.set(token, {
    store,
    review,
    sourceDirectory: origin.sourceDirectory,
    sourceDigest: origin.digest,
    serialized: JSON.stringify(review, null, 2)
  })
  return token
}

export function readVirtualTreeReview(token: object): VirtualTreeReview | undefined {
  const plan = plans.get(token)
  return plan && structuredClone(plan.review)
}

export interface PublicationJournalStore {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting(key: string, expected: string | undefined, value: string): boolean
}
export interface VirtualPublicationRecord {
  operationId: string
  reviewDigest: string
  target: string
  kind: "reviewed-export" | "workspace-writeback"
  state: "intent" | "settled" | "unknown" | "failed"
  backupDirectory?: string
  paths?: Array<{ path: string; state: "intent" | "backed-up" | "written" }>
}
const KEY = "virtual-tree-publications-v1"
const ABSENT = "\0virtual-publications-absent"

/** Durable host observations, not proof that an external filesystem effect completed. */
export class VirtualPublicationJournal {
  constructor(private readonly store: PublicationJournalStore) {}
  private validate(rows: VirtualPublicationRecord[]) {
    if (
      !Array.isArray(rows) ||
      rows.length > 64 ||
      rows.some(
        (row) =>
          !row ||
          !/^[0-9a-f-]{36}$/.test(row.operationId) ||
          !/^[0-9a-f]{64}$/.test(row.reviewDigest) ||
          typeof row.target !== "string" ||
          row.target.length > 8192 ||
          !isAbsolute(row.target) ||
          !["reviewed-export", "workspace-writeback"].includes(row.kind) ||
          (row.paths !== undefined &&
            (!Array.isArray(row.paths) ||
              row.paths.length > 2048 ||
              row.paths.some(
                (item) =>
                  !item ||
                  typeof item.path !== "string" ||
                  item.path.length > 1024 ||
                  !["intent", "backed-up", "written"].includes(item.state)
              ))) ||
          !["intent", "settled", "unknown", "failed"].includes(row.state)
      ) ||
      new Set(rows.map((row) => row.operationId)).size !== rows.length
    )
      throw Error("VIRTUAL_PUBLICATION_JOURNAL_INVALID")
    for (const row of rows) {
      if (
        row.backupDirectory !== undefined &&
        (typeof row.backupDirectory !== "string" ||
          row.backupDirectory.length > 8192 ||
          !isAbsolute(row.backupDirectory))
      )
        throw Error("VIRTUAL_PUBLICATION_JOURNAL_INVALID")
    }
  }
  private read() {
    const value = this.store.getSetting(KEY, ABSENT)
    const raw = value === ABSENT ? undefined : value
    if (raw && Buffer.byteLength(raw) > 1024 * 1024)
      throw Error("VIRTUAL_PUBLICATION_JOURNAL_LIMIT")
    const rows = raw ? (JSON.parse(raw) as VirtualPublicationRecord[]) : []
    this.validate(rows)
    return { raw, rows }
  }
  list(): VirtualPublicationRecord[] {
    return this.read().rows
  }
  begin(record: Omit<VirtualPublicationRecord, "operationId" | "state">, guard: () => void) {
    const captured = structuredClone(record)
    const { raw, rows } = this.read()
    if (rows.length >= 64) throw Error("VIRTUAL_PUBLICATION_JOURNAL_LIMIT")
    if (
      rows.some(
        (row) => row.target === captured.target && ["intent", "unknown"].includes(row.state)
      )
    )
      throw Error("VIRTUAL_PUBLICATION_RECONCILE_REQUIRED")
    const next: VirtualPublicationRecord = {
      ...captured,
      operationId: randomUUID(),
      state: "intent"
    }
    this.validate([...rows, next])
    const encoded = JSON.stringify([...rows, next])
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw Error("VIRTUAL_PUBLICATION_JOURNAL_LIMIT")
    guard()
    if (!this.store.compareAndSetSetting(KEY, raw, encoded))
      throw Error("VIRTUAL_PUBLICATION_JOURNAL_CHANGED")
    return next.operationId
  }
  /** Internal settlement survives caller revocation; it grants no new filesystem access. */
  update(
    operationId: string,
    change: Pick<VirtualPublicationRecord, "state"> &
      Partial<Pick<VirtualPublicationRecord, "paths">>
  ) {
    const captured = structuredClone(change)
    const { raw, rows } = this.read()
    const index = rows.findIndex((row) => row.operationId === operationId)
    if (index < 0 || rows[index].state !== "intent")
      throw Error("VIRTUAL_PUBLICATION_JOURNAL_CHANGED")
    rows[index] = { ...rows[index], ...captured }
    this.validate(rows)
    const encoded = JSON.stringify(rows)
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw Error("VIRTUAL_PUBLICATION_JOURNAL_LIMIT")
    if (!this.store.compareAndSetSetting(KEY, raw, encoded))
      throw Error("VIRTUAL_PUBLICATION_JOURNAL_CHANGED")
  }
}

export async function assertVirtualPublicationSource(
  token: object,
  approvedDigest: string,
  signal: AbortSignal,
  assertCurrent: () => void
) {
  const plan = plans.get(token)
  if (!plan || plan.review.digest !== approvedDigest)
    throw Error("VIRTUAL_PUBLICATION_REVIEW_REQUIRED")
  const guard = () => {
    signal.throwIfAborted()
    assertCurrent()
    signal.throwIfAborted()
  }
  guard()
  plan.store.captureSnapshot(plan.review.treeId, plan.review.finalRoot, guard)
  const observed = readVirtualTreeImport(
    await importVirtualTreeSource({
      sourceDirectory: plan.sourceDirectory,
      signal,
      assertCurrent: guard
    })
  )
  if (observed.provenance.digest !== plan.sourceDigest)
    throw Error("VIRTUAL_PUBLICATION_SOURCE_CONFLICT")
  guard()
  return {
    sourceDirectory: plan.sourceDirectory,
    review: structuredClone(plan.review),
    serialized: plan.serialized,
    initialEntries: observed.entries
  }
}

/** Exclusive creation only: exporting never overwrites a destination or modifies the source. */
export async function exportReviewedVirtualTree(input: {
  token: object
  approvedDigest: string
  destination: string
  journal: VirtualPublicationJournal
  signal: AbortSignal
  assertCurrent(): void
}) {
  const { token, approvedDigest, journal, signal, assertCurrent } = input
  const destination = resolve(input.destination)
  const guard = () => {
    signal.throwIfAborted()
    assertCurrent()
    signal.throwIfAborted()
  }
  const plan = await assertVirtualPublicationSource(token, approvedDigest, signal, guard)
  const relativePath = relative(plan.sourceDirectory, destination)
  if (!relativePath || (!relativePath.startsWith("..") && !isAbsolute(relativePath)))
    throw Error("VIRTUAL_PUBLICATION_EXPORT_OUTSIDE_SOURCE")
  const parent = dirname(destination)
  const parentIdentity = await lstat(parent, { bigint: true })
  if (
    !parentIdentity.isDirectory() ||
    parentIdentity.isSymbolicLink() ||
    resolve(await realpath(parent)) !== parent
  )
    throw Error("VIRTUAL_PUBLICATION_DESTINATION")
  const operationId = journal.begin(
    { reviewDigest: approvedDigest, target: destination, kind: "reviewed-export" },
    guard
  )
  let created = false
  try {
    guard()
    const handle = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    created = true
    try {
      guard()
      await handle.writeFile(plan.serialized, "utf8")
      await handle.sync()
      const own = await handle.stat({ bigint: true })
      const current = await lstat(destination, { bigint: true })
      const currentParent = await lstat(parent, { bigint: true })
      if (
        own.dev !== current.dev ||
        own.ino !== current.ino ||
        current.nlink !== 1n ||
        own.size !== BigInt(Buffer.byteLength(plan.serialized)) ||
        parentIdentity.dev !== currentParent.dev ||
        parentIdentity.ino !== currentParent.ino
      )
        throw Error("VIRTUAL_PUBLICATION_DESTINATION_CHANGED")
      await assertVirtualPublicationSource(token, approvedDigest, signal, guard)
    } finally {
      await handle.close()
    }
    guard()
    journal.update(operationId, { state: "settled" })
    return {
      operationId,
      destination,
      reviewDigest: approvedDigest,
      state: "exported" as const,
      workspace: "unchanged" as const
    }
  } catch (error) {
    // Never unlink a path that another process could have replaced. The record explicitly
    // retains uncertainty and the owned destination for human inspection after interruption.
    journal.update(operationId, { state: created ? "unknown" : "failed" })
    throw error
  }
}
