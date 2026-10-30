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
import type { DesignSessionStore, DesignPatchJournal, DesignEditReceipt } from "./session-store"
import {
  prepareEditableSource,
  inspectEditableSource,
  applyDirectEdit,
  directEditValues,
  type DirectEditCandidate
} from "./direct-edit"
import {
  parseDesignEditCommand,
  serializeDesignEditCommand,
  type DesignEditCommand,
  type DesignEditableDocument
} from "../../../shared/design-edit"
import { sourceHash, verifyDesignPatchDependencies } from "./document-index"
import { inspectDesignDocument } from "../../../shared/design-progressive"
import { isSingleDesignVariant, designVariantPolicyIssue, SINGLE_DESIGN_VARIANT_PROMPT } from "../../../shared/design-variation-policy"
import {
  readTweakDeclaration,
  reconcileTweaks,
  editTweaks,
  materializeTweaks,
  readyTweakKeys,
  effectiveTweaks,
  type DesignTweakCommand
} from "../../../shared/design-tweaks"

interface ActiveRun {
  id: string
  request: DesignRunRequest
  normalize: (token: string) => string
  pending: DesignRunEvent[]
  timer?: ReturnType<typeof setTimeout>
  snapshot?: DesignSessionSnapshot
}

export interface DesignRunDependencies {
  validateDirectEdit?: (
    candidate: DirectEditCandidate,
    before: DesignSessionSnapshot
  ) => Promise<void>
  project?: (snapshot: DesignSessionSnapshot) => void
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
  private readonly editing = new Set<string>()

