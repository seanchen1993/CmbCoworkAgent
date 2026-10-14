import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"

const imports = new WeakMap<
  object,
  {
    entries: { path: string; content?: Buffer }[]
    provenance: Record<string, unknown>
  }
>()

/** Only an actual successful host import can provide persisted source provenance. */
export function readVirtualTreeImport(token: object) {
  const snapshot = imports.get(token)
  if (!snapshot) throw Error("VIRTUAL_IMPORT_IDENTITY")
  return {
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      ...(entry.content ? { content: Buffer.from(entry.content) } : {})
    })),
    provenance: structuredClone(snapshot.provenance)
  }
}

/** The virtual namespace is a complete copy of this selected source directory.
 * This import has per-file observation semantics, NOT atomic source snapshot
 * semantics. Future file tools must identify the virtual namespace explicitly.
 * A digest cannot authorize physical write-back or prove absence outside it.
 */
export async function importVirtualTreeSource(input: {
  sourceDirectory: string
  signal: AbortSignal
  assertCurrent(): void
}) {
  const { signal, assertCurrent } = input
  const root = resolve(input.sourceDirectory)
  signal.throwIfAborted()
  assertCurrent()
  signal.throwIfAborted()
  const rootIdentity = await lstat(root, { bigint: true })
  if (
    !rootIdentity.isDirectory() ||
    rootIdentity.isSymbolicLink() ||
    relative(root, await realpath(root)) !== ""
  )
    throw Error("VIRTUAL_IMPORT_ROOT")
  const entries: { path: string; content?: Buffer }[] = []
  const observed: { path: string; stat: BigIntStats }[] = []
  let total = 0
  const same = (a: BigIntStats, b: BigIntStats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  const guard = async () => {
    signal.throwIfAborted()
    assertCurrent()
    if (
      !same(rootIdentity, await lstat(root, { bigint: true })) ||
      relative(root, await realpath(root)) !== ""
    )
      throw Error("VIRTUAL_IMPORT_CHANGED")
    signal.throwIfAborted()
    assertCurrent()
    signal.throwIfAborted()
  }
  const visit = async (path: string, depth: number): Promise<void> => {
    await guard()
    if (depth > 64 || entries.length >= 2048) throw Error("VIRTUAL_IMPORT_LIMIT")
    const absolute = path ? join(root, path) : root
    const identity = await lstat(absolute, { bigint: true })
    if (identity.isSymbolicLink() || relative(absolute, await realpath(absolute)) !== "") {
      throw Error("VIRTUAL_IMPORT_LINK")
    }
    observed.push({ path, stat: identity })
    if (identity.isDirectory()) {
      if (path) entries.push({ path })
      const names: string[] = []
      const directory = await opendir(absolute)
      for await (const item of directory) {
        if (names.length + entries.length >= 2048) throw Error("VIRTUAL_IMPORT_LIMIT")
        if (item.name.toLowerCase() === ".git") {
          if (path) throw Error("VIRTUAL_IMPORT_SELECT_SUBTREE")
          const metadata = await lstat(join(root, item.name), { bigint: true })
          if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
            throw Error("VIRTUAL_IMPORT_LINK")
          }
          // Explicitly outside the virtual namespace; key() rejects access,
          // including negative queries, instead of reporting it as absent.
          observed.push({ path: item.name, stat: metadata })
          continue
        }
        names.push(item.name)
      }
      for (const name of names.sort()) await visit(path ? `${path}/${name}` : name, depth + 1)
    } else {
      if (!identity.isFile() || identity.nlink !== 1n) throw Error("VIRTUAL_IMPORT_LINK")
      const opened = await openStableFileHandle(root, absolute)
      try {
        const content = await readStableFileHandleBounded(opened, 4 * 1024 * 1024)
        if (!same(identity, await opened.handle.stat({ bigint: true }))) {
          throw Error("VIRTUAL_IMPORT_CHANGED")
        }
        if ((total += content.byteLength) > 64 * 1024 * 1024) throw Error("VIRTUAL_IMPORT_LIMIT")
        entries.push({ path, content })
      } finally {
        await opened.handle.close()
      }
    }
  }
  await visit("", 0)
  for (const item of observed) {
    await guard()
    if (!same(item.stat, await lstat(join(root, item.path), { bigint: true }))) {
      throw Error("VIRTUAL_IMPORT_CHANGED")
    }
  }
  await guard()
  const manifest = entries.map((entry) => [
    entry.path,
    entry.content === undefined
      ? "directory"
      : createHash("sha256").update(entry.content).digest("hex")
  ])
  const result = {
    entries,
    provenance: {
      version: "virtual-source-import-v1" as const,
      observation: "bounded-per-file-observation" as const,
      coverage: "complete-selected-directory-except-root-git-metadata" as const,
      excludedPrefixes: [".git"],
      sourceDirectory: root,
      digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      fileBytes: total
    }
  }
  imports.set(result, {
    entries: result.entries.map((entry) => ({
      path: entry.path,
      ...(entry.content ? { content: Buffer.from(entry.content) } : {})
    })),
    provenance: structuredClone(result.provenance)
  })
  return Object.freeze(result)
}
