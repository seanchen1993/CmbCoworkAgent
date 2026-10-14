import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { importVirtualTreeSource, readVirtualTreeImport } from "./virtual-tree-import"
import {
  acquireWindowsPublicationLease,
  publicationDirectoryAncestors
} from "./windows-publication-lease"
import {
  assertVirtualPublicationSource,
  type VirtualPublicationJournal,
  type VirtualPublicationRecord
} from "./virtual-tree-publication"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Explicitly reviewed Windows write-back. Existing bytes are renamed by the
 * locked original HANDLE into a durable recovery directory before an exclusive
 * link creates each new destination. No existing destination is overwritten.
 * A failed/crashed operation is retained for manual reconciliation, never replayed.
 * Directory entry sets are not globally atomic; final observation detects extra
 * names, and no successful result claims control of editors after locks release.
 */
export async function publishReviewedVirtualTree(input: {
  token: object
  approvedDigest: string
  journal: VirtualPublicationJournal
  signal: AbortSignal
  assertCurrent(): void
}) {
  const { token, approvedDigest, journal, signal, assertCurrent } = input
  let lease: Awaited<ReturnType<typeof acquireWindowsPublicationLease>> | undefined
  const guard = () => {
    signal.throwIfAborted()
    lease?.assertAlive()
    assertCurrent()
    signal.throwIfAborted()
    lease?.assertAlive()
  }
  const plan = await assertVirtualPublicationSource(token, approvedDigest, signal, guard)
  const root = plan.sourceDirectory
  const directories = new Set(
    plan.initialEntries.filter((entry) => !entry.content).map((entry) => entry.path)
  )
  directories.add(".")
  const missingDirectories = new Set<string>()
  for (const change of plan.review.changes) {
    let parent = dirname(change.path)
    while (!directories.has(parent)) {
      missingDirectories.add(parent)
      parent = dirname(parent)
    }
  }
  const createdDirectories = [...missingDirectories].sort(
    (a, b) => a.length - b.length || a.localeCompare(b)
  )
  const backupDirectory = join(dirname(root), `.cmb-flow-publication-${randomUUID()}`)
  const paths: NonNullable<VirtualPublicationRecord["paths"]> = plan.review.changes.map(
    (change) => ({ path: change.path, state: "intent" })
  )
  const operationId = journal.begin(
    {
      reviewDigest: approvedDigest,
      target: root,
      kind: "workspace-writeback",
      backupDirectory,
      paths
    },
    guard
  )
  let sourceTouched = false
  try {
    guard()
    await mkdir(backupDirectory, { recursive: false, mode: 0o700 })
    const changed = new Map(plan.review.changes.map((change, index) => [change.path, index]))
    const files = plan.initialEntries
      .filter((entry) => entry.content)
      .map((entry) => ({
        path: join(root, entry.path),
        digest: hash(entry.content!),
        ...(changed.has(entry.path)
          ? { backup: join(backupDirectory, `${changed.get(entry.path)}.before`) }
          : {})
      }))
    lease = await acquireWindowsPublicationLease({
      directories: publicationDirectoryAncestors([
        root,
        backupDirectory,
        ...[...directories].map((path) => join(root, path))
      ]),
      files,
      createdDirectories: createdDirectories.map((path) => join(root, path)),
      publishedFiles: plan.review.changes.map((change) => ({
        path: join(root, change.path),
        digest: change.afterDigest
      })),
      signal,
      assertCurrent: guard
    })
    // Locks alone do not prove complete import coverage. Re-read the full namespace
    // after acquisition; external additions remain observable conflicts.
    await assertVirtualPublicationSource(token, approvedDigest, signal, guard)
    for (let index = 0; index < createdDirectories.length; index++) {
      guard()
      // Parents are already held; exclusive mkdir rejects a concurrent existing name.
      // Lock each created directory before using it as the parent of another effect.
      sourceTouched = true
      await mkdir(join(root, createdDirectories[index]), { recursive: false, mode: 0o700 })
      await lease.lockCreatedDirectory(index)
    }
    for (let index = 0; index < plan.review.changes.length; index++) {
      guard()
      const change = plan.review.changes[index]
      const staged = join(backupDirectory, `${index}.after`)
      const bytes = Buffer.from(change.content, change.encoding)
      if (hash(bytes) !== change.afterDigest || bytes.length !== change.bytes)
        throw Error("VIRTUAL_PUBLICATION_PATCH_CORRUPT")
      const handle = await open(staged, "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      guard()
      const target = join(root, change.path)
      if (change.kind === "replace") {
        const fileIndex = files.findIndex((file) => file.path === target)
        if (fileIndex < 0) throw Error("VIRTUAL_PUBLICATION_PATCH_CORRUPT")
        sourceTouched = true
        await lease.backup(fileIndex)
        paths[index].state = "backed-up"
        journal.update(operationId, { state: "intent", paths })
      }
      guard()
      // Hard-link creation is atomic and refuses an existing name on Windows.
      // Both locations are siblings on the same volume; no copy/overwrite fallback.
      sourceTouched = true
      await link(staged, target)
      await unlink(staged)
      await lease.lockPublishedFile(index)
      paths[index].state = "written"
      journal.update(operationId, { state: "intent", paths })
      guard()
    }
    const observed = readVirtualTreeImport(
      await importVirtualTreeSource({ sourceDirectory: root, signal, assertCurrent: guard })
    )
    const expected = new Map(
      plan.initialEntries.map((entry) => [
        entry.path,
        entry.content ? hash(entry.content) : "directory"
      ])
    )
    for (const change of plan.review.changes) expected.set(change.path, change.afterDigest)
    for (const path of createdDirectories) expected.set(path, "directory")
    if (
      observed.entries.length !== expected.size ||
      observed.entries.some(
        (entry) => expected.get(entry.path) !== (entry.content ? hash(entry.content) : "directory")
      )
    )
      throw Error("VIRTUAL_PUBLICATION_SOURCE_CONFLICT")
    guard()
    await lease.close()
    lease = undefined
    guard()
    journal.update(operationId, { state: "settled", paths })
    return {
      operationId,
      reviewDigest: approvedDigest,
      backupDirectory,
      state: "published" as const,
      coverage: "locked-file-replacement-bounded-final-observation-v1" as const
    }
  } catch (error) {
    await lease?.close().catch(() => {})
    // Original bytes and all staged files remain. Even a pre-effect interruption
    // stays explicit; this API never guesses that a retry is safe or rolls back.
    journal.update(operationId, { state: sourceTouched ? "unknown" : "failed", paths })
    throw error
  }
}
