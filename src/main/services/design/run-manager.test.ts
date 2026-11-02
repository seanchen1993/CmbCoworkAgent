import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import {
  createDesignState,
  type DesignRunEvent,
  type DesignRunRequest,
  type DesignSessionChange
} from "../../../shared/managed-design-session"
import { DesignSessionStore } from "./session-store"
import { DesignRunManager, type DesignRunDependencies } from "./run-manager"
import { inspectDesignDocument, type DesignDraftPreview } from "../../../shared/design-progressive"
import { readTweakDeclaration, materializeTweaks } from "../../../shared/design-tweaks"

const databases: NativeSqliteAdapter[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  for (const db of databases.splice(0)) db.close()
})

function harness(options: Partial<DesignRunDependencies> = {}) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new DesignSessionStore(db)
  const changes: DesignSessionChange[] = []
  const emitters = new Map<string, (event: DesignRunEvent) => void>()
  const finishes = new Map<string, () => void>()
  const execute = vi.fn(
    (request: DesignRunRequest, _runId: string, emit: (event: DesignRunEvent) => void) => {
      emitters.set(request.requestId, emit)
      return new Promise<void>((resolve) => finishes.set(request.requestId, resolve))
    }
  )
  const deps: DesignRunDependencies = {
    execute,
    abort: vi.fn(),
    finalize: (event) => ({ ...event, artifactPath: "/design/result.html" }),
    publish: (change) => changes.push(change),
    ...options
  }
  const manager = new DesignRunManager(store, deps)
  function create(id = "ds_a") {
    const state = createDesignState()
    state.messages.push({ role: "user", content: "创建一个页面" })
    return manager.create({
      id,
      meta: { id, title: "设计", createdAt: 1, updatedAt: 1 },
      state,
      workspacePath: "/workspace"
    })
  }
  async function start(
    id = "ds_a",
    requestId = "request-a",
    kind: DesignRunRequest["kind"] = "agent"
  ) {
    manager.start({ requestId, designSessionId: id, kind, prompt: "生成页面" })
    await Promise.resolve()
    return emitters.get(requestId)!
  }
  return { db, store, manager, deps, create, start, execute, changes, emitters, finishes }
}

