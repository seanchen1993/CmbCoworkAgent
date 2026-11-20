import { spawn } from "node:child_process"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import type { CommandShellSyntax } from "./exec-policy"
import { withoutGitRepositoryOverrides } from "../services/git-environment"
import {
  profileShellCommand,
  shellPathMatches,
  type ShellCommandProfile,
  type ShellWriteKind
} from "./shell-command-profile"

export interface ShellFileChange {
  absPath: string
  before?: Buffer | string
  after?: Buffer | string
  decision: "counted" | "attributed" | "unattributed"
  reason?:
    | "long-command-unscoped"
    | "named-peer"
    | "concurrent-unscoped"
    | "stale-observation"
    | "excluded-output"
}
export interface ShellFileCapture {
  finish(): Promise<{ changes: ShellFileChange[] }>
}
interface Limits {
  beforeMs: number
  afterMs: number
  gitMs: number
  slowMs: number
  cooldownMs: number
  shortMs: number
  fileBytes: number
  snapshotBytes: number
  entries: number
}
const DEFAULTS: Limits = {
  beforeMs: 4000,
  afterMs: 6000,
  gitMs: 3000,
  slowMs: 1500,
  cooldownMs: 600_000,
  shortMs: 5000,
  fileBytes: 2 * 1024 * 1024,
  snapshotBytes: 32 * 1024 * 1024,
  entries: 5000
}
interface FileState {
  fingerprint: string
  content?: Buffer
  size: number
  exists: boolean
  epoch: number
}
interface RepoSnapshot {
  root: string
  head: string | null
  files: Map<string, FileState>
  epoch: number
}
interface Observation {
  repos: RepoSnapshot[]
  bytes: number
}
interface Window {
  id: number
  start: number
  ended?: number
  epoch: number
  workspace: string
  profile: ShellCommandProfile
  limits: Limits
  peers: Set<Window>
}
interface WriteNote {
  epoch: number
  state: "present" | "missing" | "unavailable"
  content: Buffer | null
  at: number
}
interface ContentBudget {
  bytes: number
  closed: boolean
}
const windows = new Map<number, Window>()
const notes = new Map<string, WriteNote>()
const circuits = new Map<string, number>()
const contentCache = new Map<string, { fingerprint: string; content: Buffer }>()
let cacheBytes = 0
let noteBytes = 0
let nextId = 0
let epoch = 0
const CACHE_BYTES = 64 * 1024 * 1024
const NOTE_BYTES = 32 * 1024 * 1024
const MAX_WINDOWS = 64
const ACTIVE_CONTENT_BYTES = 128 * 1024 * 1024
let activeContentBytes = 0
let activeCaptureSlots = 0

function reserveContent(budget: ContentBudget, bytes: number): boolean {
  if (budget.closed || activeContentBytes + bytes > ACTIVE_CONTENT_BYTES) return false
  budget.bytes += bytes
  activeContentBytes += bytes
  return true
}
function releaseContent(budget: ContentBudget): void {
  if (budget.closed) return
  budget.closed = true
  activeContentBytes -= budget.bytes
  budget.bytes = 0
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  )
}

function checkBudget(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("capture time budget exceeded")
}

/** No shell expansion, repository redirection, prompts or optional Git locks. */
function git(
  root: string,
  args: string[],
  deadline: number,
  limits: Limits,
  input?: string,
  maxBytes = 8 * 1024 * 1024
): Promise<Buffer> {
  checkBudget(deadline)
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      env: {
        ...withoutGitRepositoryOverrides(process.env),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0"
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        child.kill("SIGKILL")
        reject(error)
      } else resolve(Buffer.concat(chunks))
    }
    const timer = setTimeout(
      () => finish(new Error("git probe timed out")),
      Math.min(limits.gitMs, Math.max(1, deadline - Date.now()))
    )
    child.on("error", finish)
    child.stdin.on("error", () => {
      /* A failed Git command may close stdin early. */
    })
    child.stdout.on("data", (b: Buffer) => {
      bytes += b.length
      if (bytes > maxBytes) finish(new Error("git output budget exceeded"))
      else chunks.push(b)
    })
    // Do not retain unbounded stderr, command text or source contents.
    child.stderr.resume()
    child.on("close", (code) =>
      finish(code === 0 ? undefined : new Error(`git probe exited ${code}`))
    )
    child.stdin.end(input)
  })
}

