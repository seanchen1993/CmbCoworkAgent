import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import {
  createDesignState,
  type DesignRunEvent,
  type DesignSessionSnapshot
} from "../../../shared/managed-design-session"
import {
  reconcileTweaks,
  readTweakDeclaration,
  effectiveTweaks
} from "../../../shared/design-tweaks"
import { DesignSessionStore } from "./session-store"
import { DesignRunManager } from "./run-manager"
import { sourceHash } from "./document-index"

const dbs: NativeSqliteAdapter[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})
const html =
  '<html><head></head><body><section data-design-section="main"><p id="label">before</p></section></body></html>'
const after = html.replace("before", "after")

function setup(project: (snapshot: DesignSessionSnapshot) => void = vi.fn()) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  dbs.push(db)
  const store = new DesignSessionStore(db)
  let emit: (e: DesignRunEvent) => void = () => undefined
  let finish: () => void = () => undefined
  const execute = vi.fn((_request, _id, send) => {
    emit = send
    return new Promise<void>((r) => {
      finish = r
    })
  })
  const dependencies = {
    execute,
    project,
    abort: vi.fn(),
    publish: vi.fn(),
    finalize: (e: DesignRunEvent) => e
  }
  const manager = new DesignRunManager(store, dependencies)
  manager.create({
    id: "ds_patch",
    meta: { id: "ds_patch", title: "patch", createdAt: 1, updatedAt: 1 },
    workspacePath: "/workspace",
    state: { ...createDesignState(), html, artifactPath: "/workspace/index.html" }
  })
  async function start() {
    manager.start({
      designSessionId: "ds_patch",
      requestId: Math.random().toString(),
      kind: "patch",
      prompt: "修改目标",
      currentHtml: "UNTRUSTED FULL PAGE",
      patch: {
        targets: [],
        variationId: null,
        artifactRevision: manager.get("ds_patch").state.artifactRevision ?? 0
      }
    })
    await Promise.resolve()
    await Promise.resolve()
  }
  const done = (base = html, next = after, updates = {}, reads = {}) => {
    emit({
      type: "done",
      html: next,
      artifactPath: "/workspace/index.html",
      patchResult: {
        patch: {
          id: `patch-${Math.random()}`,
          revision: (manager.get("ds_patch").state.artifactRevision ?? 0) + 1,
          mode: "live",
          targetIds: [],
          summary: "局部更新"
        },
        baseSourceHash: sourceHash(base),
        baseTweakRevision: 0,
        tweakReads: reads,
        tweakUpdates: updates
      }
    })
    finish()
  }
  return {
    db,
    store,
    manager,
    project,
    dependencies,
    start,
    done,
    get: () => manager.get("ds_patch"),
    send: (e: DesignRunEvent) => emit(e)
  }
}