describe("background design conversations", () => {
  it("persists reasoning-only output across reopening, stop and a fresh retry without mixing it into the artifact", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    emit({ type: "model_activity", activity: { scope: "ai", reasoning: "先分析需求" } })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.manager.get("ds_a").state.liveOutput).toMatchObject({ phase: "thinking", text: "", chars: 0, reasoning: "先分析需求" })
    expect(h.store.get("ds_a")!.state.messages.at(-1)!.reasoning).toBe("先分析需求")
    expect(h.manager.get("ds_a").state.messages.at(-1)!.executionEvents).toEqual([])
    h.manager.stop("ds_a")
    emit({ type: "model_activity", activity: { scope: "ai", reasoning: "过期思考" } })
    expect(h.manager.get("ds_a").state.messages.at(-1)!.reasoning).toBe("先分析需求")
    expect(h.manager.get("ds_a").state.liveOutput).toBeNull()
    h.finishes.get("request-a")!()
    const reopened = new DesignRunManager(h.store, h.deps)
    expect(reopened.get("ds_a").state.messages.at(-1)!.reasoning).toBe("先分析需求")
    reopened.retry("ds_a", "reasoning-retry")
    await Promise.resolve()
    expect(reopened.get("ds_a").state.messages.at(-1)!.reasoning).toBeUndefined()
    const retryEmit = h.emitters.get("reasoning-retry")!
    retryEmit({ type: "model_activity", activity: { scope: "new-ai", reasoning: "重新规划" } })
    retryEmit({ type: "token", token: "开始生成" })
    retryEmit({ type: "done", html: html() })
    expect(reopened.get("ds_a").state.messages.at(-1)!.reasoning).toBe("重新规划")
    expect(reopened.get("ds_a").state.html).not.toMatch(/先分析需求|重新规划/)
    expect(reopened.get("ds_a").state.liveOutput).toBeNull()
    h.finishes.get("reasoning-retry")!()
  })
  it("shows inline thinking during questions without displaying the questions JSON", async () => {
    const h = harness()
    h.create()
    const emit = await h.start("ds_a", "questions", "questions")
    emit({ type: "model_activity", activity: { scope: "questions-ai" } })
    emit({ type: "token", token: "<thi" })
    emit({ type: "token", token: "nk>需要补充用户偏好" })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.manager.get("ds_a").state.liveOutput?.phase).toBe("thinking")
    emit({ type: "token", token: '</think>[{"id":"q","label":"你的偏好？"}]' })
    emit({ type: "done", questions: [] })
    const message = h.store.get("ds_a")!.state.messages.at(-1)!
    expect(message.reasoning).toBe("需要补充用户偏好")
    expect(message.executionEvents).toEqual([])
    expect(message.role).toBe("questions-prompt")
    h.finishes.get("questions")!()
  })
  it("streams bounded generated file output, persists it across reopen and clears it on stop/retry", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    expect(h.manager.get("ds_a").state.liveOutput?.phase).toBe("waiting")
    emit({ type: "model_activity", activity: { scope: "ai", toolCallChunks: [{ index: 0, name: "write_file", args: '{"content":"<html>' }] } })
    emit({ type: "model_activity", activity: { scope: "ai", toolCallChunks: [{ index: 0, args: 'streaming-page' }] } })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.store.get("ds_a")!.state.liveOutput).toMatchObject({ phase: "file", text: "<html>streaming-page" })
    expect(h.manager.get("ds_a").state.liveOutput?.text).toContain("streaming-page")
    h.manager.patch("ds_a", { liveOutput: null })
    expect(h.manager.get("ds_a").state.liveOutput).not.toBeNull()
    h.manager.stop("ds_a")
    expect(h.manager.get("ds_a").state.liveOutput).toBeNull()
    emit({ type: "token", token: "late output" })
    expect(h.manager.get("ds_a").state.liveOutput).toBeNull()
    h.finishes.get("request-a")!()
    const second = await h.start("ds_a", "request-b")
    expect(h.manager.get("ds_a").state.liveOutput?.text).toBe("")
    second({ type: "preview", preview: preview(h.manager.get("ds_a").activeRunId!, 1, true) })
    second({ type: "done", html: html().replace("<body>", '<body data-design-build="complete">') })
    expect(h.manager.get("ds_a").state.generationState).toBe("done")
    expect(h.manager.get("ds_a").state.liveOutput).toBeNull()
    h.finishes.get("request-b")!()
  })
  it("imports a captured page with fresh runtime state and refuses to replace an active run", async () => {
    const h = harness()
    // A failed generation may leave a recoverable draft. Import must replace it.
    const initial = h.manager.create({
      id: "ds_import",
      meta: { id: "ds_import", title: "Previous", createdAt: 1, updatedAt: 1 },
      state: {
        ...createDesignState(),
        html: "previous",
        draftPreview: {
          runId: "old", revision: 1, html: "old draft", draftPath: "/workspace/.draft.html",
          phase: "sections", status: "incomplete", sections: [], completedSections: [],
          totalSections: 0, tweaks: null, createdAt: 1, updatedAt: 1
        },
        lastCompletedRunId: "previous",
        canUndoPatch: true
      },
      workspacePath: "/workspace"
    })
    const markup = "<html><head></head><body><h1>Captured</h1></body></html>"
    const patch = {
      html: markup,
      sourceInfo: { kind: "import_url" as const, label: "Captured" },
      generationState: "done" as const
    }
    const replaced = h.manager.patch(initial.id, patch)
    expect(replaced.state.html).toBe(markup)
    expect(replaced.state.draftPreview).toBeNull()
    expect(replaced.state.lastCompletedRunId).toBeNull()
    expect(replaced.state.canUndoPatch).toBe(false)
    expect(replaced.state.tweaks).toBeNull()
    await h.start(initial.id)
    expect(() => h.manager.patch(initial.id, patch)).toThrow("请先停止")
    h.manager.stop(initial.id)
    h.finishes.get("request-a")!()
  })
  it("keeps the last page and reports an error when the formal artifact cannot be committed", async () => {
    const h = harness({
      finalize: () => {
        throw new Error("正式保存失败：磁盘已满")
      }
    })
    h.create()
    h.manager.patch("ds_a", { html: "<!doctype html><html><body>上一版</body></html>" })
    const emit = await h.start()
    emit({ type: "done", html: "<!doctype html><html><body>新页面</body></html>" })
    expect(h.manager.get("ds_a").state.html).toContain("上一版")
    expect(h.manager.get("ds_a").state.generationState).toBe("error")
    expect(h.manager.get("ds_a").state.lastCompletedRunId).toBeNull()
    h.finishes.get("request-a")!()
  })
  it("persists the DESIGN.md single-variant lock through deselection, reopen and later generation kinds", async () => {
    const h = harness()
    h.create()
    h.manager.patch("ds_a", { selectedDesignSystemId: "brand" })
    h.manager.patch("ds_a", { selectedDesignSystemId: null, singleVariant: false })
    expect(h.store.get("ds_a")!.state.singleVariant).toBe(true)
    const reopened = new DesignRunManager(h.store, h.deps)
    expect(reopened.get("ds_a").state.singleVariant).toBe(true)
    for (const kind of ["agent", "image"] as const) {
      const emit = await h.start("ds_a", kind, kind)
      expect(h.execute.mock.calls.at(-1)![0].prompt).toContain("permanently single-variant")
      emit({ type: "done", html: "<!doctype html><html><body><main>单版</main></body></html>" })
      h.finishes.get(kind)!()
    }
    h.create("ds_other")
    expect(h.manager.get("ds_other").state.singleVariant).toBe(false)
  })

  it("backfills old conversations from persisted artifact metadata", () => {
    const h = harness()
    const seed = h.create()
    seed.state.artifactMetadata = { designSystemId: "brand" } as typeof seed.state.artifactMetadata
    delete seed.state.singleVariant
    h.store.save(seed, [])
    const restored = new DesignRunManager(h.store, h.deps)
    expect(restored.get("ds_a").state.singleVariant).toBe(true)
  })

  it("rejects multi-variant previews and final artifacts without replacing the last valid page", async () => {
    const h = harness()
    h.create()
    const baseline = "<!doctype html><html><body><main>已保存版本</main></body></html>"
    h.manager.patch("ds_a", { selectedDesignSystemId: "brand", html: baseline })
    const emit = await h.start()
    const runId = h.manager.get("ds_a").activeRunId!
    const variants =
      '<!doctype html><html><body><div id="variation-a">A</div><div id="variation-b">B</div></body></html>'
    emit({ type: "preview", preview: { ...preview(runId, 1), html: variants } })
    expect(h.manager.get("ds_a").state.draftPreview).toBeNull()
    emit({ type: "done", html: variants })
    expect(h.manager.get("ds_a").state.html).toBe(baseline)
    expect(h.manager.get("ds_a").state.generationState).toBe("error")
    expect(() => h.manager.patch("ds_a", { html: variants })).toThrow("只允许单一方案")
    h.finishes.get("request-a")!()
  })

  const html = (pending = false) =>
    `<!doctype html><html><head><style>section{color:var(--primary)}</style><script type="application/design-tweaks+json">{"defaults":{"primary":"#123456"},"schema":{"primary":{"type":"color","label":"主色"}},"bindings":{"primary":[{"type":"css-var","name":"--primary"}]}}</script></head><body ${pending ? 'data-design-build="building"' : ""}><section data-design-section="main" ${pending ? "data-design-pending" : ""}>页面</section></body></html>`
  const preview = (runId: string, revision: number, pending = false): DesignDraftPreview => ({
    runId,
    revision,
    html: html(pending),
    draftPath: "/workspace/draft.html",
    phase: "sections",
    status: "building",
    ...inspectDesignDocument(html(pending)),
    tweaks: null,
    createdAt: 1,
    updatedAt: 1
  })

  it("persists previews separately, rejects stale/foreign revisions and preserves drafts on stop", async () => {
    const h = harness()
    h.create()
    h.manager.patch("ds_a", { html: html() })
    const emit = await h.start(),
      runId = h.manager.get("ds_a").activeRunId!
    emit({ type: "preview", preview: preview(runId, 2, true) })
    emit({ type: "preview", preview: preview("other-run", 100) })
    emit({ type: "preview", preview: preview(runId, 1) })
    expect(h.store.get("ds_a")!.state.draftPreview!.revision).toBe(2)
    expect(h.store.get("ds_a")!.state.html).toBe(html())
    expect(h.store.get("ds_a")!.state.generationState).toBe("generating")
    h.manager.stop("ds_a")
    emit({ type: "preview", preview: preview(runId, 3) })
    expect(h.store.get("ds_a")!.state.draftPreview).toMatchObject({
      revision: 2,
      status: "incomplete"
    })
  })

  it("resumes a stopped first page from its durable draft and tweaks instead of restarting the template", async () => {
    const h = harness()
    h.create()
    h.manager.start({ requestId: "first", designSessionId: "ds_a", kind: "agent",
      prompt: "生成销售看板\n[初始模板 HTML]", cleanUserMsg: "生成销售看板", modelId: "test-model" })
    await Promise.resolve()
    const firstEmit = h.emitters.get("first")!
    const firstRun = h.manager.get("ds_a").activeRunId!
    const partialHtml = html(true).replace("data-design-pending", "")
      .replace("页面", "已完成的标题")
      .replace("</body>", '<section data-design-section="details" data-design-pending>统计区占位</section></body>')
    firstEmit({ type: "preview", preview: { ...preview(firstRun, 7), html: partialHtml,
      ...inspectDesignDocument(partialHtml) } })
    h.manager.tweak("ds_a", { scope: "draft", runId: firstRun, baseRevision: h.manager.get("ds_a").state.draftPreview!.tweaks!.revision,
      operation: "set", key: "primary", value: "#00aa00" })
    const stopped = h.manager.stop("ds_a")
    h.finishes.get("first")!()
    const checkpoint = stopped.state.draftPreview!
    h.manager.retry("ds_a", "resume-one")
    await Promise.resolve()
    const resumed = h.manager.get("ds_a")
    const request = h.execute.mock.calls.at(-1)![0]
    expect(request).toMatchObject({ kind: "agent", isIteration: true, resumeFromDraft: true,
      resumeGoal: "生成销售看板", resumeInstruction: "生成销售看板", modelId: "test-model",
      sourceArtifactPath: checkpoint.draftPath,
      currentHtml: materializeTweaks(checkpoint.html, checkpoint.tweaks, false) })
    expect(request.prompt).toContain("已完成区块：main")
    expect(request.prompt).toContain("待完成区块：details")
    expect(request.prompt).not.toContain("初始模板 HTML")
    expect(resumed.state.html).toBe("")
    expect(resumed.state.draftPreview).toMatchObject({ runId: resumed.activeRunId,
      revision: 0, html: checkpoint.html, status: "building" })
    expect(resumed.state.draftPreview!.tweaks!.overrides.primary).toBe("#00aa00")
    firstEmit({ type: "done", html: html() })
    expect(h.manager.get("ds_a").state.html).toBe("")
    const updatedHtml = partialHtml.replace("统计区占位", "统计区已完成一半")
    h.emitters.get("resume-one")!({ type: "preview", preview: { ...preview(resumed.activeRunId!, 1),
      html: updatedHtml, ...inspectDesignDocument(updatedHtml) } })
    expect(h.manager.get("ds_a").state.draftPreview!.revision).toBe(1)
    h.manager.stop("ds_a")
    h.finishes.get("resume-one")!()
    h.manager.retry("ds_a", "resume-two")
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(3))
    const secondRequest = h.execute.mock.calls.at(-1)![0]
    expect(secondRequest.currentHtml).toContain("统计区已完成一半")
    expect(secondRequest.currentHtml).toContain("#00aa00")
    expect(secondRequest.prompt.match(/\[接续未完成的设计\]/g)).toHaveLength(1)
    expect(secondRequest.resumeGoal).toBe("生成销售看板")
  })

  it("continues the latest failed draft across repeated errors and app reopen, retaining confirmed answers", async () => {
    const h = harness()
    h.create()
    h.manager.patch("ds_a", { questions: [{ id: "platform", type: "text", label: "运行平台" }], answers: { platform: "企业内部桌面端" } })
    const emit = await h.start()
    const runId = h.manager.get("ds_a").activeRunId!
    const latest = html(true).replace("页面", "出错前已完成一半")
    emit({ type: "preview", preview: { ...preview(runId, 8, true), html: latest } })
    emit({ type: "error", error: "模型请求失败" })
    h.finishes.get("request-a")!()
    expect(h.manager.get("ds_a").state.generationState).toBe("error")
    h.manager.retry("ds_a", "retry-error")
    await Promise.resolve()
    let request = h.execute.mock.calls.at(-1)![0]
    expect(request).toMatchObject({ resumeFromDraft: true, resumeOnly: true, isIteration: true })
    expect(request.currentHtml).toContain("出错前已完成一半")
    expect(request.prompt).toContain("运行平台：企业内部桌面端")
    h.emitters.get("retry-error")!({ type: "error", error: "再次请求失败，未写入新内容" })
    h.finishes.get("retry-error")!()
    const reopened = new DesignRunManager(h.store, h.deps)
    expect(reopened.get("ds_a").state.draftPreview!.html).toBe(latest)
    reopened.retry("ds_a", "retry-reopened")
    await Promise.resolve()
    request = h.execute.mock.calls.at(-1)![0]
    expect(request.currentHtml).toContain("出错前已完成一半")
    expect(request.prompt.match(/\[接续未完成的设计\]/g)).toHaveLength(1)
    expect(request.prompt.match(/运行平台：企业内部桌面端/g)).toHaveLength(1)
    reopened.stop("ds_a")
    h.finishes.get("retry-reopened")!()
  })

  it("recovers a lost legacy preview before retry instead of dispatching the original creation again", async () => {
    const recoverDraft = vi.fn(() => ({ ...preview("legacy", 0, true), html: html(true).replace("页面", "旧版本出错前的内容") }))
    const h = harness({ recoverDraft })
    h.create()
    const emit = await h.start()
    emit({ type: "error", error: "旧版本没有保留草稿引用" })
    h.finishes.get("request-a")!()
    h.manager.retry("ds_a", "recover-legacy")
    await Promise.resolve()
    expect(recoverDraft).toHaveBeenCalledOnce()
    const request = h.execute.mock.calls.at(-1)![0]
    expect(request).toMatchObject({ resumeFromDraft: true, resumeOnly: true, isIteration: true })
    expect(request.currentHtml).toContain("旧版本出错前的内容")
    expect(h.store.get("ds_a")!.state.draftPreview!.html).toContain("旧版本出错前的内容")
    h.manager.stop("ds_a")
    h.finishes.get("recover-legacy")!()
  })

  it("continues recovered drafts for a follow-up using draft values rather than the previous final page", async () => {
    const h = harness()
    h.create()
    h.manager.patch("ds_a", { html: html() })
    h.manager.tweak("ds_a", { scope: "artifact", baseRevision: h.manager.get("ds_a").state.tweaks!.revision,
      operation: "set", key: "primary", value: "#bb0000" })
    const emit = await h.start()
    const runId = h.manager.get("ds_a").activeRunId!
    emit({ type: "preview", preview: preview(runId, 4, true) })
    h.manager.tweak("ds_a", { scope: "draft", runId, baseRevision: h.manager.get("ds_a").state.draftPreview!.tweaks!.revision,
      operation: "set", key: "primary", value: "#00aa00" })
    const recovered = new DesignRunManager(h.store, h.deps)
    expect(recovered.get("ds_a").state.generationState).toBe("interrupted")
    const checkpoint = recovered.get("ds_a").state.draftPreview!
    recovered.start({ requestId: "follow-up", designSessionId: "ds_a", kind: "patch",
      prompt: "继续补齐统计图表", cleanUserMsg: "继续补齐统计图表", currentHtml: "错误的旧页面" })
    await Promise.resolve()
    const request = h.execute.mock.calls.at(-1)![0]
    expect(request.kind).toBe("agent")
    expect(request.currentHtml).toBe(materializeTweaks(checkpoint.html, checkpoint.tweaks, false))
    expect(request.currentHtml).toContain("#00aa00")
    expect(request.currentHtml).not.toContain("#bb0000")
    expect(request.prompt).toContain("继续补齐统计图表")
    expect(request.resumeGoal).toBe("生成页面")
    expect(recovered.get("ds_a").state.html).toBe(html())
    expect(recovered.get("ds_a").state.tweaks!.overrides.primary).toBe("#bb0000")
    expect(recovered.get("ds_a").state.draftPreview!.html).toBe(checkpoint.html)
  })

  it("never finalizes a pending scaffold and keeps the last preview through rollback/recovery", async () => {
    const finalize = vi.fn((event) => event)
    const h = harness({ finalize })
    h.create()
    h.manager.patch("ds_a", { html: "旧版本" })
    h.manager.start({
      designSessionId: "ds_a",
      requestId: "rollback",
      kind: "agent",
      prompt: "修改",
      rollback: { html: "旧版本", draftPreview: null }
    })
    await Promise.resolve()
    const emit = h.emitters.get("rollback")!,
      runId = h.manager.get("ds_a").activeRunId!
    emit({ type: "preview", preview: preview(runId, 1, true) })
    emit({ type: "done", html: html(true) })
    expect(finalize).not.toHaveBeenCalled()
    expect(h.store.get("ds_a")!.state.html).toBe("旧版本")
    expect(h.store.get("ds_a")!.state.draftPreview!.status).toBe("incomplete")
    const recovered = new DesignRunManager(h.store, h.deps)
    expect(recovered.get("ds_a").state.draftPreview!.html).toBe(html(true))
  })

  it("keeps draft tweaks during section updates, completion and a debounced final edit", async () => {
    const h = harness()
    h.create()
    const emit = await h.start(),
      runId = h.manager.get("ds_a").activeRunId!
    emit({ type: "preview", preview: preview(runId, 1, true) })
    let draft = h.manager.get("ds_a").state.draftPreview!
    h.manager.tweak("ds_a", {
      scope: "draft",
      runId,
      baseRevision: draft.tweaks!.revision,
      operation: "set",
      key: "primary",
      value: "#00aa00"
    })
    emit({ type: "preview", preview: preview(runId, 2) })
    draft = h.manager.get("ds_a").state.draftPreview!
    expect(draft.tweaks!.overrides.primary).toBe("#00aa00")
    emit({ type: "done", html: html() })
    let state = h.manager.get("ds_a").state
    expect(state.draftPreview).toBeNull()
    expect(state.tweaks!.overrides.primary).toBe("#00aa00")
    expect(
      readTweakDeclaration(materializeTweaks(state.html, state.tweaks))!.defaults.primary
    ).toBe("#00aa00")
    h.manager.tweak("ds_a", {
      scope: "draft",
      runId,
      baseRevision: state.tweaks!.revision,
      operation: "set",
      key: "primary",
      value: "#aa0000"
    })
    state = h.manager.get("ds_a").state
    expect(state.tweaks!.overrides.primary).toBe("#aa0000")
    expect(() =>
      h.manager.tweak("ds_a", {
        scope: "draft",
        runId: "stale-run",
        baseRevision: state.tweaks!.revision,
        operation: "set",
        key: "primary",
        value: "#aaaaaa"
      })
    ).toThrow()
    const reloadKey = state.reloadKey
    h.manager.tweak("ds_a", {
      scope: "artifact",
      baseRevision: state.tweaks!.revision,
      operation: "undo"
    })
    expect(h.manager.get("ds_a").state.reloadKey).toBe(reloadKey)
  })

  it("restores an interrupted run with its last persisted draft and user values", async () => {
    const h = harness()
    h.create()
    const emit = await h.start(),
      runId = h.manager.get("ds_a").activeRunId!
    emit({ type: "preview", preview: preview(runId, 1, true) })
    const draft = h.manager.get("ds_a").state.draftPreview!
    h.manager.tweak("ds_a", {
      scope: "draft",
      runId,
      baseRevision: draft.tweaks!.revision,
      operation: "set",
      key: "primary",
      value: "#00aa00"
    })
    emit({ type: "preview", preview: { ...preview(runId, 2, true), phase: "validating" } })
    const recoveryManager = new DesignRunManager(h.store, h.deps)
    const recovered = recoveryManager.get("ds_a")
    expect(recovered.state.generationState).toBe("interrupted")
    expect(recovered.state.draftPreview!.status).toBe("incomplete")
    expect(recovered.state.draftPreview!.phase).toBe("sections")
    expect(recovered.state.draftPreview!.tweaks!.overrides.primary).toBe("#00aa00")
    recoveryManager.tweak("ds_a", {
      scope: "draft",
      runId,
      baseRevision: recovered.state.draftPreview!.tweaks!.revision,
      operation: "set",
      key: "primary",
      value: "#aa0000"
    })
    expect(recoveryManager.get("ds_a").state.draftPreview!.tweaks!.overrides.primary).toBe(
      "#aa0000"
    )
  })

  it("persists user messages immediately and collects progress with no UI subscribers", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.create()
    const emit = await h.start()
    expect(h.store.get("ds_a")!.state.messages[0].content).toBe("创建一个页面")
    for (let i = 0; i < 10; i++) {
      emit({ type: "token", token: `进度${i}。` })
      await vi.advanceTimersByTimeAsync(30)
    }
    const persisted = h.store.get("ds_a")!
    expect(persisted.state.messages[1].executionEvents?.[0].content).toContain("进度0")
    expect(persisted.state.messages[1].executionEvents?.[0].content).toContain("进度7")
    emit({ type: "done", html: "<!doctype html><html><body>完成</body></html>" })
    expect(h.store.get("ds_a")!.state.generationState).toBe("done")
    expect(h.store.get("ds_a")!.state.messages[1].executionEvents?.[0].content).toContain("进度9")
    expect(h.store.get("ds_a")!.activeRunId).toBeNull()
    expect(h.store.get("ds_a")!.state.artifactPath).toBe("/design/result.html")
  })

  it("isolates background sessions, enforces one active run and deduplicates start requests", async () => {
    const h = harness()
    h.create()
    h.create("ds_b")
    const a = await h.start()
    const b = await h.start("ds_b", "request-b")
    const first = h.manager.get("ds_a")
    expect(
      h.manager.start({
        requestId: "request-a",
        designSessionId: "ds_a",
        kind: "agent",
        prompt: "重复"
      }).activeRunId
    ).toBe(first.activeRunId)
    expect(() =>
      h.manager.start({
        requestId: "duplicate",
        designSessionId: "ds_a",
        kind: "agent",
        prompt: "重复"
      })
    ).toThrow("仍在运行")
    a({ type: "error", error: "A失败" })
    b({ type: "done", html: "<html>B完成</html>" })
    expect(h.manager.get("ds_a").state.messages.at(-1)!.content).toContain("A失败")
    expect(h.manager.get("ds_b").state.html).toContain("B完成")
  })

  it("flushes pending progress on Stop and fences late terminal events", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    emit({ type: "token", token: "已经产生的内容" })
    h.manager.stop("ds_a")
    emit({ type: "done", html: "迟到结果" })
    expect(h.deps.abort).toHaveBeenCalledOnce()
    const state = h.store.get("ds_a")!.state
    expect(state.generationState).toBe("cancelled")
    expect(state.messages.at(-1)!.executionEvents?.[0].content).toContain("已经产生的内容")
    expect(state.html).toBe("")
  })

  it("keeps execution-only assistant messages and reconciles approvals without a view", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    emit({
      type: "execution",
      event: { kind: "tool_call", id: "tool-1", name: "read_file", timestamp: 1 }
    })
    h.manager.approval("design_ds_a_design-main", {
      _orchestratorRequestId: "approval-1",
      command: "build"
    })
    expect(h.manager.get("ds_a").meta.generationState).toBe("waiting_approval")
    expect(h.store.get("ds_a")!.state.messages.at(-1)!.executionEvents).toHaveLength(1)
    h.manager.approvalRemoved("approval-1")
    expect(h.store.get("ds_a")!.state.pendingApproval).toBeNull()
    expect(h.manager.get("ds_a").state.generationState).toBe("generating")
  })

  it("streams questions immediately and preserves answers through duplicates, completion and reopen", async () => {
    const h = harness()
    h.create()
    const emit = await h.start("ds_a", "questions", "questions")
    const first = { id: "name", type: "text", label: "产品名称" }
    const second = { id: "scope", type: "chips", label: "功能范围", options: ["概览", "详情"] }
    emit({ type: "question", question: first })
    expect(h.store.get("ds_a")!.state.questions.map((q) => q.id)).toEqual(["name"])
    expect(h.manager.get("ds_a").state.generationState).toBe("asking")
    h.manager.patch("ds_a", { answers: { name: "销售中心" } })
    emit({ type: "question", question: second })
    emit({ type: "question", question: { ...first, label: "模型重发的名称" } })
    emit({ type: "done", questions: [second, first] })
    h.finishes.get("questions")!()
    const state = h.manager.get("ds_a").state
    expect(state.questions.map((q) => q.label)).toEqual(["产品名称", "功能范围"])
    expect(state.answers).toEqual({ name: "销售中心" })
    expect(state.generationState).toBe("questions_ready")
    expect(state.generationMetrics?.firstQuestionAt).toBeDefined()
    const recovered = new DesignRunManager(h.store, h.deps)
    expect(recovered.get("ds_a").state.answers).toEqual({ name: "销售中心" })
  })

  it("keeps a single necessary question even when a design system is selected", async () => {
    const h = harness()
    h.create()
    h.manager.patch("ds_a", { selectedDesignSystemId: "system" })
    const emit = await h.start("ds_a", "questions", "questions")
    emit({ type: "done", questions: [{ id: "scope", type: "text", label: "页面范围" }] })
    expect(h.manager.get("ds_a").state.generationState).toBe("questions_ready")
    expect(h.execute).toHaveBeenCalledTimes(1)
    h.finishes.get("questions")!()
  })

  it("ignores questions from cancelled runs and clears old answers when asking again", async () => {
    const h = harness()
    h.create()
    const old = await h.start("ds_a", "old", "questions")
    old({ type: "question", question: { id: "old", label: "旧问题" } })
    h.manager.patch("ds_a", { answers: { old: "旧答案" } })
    h.manager.stop("ds_a")
    h.finishes.get("old")!()
    const emit = await h.start("ds_a", "new", "questions")
    old({ type: "question", question: { id: "late", label: "过期事件" } })
    expect(h.manager.get("ds_a").state.questions).toEqual([])
    expect(h.manager.get("ds_a").state.answers).toEqual({})
    emit({ type: "done", questions: [] })
    h.finishes.get("new")!()
  })

  it("persists questions and automatically continues a design-system run without renderer callbacks", async () => {
    const h = harness()
    h.create()
    h.manager.patch("ds_a", { selectedDesignSystemId: "system" })
    const emit = await h.start("ds_a", "questions", "questions")
    emit({ type: "done", questions: [] })
    h.finishes.get("questions")!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.execute.mock.calls.some(([request]) => request.kind === "agent")).toBe(true)
    expect(h.manager.get("ds_a").state.generationState).toBe("generating")
  })

  it("restores unfinished runs as interrupted and preserves committed messages", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    emit({ type: "execution", event: { kind: "used_skill", name: "design", timestamp: 1 } })
    h.manager.approval("design_ds_a_design-main", { _orchestratorRequestId: "approval" })
    const recovered = new DesignRunManager(h.store, { ...h.deps, execute: vi.fn() })
    const snapshot = recovered.get("ds_a")
    expect(snapshot.state.generationState).toBe("interrupted")
    expect(snapshot.state.pendingApproval).toBeNull()
    expect(snapshot.state.messages[1].executionEvents).toHaveLength(1)
    expect(snapshot.state.messages.every((m) => !m.isStreaming)).toBe(true)
  })

  it("keeps rollback state and error details when final artifact persistence fails", async () => {
    const h = harness({
      finalize: () => {
        throw new Error("磁盘写入失败")
      }
    })
    h.create()
    h.manager.patch("ds_a", { html: "旧设计" })
    h.manager.start({
      requestId: "iteration",
      designSessionId: "ds_a",
      kind: "agent",
      prompt: "修改",
      rollback: {
        html: "旧设计",
        comments: [
          { id: "comment", pageX: 1, pageY: 2, text: "修改", elementDesc: "按钮", createdAt: 1 }
        ]
      }
    })
    await Promise.resolve()
    h.emitters.get("iteration")!({ type: "done", html: "新设计" })
    const state = h.store.get("ds_a")!.state
    expect(state.html).toBe("旧设计")
    expect(state.comments[0].id).toBe("comment")
    expect(state.messages.at(-1)!.content).toContain("磁盘写入失败")
  })

  it("does not resurrect a deleted session from late events or duplicate legacy migration", async () => {
    const h = harness()
    const seed = h.create()
    const emit = await h.start()
    h.manager.create(seed)
    expect(h.manager.list()).toHaveLength(1)
    h.manager.remove("ds_a")
    emit({ type: "done", html: "迟到" })
    expect(h.store.get("ds_a")).toBeNull()
    expect(h.manager.list()).toHaveLength(0)
    h.manager.migrate([seed])
    expect(h.manager.list()).toHaveLength(0)
  })

  it("marks read without duplicating a journal cursor and replaces retry messages losslessly", () => {
    const h = harness()
    h.create()
    h.manager.markRead("ds_a", h.manager.get("ds_a").seq)
    h.manager.markRead("ds_a", h.manager.get("ds_a").seq)
    const user = h.manager.get("ds_a").state.messages[0]
    h.manager.patch("ds_a", { messages: [user, { role: "assistant", content: "旧错误" }] })
    h.manager.patch("ds_a", { messages: [user, { role: "assistant", content: "新结果" }] })
    expect(h.store.get("ds_a")!.state.messages.map((m) => m.content)).toEqual([
      "创建一个页面",
      "新结果"
    ])
  })

  it("retries the original image request with its image input after leaving the page", async () => {
    const h = harness()
    h.create()
    h.manager.start({
      requestId: "image",
      designSessionId: "ds_a",
      kind: "image",
      prompt: "截图",
      imageData: "original-image",
      mimeType: "image/png"
    })
    await Promise.resolve()
    h.emitters.get("image")!({ type: "error", error: "暂时失败" })
    h.manager.retry("ds_a", "image-retry")
    await Promise.resolve()
    expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({
      kind: "image",
      imageData: "original-image",
      mimeType: "image/png"
    })
  })

  it("flushes the final pending progress when the application quits", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    emit({ type: "token", token: "最后一批尚未定时保存的消息" })
    h.manager.interruptAll()
    const snapshot = h.store.get("ds_a")!
    expect(snapshot.state.generationState).toBe("interrupted")
    expect(snapshot.state.messages[1].executionEvents?.[0].content).toContain("最后一批")
    expect(snapshot.activeRunId).toBeNull()
  })

  it("keeps workspace changes separate from an active run's captured configuration", async () => {
    const h = harness()
    h.create()
    const changed = h.manager.setWorkspace("ds_a", "/workspace-a")
    const publishedChanges = h.changes.length
    expect(h.manager.setWorkspace("ds_a", "/workspace-a").seq).toBe(changed.seq)
    expect(h.changes).toHaveLength(publishedChanges)
    const emit = await h.start()
    expect(() => h.manager.setWorkspace("ds_a", "/workspace-a")).not.toThrow()
    expect(() => h.manager.setWorkspace("ds_a", "/workspace-b")).toThrow("运行中")
    emit({ type: "error", error: "结束" })
    h.manager.setWorkspace("ds_a", "/workspace-b")
    expect(h.store.get("ds_a")!.workspacePath).toBe("/workspace-b")
  })

  it("surfaces persistence failure and stops the model instead of leaving a phantom running task", async () => {
    const h = harness()
    h.create()
    const emit = await h.start()
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const save = vi.spyOn(h.store, "save").mockImplementationOnce(() => {
      throw new Error("磁盘不可用")
    })
    try {
      emit({ type: "done", html: "<html>结果</html>" })
      expect(h.deps.abort).toHaveBeenCalledOnce()
      expect(h.manager.get("ds_a").activeRunId).toBeNull()
      expect(h.manager.get("ds_a").state.messages.at(-1)!.content).toContain("保存失败")
      expect(h.store.get("ds_a")!.state.generationState).toBe("generating")
    } finally {
      save.mockRestore()
      log.mockRestore()
    }
  })
})
