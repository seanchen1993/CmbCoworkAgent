import { describe, expect, it, vi } from "vitest"
import { DesignSessionClient } from "../components/design/session-client"
import {
  createDesignState,
  type DesignSessionApi,
  type DesignSessionChange,
  type DesignSessionSnapshot
} from "../../../shared/managed-design-session"

function snapshot(seq: number, text: string, id = "ds_a"): DesignSessionSnapshot {
  return {
    id,
    seq,
    meta: { id, title: text, createdAt: 1, updatedAt: seq },
    state: { ...createDesignState(), messages: [{ id: "m1", role: "assistant", content: text }] },
    workspacePath: "/workspace",
    activeRunId: null,
    lastSeenSeq: 0
  }
}
function fixture() {
  let listener: (change: DesignSessionChange) => void = () => undefined
  const api: DesignSessionApi = {
    list: vi.fn(async () => []),
    migrate: vi.fn(async () => []),
    create: vi.fn(async () => snapshot(1, "创建")),
    open: vi.fn(async () => snapshot(1, "快照")),
    close: vi.fn(async () => undefined),
    patch: vi.fn(async () => snapshot(2, "修改")),
    start: vi.fn(async () => snapshot(3, "生成")),
    setWorkspace: vi.fn(async () => snapshot(2, "工作目录")),
    retry: vi.fn(async () => snapshot(4, "重试")),
    stop: vi.fn(async () => snapshot(4, "停止")),
    delete: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    onChange: vi.fn((callback) => {
      listener = callback
      return () => undefined
    })
  }
  const client = new DesignSessionClient(api)
  const emit = (s: DesignSessionSnapshot) =>
    listener({ id: s.id, seq: s.seq, meta: s.meta, snapshot: s })
  return { api, client, emit, change: (event: DesignSessionChange) => listener(event) }
}

describe("design view reconnect", () => {
  it("reuses draft HTML for metadata-only updates and fetches a full snapshot after a missing revision", async () => {
    const h = fixture()
    await h.client.initialize([])
    await h.client.open("ds_a")
    const first = snapshot(2, "骨架")
    first.state.draftPreview = {
      runId: "run",
      revision: 1,
      html: "<html>large-draft</html>",
      draftPath: "/draft.html",
      phase: "scaffold",
      status: "building",
      sections: [],
      completedSections: [],
      totalSections: 0,
      tweaks: null,
      createdAt: 1,
      updatedAt: 1
    }
    h.emit(first)
    const metadata = structuredClone(first)
    metadata.seq = 3
    metadata.state.draftPreview!.html = ""
    h.change({
      id: "ds_a",
      seq: 3,
      meta: metadata.meta,
      snapshot: metadata,
      draftHtmlOmitted: true
    })
    expect(h.client.get("ds_a")!.state.draftPreview!.html).toBe("<html>large-draft</html>")
    const full = structuredClone(first)
    full.seq = 5
    full.state.draftPreview!.revision = 2
    full.state.draftPreview!.html = "<html>updated</html>"
    vi.mocked(h.api.open).mockResolvedValue(full)
    const missing = structuredClone(full)
    missing.seq = 4
    missing.state.draftPreview!.html = ""
    h.change({ id: "ds_a", seq: 4, meta: missing.meta, snapshot: missing, draftHtmlOmitted: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.client.get("ds_a")!.state.draftPreview!.html).toBe("<html>updated</html>")
  })

  it("registers the stream before fetching a snapshot and keeps events newer than the reply", async () => {
    const h = fixture()
    await h.client.initialize([])
    let reply!: (s: DesignSessionSnapshot) => void
    vi.mocked(h.api.open).mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    const opening = h.client.open("ds_a")
    await Promise.resolve()
    h.emit(snapshot(3, "打开期间产生的新消息"))
    reply(snapshot(2, "较旧快照"))
    await opening
    expect(h.client.get("ds_a")!.state.messages[0].content).toBe("打开期间产生的新消息")
    expect(h.api.onChange).toHaveBeenCalledOnce()
  })

  it("detaches without stopping and restores messages accumulated while absent", async () => {
    const h = fixture()
    await h.client.initialize([])
    await h.client.open("ds_a")
    const render = vi.fn()
    const unsubscribe = h.client.subscribe(render)
    unsubscribe()
    h.client.close("ds_a")
    h.change({ id: "ds_a", seq: 8, meta: snapshot(8, "后台完成").meta })
    vi.mocked(h.api.open).mockResolvedValue(snapshot(8, "离开期间的消息与结果"))
    await h.client.open("ds_a")
    expect(h.client.get("ds_a")!.state.messages[0].content).toBe("离开期间的消息与结果")
    expect(render).not.toHaveBeenCalled()
    expect(h.api.stop).not.toHaveBeenCalled()
    expect(h.client.list()[0].title).toBe("离开期间的消息与结果")
  })

  it("serializes user input persistence before starting model execution", async () => {
    const h = fixture()
    await h.client.initialize([])
    let save!: () => void
    vi.mocked(h.api.patch).mockImplementation(
      () =>
        new Promise((resolve) => {
          save = () => resolve(snapshot(2, "用户消息"))
        })
    )
    const saving = h.client.patch("ds_a", { messages: [{ role: "user", content: "用户消息" }] })
    const starting = h.client.start({
      designSessionId: "ds_a",
      requestId: "r",
      kind: "agent",
      prompt: "生成"
    })
    await Promise.resolve()
    expect(h.api.start).not.toHaveBeenCalled()
    save()
    await saving
    await starting
    expect(h.api.start).toHaveBeenCalledOnce()
  })

  it("does not execute a queued run when saving its user input fails", async () => {
    const h = fixture()
    await h.client.initialize([])
    vi.mocked(h.api.patch).mockRejectedValue(new Error("保存失败"))
    const saving = h.client.patch("ds_a", { inputValue: "草稿" })
    const starting = h.client.start({
      designSessionId: "ds_a",
      requestId: "r",
      kind: "agent",
      prompt: "生成"
    })
    await expect(saving).rejects.toThrow("保存失败")
    await expect(starting).rejects.toThrow("保存失败")
    expect(h.api.start).not.toHaveBeenCalled()
  })

  it("ignores late snapshots and metadata after a deletion", async () => {
    const h = fixture()
    await h.client.initialize([])
    h.emit(snapshot(3, "旧记录"))
    h.change({ id: "ds_a", seq: 5, meta: snapshot(5, "").meta, deleted: true })
    h.emit(snapshot(4, "迟到记录"))
    expect(h.client.get("ds_a")).toBeUndefined()
    expect(h.client.list()).toHaveLength(0)
  })

  it("does not let an older open reply detach a newer subscription", async () => {
    const h = fixture()
    await h.client.initialize([])
    let first!: (s: DesignSessionSnapshot) => void
    vi.mocked(h.api.open).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve
        })
    )
    const old = h.client.open("ds_a")
    await Promise.resolve()
    h.client.close("ds_a")
    vi.mocked(h.api.open).mockResolvedValue(snapshot(5, "新打开"))
    await h.client.open("ds_a")
    first(snapshot(1, "旧打开"))
    await old
    expect(h.api.close).toHaveBeenCalledTimes(1)
    expect(h.client.get("ds_a")!.seq).toBe(5)
  })
})