describe("durable local patch lifecycle", () => {
  it("excludes renderer full HTML, commits journal/state/outbox and supports undo/redo", async () => {
    const h = setup()
    await h.start()
    expect(h.dependencies.execute.mock.calls[0][0].currentHtml).toBeUndefined()
    expect(h.store.latestRequest("ds_patch")?.currentHtml).toBeUndefined()
    h.done()
    expect(h.get().state.html).toBe(after)
    expect(h.get().state.artifactRevision).toBe(1)
    expect(h.get().state.canUndoPatch).toBe(true)
    h.manager.previewVisible("ds_patch", h.get().state.appliedPatch!.id, 1)
    expect(h.get().state.generationMetrics!.patchVisibleAt).toBeTypeOf("number")
    const visibleSeq = h.get().seq
    h.manager.previewVisible("ds_patch", h.get().state.appliedPatch!.id, 1)
    expect(h.get().seq).toBe(visibleSeq)
    expect(h.store.pendingProjections()).toEqual([])
    expect(h.project).toHaveBeenCalledTimes(1)
    const undone = h.manager.patchHistory("ds_patch", "undo", 1)
    expect(undone.state.html).toBe(html)
    expect(undone.state.canRedoPatch).toBe(true)
    expect(undone.state.canUndoPatch).toBe(false)
    expect(h.manager.patchHistory("ds_patch", "redo", 2).state.html).toBe(after)
  })
  it("keeps the durable version and replays a failed projection on reopen", async () => {
    const h = setup(
      vi.fn(() => {
        throw new Error("disk temporarily unavailable")
      })
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await h.start()
      h.done()
      expect(h.store.get("ds_patch")!.state.html).toBe(after)
      expect(h.store.pendingProjections()).toHaveLength(1)
      const project = vi.fn()
      const reopened = new DesignRunManager(h.store, { ...h.dependencies, project })
      expect(project).toHaveBeenCalledTimes(1)
      expect(reopened.get("ds_patch").state.html).toBe(after)
      expect(h.store.pendingProjections()).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
  it("rejects a stale base and late completion after cancellation", async () => {
    const h = setup()
    await h.start()
    h.done("different")
    expect(h.get().state.html).toBe(html)
    expect(h.get().state.generationState).toBe("error")
    expect(h.store.lastPatch("ds_patch", "undo")).toBeNull()
    await h.start()
    h.manager.stop("ds_patch")
    h.done()
    expect(h.get().state.html).toBe(html)
    expect(h.get().state.generationState).toBe("cancelled")
  })
  it("keeps unrelated user parameter edits and blocks conflicting edits", async () => {
    const h = setup()
    const declaration =
      '<script type="application/design-tweaks+json">{"defaults":{"label":"before","radius":12},"schema":{"label":{"type":"text","label":"文案"},"radius":{"type":"number","label":"圆角"}},"bindings":{"label":[{"type":"text","selector":"#label"}],"radius":[{"type":"css-var","name":"--radius"}]}}</script>'
    const source = html.replace("</head>", declaration + "</head>")
    h.manager.patch("ds_patch", { html: source })
    expect(reconcileTweaks(readTweakDeclaration(source))).not.toBeNull()
    await h.start()
    h.manager.tweak("ds_patch", {
      scope: "artifact",
      baseRevision: h.get().state.tweaks!.revision,
      operation: "set",
      key: "radius",
      value: 20
    })
    h.done(source, source, { label: "new" }, { label: "before" })
    expect(effectiveTweaks(h.get().state.tweaks!)).toEqual({ label: "new", radius: 20 })
    h.manager.patchHistory("ds_patch", "undo", h.get().state.artifactRevision!)
    expect(effectiveTweaks(h.get().state.tweaks!)).toEqual({ label: "before", radius: 20 })
    expect(Object.hasOwn(h.get().state.tweaks!.overrides, "label")).toBe(false)
    await h.start()
    h.manager.tweak("ds_patch", {
      scope: "artifact",
      baseRevision: h.get().state.tweaks!.revision,
      operation: "set",
      key: "label",
      value: "user-newer"
    })
    h.done(source, source, { label: "AI-newer" }, { label: "before" })
    expect(h.get().state.generationState).toBe("error")
    expect(effectiveTweaks(h.get().state.tweaks!).label).toBe("user-newer")
  })
  it("does not project or journal a failed database commit", async () => {
    const h = setup()
    await h.start()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const save = vi.spyOn(h.store, "save").mockImplementationOnce(() => {
      throw new Error("storage unavailable")
    })
    try {
      h.done()
      expect(h.store.get("ds_patch")!.state.html).toBe(html)
      expect(h.project).not.toHaveBeenCalled()
      expect(h.store.lastPatch("ds_patch", "undo")).toBeNull()
    } finally {
      save.mockRestore()
      error.mockRestore()
    }
  })
  it("invalidates patch history after a subsequent direct source edit", async () => {
    const h = setup()
    await h.start()
    h.done()
    h.manager.patch("ds_patch", { html: after.replace("after", "manual") })
    expect(h.get().state.canUndoPatch).toBe(false)
    expect(() =>
      h.manager.patchHistory("ds_patch", "undo", h.get().state.artifactRevision!)
    ).toThrow()
  })
})
