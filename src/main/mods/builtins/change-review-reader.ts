import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { withoutGitRepositoryOverrides } from "../../services/git-environment"

const execute = promisify(execFile)
export const CHANGE_REVIEW_LIMITS = {
  files: 5000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  milliseconds: 5000,
  commandBytes: 2 * 1024 * 1024
}

export interface ReviewContent {
  fingerprint: string
  text?: string
}

export interface ReviewTree {
  root: string
  head: string | null
  branch: string | null
  capturedAt: number
  fingerprint: string
  contents: Map<string, ReviewContent>
  excluded: number
}

/** Excluded paths are never opened or passed to cat-file, including committed versions. */
export function excludedReviewPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(?:\.env(?:\..*)?|\.envrc|\.git|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(
          part
        ) || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(part)
    )
}

function fingerprint(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function content(bytes: Buffer): ReviewContent {
  let text: string | undefined
  if (!bytes.includes(0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      /* binary */
    }
  }
  return { fingerprint: fingerprint(bytes), ...(text === undefined ? {} : { text }) }
}

function safePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw Error("REVIEW_UNSUPPORTED_PATH")
}

/** Plumbing only: no diff/status/filter execution, no index refresh and no network fetch. */
export async function readReviewTree(
  workspace: string,
  mode: "head" | "worktree",
  externalSignal?: AbortSignal
): Promise<ReviewTree> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(CHANGE_REVIEW_LIMITS.milliseconds),
    ...(externalSignal ? [externalSignal] : [])
  ])
  const git = async (args: string[], maxBuffer = CHANGE_REVIEW_LIMITS.commandBytes) => {
    signal.throwIfAborted()
    const result = await execute(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "diff.external=",
        "-c",
        "core.pager=cat",
        "-c",
        "protocol.allow=never",
        ...args
      ],
      {
        cwd: workspace,
        env: {
          ...withoutGitRepositoryOverrides(process.env),
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_PAGER: "",
          GIT_EXTERNAL_DIFF: ""
        },
        windowsHide: true,
        maxBuffer,
        encoding: "buffer",
        signal
      }
    )
    return result.stdout
  }
  let root: string
  try {
    root = await realpath((await git(["rev-parse", "--show-toplevel"])).toString().trim())
  } catch {
    signal.throwIfAborted()
    throw Error("REVIEW_NOT_REPOSITORY")
  }
  const cwd = await realpath(workspace)
  const subdir = relative(root, cwd)
  if (subdir.startsWith(`..${sep}`) || isAbsolute(subdir)) throw Error("REVIEW_WORKSPACE_CHANGED")
  const prefix = subdir ? `${subdir.split(sep).join("/")}/` : ""
  const inScope = (path: string) => !prefix || path.startsWith(prefix)
  const readHead = async () => {
    try {
      return (await git(["rev-parse", "--verify", "HEAD"])).toString().trim()
    } catch {
      signal.throwIfAborted()
      return null
    }
  }
  const head = await readHead()
  const readBranch = async () => {
    try {
      return (await git(["symbolic-ref", "--quiet", "HEAD"])).toString().trim()
    } catch {
      signal.throwIfAborted()
      return null
    }
  }
  const branch = await readBranch()
  if (mode === "head" && !head) throw Error("REVIEW_UNBORN")
  const listHead = head ? await git(["ls-tree", "-rz", "--full-tree", head]) : Buffer.alloc(0)
  const objects = new Map<string, { mode: string; object: string }>()
  for (const entry of new TextDecoder("utf-8", { fatal: true })
    .decode(listHead)
    .split("\0")
    .filter(Boolean)) {
    const tab = entry.indexOf("\t")
    const [fileMode, , object] = entry.slice(0, tab).split(" ")
    const path = entry.slice(tab + 1)
    safePath(path)
    if (inScope(path)) objects.set(path, { mode: fileMode, object })
  }
  const listWorktree = async () =>
    await git(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"])
  const listing = mode === "worktree" ? await listWorktree() : listHead
  const paths =
    mode === "head"
      ? [...objects.keys()]
      : [
          ...new Set(
            new TextDecoder("utf-8", { fatal: true })
              .decode(listing)
              .split("\0")
              .filter(Boolean)
              .filter(inScope)
          )
        ]
  if (paths.length > CHANGE_REVIEW_LIMITS.files) throw Error("REVIEW_FILE_LIMIT")
  let total = 0
  let excluded = 0
  const contents = new Map<string, ReviewContent>()
  const missingFiles: string[] = []
  const observedFiles: Array<{
    path: string
    dev: bigint
    ino: bigint
    size: bigint
    mtimeNs: bigint
    ctimeNs: bigint
  }> = []
  for (const path of paths.sort()) {
    signal.throwIfAborted()
    safePath(path)
    if (excludedReviewPath(path)) {
      excluded++
      continue
    }
    const object = objects.get(path)
    if (object && !["100644", "100755"].includes(object.mode)) throw Error("REVIEW_SPECIAL_FILE")
    let bytes: Buffer
    if (mode === "head") {
      const size = Number((await git(["cat-file", "-s", object!.object])).toString())
      if (!Number.isSafeInteger(size) || size > CHANGE_REVIEW_LIMITS.fileBytes) {
        throw Error("REVIEW_BYTE_LIMIT")
      }
      if (total + size > CHANGE_REVIEW_LIMITS.totalBytes) throw Error("REVIEW_BYTE_LIMIT")
      bytes = await git(["cat-file", "blob", object!.object], CHANGE_REVIEW_LIMITS.fileBytes)
    } else {
      const absolute = resolve(root, path)
      const before = await lstat(absolute, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }
      )
      if (!before) {
        missingFiles.push(absolute)
        continue
      }
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        (await realpath(absolute)) !== absolute
      )
        throw Error("REVIEW_SPECIAL_FILE")
      if (
        before.size > BigInt(CHANGE_REVIEW_LIMITS.fileBytes) ||
        total + Number(before.size) > CHANGE_REVIEW_LIMITS.totalBytes
      )
        throw Error("REVIEW_BYTE_LIMIT")
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const initial = await handle.stat({ bigint: true })
        if (
          !initial.isFile() ||
          initial.nlink !== 1n ||
          initial.dev !== before.dev ||
          initial.ino !== before.ino ||
          initial.size !== before.size
        ) {
          throw Error("REVIEW_WORKSPACE_CHANGED")
        }
        bytes = Buffer.alloc(Number(initial.size))
        let offset = 0
        while (offset < bytes.length) {
          signal.throwIfAborted()
          const result = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!result.bytesRead) break
          offset += result.bytesRead
        }
        const after = await handle.stat({ bigint: true })
        const named = await lstat(absolute, { bigint: true })
        if (
          offset !== bytes.length ||
          after.size !== initial.size ||
          after.mtimeNs !== initial.mtimeNs ||
          after.ctimeNs !== initial.ctimeNs ||
          named.dev !== initial.dev ||
          named.ino !== initial.ino ||
          named.isSymbolicLink() ||
          (await realpath(absolute)) !== absolute
        )
          throw Error("REVIEW_WORKSPACE_CHANGED")
        observedFiles.push({
          path: absolute,
          dev: after.dev,
          ino: after.ino,
          size: after.size,
          mtimeNs: after.mtimeNs,
          ctimeNs: after.ctimeNs
        })
      } finally {
        await handle.close()
      }
    }
    total += bytes.length
    if (total > CHANGE_REVIEW_LIMITS.totalBytes) throw Error("REVIEW_BYTE_LIMIT")
    contents.set(path, content(bytes))
  }
  for (const path of missingFiles) {
    signal.throwIfAborted()
    const exists = await lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      }
    )
    if (exists) throw Error("REVIEW_WORKSPACE_CHANGED")
  }
  // Detect changes to an earlier file while subsequent files were being captured.
  for (const observed of observedFiles) {
    signal.throwIfAborted()
    const current = await lstat(observed.path, { bigint: true })
    if (
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.size !== observed.size ||
      current.mtimeNs !== observed.mtimeNs ||
      current.ctimeNs !== observed.ctimeNs ||
      current.isSymbolicLink()
    ) {
      throw Error("REVIEW_WORKSPACE_CHANGED")
    }
  }
  if (
    (await readHead()) !== head ||
    (await readBranch()) !== branch ||
    (await realpath(workspace)) !== cwd ||
    (mode === "worktree" && !(await listWorktree()).equals(listing))
  )
    throw Error("REVIEW_WORKSPACE_CHANGED")
  signal.throwIfAborted()
  return {
    root,
    head,
    branch,
    capturedAt: Date.now(),
    contents,
    excluded,
    fingerprint: fingerprint(
      JSON.stringify([...contents].map(([path, value]) => [path, value.fingerprint]))
    )
  }
}
