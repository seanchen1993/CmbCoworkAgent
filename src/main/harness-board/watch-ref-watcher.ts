import { existsSync, statSync, watch, type FSWatcher } from "fs"
import { dirname, resolve } from "path"
import { BrowserWindow } from "electron"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import { markHarnessStageAttributionDirty } from "../services/harness-stage-attribution"

interface WatchEntry {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
}

interface HarnessRunAttributionTarget {
  projectId: string
  featureSlug: string
}

const activeWatchers = new Map<string, WatchEntry[]>()
const DEBOUNCE_MS = 500

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const workspace = resolve(workspacePath)
  const target = resolve(targetPath)
  return target === workspace || target.startsWith(`${workspace}/`)
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

function emitChanged(scopeKey: string, workspacePath: string, ref: HarnessWatchRef): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("harnessBoard:watchRefsChanged", {
      scopeKey,
      workspacePath,
      ref,
      at: new Date().toISOString()
    })
  }
}

export function startHarnessWatchRefs(
  scopeKey: string,
  workspacePath: string,
  refs: HarnessWatchRef[],
  attributionTarget?: HarnessRunAttributionTarget
): void {
  stopHarnessWatchRefs(scopeKey)

  const entries: WatchEntry[] = []
  for (const ref of refs) {
    const watchPath = resolveWatchPath(workspacePath, ref.path)
    if (!watchPath) continue

    try {
      const entry: WatchEntry = {
        watcher: watch(watchPath, { recursive: false }, () => {
          // The Feature page reloads feature_status after any run watch ref
          // changes. Share that same signal with code_gen attribution even when
          // the renderer refresh is still inside its debounce window.
          if (attributionTarget) {
            markHarnessStageAttributionDirty(
              attributionTarget.projectId,
              attributionTarget.featureSlug
            )
          }
          if (entry.timer) {
            clearTimeout(entry.timer)
          }
          entry.timer = setTimeout(() => {
            entry.timer = null
            emitChanged(scopeKey, workspacePath, ref)
          }, DEBOUNCE_MS)
        }),
        timer: null
      }
      entry.watcher.on("error", () => {
        stopHarnessWatchRefs(scopeKey)
      })
      entries.push(entry)
    } catch {
      // Missing or inaccessible watch paths are non-fatal. The page can still use manual refresh.
    }
  }

  if (entries.length > 0) {
    activeWatchers.set(scopeKey, entries)
  }
}

export function stopHarnessWatchRefs(scopeKey: string): void {
  const entries = activeWatchers.get(scopeKey)
  if (!entries) return
  for (const entry of entries) {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.watcher.close()
  }
  activeWatchers.delete(scopeKey)
}

export function stopAllHarnessWatchRefs(): void {
  for (const scopeKey of Array.from(activeWatchers.keys())) {
    stopHarnessWatchRefs(scopeKey)
  }
}