async function repositoryAt(
  directory: string,
  deadline: number,
  limits: Limits
): Promise<string | null> {
  try {
    return (
      (await git(directory, ["rev-parse", "--show-toplevel"], deadline, limits))
        .toString("utf8")
        .trim() || null
    )
  } catch {
    checkBudget(deadline)
    return null
  }
}

async function repositories(
  workspace: string,
  deadline: number,
  limits: Limits
): Promise<string[]> {
  const roots = new Set<string>()
  const containing = await repositoryAt(workspace, deadline, limits)
  if (containing) roots.add(containing)
  else {
    const skip = new Set([
      "node_modules",
      ".git",
      ".venv",
      "dist",
      "build",
      "out",
      "target",
      "coverage"
    ])
    const queue = [{ dir: workspace, depth: 0 }]
    for (let i = 0; i < queue.length && i < 2000; i++) {
      checkBudget(deadline)
      const { dir, depth } = queue[i]
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        if (entries.some((e) => e.name === ".git")) {
          const root = await repositoryAt(dir, deadline, limits)
          if (root && inside(workspace, root)) roots.add(root)
          continue
        }
        if (depth < 4)
          for (const entry of entries)
            if (entry.isDirectory() && !skip.has(entry.name))
              queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      } catch {
        checkBudget(deadline)
      }
    }
  }
  // Only initialized tracked submodules, not arbitrary untracked nested repos.
  const pending = [...roots]
  for (let i = 0; i < pending.length && i < 64; i++) {
    const root = pending[i]
    const scope = inside(root, workspace) ? path.relative(root, workspace) || "." : "."
    try {
      const tracked = (
        await git(root, ["ls-files", "--stage", "-z", "--", scope], deadline, limits)
      ).toString("utf8")
      for (const record of tracked.split("\0")) {
        if (!record.startsWith("160000 ")) continue
        const name = record.slice(record.indexOf("\t") + 1)
        const child = path.resolve(root, name)
        if (!inside(workspace, child) || roots.has(child)) continue
        const childRoot = await repositoryAt(child, deadline, limits)
        if (childRoot && path.resolve(childRoot) === child) {
          roots.add(child)
          pending.push(child)
        }
      }
    } catch {
      checkBudget(deadline)
    }
  }
  return [...roots].slice(0, 64)
}

function statusPaths(raw: Buffer): { head: string | null; paths: string[] } {
  const records = raw.toString("utf8").split("\0")
  const paths: string[] = []
  let head: string | null = null
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice(13).trim()
      if (/^[a-f0-9]{40,64}$/.test(value)) head = value
    } else if (record.startsWith("? ")) paths.push(record.slice(2))
    else if (record.startsWith("1 ")) paths.push(record.split(" ").slice(8).join(" "))
    else if (record.startsWith("2 ")) {
      paths.push(record.split(" ").slice(9).join(" "))
      if (records[i + 1]) paths.push(records[++i])
    } else if (record.startsWith("u ")) paths.push(record.split(" ").slice(10).join(" "))
  }
  return { head, paths }
}

function rememberContent(absPath: string, fingerprint: string, content: Buffer): void {
  const previous = contentCache.get(absPath)
  if (previous) {
    cacheBytes -= previous.content.length
    contentCache.delete(absPath)
  }
  while (cacheBytes + content.length > CACHE_BYTES || contentCache.size >= 5000) {
    const key = contentCache.keys().next().value
    if (!key) break
    cacheBytes -= contentCache.get(key)!.content.length
    contentCache.delete(key)
  }
  if (content.length <= CACHE_BYTES) {
    contentCache.set(absPath, { fingerprint, content })
    cacheBytes += content.length
  }
}

