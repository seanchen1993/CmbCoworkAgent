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
  retryAt?: number
}

interface StageWatchConfiguration {
  workspacePath: string
  refs: HarnessWatchRef[]
  signature: string
}

const FAILED_INSTALL_RETRY_MS = 30_000

/** Session-side state notifications, independent of the Feature page's watchers.
 * All filesystem probes and watcher installation stay in the existing worker.
 */
export class HarnessStageWatchRegistry {
  private readonly scopes = new Map<string, StageWatch>()
  private readonly configurations = new Map<string, StageWatchConfiguration>()
  private readonly client: HarnessWatchRefWorkerClient
  private closed = false

  constructor(
    private readonly onChanged: (projectId: string, featureSlug: string) => void,
    workerFactory?: () => Promise<Worker>,
    private readonly idleMs = 10 * 60_000
  ) {
    this.client = new HarnessWatchRefWorkerClient(
      {
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
    if (this.closed || !projectId.trim() || !featureSlug.trim()) return
    const key = JSON.stringify([projectId, featureSlug])
    const stateRefs = refs.filter((ref) => ref.purpose === "run-state").slice(0, 16)
    if (!stateRefs.length) {
      this.configurations.delete(key)
      this.remove(key)
      return
    }
    const signature = JSON.stringify([workspacePath, stateRefs.map((ref) => ref.path)])
    if (this.configurations.get(key)?.signature === signature) return
    const wasActive = this.scopes.has(key)
    this.remove(key)
    this.configurations.delete(key)
    const config = {
      workspacePath,
      refs: stateRefs.map((ref) => ({ ...ref })),
      signature
    }
    this.configurations.set(key, config)
    if (this.configurations.size > HARNESS_STAGE_WATCH_MAX_SCOPES) {
      this.configurations.delete(this.configurations.keys().next().value!)
    }
    if (wasActive) {
      void this.install(projectId, featureSlug, key, config)
      this.onChanged(projectId, featureSlug)
    }
  }

  activate(projectId: string, featureSlug: string): void | Promise<void> {
    if (this.closed) return
    const key = JSON.stringify([projectId, featureSlug])
    const config = this.configurations.get(key)
    if (!config?.refs.length) return
    const scope = this.scopes.get(key)
    if (scope && this.canReuse(scope, config.signature)) {
      scope.touch()
      this.scopes.delete(key)
      this.scopes.set(key, scope)
      return scope.watcherCount === undefined ? scope.ready : undefined
    }
    const installing = this.install(projectId, featureSlug, key, config)
    // The page snapshot may predate this install. Invalidate before yielding so
    // concurrent readers also recover once after the gap.
    this.onChanged(projectId, featureSlug)
    return installing
  }

  configure(
    projectId: string,
    featureSlug: string,
    workspacePath: string,
    refs: HarnessWatchRef[]
  ): Promise<void> {
    if (this.closed || !projectId.trim() || !featureSlug.trim()) return Promise.resolve()
    this.remember(projectId, featureSlug, workspacePath, refs)
    const key = JSON.stringify([projectId, featureSlug])
    const config = this.configurations.get(key)
    return config ? this.install(projectId, featureSlug, key, config) : Promise.resolve()
  }

  private canReuse(scope: StageWatch, signature: string): boolean {
    return (
      scope.signature === signature &&
      (scope.watcherCount !== 0 || Date.now() < (scope.retryAt ?? 0))
    )
  }

  private install(
    projectId: string,
    featureSlug: string,
    key: string,
    { workspacePath, refs: stateRefs, signature }: StageWatchConfiguration
  ): Promise<void> {
    const previous = this.scopes.get(key)
    // Reuse the installed scope. No timers launch inspect or poll files.
    if (previous && this.canReuse(previous, signature)) {
      previous.touch()
      this.scopes.delete(key)
      this.scopes.set(key, previous)
      return previous.ready
    }
    this.remove(key)
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
        scope.retryAt = count === 0 ? Date.now() + FAILED_INSTALL_RETRY_MS : undefined
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
    return ready
  }

  private remove(key: string): void {
    const scope = this.scopes.get(key)
    if (!scope) return
    this.scopes.delete(key)
    scope.dispose()
    this.client.stop(key)
  }

  async close(): Promise<void> {
    this.closed = true
    this.configurations.clear()
    for (const key of this.scopes.keys()) this.remove(key)
    await this.client.close()
  }
}
