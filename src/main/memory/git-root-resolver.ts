import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

const DEFAULT_CACHE_TTL_MS = 60_000

export type MemoryGitRunner = (
  workDir: string,
  args: string[],
  signal: AbortSignal
) => Promise<string>

interface SharedGitRequest {
  controller: AbortController
  promise: Promise<string | null>
  consumers: Set<symbol>
}

function abortError(): Error {
  const error = new Error("Memory Git root lookup was cancelled")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function runGit(workDir: string, args: string[], signal: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", workDir, ...args],
      {
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        signal
      },
      (error, stdout) => {
        if (signal.aborted) {
          reject(abortError())
          return
        }
        if (error) {
          reject(error)
          return
        }
        resolvePromise(stdout.trim())
      }
    )
  })
}

export class MemoryGitRootResolver {
  private readonly cache = new Map<string, { value: string | null; expiresAt: number }>()
  private readonly inFlight = new Map<string, SharedGitRequest>()

  constructor(
    private readonly runner: MemoryGitRunner = runGit,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS
  ) {}

  private async resolveUncached(cwd: string, signal: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    try {
      const commonDir = await this.runner(
        cwd,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal
      )
      throwIfAborted(signal)
      if (commonDir && basename(commonDir) === ".git") return resolve(dirname(commonDir))
    } catch (error) {
      throwIfAborted(signal)
      // Older Git versions may not support --path-format=absolute.
      if (error instanceof Error && error.name === "AbortError") throw error
    }
    try {
      const root = await this.runner(cwd, ["rev-parse", "--show-toplevel"], signal)
      throwIfAborted(signal)
      return root ? resolve(root) : null
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof Error && error.name === "AbortError") throw error
      return null
    }
  }

  private createShared(key: string, cwd: string): SharedGitRequest {
    const controller = new AbortController()
    const shared: SharedGitRequest = {
      controller,
      promise: Promise.resolve(null),
      consumers: new Set()
    }
    shared.promise = this.resolveUncached(cwd, controller.signal)
      .then((value) => {
        this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs })
        return value
      })
      .finally(() => {
        if (this.inFlight.get(key) === shared) this.inFlight.delete(key)
      })
    this.inFlight.set(key, shared)
    return shared
  }

  private subscribe(shared: SharedGitRequest, signal?: AbortSignal): Promise<string | null> {
    const consumer = Symbol("memory-git-root-consumer")
    shared.consumers.add(consumer)
    return new Promise<string | null>((resolvePromise, reject) => {
      let settled = false
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort)
        shared.consumers.delete(consumer)
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        if (shared.consumers.size === 0 && !shared.controller.signal.aborted) {
          shared.controller.abort()
        }
        reject(abortError())
      }
      shared.promise.then(
        (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolvePromise(value)
        },
        (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
      )
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  async find(workDir?: string | null, signal?: AbortSignal): Promise<string | null> {
    if (!workDir) return null
    throwIfAborted(signal)
    const cwd = resolve(workDir)
    try {
      await access(cwd)
    } catch {
      return null
    }
    throwIfAborted(signal)
    const key = process.platform === "win32" ? cwd.toLowerCase() : cwd
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    if (cached) this.cache.delete(key)
    const existing = this.inFlight.get(key)
    const shared =
      existing && !existing.controller.signal.aborted ? existing : this.createShared(key, cwd)
    return this.subscribe(shared, signal)
  }

  clear(): void {
    this.cache.clear()
  }

  activeCount(): number {
    return this.inFlight.size
  }
}

const defaultResolver = new MemoryGitRootResolver()

export function findCanonicalGitRootAsync(
  workDir?: string | null,
  signal?: AbortSignal
): Promise<string | null> {
  return defaultResolver.find(workDir, signal)
}

export function clearAsyncGitRootCache(): void {
  defaultResolver.clear()
}
