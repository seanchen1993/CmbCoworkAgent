import type { Worker } from "node:worker_threads"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import { HarnessWatchRefWorkerClient } from "../harness-board/watch-ref-client"
import { HARNESS_STAGE_WATCH_MAX_SCOPES } from "../harness-board/watch-ref-protocol"

interface StageWatch {
  signature: string
  ready: Promise<void>
  installed: (count: number) => void
  touch: () => void
  dispose: () => void
  watcherCount?: number
}

/** Session-side state notifications, independent of the Feature page's watchers.
 * All filesystem probes and watcher installation stay in the existing worker.
 */
export class HarnessStageWatchRegistry {
  private readonly scopes = new Map<string, StageWatch>()
  private readonly configurations = new Map<
    string,
    { workspacePath: string; refs: HarnessWatchRef[] }
  >()
  private readonly client: HarnessWatchRefWorkerClient

  constructor(
    private readonly onChanged: (projectId: string, featureSlug: string) => void,
    workerFactory?: () => Promise<Worker>,
    private readonly idleMs = 10 * 60_000
  ) {
    this.client = new HarnessWatchRefWorkerClient(
      {
        onChanged: () => undefined,
        onDirty: ({ attributionTarget }) =>
          onChanged(attributionTarget.projectId, attributionTarget.featureSlug),
        onInstalled: ({ scopeKey, watcherCount }) =>
          this.scopes.get(scopeKey)?.installed(watcherCount)
      },
      workerFactory,
      HARNESS_STAGE_WATCH_MAX_SCOPES
    )
  }

  // Page refreshes can supply paths without starting a conversation watcher.
  remember(
    projectId: string,
    featureSlug: string,
    workspacePath: string,
    refs: HarnessWatchRef[]
  ): void {
    if (!projectId.trim() || !featureSlug.trim()) return
    const key = JSON.stringify([projectId, featureSlug])
    this.configurations.delete(key)
    this.configurations.set(key, {
      workspacePath,
      refs: refs.filter((ref) => ref.purpose === "run-state").slice(0, 16)
    })
    if (this.configurations.size > HARNESS_STAGE_WATCH_MAX_SCOPES) {
      this.configurations.delete(this.configurations.keys().next().value!)
    }
  }

  async activate(projectId: string, featureSlug: string): Promise<void> {
    const key = JSON.stringify([projectId, featureSlug])
    const config = this.configurations.get(key)
    if (!config?.refs.length) return
    const scope = this.scopes.get(key)
    if (scope?.signature === JSON.stringify([config.workspacePath, config.refs])) {
      scope.touch()
      await scope.ready
      return
    }
    const installing = this.configure(projectId, featureSlug, config.workspacePath, config.refs)
    // The page snapshot may predate this install. Invalidate before yielding so
    // concurrent readers also recover once after the gap.
    this.onChanged(projectId, featureSlug)
    await installing
  }

  async configure(
    projectId: string,
    featureSlug: string,
    workspacePath: string,
    refs: HarnessWatchRef[]
  ): Promise<void> {
    if (!projectId.trim() || !featureSlug.trim()) return
    this.remember(projectId, featureSlug, workspacePath, refs)
    const key = JSON.stringify([projectId, featureSlug])
    const stateRefs = refs.filter((ref) => ref.purpose === "run-state").slice(0, 16)
    const signature = JSON.stringify([workspacePath, stateRefs])
    const previous = this.scopes.get(key)
    // Reuse the installed scope. No timers launch inspect or poll files.
    if (previous?.signature === signature && previous.watcherCount !== 0) {
      previous.touch()
      this.scopes.delete(key)
      this.scopes.set(key, previous)
      return previous.ready
    }
    this.remove(key)
    if (!stateRefs.length) return
    while (this.scopes.size >= HARNESS_STAGE_WATCH_MAX_SCOPES) {
      this.remove(this.scopes.keys().next().value!)
    }
    let done!: () => void
    let timedOut = false
    const ready = new Promise<void>((resolve) => {
      done = resolve
    })
    const installTimeout = setTimeout(() => {
      timedOut = true
      done()
    }, 1_000)
    installTimeout.unref()
    let expiry = setTimeout(() => this.remove(key), this.idleMs)
    let expiresAt = Date.now() + this.idleMs
    expiry.unref()
    const scope: StageWatch = {
      signature,
      ready,
      touch: () => {
        if (Date.now() < expiresAt - this.idleMs / 2) return
        clearTimeout(expiry)
        expiry = setTimeout(() => this.remove(key), this.idleMs)
        expiresAt = Date.now() + this.idleMs
        expiry.unref()
      },
      installed: (count) => {
        scope.watcherCount = count
        clearTimeout(installTimeout)
        // A late install or worker restart may have missed changes. Invalidate
        // once so the next consumer recovers; never inspect inside this callback.
        if (timedOut || scopeInstalled) this.onChanged(projectId, featureSlug)
        scopeInstalled = true
        done()
      },
      dispose: () => {
        clearTimeout(installTimeout)
        clearTimeout(expiry)
        done()
      }
    }
    let scopeInstalled = false
    this.scopes.set(key, scope)
    this.client.start(key, workspacePath, stateRefs, { projectId, featureSlug })
    await ready
  }

  private remove(key: string): void {
    const scope = this.scopes.get(key)
    if (!scope) return
    this.scopes.delete(key)
    scope.dispose()
    this.client.stop(key)
  }

  async close(): Promise<void> {
    this.configurations.clear()
    for (const key of this.scopes.keys()) this.remove(key)
    await this.client.close()
  }
}
