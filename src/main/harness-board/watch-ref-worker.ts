import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { parentPort } from "node:worker_threads"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import {
  HARNESS_WATCH_REF_MAX_REFS,
  HARNESS_WATCH_REF_MAX_SCOPES,
  HARNESS_STAGE_WATCH_MAX_SCOPES,
  type HarnessWatchRefStartRequest,
  type HarnessWatchRefWorkerRequest,
  type HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"

interface WatchEntry {
  close: () => void
}

interface WatchListener {
  changed: (filename: string | Buffer | null) => void
  failed: () => void
}

const sharedWatches = new Map<string, { watcher: FSWatcher; listeners: Set<WatchListener> }>()

function subscribeWatch(path: string, listener: WatchListener): WatchEntry {
  let shared = sharedWatches.get(path)
  if (!shared) {
    const listeners = new Set<WatchListener>()
    const watcher = watch(path, { recursive: false }, (_event, filename) => {
      for (const subscriber of listeners) subscriber.changed(filename)
    })
    shared = { watcher, listeners }
    sharedWatches.set(path, shared)
    watcher.on("error", () => {
      for (const subscriber of [...listeners]) subscriber.failed()
    })
  }
  const subscription = shared
  subscription.listeners.add(listener)
  return {
    close: () => {
      subscription.listeners.delete(listener)
      if (!subscription.listeners.size) {
        subscription.watcher.close()
        if (sharedWatches.get(path) === subscription) sharedWatches.delete(path)
      }
    }
  }
}

interface ActiveScope {
  generation: number
  cancelFlag: Int32Array
  entries: WatchEntry[]
  changeTimer: NodeJS.Timeout | null
  dirtyTimer: NodeJS.Timeout | null
  dirtyAgain: boolean
  dirtyStageAgain: boolean
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
    entry.close()
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
  const existing = activeScopes.get(request.scopeKey)
  if (existing?.generation === request.generation && Atomics.load(existing.cancelFlag, 0) === 0) {
    post({
      type: "installed",
      scopeKey: request.scopeKey,
      generation: request.generation,
      watcherCount: existing.entries.length,
      sharedWatcherCount: sharedWatches.size,
      cancelled: false
    })
    return
  }
  stopScope(request.scopeKey)
  const maxScopes = Math.max(
    1,
    Math.min(request.maxScopes ?? HARNESS_WATCH_REF_MAX_SCOPES, HARNESS_STAGE_WATCH_MAX_SCOPES)
  )
  while (activeScopes.size >= maxScopes) {
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
    const targetPath = resolve(request.workspacePath, ref.path)
    const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
    const targetName = fold(basename(targetPath))

    try {
      const entry = subscribeWatch(watchPath, {
        changed: (filename) => {
          const active = activeScopes.get(request.scopeKey)
          if (
            !active ||
            active.generation !== request.generation ||
            Atomics.load(cancelFlag, 0) !== 0
          ) {
            return
          }
          if (watchPath !== targetPath && filename && fold(filename.toString()) !== targetName)
            return
          const stateChanged = ref.purpose === "run-state"
          const attributionTarget = request.attributionTarget
          if (attributionTarget) {
            const notifyDirty = (stageChanged: boolean) =>
              post({
                type: "dirty",
                scopeKey: request.scopeKey,
                generation: request.generation,
                attributionTarget,
                stageChanged
              })
            if (active.dirtyTimer) {
              active.dirtyAgain = true
              active.dirtyStageAgain ||= stateChanged
            } else {
              notifyDirty(stateChanged)
              active.dirtyTimer = setTimeout(() => {
                active.dirtyTimer = null
                if (active.dirtyAgain) notifyDirty(active.dirtyStageAgain)
                active.dirtyAgain = false
                active.dirtyStageAgain = false
              }, 100)
            }
          }
          if (request.notifyChanges === false) return
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
        },
        failed: () => {
          // Several refs can share this directory. Closing the first listener
          // removes the scope; notify its failure only once.
          if (activeScopes.get(request.scopeKey)?.generation !== request.generation) return
          stopScope(request.scopeKey, request.generation)
          post({
            type: "installed",
            scopeKey: request.scopeKey,
            generation: request.generation,
            watcherCount: 0,
            sharedWatcherCount: sharedWatches.size,
            cancelled: false
          })
        }
      })
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
      dirtyAgain: false,
      dirtyStageAgain: false,
      latestRef: null
    })
  }
  post({
    type: "installed",
    scopeKey: request.scopeKey,
    generation: request.generation,
    watcherCount: cancelled ? 0 : entries.length,
    sharedWatcherCount: sharedWatches.size,
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
