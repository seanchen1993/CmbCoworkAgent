import fs from "node:fs/promises"
import path from "node:path"
import { AsyncRWLock } from "./async-lock"

type Access = "read" | "write"
type Entry = { lock: AsyncRWLock; users: number }
type WorkspaceAccess = "file-read" | "file-write" | "scan" | "exclusive"

/** Compatible groups overlap, but queued incompatible work cannot be starved. */
class WorkspaceLock {
  private active: Record<WorkspaceAccess, number> = {
    "file-read": 0,
    "file-write": 0,
    scan: 0,
    exclusive: 0
  }
  private queue: Array<{ access: WorkspaceAccess; grant: () => void }> = []

  private compatible(access: WorkspaceAccess): boolean {
    if (this.active.exclusive > 0) return false
    if (access === "exclusive") return Object.values(this.active).every((count) => count === 0)
    if (access === "scan") return this.active["file-write"] === 0
    if (access === "file-write") return this.active.scan === 0
    return true
  }

  private drain(): void {
    while (this.queue.length > 0 && this.compatible(this.queue[0].access)) {
      this.queue.shift()!.grant()
    }
  }

  private acquire(access: WorkspaceAccess, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.queue.length === 0 && this.compatible(access)) {
      this.active[access]++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(waiter)
        if (index < 0) return
        this.queue.splice(index, 1)
        signal?.removeEventListener("abort", onAbort)
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
        this.drain()
      }
      const waiter = {
        access,
        grant: () => {
          signal?.removeEventListener("abort", onAbort)
          this.active[access]++
          resolve()
        }
      }
      this.queue.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  async run<T>(access: WorkspaceAccess, operation: () => Promise<T>, signal?: AbortSignal) {
    await this.acquire(access, signal)
    try {
      signal?.throwIfAborted()
      return await operation()
    } finally {
      this.active[access]--
      this.drain()
    }
  }
}

// Shared across sandbox instances and workflow scripts. Entries include queued
// callers and are removed only after the last holder/waiter has settled.
const fileLocks = new Map<string, Entry>()
const workspaceLocks = new Map<string, { lock: WorkspaceLock; users: number }>()

async function resourceKey(target: string, linkDepth = 0): Promise<string> {
  if (linkDepth >= 40) throw new Error("Too many symbolic links while resolving resource")
  let ancestor = path.resolve(target)
  const suffix: string[] = []
  for (;;) {
    try {
      const canonical = path.join(await fs.realpath(ancestor), ...suffix)
      return process.platform === "win32" ? canonical.toLowerCase() : canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // realpath also reports ENOENT for a dangling link. Resolve its target
      // before walking upwards, so alias/new and target/new share admission.
      try {
        if ((await fs.lstat(ancestor)).isSymbolicLink()) {
          const target = path.resolve(
            path.dirname(ancestor),
            await fs.readlink(ancestor),
            ...suffix
          )
          return resourceKey(target, linkDepth + 1)
        }
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError
      }
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}

async function fileResourceKey(target: string): Promise<string> {
  const canonical = await resourceKey(target)
  try {
    const stat = await fs.stat(target, { bigint: true })
    // realpath resolves symlinks, but distinct hard-link paths share an inode.
    // Keep single-link/new files path-keyed so creation does not change the key.
    if (stat.isFile() && stat.nlink > 1n && stat.ino !== 0n) {
      return `inode:${stat.dev}:${stat.ino}`
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return canonical
}

async function withLock<T>(
  entries: Map<string, Entry>,
  key: string,
  access: Access,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  let entry = entries.get(key)
  if (!entry) {
    entry = { lock: new AsyncRWLock(), users: 0 }
    entries.set(key, entry)
  }
  entry.users++
  try {
    return await entry.lock[access](operation, signal)
  } finally {
    if (--entry.users === 0) entries.delete(key)
  }
}

async function withWorkspaceAccess<T>(
  workspace: string,
  access: WorkspaceAccess,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  const key = await resourceKey(workspace)
  let entry = workspaceLocks.get(key)
  if (!entry) {
    entry = { lock: new WorkspaceLock(), users: 0 }
    workspaceLocks.set(key, entry)
  }
  entry.users++
  try {
    return await entry.lock.run(access, operation, signal)
  } finally {
    if (--entry.users === 0) workspaceLocks.delete(key)
  }
}

/** Scans coexist with other readers, but exclude writes whose files they may read. */
export async function withWorkspaceExecution<T>(
  workspace: string,
  access: Access,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withWorkspaceAccess(workspace, access === "read" ? "scan" : "exclusive", operation, signal)
}

/** Acquire in workspace -> file order, after hooks and approval resolve the target. */
export async function withFileOperation<T>(
  workspace: string,
  filePath: string,
  access: Access,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withWorkspaceAccess(
    workspace,
    access === "read" ? "file-read" : "file-write",
    async () => {
      const key = await fileResourceKey(filePath)
      return withLock(
        fileLocks,
        key,
        access,
        async () => {
          // A queued path can be replaced by a symlink. Do not touch its new
          // target under the old target's lock; let the caller retry resolution.
          if ((await fileResourceKey(filePath)) !== key) {
            throw new Error("File path changed while waiting for access; retry the operation.")
          }
          signal?.throwIfAborted()
          return operation()
        },
        signal
      )
    },
    signal
  )
}
