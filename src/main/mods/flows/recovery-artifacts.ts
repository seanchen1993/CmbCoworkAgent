import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"

export interface FlowRecoveryArtifactSnapshot {
  schemaVersion: 1
  coverage: "workspace-excluding-root-git-metadata"
  digest: string
  fileCount: number
  totalBytes: number
}

const MAX_ENTRIES = 8192
const MAX_FILES = 2048
const MAX_DEPTH = 64
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/**
 * All files, including ignored outputs and dependencies, must fit the bounded snapshot.
 * Only root .git metadata is excluded; the caller must separately verify repository identity,
 * HEAD/index state, configuration and actual tool dependency coverage. This is not a permit.
 * This bounded observation is not an atomic filesystem snapshot. The host must fence writers
 * through reservation/start and revalidate at startup; unexcluded external writers mean unknown.
 */
export async function captureFlowRecoveryArtifacts(input: {
  workspace: string
  signal: AbortSignal
  assertCurrent(): void
}): Promise<FlowRecoveryArtifactSnapshot> {
  const workspace = resolve(input.workspace)
  const assertCurrent = async () => {
    input.signal.throwIfAborted()
    input.assertCurrent()
    if (relative(workspace, await realpath(workspace)) !== "")
      throw Error("FLOW_RECOVERY_ROOT_CHANGED")
    input.signal.throwIfAborted()
    input.assertCurrent()
  }
  await assertCurrent()
  const observed = new Map<string, { identity: BigIntStats; names?: string[] }>()
  const unchanged = (before: BigIntStats, after: BigIntStats) =>
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  const observe = (path: string, identity: BigIntStats, names?: string[]) => {
    const previous = observed.get(path)
    if (
      previous &&
      (!unchanged(previous.identity, identity) ||
        JSON.stringify(previous.names) !== JSON.stringify(names))
    )
      throw Error("FLOW_RECOVERY_ARTIFACTS_CHANGED")
    if (!previous) observed.set(path, { identity, names })
  }
  const namesAt = async (absolute: string) => {
    const names: string[] = []
    const directory = await opendir(absolute)
    for await (const entry of directory) {
      input.signal.throwIfAborted()
      input.assertCurrent()
      if (names.length >= MAX_ENTRIES) throw Error("FLOW_RECOVERY_ARTIFACT_LIMIT")
      names.push(entry.name)
    }
    return names.sort()
  }
  const scan = async () => {
    let entries = 0
    let fileCount = 0
    let totalBytes = 0
    const manifest: unknown[] = []
    const visit = async (path: string, depth: number) => {
      if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) throw Error("FLOW_RECOVERY_ARTIFACT_LIMIT")
      input.signal.throwIfAborted()
      input.assertCurrent()
      const absolute = path ? join(workspace, path) : workspace
      const item = await lstat(absolute, { bigint: true })
      if (item.isSymbolicLink()) throw Error("FLOW_RECOVERY_ARTIFACT_LINK")
      if (item.isDirectory()) {
        if (relative(absolute, await realpath(absolute)) !== "")
          throw Error("FLOW_RECOVERY_ARTIFACT_LINK")
        const names = await namesAt(absolute)
        observe(path, item, names)
        if (names.length + entries > MAX_ENTRIES) throw Error("FLOW_RECOVERY_ARTIFACT_LIMIT")
        manifest.push([path, "directory", item.mode.toString(), names])
        for (const name of names) {
          // Never treat .git symlinks or special entries as harmless metadata.
          const isGit =
            path === "" && (process.platform === "win32" ? name.toLowerCase() : name) === ".git"
          if (isGit) {
            const metadata = await lstat(join(absolute, name), { bigint: true })
            if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()))
              throw Error("FLOW_RECOVERY_ARTIFACT_LINK")
            observe(name, metadata)
            manifest.push([
              name,
              metadata.isFile() ? "git-file" : "git-directory",
              metadata.mode.toString()
            ])
            continue
          }
          await visit(path ? `${path}/${name}` : name, depth + 1)
        }
        const current = await lstat(absolute, { bigint: true })
        if (current.isSymbolicLink() || !current.isDirectory() || !unchanged(item, current))
          throw Error("FLOW_RECOVERY_ARTIFACTS_CHANGED")
        if (JSON.stringify(await namesAt(absolute)) !== JSON.stringify(names))
          throw Error("FLOW_RECOVERY_ARTIFACTS_CHANGED")
        return
      }
      if (!item.isFile()) throw Error("FLOW_RECOVERY_ARTIFACT_TYPE")
      observe(path, item)
      if (
        ++fileCount > MAX_FILES ||
        item.size > BigInt(MAX_FILE_BYTES) ||
        BigInt(totalBytes) + item.size > BigInt(MAX_TOTAL_BYTES)
      )
        throw Error("FLOW_RECOVERY_ARTIFACT_LIMIT")
      const opened = await openStableFileHandle(workspace, absolute)
      try {
        const bytes = await readStableFileHandleBounded(
          opened,
          Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes)
        )
        totalBytes += bytes.length
        manifest.push([path, item.mode.toString(), bytes.length, digest(bytes)])
      } finally {
        await opened.handle.close()
      }
      input.signal.throwIfAborted()
      input.assertCurrent()
    }
    await visit("", 0)
    await assertCurrent()
    return { digest: digest(JSON.stringify(manifest)), fileCount, totalBytes }
  }
  const first = await scan()
  const second = await scan()
  if (first.digest !== second.digest) throw Error("FLOW_RECOVERY_ARTIFACTS_CHANGED")
  // Recheck every observed original path after both reads, including files visited early.
  // Timestamps/inodes guard only this observation window, not the persistent content digest.
  for (const [path, previous] of observed) {
    input.signal.throwIfAborted()
    input.assertCurrent()
    const absolute = path ? join(workspace, path) : workspace
    const current = await lstat(absolute, { bigint: true })
    if (current.isSymbolicLink() || relative(absolute, await realpath(absolute)) !== "")
      throw Error("FLOW_RECOVERY_ARTIFACT_LINK")
    if (!unchanged(previous.identity, current)) throw Error("FLOW_RECOVERY_ARTIFACTS_CHANGED")
    if (
      previous.names &&
      JSON.stringify(await namesAt(absolute)) !== JSON.stringify(previous.names)
    )
      throw Error("FLOW_RECOVERY_ARTIFACTS_CHANGED")
  }
  await assertCurrent()
  return { schemaVersion: 1, coverage: "workspace-excluding-root-git-metadata", ...second }
}
