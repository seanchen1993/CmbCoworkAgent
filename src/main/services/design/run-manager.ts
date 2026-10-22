import { randomUUID } from "node:crypto"
import {
  makeDesignAgentThreadId,
  DESIGN_UI_FIELDS,
  appendDesignExecutionEvent,
  asDesignModelRetryState,
  createDesignProgressNormalizer,
  normalizeQuestionDef,
  buildNewDesignPrompt,
  type DesignRunRequest,
  type DesignRunEvent,
  type DesignSessionSnapshot,
  type DesignSessionSeed,
  type DesignSessionChange,
  type TabState,
  type SessionMeta
} from "../../../shared/managed-design-session"
import type { DesignSessionStore } from "./session-store"

interface ActiveRun {
  id: string
  request: DesignRunRequest
  normalize: (token: string) => string
  pending: DesignRunEvent[]
  timer?: ReturnType<typeof setTimeout>
  snapshot?: DesignSessionSnapshot
}

export interface DesignRunDependencies {
  execute: (
    request: DesignRunRequest,
    runId: string,
    emit: (event: DesignRunEvent) => void,
    snapshot: DesignSessionSnapshot
  ) => Promise<void>
  abort: (runId: string) => void
  finalize: (
    event: DesignRunEvent,
    request: DesignRunRequest,
    snapshot: DesignSessionSnapshot
  ) => DesignRunEvent
  publish: (change: DesignSessionChange) => void
  maxConcurrent?: number
}

const clone = <T>(value: T): T => structuredClone(value)
const busy = (state: TabState): boolean =>
  state.generationState === "generating" || state.generationState === "asking"

/** Owns runs even with zero subscribers. All mutations are serialized on the main event loop. */
export class DesignRunManager {
  private readonly sessions = new Map<string, DesignSessionSnapshot>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly queue: Array<() => void> = []
  private executing = 0

