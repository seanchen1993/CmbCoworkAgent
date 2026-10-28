import type {
  DesignSessionApi,
  DesignSessionSnapshot,
  DesignSessionSeed,
  DesignSessionChange,
  DesignRunRequest,
  SessionMeta,
  TabState
} from "../../../../shared/managed-design-session"
import type { DesignTweakCommand } from "../../../../shared/design-tweaks"

/** One client per renderer, not per DesignView. Sequenced snapshots make reconnect idempotent. */
export class DesignSessionClient {
  private readonly snapshots = new Map<string, DesignSessionSnapshot>()
  private readonly metas = new Map<string, SessionMeta>()
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly opened = new Set<string>()
  private connected = false
  private readonly versions = new Map<string, number>()
  private readonly openVersions = new Map<string, number>()

  constructor(private readonly api: DesignSessionApi) {}

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.api.onChange((change) => this.accept(change))
  }

  private accept(change: DesignSessionChange): void {
    if ((this.versions.get(change.id) ?? -1) > change.seq) return
    if (change.draftHtmlOmitted && change.snapshot?.state.draftPreview) {
      const cached = this.snapshots.get(change.id)?.state.draftPreview
      const draft = change.snapshot.state.draftPreview
      if (!cached || cached.runId !== draft.runId || cached.revision !== draft.revision) {
        if (this.opened.has(change.id))
          void this.api
            .open(change.id)
            .then((snapshot) => this.apply(snapshot))
            .catch(console.error)
        return
      }
      change = {
        ...change,
        snapshot: {
          ...change.snapshot,
          state: { ...change.snapshot.state, draftPreview: { ...draft, html: cached.html } }
        }
      }
    }
    this.versions.set(change.id, change.seq)
    if (change.deleted) {
      this.snapshots.delete(change.id)
      this.metas.delete(change.id)
      this.opened.delete(change.id)
    } else {
      this.metas.set(change.id, change.meta)
      if (change.snapshot) this.snapshots.set(change.id, change.snapshot)
    }
    this.notify()
  }

  private apply(snapshot: DesignSessionSnapshot): DesignSessionSnapshot {
    this.accept({ id: snapshot.id, seq: snapshot.seq, meta: snapshot.meta, snapshot })
    return this.snapshots.get(snapshot.id)!
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get(id: string): DesignSessionSnapshot | undefined {
    return this.snapshots.get(id)
  }
  list(): SessionMeta[] {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async initialize(seeds: DesignSessionSeed[]): Promise<void> {
    this.connect() // Before list/migration/open: live events can race IPC replies.
    const index = await this.api.list()
    for (const meta of index) this.metas.set(meta.id, meta)
    if (seeds.length) {
      const migrated = await this.api.migrate(seeds)
      for (const meta of migrated) this.metas.set(meta.id, meta)
    }
    this.notify()
  }

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve()
    // Failure is visible to the caller and keeps subsequent commands from silently starting a run.
    const next = previous.then(action)
    this.pending.set(id, next)
    void next
      .finally(() => {
        if (this.pending.get(id) === next) this.pending.delete(id)
      })
      .catch(() => undefined)
    return next
  }

  create(seed: DesignSessionSeed): Promise<DesignSessionSnapshot> {
    return this.enqueue(seed.id, async () => this.apply(await this.api.create(seed)))
  }
  async waitUntilReady(id: string): Promise<DesignSessionSnapshot> {
    await this.pending.get(id)
    const snapshot = this.get(id)
    if (!snapshot) throw new Error("设计会话创建失败")
    return snapshot
  }
  patch(
    id: string,
    patch: Partial<TabState>,
    meta?: Partial<SessionMeta>
  ): Promise<DesignSessionSnapshot> {
    return this.enqueue(id, async () => this.apply(await this.api.patch(id, patch, meta)))
  }
  tweak(id: string, command: DesignTweakCommand): Promise<DesignSessionSnapshot> {
    return this.enqueue(id, async () => {
      if (!this.api.tweak) throw new Error("当前应用不支持新版微调，请更新应用")
      const snapshot = this.get(id)
      const finalized =
        command.scope === "draft" &&
        command.runId === snapshot?.state.lastCompletedRunId &&
        !snapshot?.activeRunId
      const state =
        command.scope === "draft" && !finalized
          ? snapshot?.state.draftPreview?.tweaks
          : snapshot?.state.tweaks
      if (
        !state ||
        (command.scope === "draft" &&
          !finalized &&
          snapshot?.state.draftPreview?.runId !== command.runId)
      )
        throw new Error("微调目标已变更")
      return this.apply(await this.api.tweak(id, { ...command, baseRevision: state.revision }))
    })
  }
  previewVisible(id: string, runId: string, revision: number): void {
    void this.api.previewVisible?.(id, runId, revision).catch(console.error)
  }
  patchHistory(id: string, operation: "undo" | "redo"): Promise<DesignSessionSnapshot> {
    return this.enqueue(id, async () => {
      if (!this.api.patchHistory) throw new Error("当前应用不支持局部修改撤销，请重启应用")
      const revision = this.get(id)?.state.artifactRevision ?? 0
      return this.apply(await this.api.patchHistory(id, operation, revision))
    })
  }
  start(request: DesignRunRequest): Promise<DesignSessionSnapshot> {
    return this.enqueue(request.designSessionId, async () =>
      this.apply(await this.api.start(request))
    )
  }
  async open(id: string): Promise<DesignSessionSnapshot> {
    this.opened.add(id)
    const version = (this.openVersions.get(id) ?? 0) + 1
    this.openVersions.set(id, version)
    await this.pending.get(id)
    if (!this.opened.has(id) || this.openVersions.get(id) !== version) throw new Error("会话已切换")
    const snapshot = await this.api.open(id)
    if (!this.opened.has(id) || this.openVersions.get(id) !== version) return snapshot
    return this.apply(snapshot)
  }
  close(id: string): void {
    this.opened.delete(id)
    this.openVersions.set(id, (this.openVersions.get(id) ?? 0) + 1)
    void this.api.close(id).catch(console.error)
  }
  stop(id: string): Promise<DesignSessionSnapshot> {
    return this.enqueue(id, async () => this.apply(await this.api.stop(id)))
  }
  setWorkspace(id: string, path: string): Promise<DesignSessionSnapshot> {
    return this.enqueue(id, async () => this.apply(await this.api.setWorkspace(id, path)))
  }
  retry(id: string, requestId: string): Promise<DesignSessionSnapshot> {
    return this.enqueue(id, async () => this.apply(await this.api.retry(id, requestId)))
  }
  async remove(id: string): Promise<void> {
    await this.enqueue(id, () => this.api.delete(id))
    this.snapshots.delete(id)
    this.metas.delete(id)
    this.notify()
  }
  markRead(id: string, seq: number): void {
    const meta = this.metas.get(id)
    if (meta) meta.unread = false
    void this.api.markRead(id, seq).catch(console.error)
  }
}

let client: DesignSessionClient | undefined
export function getDesignSessionClient(): DesignSessionClient {
  return (client ??= new DesignSessionClient(window.api.design.sessions))
}