  constructor(
    private readonly store: DesignSessionStore,
    private readonly deps: DesignRunDependencies
  ) {
    for (const snapshot of store.list()) {
      snapshot.state.singleVariant = isSingleDesignVariant(snapshot.state, snapshot.meta)
      snapshot.state.artifactRevision ??= 0
      snapshot.state.patchStatus = null
      snapshot.state.draftPreview ??= null
      snapshot.state.tweaks ??=
        snapshot.state.artifactMetadata?.tweaks ??
        reconcileTweaks(readTweakDeclaration(snapshot.state.html))
      this.sessions.set(snapshot.id, snapshot)
      if (snapshot.activeRunId || busy(snapshot.state)) {
        const next = clone(snapshot)
        const oldRun = next.activeRunId
        next.activeRunId = null
        next.state.generationState = "interrupted"
        next.state.pendingApproval = null
        if (next.state.draftPreview) {
          next.state.draftPreview.status = "incomplete"
          next.state.draftPreview.phase = "sections"
        }
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
    this.replayProjections()
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

  inspectEditable(id: string): DesignEditableDocument {
    const next = this.get(id)
    if (next.activeRunId || next.state.draftPreview || this.editing.has(id))
      throw new Error("页面正在修改，请稍后编辑")
    if (!next.state.html) throw new Error("没有可编辑的页面")
    const html = prepareEditableSource(next.state.html)
    if (html !== next.state.html) {
      next.state.html = html
      next.state.artifactRevision = (next.state.artifactRevision ?? 0) + 1
      next.state.appliedPatch = {
        id: `identity-${randomUUID()}`,
        revision: next.state.artifactRevision,
        mode: "live",
        targetIds: [],
        summary: "编辑节点已就绪"
      }
      next.state.canUndoPatch = false
      next.state.canRedoPatch = false
      this.commit(next, [{ type: "editor_initialized" }])
      this.replayProjections()
    }
    return inspectEditableSource(html, next.state.artifactRevision ?? 0, next.state.tweaks)
  }

  async edit(id: string, input: DesignEditCommand): Promise<DesignSessionSnapshot> {
    const command = parseDesignEditCommand(input)
    const hash = sourceHash(serializeDesignEditCommand(command))
    const receipt = this.store.editReceipt(id, command.commandId)
    if (receipt) {
      if (receipt.hash !== hash) throw new Error("相同编辑命令不能使用不同内容")
      return this.get(id)
    }
    const before = this.get(id)
    if (before.activeRunId || before.state.draftPreview || this.editing.has(id))
      throw new Error("页面正在修改，请稍后重试")
    if ((before.state.artifactRevision ?? 0) !== command.baseRevision)
      throw new Error("页面版本已变化，请重新选择元素")
    if (
      command.baseTweakRevision !== undefined &&
      command.baseTweakRevision !== (before.state.tweaks?.revision ?? 0)
    )
      throw new Error("相关参数已变化，请重新选择文字")
    this.editing.add(id)
    try {
      const candidate = applyDirectEdit(before.state.html, before.state.tweaks ?? null, command)
      await this.deps.validateDirectEdit?.(candidate, before)
      const next = this.get(id)
      if (
        next.activeRunId ||
        next.state.artifactRevision !== before.state.artifactRevision ||
        next.state.tweaks?.revision !== before.state.tweaks?.revision
      )
        throw new Error("校验期间页面或参数已变化，请重新提交")
      next.state.html = candidate.html
      next.state.tweaks = candidate.tweaks
      next.state.artifactRevision = command.baseRevision + 1
      next.state.appliedPatch = {
        id: command.commandId,
        revision: next.state.artifactRevision,
        mode: candidate.mode,
        targetIds: candidate.targetIds,
        summary: candidate.summary
      }
      next.state.patchStatus = { phase: "applied", message: candidate.summary }
      next.state.canUndoPatch = true
      next.state.canRedoPatch = false
      next.state.variations = []
      const journal: DesignPatchJournal = {
        id: command.commandId,
        action: "apply",
        beforeHtml: before.state.html,
        afterHtml: candidate.html,
        beforeTweaks: {},
        afterTweaks: {},
        patch: next.state.appliedPatch,
        direct: {
          before: before.state.tweaks ?? null,
          after: candidate.tweaks,
          keys: candidate.touchedTweaks
        }
      }
      return this.commit(
        next,
        [{ type: "direct_edit", commandId: command.commandId, summary: candidate.summary }],
        undefined,
        undefined,
        journal,
        { commandId: command.commandId, hash, revision: next.state.artifactRevision }
      )
    } finally {
      this.editing.delete(id)
    }
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
    state.draftPreview ??= null
    state.tweaks ??=
      state.artifactMetadata?.tweaks ?? reconcileTweaks(readTweakDeclaration(state.html))
    return this.commit({ ...clone(seed), state, seq: 0, activeRunId: null, lastSeenSeq: 0 }, [
      { type: "created" }
    ])
  }

  migrate(seeds: DesignSessionSeed[]): SessionMeta[] {
    for (const seed of seeds) if (!this.store.wasDeleted(seed.id)) this.create(seed)
    return this.list()
  }

  patch(id: string, patch: Partial<TabState>, meta?: Partial<SessionMeta>): DesignSessionSnapshot {
    if (this.editing.has(id) && patch.html !== undefined) throw new Error("直接编辑正在保存")
    const next = this.get(id)
    const updates = clone(patch)
    if (next.activeRunId) {
      for (const key of Object.keys(updates) as Array<keyof TabState>) {
        if (!(DESIGN_UI_FIELDS as readonly string[]).includes(key)) delete updates[key]
      }
    }
    // Runtime-owned state cannot be manufactured by a UI patch.
    delete updates.pendingApproval
    delete updates.draftPreview
    delete updates.tweaks
    delete updates.generationMetrics
    delete updates.lastCompletedRunId
    delete updates.singleVariant
    for (const key of [
      "artifactRevision",
      "appliedPatch",
      "patchStatus",
      "patchMetrics",
      "canUndoPatch",
      "canRedoPatch"
    ] as const)
      delete updates[key]
    if (updates.generationState === "generating" || updates.generationState === "asking")
      delete updates.generationState
    if (updates.html !== undefined && updates.html !== next.state.html) {
      const issue = designVariantPolicyIssue(updates.html, isSingleDesignVariant(next.state, next.meta))
      if (issue) throw new Error(issue)
      next.state.artifactRevision = (next.state.artifactRevision ?? 0) + 1
      next.state.appliedPatch = null
      next.state.patchStatus = null
      next.state.canUndoPatch = false
      next.state.canRedoPatch = false
    }
    next.state = { ...next.state, ...updates }
    if (updates.html !== undefined)
      next.state.tweaks = reconcileTweaks(readTweakDeclaration(updates.html), next.state.tweaks)
    next.state.messages = next.state.messages.map((message) => ({
      ...message,
      id: message.id || randomUUID()
    }))
    if (meta) next.meta = { ...next.meta, ...meta, id }
    return this.commit(next, [{ type: "edited", fields: Object.keys(updates) }])
  }

  tweak(id: string, command: DesignTweakCommand): DesignSessionSnapshot {
    if (this.editing.has(id)) throw new Error("直接编辑正在保存，请稍后调整参数")
    const next = this.get(id)
    const draft = next.state.draftPreview
    // A debounced edit submitted just as validation completes still belongs to this result.
    if (
      command.scope === "draft" &&
      !draft &&
      !next.activeRunId &&
      command.runId === next.state.lastCompletedRunId
    )
      command = { ...command, scope: "artifact" }
    if (command.scope !== "artifact" && command.scope !== "draft") throw new Error("微调范围无效")
    if (command.scope === "draft") {
      if (!draft || command.runId !== draft.runId || draft.phase === "validating")
        throw new Error("草稿已变更或正在校验")
      if (!draft.tweaks) throw new Error("草稿没有可调参数")
      if (
        command.operation === "set" &&
        command.key &&
        !readyTweakKeys(draft.html, draft.tweaks.declaration).has(command.key)
      )
        throw new Error("该参数对应区块尚未生成")
      draft.tweaks = editTweaks(draft.tweaks, command)
    } else {
      if (next.activeRunId && this.active.get(id)?.request.kind !== "patch")
        throw new Error("请调整当前草稿的参数")
      if (!next.state.tweaks) throw new Error("设计没有可调参数")
      next.state.tweaks = editTweaks(next.state.tweaks, command)
    }
    return this.commit(next, [
      {
        type: "tweaks_changed",
        scope: command.scope,
        revision: command.scope === "draft" ? draft!.tweaks!.revision : next.state.tweaks!.revision
      }
    ])
  }

  previewVisible(id: string, runId: string, revision: number): void {
    const next = this.get(id)
    const draft = next.state.draftPreview
    if (
      !draft &&
      !next.activeRunId &&
      next.state.appliedPatch?.id === runId &&
      next.state.appliedPatch.revision === revision
    ) {
      if (next.state.generationMetrics?.patchVisibleAt !== undefined) return
      next.state.generationMetrics = {
        ...next.state.generationMetrics,
        patchVisibleAt: next.state.generationMetrics?.patchVisibleAt ?? Date.now()
      }
      this.commit(next, [{ type: "patch_visible", patchId: runId, revision }])
      return
    }
    if (!draft || draft.runId !== runId || draft.revision !== revision) return
    const metrics = next.state.generationMetrics ?? {}
    metrics.scaffoldVisibleAt ??= Date.now()
    if (draft.completedSections.length) metrics.firstSectionVisibleAt ??= Date.now()
    if (draft.totalSections && draft.completedSections.length === draft.totalSections)
      metrics.lastSectionVisibleAt ??= Date.now()
    next.state.generationMetrics = metrics
    this.commit(next, [{ type: "preview_visible", runId, revision }])
  }

  start(request: DesignRunRequest): DesignSessionSnapshot {
    if (this.editing.has(request.designSessionId))
      throw new Error("直接编辑尚未保存，请稍后开始生成")
    const previous = this.store.findRequest(request.requestId)
    if (previous) {
      if (previous.sessionId !== request.designSessionId)
        throw new Error("请求已属于另一个设计会话")
      return this.get(previous.sessionId)
    }
    const next = this.get(request.designSessionId)
    next.state.singleVariant = isSingleDesignVariant(next.state, next.meta)
    if (next.activeRunId) throw new Error("当前设计仍在运行，请先停止或等待完成")
    if (
      request.kind === "patch" &&
      (!request.patch || request.patch.artifactRevision !== (next.state.artifactRevision ?? 0))
    )
      throw new Error("设计版本已更新，请重新提交局部修改")
    const run: ActiveRun = {
      id: randomUUID(),
      request: clone(request),
      normalize: createDesignProgressNormalizer(),
      pending: []
    }
    if (next.state.singleVariant && request.kind !== "questions" && !run.request.prompt.includes(SINGLE_DESIGN_VARIANT_PROMPT))
      run.request.prompt += `\n\n${SINGLE_DESIGN_VARIANT_PROMPT}`
    next.activeRunId = run.id
    next.state.lastCompletedRunId = null
    next.state.draftPreview = null
    next.state.generationMetrics = { startedAt: Date.now() }
    next.state.patchMetrics = undefined
    next.state.patchStatus =
      request.kind === "patch" ? { phase: "locating", message: "正在定位修改目标" } : null
    if (request.kind === "patch") {
      // Local runs are sourced exclusively from durable state; never persist renderer HTML/history.
      delete run.request.currentHtml
      run.request.rollback = request.rollback
        ? Object.fromEntries(
            [
              "comments",
              "draftComment",
              "activeCommentId",
              "drawStrokes",
              "drawElementHints",
              "drawNotes",
              "draftDrawNote"
            ]
              .filter((k) => k in request.rollback!)
              .map((k) => [k, request.rollback![k as keyof TabState]])
          )
        : null
    } else if (request.isIteration && next.state.tweaks)
      run.request.currentHtml = materializeTweaks(
        request.currentHtml || next.state.html,
        next.state.tweaks,
        false
      )
    next.state.pendingApproval = null
    next.state.generationState = request.kind === "questions" ? "asking" : "generating"
    next.state.rightTab = request.kind === "questions" ? "questions" : "design"
    next.state.originalPrompt =
      request.kind === "questions" ? request.prompt : next.state.originalPrompt
    if (request.kind === "questions") {
      next.state.questions = []
      next.state.answers = {}
    }
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
    const result = this.commit(next, [{ type: "run_started", runId: run.id }], run.request)
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
      [
        "done",
        "error",
        "cancelled",
        "interrupted",
        "approval",
        "approval_resolved",
        "preview",
        "question",
        "patch_status"
      ].includes(event.type)
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
    if (next.state.draftPreview) {
      next.state.draftPreview.status = "incomplete"
      next.state.draftPreview.phase = "sections"
    }
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
    let patchJournal: DesignPatchJournal | undefined
    for (let event of events) {
      if (terminal) break
      if (event.type === "preview" && event.preview) {
        const preview = event.preview
        if (designVariantPolicyIssue(preview.html, !!state.singleVariant)) continue
        const previous = state.draftPreview
        if (preview.runId !== run.id || (previous && preview.revision <= previous.revision))
          continue
        const inspection = inspectDesignDocument(preview.html, previous?.sections)
        if (!inspection.valid) continue
        preview.tweaks = reconcileTweaks(
          readTweakDeclaration(preview.html),
          previous?.tweaks ?? state.tweaks
        )
        state.draftPreview = preview
        state.generationMetrics = {
          ...state.generationMetrics,
          firstWriteAt: state.generationMetrics?.firstWriteAt ?? Date.now(),
          previewCount: (state.generationMetrics?.previewCount ?? 0) + 1,
          previewBytes:
            (state.generationMetrics?.previewBytes ?? 0) + Buffer.byteLength(preview.html)
        }
      } else if (event.type === "patch_status" && event.patchStatus) {
        state.patchStatus = event.patchStatus
      } else if (event.type === "patch_metrics" && event.patchMetrics) {
        state.patchMetrics = event.patchMetrics
      } else if (event.type === "metrics") {
        state.generationMetrics = { ...state.generationMetrics, ...event.metrics }
      } else if (event.type === "token" && event.token) {
        if (!state.generationMetrics?.firstTokenAt)
          state.generationMetrics = { ...state.generationMetrics, firstTokenAt: Date.now() }
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
      } else if (event.type === "question" && run.request.kind === "questions") {
        const question = normalizeQuestionDef(event.question)
        if (question && !state.questions.some((q) => q.id === question.id)) {
          state.questions.push(question)
          state.generationMetrics = {
            ...state.generationMetrics,
            firstQuestionAt: state.generationMetrics?.firstQuestionAt ?? Date.now()
          }
        }
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
          // Streamed definitions stay stable so later snapshots cannot reset an
          // input's options or overwrite an answer entered while streaming.
          for (const raw of event.questions ?? []) {
            const question = normalizeQuestionDef(raw)
            if (question && !state.questions.some((q) => q.id === question.id))
              state.questions.push(question)
          }
          state.generationMetrics = { ...state.generationMetrics, questionsReadyAt: Date.now() }
          state.generationState = "questions_ready"
          assistant.role = "questions-prompt"
          assistant.content = "请补充相关问题 →"
          continueGenerating = !!state.selectedDesignSystemId && state.questions.length === 0
          if (continueGenerating) {
            assistant.role = "assistant"
            assistant.content = "需求已整理，正在生成设计。"
            state.questions = []
          }
        } else {
          try {
            const variantIssue = designVariantPolicyIssue(event.html ?? "", !!state.singleVariant)
            if (variantIssue) throw new Error(variantIssue)
            if (event.patchResult) {
              const result = event.patchResult
              verifyDesignPatchDependencies(result.externalFiles ?? {})
              if (
                result.baseSourceHash !== sourceHash(state.html) ||
                result.patch.revision !== (state.artifactRevision ?? 0) + 1
              )
                throw new Error("设计版本已变化，局部补丁未应用，请重试")
              const values = state.tweaks ? effectiveTweaks(state.tweaks) : {}
              if (Object.entries(result.tweakReads).some(([key, value]) => values[key] !== value))
                throw new Error("相关参数已变化，局部补丁未应用，请重试")
              let updated = state.tweaks ? clone(state.tweaks) : null
              for (const [key, value] of Object.entries(result.tweakUpdates)) {
                if (!updated) throw new Error("参数状态已失效")
                updated = editTweaks(updated, {
                  scope: "artifact",
                  baseRevision: updated.revision,
                  operation: "set",
                  key,
                  value
                })
              }
              event.tweaks = updated
              patchJournal = {
                id: result.patch.id,
                action: "apply",
                beforeHtml: state.html,
                afterHtml: event.html!,
                beforeTweaks: Object.fromEntries(
                  Object.keys(result.tweakUpdates).map((key) => [key, values[key]])
                ),
                beforeOverrides: Object.fromEntries(
                  Object.keys(result.tweakUpdates).map((key) => [
                    key,
                    Object.hasOwn(state.tweaks?.overrides ?? {}, key)
                      ? state.tweaks!.overrides[key]
                      : null
                  ])
                ),
                afterTweaks: result.tweakUpdates,
                patch: result.patch
              }
            }
            if (
              state.draftPreview &&
              !inspectDesignDocument(event.html ?? "", state.draftPreview.sections).finalizable
            )
              throw new Error("页面还有未完成区块，已保留草稿")
            event = this.deps.finalize(event, run.request, run.snapshot!)
            const finalizedVariantIssue = designVariantPolicyIssue(event.html ?? "", !!state.singleVariant)
            if (finalizedVariantIssue) throw new Error(finalizedVariantIssue)
            if (!event.html?.trim()) throw new Error("生成没有返回有效设计")
            if (
              state.draftPreview &&
              !inspectDesignDocument(event.html, state.draftPreview.sections).finalizable
            )
              throw new Error("页面还有未完成区块，已保留草稿")
            state.html = event.html
            if (!run.request.isIteration) state.activeMode = "edit"
            state.artifactRevision = (state.artifactRevision ?? 0) + 1
            state.appliedPatch = event.patchResult?.patch ?? null
            state.patchStatus = event.patchResult
              ? { phase: "applied", message: event.patchResult.patch.summary }
              : null
            state.canUndoPatch = !!event.patchResult
            state.canRedoPatch = false
            state.lastCompletedRunId = run.id
            state.tweaks =
              event.tweaks ??
              reconcileTweaks(
                readTweakDeclaration(event.html),
                state.draftPreview?.tweaks ?? state.tweaks,
                true
              )
            state.draftPreview = null
            state.generationMetrics = { ...state.generationMetrics, finishedAt: Date.now() }
            state.artifactPath = event.artifactPath ?? state.artifactPath
            state.artifactMetadata = event.metadata ?? state.artifactMetadata
            state.variations = [] // DOM-specific preview documents are derived by the view.
            if (!event.patchResult) state.activeVariationId = null
            if (event.patchResult?.patch.mode !== "live") state.reloadKey++
            state.generationState = "done"
            assistant.content = event.patchResult
              ? `✓ ${event.patchResult.patch.summary}`
              : run.request.isIteration
                ? "✓ 设计已更新"
                : "✓ 设计已生成"
            if (run.request.cleanUserMsg)
              state.apiHistory = [
                ...(state.apiHistory ?? []),
                { role: "user", content: run.request.cleanUserMsg },
                { role: "assistant", content: assistant.content }
              ]
          } catch (error) {
            patchJournal = undefined
            event = { type: "error", error: error instanceof Error ? error.message : String(error) }
          }
        }
        terminal = true
      }
      if (event.type === "error" || event.type === "cancelled" || event.type === "interrupted") {
        state.patchStatus = null
        const draft = state.draftPreview
        if (run.request.rollback) Object.assign(state, clone(run.request.rollback))
        state.draftPreview = draft ? { ...draft, status: "incomplete", phase: "sections" } : null
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
      state.generationMetrics = { ...state.generationMetrics, finishedAt: Date.now() }
      assistant.isStreaming = false
      assistant.modelRetry = null
      state.pendingApproval = null
      next.activeRunId = null
    }
    this.commit(
      next,
      events,
      undefined,
      terminal ? { id: run.id, status: state.generationState } : undefined,
      patchJournal
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
            { designSystemId: state.selectedDesignSystemId, singleVariant: state.singleVariant }
          ),
          cleanUserMsg: run.request.prompt
        })
      }
    }
  }

  patchHistory(id: string, operation: "undo" | "redo", revision: number): DesignSessionSnapshot {
    if (this.editing.has(id)) throw new Error("直接编辑正在保存")
    if (operation !== "undo" && operation !== "redo") throw new Error("撤销操作无效")
    const next = this.get(id)
    if (next.activeRunId || (next.state.artifactRevision ?? 0) !== revision)
      throw new Error("页面正在修改或版本已变化")
    const journal = this.store.lastPatch(id, operation)
    if (!journal) throw new Error("没有可撤销或重做的局部修改")
    const undo = operation === "undo"
    if (sourceHash(next.state.html) !== sourceHash(undo ? journal.afterHtml : journal.beforeHtml))
      throw new Error("后续源码已变化，不能覆盖后续修改")
    if (journal.direct) {
      const expectedState = undo ? journal.direct.after : journal.direct.before
      const desiredState = undo ? journal.direct.before : journal.direct.after
      const currentValues = directEditValues(next.state.tweaks ?? null)
      const expectedValues = directEditValues(expectedState)
      for (const key of journal.direct.keys) {
        if (currentValues[key] !== expectedValues[key])
          throw new Error("相关参数之后已调整，不能覆盖后续设置")
      }
      const restored = reconcileTweaks(desiredState?.declaration ?? null, next.state.tweaks)
      if (restored)
        for (const key of journal.direct.keys) {
          if (desiredState && Object.hasOwn(desiredState.overrides, key))
            restored.overrides[key] = desiredState.overrides[key]
          else delete restored.overrides[key]
        }
      next.state.tweaks = restored
    }
    const expected = undo ? journal.afterTweaks : journal.beforeTweaks
    const desired = undo ? journal.beforeTweaks : journal.afterTweaks
    const values = next.state.tweaks ? effectiveTweaks(next.state.tweaks) : {}
    if (Object.entries(expected).some(([key, value]) => values[key] !== value))
      throw new Error("补丁参数之后已被调整，不能覆盖后续设置")
    for (const [key, value] of Object.entries(desired)) {
      if (!next.state.tweaks) throw new Error("参数状态已变化")
      next.state.tweaks = editTweaks(next.state.tweaks, {
        scope: "artifact",
        baseRevision: next.state.tweaks.revision,
        operation: undo && journal.beforeOverrides?.[key] === null ? "reset" : "set",
        key,
        value
      })
    }
    next.state.html = undo ? journal.beforeHtml : journal.afterHtml
    next.state.artifactRevision = revision + 1
    next.state.appliedPatch = {
      ...journal.patch,
      id: randomUUID(),
      revision: revision + 1,
      summary: `${undo ? "撤销" : "重做"}：${journal.patch.summary}`
    }
    next.state.patchStatus = { phase: "applied", message: next.state.appliedPatch.summary }
    next.state.variations = []
    if (journal.patch.mode === "reload") next.state.reloadKey++
    next.state.canUndoPatch = !undo || this.store.hasOtherPatch(id, "undo", journal.id)
    next.state.canRedoPatch = undo || this.store.hasOtherPatch(id, "redo", journal.id)
    return this.commit(next, [{ type: "patch_history", operation }], undefined, undefined, {
      ...journal,
      action: operation
    })
  }

  private replayProjections(): void {
    if (!this.deps.project) return
    for (const entry of this.store.pendingProjections()) {
      const snapshot = this.sessions.get(entry.id)
      if (!snapshot) continue
      try {
        this.deps.project(clone(snapshot))
        this.store.projectionSaved(entry.id, entry.revision)
      } catch (error) {
        console.warn("[Design] Artifact projection pending; durable version retained", error)
      }
    }
  }
  syncArtifacts(): void {
    this.replayProjections()
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
    if (!path.trim()) throw new Error("工作目录不能为空")
    if (next.workspacePath === path) return next
    if (next.activeRunId) throw new Error("设计运行中无法切换工作目录，请先停止任务")
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
    completedRun?: { id: string; status: string },
    patchJournal?: DesignPatchJournal,
    editReceipt?: DesignEditReceipt
  ): DesignSessionSnapshot {
    const previousDraft = this.sessions.get(next.id)?.state.draftPreview
    next.state.singleVariant = !!this.sessions.get(next.id)?.state.singleVariant || isSingleDesignVariant(next.state, next.meta)
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
    this.store.save(next, events, request, completedRun, patchJournal, editReceipt)
    this.sessions.set(next.id, clone(next))
    if (patchJournal) this.replayProjections()
    const result = clone(next)
    const draft = result.state.draftPreview
    const draftHtmlOmitted =
      !!draft && previousDraft?.runId === draft.runId && previousDraft.revision === draft.revision
    const published = draftHtmlOmitted
      ? { ...result, state: { ...result.state, draftPreview: { ...draft!, html: "" } } }
      : result
    this.deps.publish({
      id: next.id,
      seq: next.seq,
      meta: result.meta,
      snapshot: published,
      ...(draftHtmlOmitted ? { draftHtmlOmitted: true } : {})
    })
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
