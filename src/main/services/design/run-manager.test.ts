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
    h.manager.setWorkspace("ds_a", "/workspace-a")
    const emit = await h.start()
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
