import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { parentPort } from "node:worker_threads"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import {
  HARNESS_WATCH_REF_MAX_REFS,
  HARNESS_WATCH_REF_MAX_SCOPES,
  type HarnessWatchRefStartRequest,
  type HarnessWatchRefWorkerRequest,
  type HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"

interface WatchEntry {
  watcher: FSWatcher
}

interface ActiveScope {
  generation: number
  cancelFlag: Int32Array
  entries: WatchEntry[]
  changeTimer: NodeJS.Timeout | null
  dirtyTimer: NodeJS.Timeout | null
  latestRef: HarnessWatchRef | null
}

if (!parentPort) throw new Error("Harness watch-ref worker requires a parent port")
const workerPort = parentPort

const DEBOUNCE_MS = 500
const activeScopes = new Map<string, ActiveScope>()

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(workspacePath), resolve(targetPath))
  return (
    relativePath === "" ||
    (Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

function resolveWatchPath(workspacePath: string, refPath: string): string | null {
  const target = resolve(workspacePath, refPath)
  if (!isInsideWorkspace(workspacePath, target)) return null
  if (existsSync(target)) {
    try {
      const stats = statSync(target)
      return stats.isDirectory() ? target : dirname(target)
    } catch {
      return null
    }
  }

  const parent = dirname(target)
  if (!isInsideWorkspace(workspacePath, parent) || !existsSync(parent)) return null
  return parent
}

function isCancelled(request: HarnessWatchRefStartRequest): boolean {
  return Atomics.load(new Int32Array(request.cancelBuffer), 0) !== 0
}

function closeEntries(entries: WatchEntry[]): void {
  for (const entry of entries) {
    entry.watcher.close()
  }
}

function stopScope(scopeKey: string, generation?: number): void {
  const active = activeScopes.get(scopeKey)
  if (!active || (generation !== undefined && active.generation > generation)) return
  activeScopes.delete(scopeKey)
  Atomics.store(active.cancelFlag, 0, 1)
  if (active.changeTimer) clearTimeout(active.changeTimer)
  if (active.dirtyTimer) clearTimeout(active.dirtyTimer)
  closeEntries(active.entries)
}

function stopAll(): void {
  for (const scopeKey of [...activeScopes.keys()]) stopScope(scopeKey)
}

function post(response: HarnessWatchRefWorkerResponse): void {
  workerPort.postMessage(response)
}

function startScope(request: HarnessWatchRefStartRequest): void {
  stopScope(request.scopeKey)
  while (activeScopes.size >= HARNESS_WATCH_REF_MAX_SCOPES) {
    const oldestScope = activeScopes.keys().next().value as string | undefined
    if (!oldestScope) break
    stopScope(oldestScope)
  }
  const cancelFlag = new Int32Array(request.cancelBuffer)
  const entries: WatchEntry[] = []
  const refs = request.refs.slice(0, HARNESS_WATCH_REF_MAX_REFS)

  for (const ref of refs) {
    if (isCancelled(request)) break
    const watchPath = resolveWatchPath(request.workspacePath, ref.path)
    if (isCancelled(request)) break
    if (!watchPath) continue

    try {
      const entry: WatchEntry = {
        watcher: watch(watchPath, { recursive: false }, () => {
          const active = activeScopes.get(request.scopeKey)
          if (
            !active ||
            active.generation !== request.generation ||
            Atomics.load(cancelFlag, 0) !== 0
          ) {
            return
          }
          if (request.attributionTarget && !active.dirtyTimer) {
            post({
              type: "dirty",
              scopeKey: request.scopeKey,
              generation: request.generation,
              attributionTarget: request.attributionTarget
            })
            active.dirtyTimer = setTimeout(() => {
              active.dirtyTimer = null
            }, 100)
          }
          active.latestRef = ref
          if (active.changeTimer) clearTimeout(active.changeTimer)
          active.changeTimer = setTimeout(() => {
            active.changeTimer = null
            const latest = activeScopes.get(request.scopeKey)
            if (
              !latest ||
              latest.generation !== request.generation ||
              Atomics.load(cancelFlag, 0) !== 0
            ) {
              return
            }
            const latestRef = latest.latestRef
            if (!latestRef) return
            post({
              type: "changed",
              scopeKey: request.scopeKey,
              generation: request.generation,
              workspacePath: request.workspacePath,
              ref: latestRef,
              at: new Date().toISOString()
            })
          }, DEBOUNCE_MS)
        })
      }
      entry.watcher.on("error", () => stopScope(request.scopeKey, request.generation))
      entries.push(entry)
    } catch {
      // Missing or inaccessible watch paths are non-fatal. Manual refresh remains available.
    }
  }

  const cancelled = isCancelled(request)
  if (cancelled) {
    closeEntries(entries)
  } else if (entries.length > 0) {
    activeScopes.set(request.scopeKey, {
      generation: request.generation,
      cancelFlag,
      entries,
      changeTimer: null,
      dirtyTimer: null,
      latestRef: null
    })
  }
  post({
    type: "installed",
    scopeKey: request.scopeKey,
    generation: request.generation,
    watcherCount: cancelled ? 0 : entries.length,
    cancelled
  })
}

workerPort.on("message", (request: HarnessWatchRefWorkerRequest) => {
  if (request.type === "start") {
    startScope(request)
    return
  }
  if (request.type === "stop") {
    stopScope(request.scopeKey, request.generation)
    post({ type: "stopped", scopeKey: request.scopeKey, generation: request.generation })
    return
  }
  if (request.type === "stop-all") {
    stopAll()
    return
  }
  stopAll()
  post({ type: "shutdown-complete" })
})
