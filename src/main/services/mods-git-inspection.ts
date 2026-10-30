import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, lstat, realpath, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createTwoFilesPatch } from "diff"
import { openStableFileHandle, readStableFileHandleBounded } from "./stable-file-handle"

export type ModsGitErrorCode =
  | "DIRECTORY_UNAVAILABLE"
  | "DIRECTORY_CHANGED"
  | "NOT_REPOSITORY"
  | "BASE_COMMIT_MISSING"
  | "INVALID_REQUEST"
  | "PATH_DENIED"
  | "FILE_UNAVAILABLE"
  | "COMPARISON_STALE"
  | "CURSOR_EXPIRED"
  | "QUERY_FAILED"
  | "QUERY_TIMEOUT"
  | "QUERY_CANCELLED"
  | "QUERY_TOO_LARGE"
  | "GIT_UNAVAILABLE"

export class ModsGitInspectionError extends Error {
  constructor(readonly code: ModsGitErrorCode) {
    super(code)
    this.name = "ModsGitInspectionError"
  }
}

/** Only a host policy's explicit path denial is eligible for a partial list. */
export class ModsGitPathAuthorizationError extends ModsGitInspectionError {
  constructor() {
    super("PATH_DENIED")
    this.name = "ModsGitPathAuthorizationError"
  }
}

export interface ModsGitDirectoryIdentity {
  directory: string
  root: string
  gitDir: string
  commonDir: string
  identity: string
}

export interface ModsGitChange {
  path: string
  oldPath?: string
  status: "added" | "modified" | "deleted" | "renamed" | "type-changed" | "conflict" | "untracked"
}

export interface ModsGitChangePage {
  baseCommit: string
  head: string
  branch: string | null
  comparisonId: string
  readAt: string
  mode: "base-to-working"
  entries: ModsGitChange[]
  nextCursor?: string
  truncated: boolean
  total: number
  consistency: "metadata-validated"
  completeness: "complete" | "partial"
  /** Unique excluded paths; names and contents never leave the service. */
  excluded: { denied: number; gitlinks: number }
  limitations: string[]
}

export interface ModsGitFilePreview {
  path: string
  oldPath?: string
  baseCommit: string
  head: string
  comparisonId: string
  readAt: string
  patch: string
  current: string | null
  base: string | null
  binary: boolean
  truncated: boolean
  limitations: string[]
}

interface ReadOptions {
  signal?: AbortSignal
  /** Host policy, applied to both sides (including deleted and renamed paths). */
  authorizePath?: (path: string, identity: ModsGitDirectoryIdentity) => Promise<void>
  authorizeContent?: (content: string, path: string) => Promise<void>
  /** Native diagnostics only: fixed phase names and elapsed time, never paths or content. */
  onMeasure?: (event: { phase: string; durationMs: number }) => void
}

export interface ModsGitListOptions extends ReadOptions {
  baseCommit: string
  comparisonId?: string
  cursor?: string
  limit?: number
}

export interface ModsGitFileOptions extends ReadOptions {
  baseCommit: string
  comparisonId: string
  path: string
  oldPath?: string
  kind?: ModsGitChange["status"]
}

interface InspectionOptions extends ReadOptions {
  timeoutMs?: number
  maxEntries?: number
  maxBytes?: number
  /** Optional native bridge budget, including serialized page metadata and cursor. */
  maxPageBytes?: number
}

interface Operation extends ReadOptions {
  deadline: number
  scannedBytes?: number
  /** Resolve once per operation; no state or executable path survives the request. */
  executable?: Promise<string>
}

function readGate(limit: number) {
  let readers = 0
  const waiters = new Set<() => void>()
  return async (op: Operation): Promise<() => void> => {
    while (readers >= limit) {
      check(op)
      await new Promise<void>((done) => {
        const wake = () => {
          clearTimeout(timer)
          op.signal?.removeEventListener("abort", wake)
          waiters.delete(wake)
          done()
        }
        const timer = setTimeout(wake, Math.max(1, op.deadline - Date.now()))
        waiters.add(wake)
        op.signal?.addEventListener("abort", wake, { once: true })
        if (op.signal?.aborted) wake()
      })
    }
    check(op)
    readers++
    return () => {
      readers--
      waiters.values().next().value?.()
    }
  }
}
const acquireGitReader = readGate(4)
const acquireFileReader = readGate(4)