  constructor(
    private readonly store: DesignSessionStore,
    private readonly deps: DesignRunDependencies
  ) {
    for (const snapshot of store.list()) {
      this.sessions.set(snapshot.id, snapshot)
      if (snapshot.activeRunId || busy(snapshot.state)) {
        const next = clone(snapshot)
        const oldRun = next.activeRunId
        next.activeRunId = null
        next.state.generationState = "interrupted"
        next.state.pendingApproval = null
        for (const message of next.state.messages) message.isStreaming = false
        next.state.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: "应用已退出，本次生成已中断。已保留生成记录，可以重试。"
        })
        this.commit(
          next,
          [{ type: "interrupted" }],
          undefined,
          oldRun ? { id: oldRun, status: "interrupted" } : undefined
        )
      }
    }
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
      .map((snapshot) => ({
        ...snapshot.meta,
        generationState: snapshot.state.pendingApproval
          ? "waiting_approval"
          : snapshot.state.generationState,
        unread: snapshot.lastSeenSeq < (snapshot.meta.lastActivitySeq ?? 0)
      }))
  }

  get(id: string): DesignSessionSnapshot {
    const snapshot = this.sessions.get(id)
    if (!snapshot) throw new Error("设计会话不存在")
    return clone(snapshot)
  }

  create(seed: DesignSessionSeed): DesignSessionSnapshot {
    if (this.sessions.has(seed.id)) return this.get(seed.id)
    if (this.store.wasDeleted(seed.id)) throw new Error("设计会话已删除")
    if (!/^ds_[a-zA-Z0-9_-]+$/.test(seed.id)) throw new Error("设计会话 ID 无效")
    const state = clone(seed.state)
    state.messages = (state.messages ?? []).map((message) => ({
      ...message,
      id: message.id || randomUUID(),
      isStreaming: false
    }))
    if (busy(state)) state.generationState = "interrupted"
    state.pendingApproval = null
    return this.commit({ ...clone(seed), state, seq: 0, activeRunId: null, lastSeenSeq: 0 }, [
      { type: "created" }
    ])
  }

  migrate(seeds: DesignSessionSeed[]): SessionMeta[] {
    for (const seed of seeds) if (!this.store.wasDeleted(seed.id)) this.create(seed)
    return this.list()
  }

  patch(id: string, patch: Partial<TabState>, meta?: Partial<SessionMeta>): DesignSessionSnapshot {
    const next = this.get(id)
    const updates = clone(patch)
    if (next.activeRunId) {
      for (const key of Object.keys(updates) as Array<keyof TabState>) {
        if (!(DESIGN_UI_FIELDS as readonly string[]).includes(key)) delete updates[key]
      }
    }
    // Runtime-owned state cannot be manufactured by a UI patch.
    delete updates.pendingApproval
    if (updates.generationState === "generating" || updates.generationState === "asking")
      delete updates.generationState
    next.state = { ...next.state, ...updates }
    next.state.messages = next.state.messages.map((message) => ({
      ...message,
      id: message.id || randomUUID()
    }))
    if (meta) next.meta = { ...next.meta, ...meta, id }
    return this.commit(next, [{ type: "edited", fields: Object.keys(updates) }])
  }

  start(request: DesignRunRequest): DesignSessionSnapshot {
    const previous = this.store.findRequest(request.requestId)
    if (previous) {
      if (previous.sessionId !== request.designSessionId)
        throw new Error("请求已属于另一个设计会话")
      return this.get(previous.sessionId)
    }
    const next = this.get(request.designSessionId)
    if (next.activeRunId) throw new Error("当前设计仍在运行，请先停止或等待完成")
    const run: ActiveRun = {
      id: randomUUID(),
      request: clone(request),
      normalize: createDesignProgressNormalizer(),
      pending: []
    }
    next.activeRunId = run.id
    next.state.pendingApproval = null
    next.state.generationState = request.kind === "questions" ? "asking" : "generating"
    next.state.rightTab = request.kind === "questions" ? "questions" : "design"
    next.state.originalPrompt =
      request.kind === "questions" ? request.prompt : next.state.originalPrompt
    next.state.retryPrompt = request.prompt
    next.state.retryIsIteration = !!request.isIteration
    next.state.retryCleanMsg = request.cleanUserMsg ?? null
    next.state.retrySkill = request.skill ?? null
    next.state.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: "",
      isStreaming: true,
      isIteration: request.isIteration,
      executionEvents: []
    })
    // Commit the user input and placeholder before any model/tool execution.
    const result = this.commit(next, [{ type: "run_started", runId: run.id }], request)
    run.snapshot = clone(result)
    this.active.set(next.id, run)
    this.queue.push(() => this.execute(run))
    this.drain()
    return result
  }

  private drain(): void {
    while (this.executing < (this.deps.maxConcurrent ?? 2) && this.queue.length)
      this.queue.shift()!()
  }

  private execute(run: ActiveRun): void {
    if (this.active.get(run.request.designSessionId) !== run) return
    this.executing++
    void Promise.resolve()
      .then(() => {
        if (this.active.get(run.request.designSessionId) !== run) return
        return this.deps.execute(
          run.request,
          run.id,
          (event) => this.receive(run, event),
          run.snapshot!
        )
      })
      .catch((error) => {
        this.receive(run, {
          type: "error",
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        if (this.active.get(run.request.designSessionId) === run) {
          this.receive(run, { type: "error", error: "生成任务未返回结果，请重试。" })
        }
        this.executing--
        this.drain()
      })
  }

  private receive(run: ActiveRun, event: DesignRunEvent): void {
    if (this.active.get(run.request.designSessionId) !== run) return
    run.pending.push(clone(event))
    if (
      ["done", "error", "cancelled", "interrupted", "approval", "approval_resolved"].includes(
        event.type
      )
    ) {
      try {
        this.flush(run)
      } catch (error) {
        this.persistenceFailed(run, error)
      }
    } else if (!run.timer) {
      run.timer = setTimeout(() => {
        run.timer = undefined
        try {
          this.flush(run)
        } catch (error) {
          this.persistenceFailed(run, error)
        }
      }, 100)
    }
  }

  private persistenceFailed(run: ActiveRun, error: unknown): void {
    if (run.timer) clearTimeout(run.timer)
    this.active.delete(run.request.designSessionId)
    this.deps.abort(run.id)
    console.error("[Design] Failed to persist background messages", error)
    // Keep the durable snapshot intact, but show an actionable error while storage is unavailable.
    const next = this.get(run.request.designSessionId)
    next.seq++
    next.activeRunId = null
    next.state.generationState = "error"
    next.state.pendingApproval = null
    const message = next.state.messages.at(-1)
    if (message?.role === "assistant") {
      message.content = `生成记录保存失败，任务已停止：${error instanceof Error ? error.message : String(error)}`
      message.isStreaming = false
      message.modelRetry = null
    }
    next.meta.generationState = "error"
    this.sessions.set(next.id, clone(next))
    this.deps.publish({ id: next.id, seq: next.seq, meta: next.meta, snapshot: next })
  }

  private flush(run: ActiveRun): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = undefined
    if (this.active.get(run.request.designSessionId) !== run || !run.pending.length) return
    const events = run.pending.slice()
    const next = this.get(run.request.designSessionId)
    const state = next.state
    const assistant = state.messages[state.messages.length - 1]
    let terminal = false
    let continueGenerating = false
    for (let event of events) {
      if (terminal) break
      if (event.type === "token" && event.token) {
        const text = run.normalize(event.token)
        if (text)
          assistant.executionEvents = appendDesignExecutionEvent(assistant.executionEvents ?? [], {
            kind: "assistant_text",
            id: "assistant-progress",
            content: text,
            status: "running",
            timestamp: Date.now()
          })
      } else if (event.type === "execution" && event.event) {
        assistant.executionEvents = appendDesignExecutionEvent(
          assistant.executionEvents ?? [],
          event.event as NonNullable<typeof assistant.executionEvents>[number]
        )
      } else if (event.type === "model_retry") {
        assistant.modelRetry = asDesignModelRetryState(event)
      } else if (event.type === "model_retry_clear") {
        assistant.modelRetry = null
      } else if (event.type === "approval") {
        state.pendingApproval = event.event as TabState["pendingApproval"]
      } else if (event.type === "approval_resolved") {
        state.pendingApproval = null
      } else if (event.type === "done") {
        if (run.request.kind === "questions") {
          state.questions = (event.questions ?? [])
            .map(normalizeQuestionDef)
            .filter((q) => q !== null)
          state.answers = {}
          state.generationState = "questions_ready"
          assistant.role = "questions-prompt"
          assistant.content = "请补充相关问题 →"
          continueGenerating = !!state.selectedDesignSystemId && state.questions.length <= 1
          if (continueGenerating) {
            assistant.role = "assistant"
            assistant.content = "需求已整理，正在生成设计。"
            state.questions = []
          }
        } else {
          try {
            event = this.deps.finalize(event, run.request, run.snapshot!)
            if (!event.html?.trim()) throw new Error("生成没有返回有效设计")
            state.html = event.html
            state.artifactPath = event.artifactPath ?? state.artifactPath
            state.artifactMetadata = event.metadata ?? state.artifactMetadata
            state.variations = [] // DOM-specific preview documents are derived by the view.
            state.activeVariationId = null
            state.reloadKey++
            state.generationState = "done"
            assistant.content = run.request.isIteration ? "✓ 设计已更新" : "✓ 设计已生成"
            if (run.request.cleanUserMsg)
              state.apiHistory = [
                ...(state.apiHistory ?? []),
                { role: "user", content: run.request.cleanUserMsg },
                { role: "assistant", content: assistant.content }
              ]
          } catch (error) {
            event = { type: "error", error: error instanceof Error ? error.message : String(error) }
          }
        }
        terminal = true
      }
      if (event.type === "error" || event.type === "cancelled" || event.type === "interrupted") {
        if (run.request.rollback) Object.assign(state, clone(run.request.rollback))
        state.generationState =
          event.type === "interrupted"
            ? "interrupted"
            : event.type === "cancelled"
              ? "cancelled"
              : "error"
        assistant.content =
          event.type === "interrupted"
            ? "应用已退出，本次生成已中断。已保留生成记录，可以重试。"
            : event.type === "cancelled"
              ? "已停止生成，已保留现有记录。"
              : `${run.request.rollback ? "❌ 修改失败，已保留修改前版本。" : "❌"} ${event.error ?? "生成失败"}`
        terminal = true
      }
    }
    if (terminal) {
      assistant.isStreaming = false
      assistant.modelRetry = null
      state.pendingApproval = null
      next.activeRunId = null
    }
    this.commit(
      next,
      events,
      undefined,
      terminal ? { id: run.id, status: state.generationState } : undefined
    )
    run.pending.splice(0, events.length)
    if (terminal) {
      this.active.delete(next.id)
      if (continueGenerating) {
        this.start({
          ...run.request,
          requestId: `${run.request.requestId}:generate`,
          kind: "agent",
          prompt: buildNewDesignPrompt(
            `${run.request.prompt}\n\n---\nNo clarifying answers were collected because the active design system already fixes visual direction.`,
            { designSystemId: state.selectedDesignSystemId }
          ),
          cleanUserMsg: run.request.prompt
        })
      }
    }
  }

  stop(id: string): DesignSessionSnapshot {
    const run = this.active.get(id)
    if (run) {
      this.receive(run, { type: "cancelled" })
      this.deps.abort(run.id)
    }
    return this.get(id)
  }

  retry(id: string, requestId: string): DesignSessionSnapshot {
    const request = this.store.latestRequest(id)
    if (!request) throw new Error("没有可重试的生成任务")
    return this.start({ ...request, requestId, freshAgentThread: request.kind === "agent" })
  }

  setWorkspace(id: string, path: string): DesignSessionSnapshot {
    const next = this.get(id)
    if (next.activeRunId) throw new Error("设计运行中无法切换工作目录，请先停止任务")
    if (!path.trim()) throw new Error("工作目录不能为空")
    next.workspacePath = path
    return this.commit(next, [{ type: "edited", fields: ["workspacePath"] }])
  }

  interruptAll(): void {
    for (const run of [...this.active.values()]) {
      this.receive(run, { type: "interrupted" })
      this.deps.abort(run.id)
    }
  }

  approval(threadId: string, request: TabState["pendingApproval"]): void {
    for (const run of this.active.values()) {
      const snapshot = this.sessions.get(run.request.designSessionId)!
      const base = makeThreadId(run)
      if (threadId !== base && !threadId.startsWith(`${base}_`)) continue
      if (
        snapshot.state.pendingApproval?._orchestratorRequestId === request?._orchestratorRequestId
      )
        continue
      this.receive(run, { type: request ? "approval" : "approval_resolved", event: request })
    }
  }

  approvalRemoved(requestId: string): void {
    for (const run of this.active.values()) {
      if (
        this.sessions.get(run.request.designSessionId)?.state.pendingApproval
          ?._orchestratorRequestId === requestId
      ) {
        this.receive(run, { type: "approval_resolved" })
      }
    }
  }

  markRead(id: string, seq: number): void {
    const next = this.get(id)
    next.lastSeenSeq = Math.min(next.seq, Math.max(next.lastSeenSeq, seq))
    next.meta.unread = next.lastSeenSeq < (next.meta.lastActivitySeq ?? 0)
    this.store.save(next, [])
    this.sessions.set(id, next)
  }

  remove(id: string): void {
    this.stop(id)
    const seq = this.get(id).seq + 1
    this.store.remove(id)
    this.sessions.delete(id)
    this.deps.publish({
      id,
      seq,
      meta: { id, title: "", createdAt: 0, updatedAt: 0 },
      deleted: true
    })
  }

  private commit(
    next: DesignSessionSnapshot,
    events: unknown[],
    request?: DesignRunRequest,
    completedRun?: { id: string; status: string }
  ): DesignSessionSnapshot {
    next.seq++
    next.meta.updatedAt = Date.now()
    next.meta.title =
      next.state.sourceInfo?.label ||
      next.state.messages.find((m) => m.role === "user")?.content.slice(0, 24) ||
      next.meta.title
    next.meta.artifactPath = next.state.artifactPath ?? undefined
    next.meta.thumbnailText = next.state.artifactMetadata?.preview?.thumbnailText
    next.meta.generationState = next.state.pendingApproval
      ? "waiting_approval"
      : next.state.generationState
    if (
      events.some(
        (event) => !["created", "edited"].includes(String((event as { type?: string }).type))
      )
    )
      next.meta.lastActivitySeq = next.seq
    next.meta.unread = next.lastSeenSeq < (next.meta.lastActivitySeq ?? 0)
    this.store.save(next, events, request, completedRun)
    this.sessions.set(next.id, clone(next))
    const result = clone(next)
    this.deps.publish({ id: next.id, seq: next.seq, meta: result.meta, snapshot: result })
    return result
  }
}

export function makeThreadId(run: Pick<ActiveRun, "id" | "request">): string {
  return makeDesignAgentThreadId(
    run.request.freshAgentThread
      ? `retry_${run.id}_${run.request.designSessionId}`
      : run.request.designSessionId,
    "design-main"
  )
}
