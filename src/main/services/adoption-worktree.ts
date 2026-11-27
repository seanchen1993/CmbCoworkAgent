import { execFile, type ExecFileException } from "child_process"
import { readFile, realpath, stat } from "fs/promises"
import { dirname, join, resolve } from "path"
import { promisify } from "util"
import { BoundedConcurrencyLimiter } from "../util/bounded-concurrency-limiter"
import { readRegisteredRepos } from "./git-hook-registry"

export type WorktreeMembership = "inside" | "outside" | "unknown"
const exec = promisify(execFile)
const FRESH_MS = 30_000
const CAPTURE_WAIT_MS = 300
const UNKNOWN_RETRY_MS = 5000
const key = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path)

const INSPECTION_BUSY = Symbol("work tree check deferred")

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(INSPECTION_BUSY), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function metadata(path: string) {
  return stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
    throw error
  })
}

// Resolve the physical parent first, so a junction/symlink cannot inherit the
// workspace of its lexical parent. Concurrent siblings share their ancestor lookups.
export class AdoptionWorktrees {
  private readonly directories = new Map<
    string,
    { until: number; result: Promise<WorktreeMembership> }
  >()
  private roots?: { until: number; result: Promise<Set<string>> }

  private activeGitProbes = 0
  private pauseGitUntil = 0
  private lastFsErrorLog = -Infinity
  // A stalled network drive must leave libuv workers available to the rest of the app.
  private readonly filesystem = new BoundedConcurrencyLimiter(2, 256, CAPTURE_WAIT_MS)

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.filesystem.acquire()
    if (!release) throw INSPECTION_BUSY
    // A timed-out OS request still owns its slot until it actually finishes.
    return within(Promise.resolve().then(operation).finally(release), 1500)
  }

  private async probe(dir: string, hasMarker = false): Promise<WorktreeMembership> {
    // Persist overflow as unknown; never queue an unbounded number of child processes.
    if (this.activeGitProbes >= 4 || Date.now() < this.pauseGitUntil) return "unknown"
    this.activeGitProbes++
    const startedAt = Date.now()
    try {
      const { stdout } = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C" }
      })
      if (stdout.trim() === "true") return "inside"
      if (stdout.trim() === "false") return "outside"
      console.info("[AdoptionTracker] unexpected git work tree response", {
        dir,
        stdout: stdout.slice(0, 120)
      })
    } catch (e) {
      const error = e as ExecFileException
      const detail = (error.stderr?.trim() || error.message).slice(0, 512)
      console.info("[AdoptionTracker] git work tree check failed", {
        dir,
        code: error.code,
        signal: error.signal,
        killed: error.killed,
        elapsedMs: Date.now() - startedAt,
        detail
      })
      if (
        !hasMarker &&
        !error.killed &&
        error.code === 128 &&
        /^fatal: not a git repository \(or any of the parent directories\): \.git$/m.test(detail)
      )
        return "outside"
    } finally {
      this.activeGitProbes--
    }
    this.pauseGitUntil = Date.now() + UNKNOWN_RETRY_MS
    return "unknown"
  }

  private registeredRoots(): Promise<Set<string>> {
    if (!this.roots || this.roots.until <= Date.now()) {
      const result = this.read(readRegisteredRepos).then(
        (repos) =>
          new Set(repos.filter((repo) => repo.enabled).map((repo) => key(resolve(repo.gitRoot))))
      )
      void result.catch(() => {
        if (this.roots?.result === result) this.roots = undefined
      })
      this.roots = { until: Date.now() + FRESH_MS, result }
    }
    return this.roots.result
  }

  async check(file: string, mode: "capture" | "retry" = "capture"): Promise<WorktreeMembership> {
    const dir = dirname(file)
    try {
      const lookup = this.lookup(dir)
      return await (mode === "retry" ? lookup : within(lookup, CAPTURE_WAIT_MS))
    } catch (error) {
      if (error !== INSPECTION_BUSY && Date.now() - this.lastFsErrorLog >= UNKNOWN_RETRY_MS) {
        this.lastFsErrorLog = Date.now()
        console.info("[AdoptionTracker] cannot inspect work tree", {
          dir,
          detail: (error as Error).message
        })
      }
      return "unknown"
    }
  }

  private async lookup(dir: string): Promise<WorktreeMembership> {
    const physical = await this.read(() => realpath(dir))
    if (physical.split(/[\\/]/).some((part) => key(part) === ".git")) return "outside"
    if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_CEILING_DIRECTORIES) {
      return this.probe(physical)
    }
    return this.directory(physical)
  }

  private directory(dir: string): Promise<WorktreeMembership> {
    const id = key(dir)
    const cached = this.directories.get(id)
    if (cached && cached.until > Date.now()) return cached.result
    const result = this.inspect(dir)
    const entry = { until: Date.now() + FRESH_MS, result }
    if (this.directories.size >= 512) this.directories.delete(this.directories.keys().next().value!)
    this.directories.set(id, entry)
    void result.then(
      (state) => {
        // Coalesce an outage without treating it as a permanent rejection.
        if (state === "unknown") entry.until = Date.now() + UNKNOWN_RETRY_MS
        if (state === "outside" && this.directories.get(id) === entry) this.directories.delete(id)
      },
      () => {
        if (this.directories.get(id) === entry) this.directories.delete(id)
      }
    )
    return result
  }

  private async inspect(dir: string): Promise<WorktreeMembership> {
    const marker = join(dir, ".git")
    const entry = await this.read(() => metadata(marker))
    if (entry) {
      if ((await this.registeredRoots()).has(key(dir))) {
        // Linked worktrees and initialized submodules have a gitfile instead of a .git directory.
        let gitDir = marker
        if (entry.isFile() && entry.size < 8192) {
          const pointer = /^gitdir: (.+)$/.exec(
            (await this.read(() => readFile(marker, "utf8"))).trim()
          )
          if (pointer) gitDir = resolve(dir, pointer[1])
        }
        if ((await this.read(() => metadata(join(gitDir, "HEAD"))))?.isFile()) return "inside"
      }
      // Unregistered or stale marker. Git runs at most once per verified root
      // during a burst of edits, including edits from different case directories.
      return this.probe(dir, true)
    }
    // A bare repository nested in a working tree is its own Git boundary.
    if ((await this.read(() => metadata(join(dir, "HEAD"))))?.isFile()) return this.probe(dir)
    const parent = dirname(dir)
    return parent === dir ? "outside" : this.directory(parent)
  }
}