async function mapFiles<T>(paths: string[], read: (path: string) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(paths.length)
  let next = 0,
    failed = false
  const workers = Array.from({ length: Math.min(4, paths.length) }, async () => {
    try {
      while (!failed && next < paths.length) {
        const index = next++
        results[index] = await read(paths[index])
      }
    } catch (error) {
      failed = true
      throw error
    }
  })
  await Promise.all(workers).finally(() => Promise.allSettled(workers))
  return results
}

function fail(code: ModsGitErrorCode): never {
  throw new ModsGitInspectionError(code)
}

function check(operation: Operation): void {
  if (operation.signal?.aborted) fail("QUERY_CANCELLED")
  if (Date.now() >= operation.deadline) fail("QUERY_TIMEOUT")
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    !path ||
    Buffer.byteLength(path) > 8192 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          (process.platform === "win32" &&
            (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
      )
  )
    fail("PATH_DENIED")
}

async function metadata(path: string, directory = false): Promise<string> {
  try {
    const value = await lstat(path, { bigint: true })
    if (directory) return `${value.dev}:${value.ino}:${value.birthtimeNs}`
    return `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    fail("FILE_UNAVAILABLE")
  }
}

/** Never resolve an executable relative to the inspected (untrusted) repository. */
async function gitExecutable(): Promise<string> {
  const name = process.platform === "win32" ? "git.exe" : "git"
  for (const entry of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue
    const candidate = join(entry, name)
    try {
      await access(candidate)
      if ((await stat(candidate)).isFile()) return await realpath(candidate)
    } catch {
      /* Try the next host PATH entry. */
    }
  }
  fail("GIT_UNAVAILABLE")
}

/** Only trusted host code constructs argv. No shell, pager, network, or Git write commands. */
async function runGit(
  cwd: string,
  args: string[],
  operation: Operation,
  options: { maxBytes?: number; truncate?: boolean; allowFailure?: boolean; stdin?: Buffer } = {}
): Promise<{ bytes: Buffer; truncated: boolean; code: number }> {
  const began = performance.now()
  const command =
    args.find((value) =>
      [
        "rev-parse",
        "config",
        "symbolic-ref",
        "ls-files",
        "ls-tree",
        "check-attr",
        "cat-file"
      ].includes(value)
    ) ?? "other"
  const release = await acquireGitReader(operation)
  try {
    check(operation)
    const executable = await (operation.executable ??= gitExecutable())
    check(operation)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
    )
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      LC_ALL: "C"
    })
    return await new Promise((resolveResult, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      let failure: ModsGitErrorCode | undefined
      const child = spawn(
        executable,
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.pager=cat",
          "-c",
          "diff.external=",
          "-c",
          "submodule.recurse=false",
          "-c",
          "protocol.allow=never",
          ...args
        ],
        {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        }
      )
      child.stdin.on("error", () => {})
      child.stdin.end(options.stdin)
      const stop = (code: ModsGitErrorCode): void => {
        failure = code
        child.kill()
      }
      const abort = (): void => stop("QUERY_CANCELLED")
      const timer = setTimeout(
        () => stop("QUERY_TIMEOUT"),
        Math.max(1, operation.deadline - Date.now())
      )
      operation.signal?.addEventListener("abort", abort, { once: true })
      if (operation.signal?.aborted) abort()
      const cap = options.maxBytes ?? 2 * 1024 * 1024
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, cap - size)
        if (remaining) chunks.push(chunk.subarray(0, remaining))
        size += chunk.length
        if (size > cap) {
          truncated = true
          if (!options.truncate) failure = "QUERY_TOO_LARGE"
          child.kill()
        }
      })
      // Drain stderr without retaining potentially sensitive paths/configuration.
      child.stderr.resume()
      const cleanup = (): void => {
        clearTimeout(timer)
        operation.signal?.removeEventListener("abort", abort)
      }
      child.on("error", () => {
        cleanup()
        reject(new ModsGitInspectionError(failure ?? "GIT_UNAVAILABLE"))
      })
      child.on("close", (code) => {
        cleanup()
        if (failure) reject(new ModsGitInspectionError(failure))
        else if (code !== 0 && !truncated && !options.allowFailure)
          reject(new ModsGitInspectionError("QUERY_FAILED"))
        else resolveResult({ bytes: Buffer.concat(chunks), truncated, code: code ?? -1 })
      })
    })
  } finally {
    release()
    operation.onMeasure?.({ phase: `git.${command}`, durationMs: performance.now() - began })
  }
}

function text(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    fail("QUERY_FAILED")
  }
}

/** Implement only Git's common CRLF text normalization, never custom repository programs. */
type TextNormalization = false | "auto" | "forced"
function normalizedWorkingBytes(bytes: Buffer, mode: TextNormalization): Buffer {
  if (!mode) return bytes
  let pairs = 0,
    loneCr = 0,
    printable = 0,
    nonprintable = 0,
    nul = 0
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]
    if (value === 13) {
      if (bytes[i + 1] === 10) {
        pairs++
        i++
      } else loneCr++
    } else if (value === 10) {
      /* line ending */
    } else if (value === 127) nonprintable++
    else if (value < 32) {
      if (value === 8 || value === 9 || value === 27 || value === 12) printable++
      else {
        nonprintable++
        if (value === 0) nul++
      }
    } else printable++
  }
  if (!pairs || (mode === "auto" && (loneCr || nul || nonprintable > printable >>> 7))) return bytes
  const result = Buffer.allocUnsafe(bytes.length - pairs)
  let offset = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue
    result[offset++] = bytes[i]
  }
  return result
}

export function createModsGitInspection(options: InspectionOptions = {}) {
  const maxEntries = Math.min(10000, Math.max(1, options.maxEntries ?? 4000))
  const maxBytes = Math.min(512 * 1024, Math.max(64, options.maxBytes ?? 128 * 1024))
  const operation = (input: ReadOptions = {}): Operation => ({
    ...options,
    ...input,
    deadline: Date.now() + Math.min(30000, Math.max(1, options.timeoutMs ?? 10000))
  })

  async function inspect(directory: string, op: Operation): Promise<ModsGitDirectoryIdentity> {
    const began = performance.now()
    try {
      check(op)
      let canonical: string
      try {
        canonical = await realpath(directory)
      } catch {
        fail("DIRECTORY_UNAVAILABLE")
      }
      const result = await runGit(
        canonical,
        [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--absolute-git-dir",
          "--git-common-dir"
        ],
        op,
        { allowFailure: true }
      )
      if (result.code !== 0) fail("NOT_REPOSITORY")
      const parts = text(result.bytes).trimEnd().split("\n")
      if (parts.length !== 3) fail("NOT_REPOSITORY")
      const [root, gitDir, commonDir] = await Promise.all(
        parts.map((part) => realpath(part.trimEnd()))
      )
      const identities = await Promise.all(
        [canonical, root, gitDir, commonDir].map((path) => metadata(path, true))
      )
      check(op)
      return {
        directory: resolve(directory),
        root,
        gitDir,
        commonDir,
        identity: digest(JSON.stringify([canonical, root, gitDir, commonDir, identities]))
      }
    } finally {
      op.onMeasure?.({ phase: "directory.inspect", durationMs: performance.now() - began })
    }
  }

  async function verify(identity: ModsGitDirectoryIdentity, op: Operation): Promise<void> {
    const current = await inspect(identity.directory, op)
    if (
      current.identity !== identity.identity ||
      current.root !== identity.root ||
      current.gitDir !== identity.gitDir ||
      current.commonDir !== identity.commonDir
    )
      fail("DIRECTORY_CHANGED")
  }

  async function allowed(
    path: string,
    identity: ModsGitDirectoryIdentity,
    op: Operation
  ): Promise<void> {
    check(op)
    validatePath(path)
    await op.authorizePath?.(path, identity)
    await contained(path, identity, op)
  }

  async function contained(
    path: string,
    identity: ModsGitDirectoryIdentity,
    op: Operation,
    checked = new Set<string>()
  ): Promise<void> {
    validatePath(path)
    // Check every existing ancestor, including for deleted paths. Never follow a junction outside.
    let candidate = identity.root
    for (const part of path.split("/")) {
      candidate = join(candidate, part)
      if (checked.has(candidate)) continue
      try {
        const actual = await realpath(candidate)
        if (!inside(identity.root, actual)) fail("PATH_DENIED")
        checked.add(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break
        if (error instanceof ModsGitInspectionError) throw error
        fail("FILE_UNAVAILABLE")
      }
    }
    check(op)
  }

  async function baseline(
    identity: ModsGitDirectoryIdentity,
    value: string,
    op: Operation
  ): Promise<string> {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 256 ||
      /[\s\0]/.test(value) ||
      value.startsWith("-")
    )
      fail("BASE_COMMIT_MISSING")
    const result = await runGit(
      identity.root,
      ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`],
      op,
      { allowFailure: true }
    )
    const commit = text(result.bytes).trim()
    if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(commit)) fail("BASE_COMMIT_MISSING")
    return commit
  }

  async function workingBlob(
    identity: ModsGitDirectoryIdentity,
    path: string,
    algorithm: "sha1" | "sha256",
    normalize: TextNormalization,
    op: Operation
  ) {
    const release = await acquireFileReader(op)
    try {
      const target = join(identity.root, path)
      const info = await lstat(target).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
        fail("FILE_UNAVAILABLE")
      })
      if (!info) return null
      if (!info.isFile() || info.isSymbolicLink()) fail("PATH_DENIED")
      // Reserve before opening so parallel workers cannot oversubscribe the byte budget.
      if (info.size > 16 * 1024 * 1024 || (op.scannedBytes ?? 0) + info.size > 128 * 1024 * 1024)
        fail("QUERY_TOO_LARGE")
      op.scannedBytes = (op.scannedBytes ?? 0) + info.size
      const opened = await openStableFileHandle(identity.root, target).catch(() =>
        fail("PATH_DENIED")
      )
      try {
        check(op)
        if (opened.size !== info.size) fail("COMPARISON_STALE")
        const bytes = await readStableFileHandleBounded(opened, 16 * 1024 * 1024).catch(() =>
          fail("COMPARISON_STALE")
        )
        check(op)
        const hash = (value: Buffer) =>
          createHash(algorithm).update(`blob ${value.length}\0`).update(value).digest("hex")
        const rawOid = hash(bytes)
        const canonical = normalizedWorkingBytes(bytes, normalize)
        return {
          oid: canonical === bytes ? rawOid : hash(canonical),
          rawOid,
          executable: (info.mode & 0o111) !== 0
        }
      } finally {
        await opened.handle.close()
      }
    } finally {
      release()
    }
  }

  async function snapshot(
    identity: ModsGitDirectoryIdentity,
    value: string,
    op: Operation,
    includeBranch = true
  ) {
    const began = performance.now()
    try {
      await verify(identity, op)
      const indexBefore = await metadata(join(identity.gitDir, "index"))
      // Only object/index/attribute metadata reaches Git. Working bytes are read by the
      // host: no Git command here can enter clean/process/textconv conversion chains.
      const reads = [
        baseline(identity, value, op),
        runGit(
          identity.root,
          ["config", "--null", "--get-regexp", "^core\\.(autocrlf|filemode)$"],
          op,
          { allowFailure: true }
        ),
        runGit(identity.root, ["rev-parse", "--verify", "HEAD"], op),
        includeBranch
          ? runGit(identity.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], op, {
              allowFailure: true
            })
          : Promise.resolve({ bytes: Buffer.alloc(0), code: 1 }),
        runGit(identity.root, ["ls-files", "--stage", "-z"], op),
        runGit(identity.root, ["ls-files", "--others", "--exclude-standard", "-z"], op)
      ] as const
      const [baseCommit, config, headResult, branchResult, tracked, untracked] = await Promise.all(
        reads
      ).finally(() => Promise.allSettled(reads))
      if (config.code !== 0 && config.code !== 1) fail("QUERY_FAILED")
      const settings = new Map(
        text(config.bytes)
          .split("\0")
          .filter(Boolean)
          .map((record) => {
            const at = record.indexOf("\n")
            return [record.slice(0, at), record.slice(at + 1)]
          })
      )
      const head = text(headResult.bytes).trim()
      const tree = await runGit(
        identity.root,
        ["ls-tree", "-r", "-z", "--full-tree", baseCommit],
        op
      )
      const base = new Map<string, { mode: string; oid: string }>()
      const index = new Map<string, { mode: string; oid: string }>()
      const conflicts = new Set<string>()
      for (const record of text(tree.bytes).split("\0").filter(Boolean)) {
        const match = /^([0-9]{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record)
        if (!match) fail("QUERY_FAILED")
        validatePath(match[4])
        base.set(match[4], { mode: match[1], oid: match[3] })
      }
      for (const record of text(tracked.bytes).split("\0").filter(Boolean)) {
        const match = /^([0-9]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record)
        if (!match) fail("QUERY_FAILED")
        validatePath(match[4])
        index.set(match[4], { mode: match[1], oid: match[2] })
        if (match[3] !== "0") conflicts.add(match[4])
      }
      const paths = [...new Set([...base.keys(), ...index.keys()])].sort()
      if (paths.length > 20000) fail("QUERY_TOO_LARGE")
      const attributes = paths.length
        ? await runGit(
            identity.root,
            ["check-attr", "-z", "--stdin", "text", "eol", "filter", "working-tree-encoding"],
            op,
            { stdin: Buffer.from(paths.join("\0") + "\0") }
          )
        : { bytes: Buffer.alloc(0) }
      const policies = new Map<string, { normalize: TextNormalization; custom: boolean }>()
      const attributesByPath = new Map<string, Map<string, string>>()
      const fields = text(attributes.bytes).split("\0")
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const values = attributesByPath.get(fields[i]) ?? new Map<string, string>()
        values.set(fields[i + 1], fields[i + 2])
        attributesByPath.set(fields[i], values)
      }
      const entries = new Map<string, ModsGitChange>()
      const excluded = new Map<string, "denied" | "gitlink">()
      const readable = async (path: string): Promise<boolean> => {
        try {
          await allowed(path, identity, op)
          return true
        } catch (error) {
          check(op)
          if (!(error instanceof ModsGitPathAuthorizationError)) throw error
          excluded.set(path, "denied")
          return false
        }
      }
      const contentStates: string[] = []
      const currentOids = new Map<string, string>()
      const scans = await mapFiles(paths, async (path) => {
        const original = base.get(path),
          staged = index.get(path)
        // Never traverse a separate repository; report the incomplete inspection.
        if (original?.mode === "160000" || staged?.mode === "160000") {
          excluded.set(path, "gitlink")
          return null
        }
        if (!(await readable(path))) return null
        const attrs = attributesByPath.get(path)
        const textMode = attrs?.get("text"),
          eol = attrs?.get("eol")
        const declared = (name: string) =>
          ![undefined, "unset", "unspecified"].includes(attrs?.get(name))
        const normalize: TextNormalization =
          textMode === "unset"
            ? false
            : textMode === "set" || (textMode !== "auto" && (eol === "lf" || eol === "crlf"))
              ? "forced"
              : textMode === "auto" ||
                  ["true", "input"].includes(settings.get("core.autocrlf") ?? "")
                ? "auto"
                : false
        const policy = {
          normalize,
          custom: declared("filter") || declared("working-tree-encoding")
        }
        const current = await workingBlob(
          identity,
          path,
          baseCommit.length === 64 ? "sha256" : "sha1",
          normalize,
          op
        )
        const state = JSON.stringify([path, current, await metadata(join(identity.root, path))])
        let status: ModsGitChange["status"] | undefined
        if (conflicts.has(path)) status = "conflict"
        else if (!current) {
          if (original) status = "deleted"
        } else if (!original) status = "added"
        else if (original.mode !== "100644" && original.mode !== "100755") status = "type-changed"
        else if (
          current.oid !== original.oid &&
          !(normalize === "auto" && current.rawOid === original.oid)
        )
          status = "modified"
        else if (
          settings.get("core.filemode") === "true" &&
          process.platform !== "win32" &&
          current.executable !== (original.mode === "100755")
        )
          status = "modified"
        return { path, policy, current, status, state }
      })
      for (const scan of scans) {
        if (!scan) continue
        policies.set(scan.path, scan.policy)
        contentStates.push(scan.state)
        if (scan.current) currentOids.set(scan.path, scan.current.oid)
        if (scan.status) entries.set(scan.path, { path: scan.path, status: scan.status })
      }
      // Exact raw-object renames are deterministic and never invoke repository code.
      const removed = new Map<string, string[]>()
      for (const [path, entry] of entries)
        if (entry.status === "deleted") {
          const oid = base.get(path)!.oid
          removed.set(oid, [...(removed.get(oid) ?? []), path])
        }
      for (const [path, entry] of entries)
        if (entry.status === "added") {
          const oldPath = removed.get(currentOids.get(path) ?? "")?.shift()
          if (oldPath) {
            entries.delete(oldPath)
            entries.set(path, { path, oldPath, status: "renamed" })
          }
        }
      for (const path of text(untracked.bytes).split("\0").filter(Boolean)) {
        if (await readable(path)) entries.set(path, { path, status: "untracked" })
      }
      if (entries.size > maxEntries) fail("QUERY_TOO_LARGE")
      const all = [...entries.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
      )
      const states: string[] = []
      for (const entry of all) {
        await allowed(entry.path, identity, op)
        if (entry.oldPath) await allowed(entry.oldPath, identity, op)
        states.push(await metadata(join(identity.root, entry.path)))
      }
      check(op)
      if (indexBefore !== (await metadata(join(identity.gitDir, "index")))) fail("COMPARISON_STALE")
      const headAfter = await runGit(identity.root, ["rev-parse", "--verify", "HEAD"], op)
      if (text(headAfter.bytes).trim() !== head) fail("COMPARISON_STALE")
      const comparisonId = digest(
        JSON.stringify([
          identity.identity,
          baseCommit,
          head,
          indexBefore,
          tree.bytes.toString("base64"),
          tracked.bytes.toString("base64"),
          config.bytes.toString("base64"),
          attributes.bytes.toString("base64"),
          contentStates,
          untracked.bytes.toString("base64"),
          [...excluded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          states
        ])
      )
      return {
        baseCommit,
        head,
        branch: branchResult.code === 0 ? text(branchResult.bytes).trim() : null,
        comparisonId,
        policies,
        excluded: {
          denied: [...excluded.values()].filter((reason) => reason === "denied").length,
          gitlinks: [...excluded.values()].filter((reason) => reason === "gitlink").length
        },
        all
      }
    } finally {
      op.onMeasure?.({ phase: "comparison.snapshot", durationMs: performance.now() - began })
    }
  }

  async function listChanges(
    identity: ModsGitDirectoryIdentity,
    input: ModsGitListOptions
  ): Promise<ModsGitChangePage> {
    const op = operation(input)
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
      fail("INVALID_REQUEST")
    const current = await snapshot(identity, input.baseCommit, op)
    if (input.comparisonId && input.comparisonId !== current.comparisonId) fail("COMPARISON_STALE")
    let offset = 0
    if (input.cursor) {
      const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(input.cursor)
      if (!match || match[1] !== current.comparisonId) fail("CURSOR_EXPIRED")
      offset = Number(match[2])
      if (!Number.isSafeInteger(offset) || offset > current.all.length) fail("CURSOR_EXPIRED")
    }
    const limit = Math.min(200, input.limit ?? 100)
    let entries = current.all.slice(offset, offset + limit)
    const page = (): ModsGitChangePage => ({
      mode: "base-to-working",
      baseCommit: current.baseCommit,
      head: current.head,
      branch: current.branch,
      comparisonId: current.comparisonId,
      readAt: new Date().toISOString(),
      entries,
      ...(offset + entries.length < current.all.length
        ? { nextCursor: `${current.comparisonId}:${offset + entries.length}` }
        : {}),
      truncated: false,
      total: current.all.length,
      consistency: "metadata-validated",
      completeness: current.excluded.denied || current.excluded.gitlinks ? "partial" : "complete",
      excluded: current.excluded,
      limitations: [
        ...(current.excluded.denied ? ["paths-not-authorized"] : []),
        ...(current.excluded.gitlinks ? ["gitlinks-not-inspected"] : [])
      ]
    })
    if (options.maxPageBytes !== undefined) {
      while (Buffer.byteLength(JSON.stringify(page())) > options.maxPageBytes) {
        if (entries.length <= 1) fail("QUERY_TOO_LARGE")
        entries = entries.slice(0, -1)
      }
    }
    await verify(identity, op)
    check(op)
    return page()
  }

  async function readFile(
    identity: ModsGitDirectoryIdentity,
    input: ModsGitFileOptions
  ): Promise<ModsGitFilePreview> {
    const op = operation(input)
    await allowed(input.path, identity, op)
    const before = await snapshot(identity, input.baseCommit, op, false)
    if (before.comparisonId !== input.comparisonId) fail("COMPARISON_STALE")
    const entry = before.all.find((candidate) => candidate.path === input.path)
    if (!entry) fail("FILE_UNAVAILABLE")
    if (input.oldPath !== undefined && input.oldPath !== entry.oldPath) fail("INVALID_REQUEST")
    const basePath = entry.oldPath ?? entry.path
    await allowed(basePath, identity, op)
    let baseBytes: Buffer | null = null
    let currentBytes: Buffer | null = null
    let truncated = false
    const limitations: string[] = []
    const policy = before.policies.get(entry.path)
    if (policy?.custom) limitations.push("working-tree-conversion-not-applied")
    if (entry.status !== "untracked" && entry.status !== "added") {
      const base = await runGit(
        identity.root,
        ["cat-file", "blob", `${before.baseCommit}:${basePath}`],
        op,
        { maxBytes, truncate: true, allowFailure: true }
      )
      if (base.code !== 0 && !base.truncated) fail("FILE_UNAVAILABLE")
      baseBytes = base.bytes
      truncated ||= base.truncated
    }
    if (entry.status !== "deleted") {
      const release = await acquireFileReader(op)
      try {
        const target = join(identity.root, entry.path)
        const info = await lstat(target).catch(() => fail("FILE_UNAVAILABLE"))
        if (!info.isFile() || info.isSymbolicLink()) fail("PATH_DENIED")
        const opened = await openStableFileHandle(identity.root, target).catch(() =>
          fail("PATH_DENIED")
        )
        try {
          const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1))
          let count = 0
          while (count < buffer.length) {
            check(op)
            const read = await opened.handle.read(buffer, count, buffer.length - count, count)
            if (!read.bytesRead) break
            count += read.bytesRead
          }
          await opened.assertPathIdentity()
          currentBytes = buffer.subarray(0, Math.min(count, maxBytes))
          truncated ||= count > maxBytes
        } finally {
          await opened.handle.close()
        }
      } finally {
        release()
      }
    }
    check(op)
    if (currentBytes && policy?.normalize && !truncated)
      currentBytes = normalizedWorkingBytes(currentBytes, policy.normalize)
    let binary = [baseBytes, currentBytes].some((value) => value?.includes(0))
    const decode = (bytes: Buffer | null): string | null => {
      if (!bytes) return null
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated })
      } catch {
        binary = true
        return null
      }
    }
    let base = decode(baseBytes)
    let current = decode(currentBytes)
    if (binary) {
      base = null
      current = null
      limitations.push("binary")
    }
    if (truncated) limitations.push("content-truncated")
    if (base !== null) await op.authorizeContent?.(base, basePath)
    if (current !== null) await op.authorizeContent?.(current, entry.path)
    let patch = ""
    if (entry.status === "conflict") limitations.push("conflict-current-content-only")
    else if (!binary && !truncated) {
      patch = await new Promise<string>((resolvePatch) => {
        createTwoFilesPatch(
          JSON.stringify(`a/${basePath}`),
          JSON.stringify(`b/${entry.path}`),
          base ?? "",
          current ?? "",
          undefined,
          undefined,
          {
            context: 3,
            timeout: Math.min(1000, Math.max(1, op.deadline - Date.now())),
            callback: (result) => resolvePatch(result ?? "")
          }
        )
      })
      if (!patch && base !== current) {
        truncated = true
        limitations.push("patch-complexity-limit")
      }
      if (Buffer.byteLength(patch) > maxBytes) {
        patch = new TextDecoder().decode(Buffer.from(patch).subarray(0, maxBytes), { stream: true })
        truncated = true
        limitations.push("patch-truncated")
      }
    }
    const after = await snapshot(identity, before.baseCommit, op, false)
    if (after.comparisonId !== before.comparisonId) fail("COMPARISON_STALE")
    check(op)
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      baseCommit: before.baseCommit,
      head: before.head,
      comparisonId: before.comparisonId,
      readAt: new Date().toISOString(),
      patch,
      current,
      base,
      binary,
      truncated,
      limitations
    }
  }

  return {
    inspectDirectory: (directory: string, input?: ReadOptions) =>
      inspect(directory, operation(input)),
    listChanges,
    readFile
  }
}