/** Bound allocations even when a file grows or is replaced during the read. */
async function readStableContent(
  absPath: string,
  expected: Stats,
  maxBytes: number,
  deadline: number
): Promise<Buffer | undefined> {
  if (expected.size > maxBytes) return undefined
  const handle = await open(absPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const same = (info: Stats): boolean =>
      info.isFile() &&
      info.dev === expected.dev &&
      info.ino === expected.ino &&
      info.size === expected.size &&
      info.mtimeMs === expected.mtimeMs &&
      info.ctimeMs === expected.ctimeMs
    if (!same(await handle.stat())) return undefined
    const content = Buffer.allocUnsafe(expected.size)
    let offset = 0
    while (offset < content.length) {
      checkBudget(deadline)
      const { bytesRead } = await handle.read(
        content,
        offset,
        Math.min(256 * 1024, content.length - offset),
        offset
      )
      if (!bytesRead) return undefined
      offset += bytesRead
    }
    checkBudget(deadline)
    const after = await lstat(absPath)
    return !after.isSymbolicLink() && same(after) && same(await handle.stat()) ? content : undefined
  } finally {
    await handle.close()
  }
}

async function observe(
  roots: string[],
  workspace: string,
  deadline: number,
  limits: Limits,
  needsContent: boolean | (() => boolean),
  isCodeFile: (p: string) => boolean,
  budget: ContentBudget
): Promise<Observation> {
  const result: Observation = { repos: [], bytes: 0 }
  for (const root of roots) {
    checkBudget(deadline)
    if ((circuits.get(root) ?? 0) > Date.now()) continue
    const started = Date.now()
    const scope = inside(root, workspace) ? path.relative(root, workspace) || "." : "."
    let parsed: ReturnType<typeof statusPaths>
    try {
      parsed = statusPaths(
        await git(
          root,
          [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--",
            scope
          ],
          deadline,
          limits
        )
      )
    } catch (error) {
      circuits.set(root, Date.now() + limits.cooldownMs)
      console.warn("[ShellFileEffects] status unavailable; repository cooling down", {
        root,
        reason: String(error)
      })
      continue
    }
    if (Date.now() - started > limits.slowMs) {
      circuits.set(root, Date.now() + limits.cooldownMs)
      console.warn("[ShellFileEffects] slow repository; capture skipped", {
        root,
        durationMs: Date.now() - started
      })
      continue
    }
    if (parsed.paths.length > limits.entries) {
      console.warn("[ShellFileEffects] skipped: entry budget exceeded", {
        root,
        entries: parsed.paths.length
      })
      continue
    }
    const repo: RepoSnapshot = { root, head: parsed.head, files: new Map(), epoch: ++epoch }
    for (const rel of parsed.paths) {
      checkBudget(deadline)
      const absPath = path.resolve(root, rel)
      if (!inside(root, absPath) || !inside(workspace, absPath)) continue
      try {
        const info = await lstat(absPath)
        if (!info.isFile() || info.isSymbolicLink()) continue
        const fingerprint = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.mode}`
        const state: FileState = { fingerprint, size: info.size, exists: true, epoch: ++epoch }
        if (
          (typeof needsContent === "function" ? needsContent() : needsContent) &&
          isCodeFile(absPath) &&
          info.size <= limits.fileBytes &&
          result.bytes + info.size <= limits.snapshotBytes &&
          reserveContent(budget, info.size)
        ) {
          const cached = contentCache.get(absPath)
          const content =
            cached?.fingerprint === fingerprint
              ? cached.content
              : await readStableContent(absPath, info, limits.fileBytes, deadline)
          // Do not label a raced read as a stable preimage or cache it.
          const after = await lstat(absPath)
          if (
            content &&
            after.isFile() &&
            !after.isSymbolicLink() &&
            after.mtimeMs === info.mtimeMs &&
            after.ctimeMs === info.ctimeMs &&
            after.size === info.size &&
            after.ino === info.ino
          ) {
            state.content = content
            result.bytes += content.length
            rememberContent(absPath, fingerprint, content)
          }
        }
        repo.files.set(absPath, state)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          repo.files.set(absPath, {
            fingerprint: "deleted",
            exists: false,
            size: 0,
            content: Buffer.alloc(0),
            epoch: ++epoch
          })
        else
          console.warn("[ShellFileEffects] file unavailable", {
            absPath,
            reasonType: (error as Error).name
          })
      }
    }
    result.repos.push(repo)
  }
  return result
}

/** Read all needed clean preimages using the HEAD captured BEFORE the command. */
async function headContents(
  repo: RepoSnapshot,
  paths: string[],
  deadline: number,
  limits: Limits,
  budget: ContentBudget
): Promise<Map<string, Buffer | null>> {
  const contents = new Map<string, Buffer | null>()
  if (!repo.head || paths.length === 0) return contents
  const queryPaths = paths.filter((p) => !/[\r\n]/.test(p))
  const expressions = queryPaths.map(
    (p) => `${repo.head}:${path.relative(repo.root, p).replace(/\\/g, "/")}`
  )
  const lookup = new Map(expressions.map((expr, i) => [expr, queryPaths[i]]))
  const checks = (
    await git(
      repo.root,
      ["cat-file", "--batch-check"],
      deadline,
      limits,
      expressions.join("\n") + "\n"
    )
  ).toString("utf8")
  const selected: string[] = []
  let bytes = 0
  const checkLines = checks.split("\n")
  for (let index = 0; index < expressions.length; index++) {
    const line = checkLines[index] ?? ""
    const m = line.match(/^([a-f0-9]+) blob (\d+)$/)
    // --batch-check returns object hash, not the input expression; preserve order.
    if (line === expressions[index] + " missing") contents.set(queryPaths[index], null)
    // cat-file temporarily holds both the batch response and copied preimages.
    if (
      m &&
      Number(m[2]) <= limits.fileBytes &&
      bytes + Number(m[2]) <= limits.snapshotBytes &&
      reserveContent(budget, Number(m[2]) * 2)
    ) {
      selected.push(expressions[index])
      bytes += Number(m[2])
    }
  }
  if (!selected.length) return contents
  const data = await git(
    repo.root,
    ["cat-file", "--batch"],
    deadline,
    limits,
    selected.join("\n") + "\n",
    limits.snapshotBytes + 1024 * 1024
  )
  let offset = 0
  for (const expr of selected) {
    const end = data.indexOf(10, offset)
    if (end < 0) throw new Error("invalid cat-file header")
    const header = data
      .subarray(offset, end)
      .toString("utf8")
      .match(/^[a-f0-9]+ blob (\d+)$/)
    if (!header) throw new Error("invalid cat-file object")
    const size = Number(header[1])
    offset = end + 1
    if (offset + size >= data.length || data[offset + size] !== 10)
      throw new Error("incomplete cat-file content")
    contents.set(lookup.get(expr)!, Buffer.from(data.subarray(offset, offset + size)))
    offset += size + 1
  }
  return contents
}

function saveNote(
  absPath: string,
  content: Buffer | null,
  missing = false,
  observedEpoch = ++epoch
): void {
  if (missing) content = Buffer.alloc(0)
  const old = notes.get(absPath)
  // Publication may finish out of order; it cannot make an old observation
  // newer than a snapshot that already saw the resulting file state.
  if (old && old.epoch > observedEpoch) return
  if (old) {
    noteBytes -= old.content?.length ?? 0
    notes.delete(absPath)
  }
  while (notes.size >= 5000 || noteBytes + (content?.length ?? 0) > NOTE_BYTES) {
    const key = notes.keys().next().value
    if (!key) break
    noteBytes -= notes.get(key)!.content?.length ?? 0
    notes.delete(key)
  }
  if ((content?.length ?? 0) <= NOTE_BYTES) {
    notes.set(absPath, {
      content,
      state: missing ? "missing" : content === null ? "unavailable" : "present",
      epoch: observedEpoch,
      at: Date.now()
    })
    noteBytes += content?.length ?? 0
  }
}

/** Called after successful file-tool writes, even on a standard-mode sandbox. */
export async function noteFileToolWrite(
  absPath: string,
  content: Buffer | string | (() => Buffer | string)
): Promise<void> {
  if (!windows.size) return
  const observedEpoch = ++epoch
  try {
    const canonical = await realpath(absPath)
    if (!windows.size) return
    // Do not re-encode every file-tool edit in standard mode or allocate a
    // giant buffer merely to mark it as over-budget.
    if (typeof content === "function" && (await lstat(canonical)).size > DEFAULTS.fileBytes) {
      saveNote(canonical, null, false, observedEpoch)
      return
    }
    const value = typeof content === "function" ? content() : content
    const buffer =
      Buffer.byteLength(value) <= DEFAULTS.fileBytes
        ? Buffer.isBuffer(value)
          ? value
          : Buffer.from(value)
        : null
    if (windows.size) saveNote(canonical, buffer, false, observedEpoch)
  } catch {
    console.warn("[ShellFileEffects] file-tool write note unavailable", { absPath })
  }
}

function named(profile: ShellCommandProfile, file: string): boolean {
  return profile.namedPaths.some((p) => shellPathMatches(p, file))
}
function kindFor(profile: ShellCommandProfile, file: string): ShellWriteKind {
  const explicitlyNamed = named(profile, file)
  const applicable = profile.effects.filter(
    (e) =>
      (e.paths.length === 0 && !(e.scope === "unknown" && explicitlyNamed)) ||
      e.paths.some((p) => shellPathMatches(p, file))
  )
  if (applicable.some((e) => e.kind === "excluded")) return "excluded"
  if (applicable.some((e) => e.kind === "generated")) return "generated"
  if (applicable.some((e) => e.kind === "transfer")) return "transfer"
  return "model"
}

function ownershipRejection(window: Window, file: string): ShellFileChange["reason"] {
  const long =
    window.profile.hasLongRunning ||
    (window.ended ?? performance.now()) - window.start > window.limits.shortMs
  if (long && !named(window.profile, file)) return "long-command-unscoped"
  const peers = [...window.peers].filter(
    (w) => (w.ended ?? Infinity) > window.start && w.start < (window.ended ?? Infinity)
  )
  const namedPeers = peers.filter((w) => named(w.profile, file))
  // Named windows settle in observation-completion order, not start-id order.
  // The first settlement writes a note; a later one uses it as its preimage,
  // or rejects a stale observation using the epoch check below.
  if (namedPeers.length && !named(window.profile, file)) return "named-peer"
  if (
    !named(window.profile, file) &&
    peers.some(
      (w) =>
        !w.profile.hasLongRunning && (w.ended ?? performance.now()) - w.start <= w.limits.shortMs
    )
  )
    return "concurrent-unscoped"
  return undefined
}

function owns(window: Window, file: string): boolean {
  return ownershipRejection(window, file) === undefined
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("capture time budget exceeded")), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function beginShellFileCapture(options: {
  workspaceRoot: string
  command: string
  cwd: string
  isCodeFile: (p: string) => boolean
  shellSyntax?: CommandShellSyntax
  limits?: Partial<Limits>
}): Promise<ShellFileCapture | null> {
  const limits = { ...DEFAULTS, ...options.limits }
  const deadline = Date.now() + limits.beforeMs
  const budget: ContentBudget = { bytes: 0, closed: false }
  if (activeCaptureSlots >= MAX_WINDOWS) {
    console.warn("[ShellFileEffects] skipped: active window budget exceeded", {
      active: activeCaptureSlots,
      limit: MAX_WINDOWS
    })
    return null
  }
  // Reserve synchronously BEFORE any await: simultaneous callers must not all
  // observe the same free slot. The reservation includes pending snapshots.
  activeCaptureSlots++
  let window: Window | undefined
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    activeCaptureSlots--
    if (window) windows.delete(window.id)
    releaseContent(budget)
    if (!activeCaptureSlots) {
      notes.clear()
      noteBytes = 0
    }
  }
  try {
    const cwd = await bounded(realpath(options.cwd), Math.max(1, deadline - Date.now()))
    const profile = await bounded(
      profileShellCommand(options.command, cwd, options.shellSyntax),
      Math.max(1, deadline - Date.now())
    )
    if (!profile.canWrite) {
      if (profile.background) console.info("[ShellFileEffects] skipped: shell background command")
      release()
      return null
    }
    const workspace = await bounded(
      realpath(options.workspaceRoot),
      Math.max(1, deadline - Date.now())
    )
    window = {
      id: ++nextId,
      start: performance.now(),
      epoch: ++epoch,
      workspace,
      profile,
      limits,
      peers: new Set()
    }
    for (const peer of windows.values())
      if (inside(workspace, peer.workspace) || inside(peer.workspace, workspace)) {
        window.peers.add(peer)
        peer.peers.add(window)
      }
    windows.set(window.id, window)
    const w = window
    const roots = await bounded(
      repositories(workspace, deadline, limits),
      Math.max(1, deadline - Date.now())
    )
    const needsContent = profile.effects.some((e) => e.kind === "model")
    const before = await bounded(
      observe(roots, workspace, deadline, limits, needsContent, options.isCodeFile, budget),
      Math.max(1, deadline - Date.now())
    )
    if (!before.repos.length) {
      release()
      return null
    }
    // Start duration attribution at actual command dispatch, not snapshot wait.
    w.start = performance.now()
    let finished: Promise<{ changes: ShellFileChange[] }> | undefined
    const finish = async (): Promise<{ changes: ShellFileChange[] }> => {
      w.ended = performance.now()
      const endDeadline = Date.now() + limits.afterMs
      const changes: ShellFileChange[] = []
      try {
        // A B/C window must hand a readable postimage to overlapping model
        // windows too, including dirty files restored to clean HEAD status.
        const postNeedsContent = () =>
          needsContent ||
          [...w.peers].some((p) => p.profile.effects.some((e) => e.kind === "model"))
        const after = await observe(
          before.repos.map((r) => r.root),
          workspace,
          endDeadline,
          limits,
          postNeedsContent,
          options.isCodeFile,
          budget
        )
        if (budget.closed) return { changes: [] }
        let remainingHeadBytes = limits.snapshotBytes
        for (const oldRepo of before.repos) {
          const newRepo = after.repos.find((r) => r.root === oldRepo.root)
          if (!newRepo) continue
          const allPaths = [...new Set([...oldRepo.files.keys(), ...newRepo.files.keys()])]
          const changed = allPaths.filter(
            (p) => oldRepo.files.get(p)?.fingerprint !== newRepo.files.get(p)?.fingerprint
          )
          const cleanPaths = needsContent
            ? changed.filter(
                (p) =>
                  !oldRepo.files.has(p) &&
                  options.isCodeFile(p) &&
                  owns(w, p) &&
                  kindFor(profile, p) === "model"
              )
            : []
          const heads = await headContents(
            oldRepo,
            cleanPaths,
            endDeadline,
            { ...limits, snapshotBytes: remainingHeadBytes },
            budget
          )
          if (budget.closed) return { changes: [] }
          for (const value of heads.values()) remainingHeadBytes -= value?.length ?? 0
          for (const absPath of changed) {
            checkBudget(endDeadline)
            const prior = oldRepo.files.get(absPath),
              current = newRepo.files.get(absPath)
            // An absent post-status entry is a revert to HEAD, not a deletion.
            let afterContent = current?.content
            let afterMissing = current?.exists === false
            let observedEpoch = current?.epoch ?? newRepo.epoch
            if (
              afterContent === undefined &&
              prior &&
              postNeedsContent() &&
              options.isCodeFile(absPath)
            ) {
              try {
                const st = await lstat(absPath)
                observedEpoch = ++epoch
                if (!st.isFile() || st.isSymbolicLink()) continue
                if (
                  st.size <= limits.fileBytes &&
                  after.bytes + st.size <= limits.snapshotBytes &&
                  reserveContent(budget, st.size)
                ) {
                  afterContent = await readStableContent(absPath, st, limits.fileBytes, endDeadline)
                  after.bytes += afterContent?.length ?? 0
                }
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") continue
                afterContent = Buffer.alloc(0)
                afterMissing = true
                observedEpoch = ++epoch
              }
            }
            if (budget.closed) return { changes: [] }
            const rejection = ownershipRejection(w, absPath)
            if (rejection) {
              changes.push({ absPath, decision: "unattributed", reason: rejection })
              continue
            }
            // EVERY source class must obey the same settlement fence. A slow
            // formatter/transfer must not overwrite a newer model preimage.
            const note = notes.get(absPath)
            const beforeEpoch = prior?.epoch ?? oldRepo.epoch
            if (note && note.epoch > beforeEpoch && note.epoch > observedEpoch) {
              changes.push({ absPath, decision: "unattributed", reason: "stale-observation" })
              continue
            }
            const kind = kindFor(profile, absPath)
            if (kind === "excluded") {
              changes.push({ absPath, decision: "unattributed", reason: "excluded-output" })
              saveNote(absPath, afterContent ?? null, afterMissing, observedEpoch)
              continue
            }
            if (kind !== "model" || !options.isCodeFile(absPath)) {
              changes.push({ absPath, decision: "attributed" })
              saveNote(absPath, afterContent ?? null, afterMissing, observedEpoch)
              continue
            }
            let beforeContent = prior?.content ?? heads.get(absPath) ?? undefined
            if (!prior && !heads.has(absPath) && !oldRepo.head) beforeContent = Buffer.alloc(0)
            // New files do not exist in HEAD. Missing tracked preimages are NOT empty.
            if (!prior && heads.has(absPath) && heads.get(absPath) === null)
              beforeContent = Buffer.alloc(0)
            if (note && note.epoch > beforeEpoch) {
              if (afterContent && note.content?.equals(afterContent)) continue
              if (note.state !== "unavailable") beforeContent = note.content ?? Buffer.alloc(0)
              else beforeContent = undefined
            }
            if (beforeContent === undefined || afterContent === undefined) {
              changes.push({ absPath, decision: "attributed" })
              console.info(
                "[ShellFileEffects] attribution only: content unavailable or oversized",
                { absPath }
              )
              continue
            }
            if (beforeContent.equals(afterContent)) {
              // Creation/deletion of an empty file is still a mutation for
              // automatic commits, but contributes zero generated lines.
              if ((!prior?.exists && !afterMissing) || afterMissing) {
                changes.push({ absPath, decision: "attributed" })
                saveNote(absPath, afterContent, afterMissing, observedEpoch)
              }
              continue
            }
            changes.push({
              absPath,
              before: beforeContent,
              after: afterContent,
              decision: "counted"
            })
            saveNote(absPath, afterContent, afterMissing, observedEpoch)
          }
        }
        if (changes.some((c) => c.decision === "unattributed"))
          console.info("[ShellFileEffects] changes not counted", {
            windowId: w.id,
            count: changes.filter((c) => c.decision === "unattributed").length,
            reasons: [
              ...new Set(changes.filter((c) => c.decision === "unattributed").map((c) => c.reason))
            ]
          })
        return { changes }
      } finally {
        release()
      }
    }
    return {
      finish: () =>
        (finished ??= bounded(finish(), limits.afterMs).catch((error) => {
          release()
          console.warn("[ShellFileEffects] capture abandoned", { reason: String(error) })
          return { changes: [] }
        }))
    }
  } catch (error) {
    release()
    console.warn("[ShellFileEffects] capture unavailable; command continues", {
      reason: String(error)
    })
    return null
  }
}
