import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFile, lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { getDb } from "../db"
import { withoutGitRepositoryOverrides } from "./git-environment"

const exec = promisify(execFile)
const maxBytes = 8 * 1024 * 1024
type Bytes = Buffer | string | null
function hash(bytes: Bytes): string | null {
  if (bytes === null) return null
  const header = `blob ${Buffer.byteLength(bytes)}\0`
  const ids = ["sha1", "sha256"].map((algorithm) =>
    createHash(algorithm).update(header).update(bytes).digest("hex")
  )
  return [...ids, Buffer.byteLength(bytes)].join(":")
}
const key = (file: string) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)

/** Only keep digests. A break between two agent writes means a third party edited the file. */
export function recordTaskCommitEdit(
  threadId: string,
  version: string,
  file: string,
  before: Bytes,
  after: Bytes
) {
  try {
    const db = getDb()
    const params = [threadId, version, key(file)]
    const oversized = [before, after].some(
      (bytes) => bytes !== null && Buffer.byteLength(bytes) > maxBytes
    )
    const preimage = oversized ? "unknown" : hash(before)
    const postimage = oversized ? "unknown" : hash(after)
    db.run(
      `INSERT INTO task_commit_edits(thread_id, version, path, before_hash, after_hash)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM task_commit_bindings WHERE thread_id=? AND version=?)
      ON CONFLICT(thread_id, version, path) DO UPDATE SET
      before_hash = CASE WHEN after_hash IS excluded.before_hash THEN before_hash ELSE 'mixed' END,
      after_hash = excluded.after_hash`,
      [...params, preimage, postimage, threadId, version]
    )
  } catch (error) {
    console.warn("[TaskCommit] failed to record edit identity", error)
  }
}

/** Compare the complete first preimage with HEAD and the last postimage with the worktree.
 * Unsupported filters, oversized files and unobserved edits fall back to desktop review. */
export async function verifyTaskCommitEdits(
  threadId: string,
  version: string,
  root: string,
  files: string[],
  verifiedPreimages = new Map<string, string | null>(),
  candidate?: { sha: string; parent: string }
) {
  const env = withoutGitRepositoryOverrides(process.env, "workspace")
  const options = {
    windowsHide: true,
    env,
    timeout: 10_000,
    maxBuffer: maxBytes,
    encoding: "buffer" as const
  }
  const git = (...args: string[]) =>
    exec("git", ["--literal-pathspecs", "-C", root, ...args], options)
  const entries = new Map<string, string>()
  const filtered: {
    file: string
    oid: string
    expected: string
    cacheKey: string
    size: number
  }[] = []
  try {
    const tree = async (ref: string) => {
      const entries: string[] = []
      let chunk: string[] = []
      let length = 0
      const flush = async () => {
        const { stdout } = await git("ls-tree", "-z", "--full-tree", ref, "--", ...chunk)
        entries.push(...stdout.toString().split("\0").filter(Boolean))
        chunk = []
        length = 0
      }
      for (const file of files) {
        if (chunk.length && length + file.length > 12_000) await flush()
        chunk.push(file)
        length += file.length + 4
      }
      if (chunk.length) await flush()
      return entries
    }
    const previousModes = new Map<string, string>()
    if (candidate) {
      for (const entry of await tree(candidate.parent)) {
        previousModes.set(entry.slice(entry.indexOf("\t") + 1), entry.split(" ", 1)[0])
      }
    }
    for (const entry of await tree(candidate?.sha ?? "HEAD")) {
      const tab = entry.indexOf("\t")
      const [mode, type, oid] = entry.slice(0, tab).split(" ")
      if (type !== "blob" || !/^100(644|755)$/.test(mode)) return false
      const name = entry.slice(tab + 1)
      if (candidate && mode !== (previousModes.get(name) ?? "100644")) return false
      entries.set(name, oid)
    }
  } catch {
    return false
  }
  for (const file of files) {
    const absolute = path.resolve(root, file)
    const row = getDb().exec(
      "SELECT before_hash,after_hash FROM task_commit_edits WHERE thread_id=? AND version=? AND path=?",
      [threadId, version, key(absolute)]
    )[0]?.values[0]
    if (!row) return false
    try {
      if (!candidate) {
        const stat = await lstat(absolute).catch((error) => {
          if (error.code === "ENOENT") return null
          throw error
        })
        if (stat && (!stat.isFile() || stat.size > maxBytes)) return false
        if (stat && path.relative(absolute, await realpath(absolute))) return false
        if (hash(stat ? await readFile(absolute) : null) !== row[1]) return false
      }
      const oid = entries.get(file)
      const expected = candidate ? row[1] : row[0]
      if (!oid && expected === null) continue
      if (!oid || typeof expected !== "string") return false
      if (oid && typeof expected === "string" && expected.split(":").includes(oid)) continue
      const cacheKey = JSON.stringify([file, oid ?? null])
      if (verifiedPreimages.has(cacheKey)) {
        if (verifiedPreimages.get(cacheKey) !== expected) return false
      } else {
        const size = Number(expected.split(":")[2])
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes || /[\r\n]/.test(file))
          return false
        filtered.push({ file, oid, expected, cacheKey, size })
      }
    } catch {
      return false
    }
  }
  // Batch the CRLF/smudge-filter slow path. Git's header describes the stored
  // blob size, so frame the filtered payload using the observed byte count.
  for (let start = 0; start < filtered.length; ) {
    let end = start
    let bytes = 0
    while (
      end < filtered.length &&
      (end === start || bytes + filtered[end].size + 128 < maxBytes)
    ) {
      bytes += filtered[end++].size + 128
    }
    const batch = filtered.slice(start, end)
    try {
      const process = exec("git", ["-C", root, "cat-file", "--batch", "--filters"], {
        ...options,
        maxBuffer: bytes + 1024
      })
      process.child.stdin?.on("error", () => {})
      process.child.stdin?.end(batch.map((item) => `${item.oid} ${item.file}\n`).join(""))
      const { stdout } = await process
      let offset = 0
      for (const item of batch) {
        const headerEnd = stdout.indexOf(10, offset)
        if (
          headerEnd < 0 ||
          !stdout.toString("ascii", offset, headerEnd).startsWith(item.oid + " blob ")
        )
          return false
        const endOfBlob = headerEnd + 1 + item.size
        if (
          stdout[endOfBlob] !== 10 ||
          hash(stdout.subarray(headerEnd + 1, endOfBlob)) !== item.expected
        )
          return false
        verifiedPreimages.set(item.cacheKey, item.expected)
        offset = endOfBlob + 1
      }
      if (offset !== stdout.length) return false
    } catch {
      return false
    }
    start = end
  }
  return true
}
