import { describe, expect, it, vi } from "vitest"
import { CanvasEditorFlush } from "./canvas-editor-flush"

describe("cross-origin editor flush", () => {
  it("can leave an editor that has not become ready", async () => {
    const send = vi.fn()
    await new CanvasEditorFlush().flush(send)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["before", "after"])("waits for a save received %s the flush request when the frame disappears", async (order) => {
    const bridge = new CanvasEditorFlush()
    bridge.ready = true
    let commit!: () => void
    const saving = new Promise<void>((resolve) => { commit = resolve })
    if (order === "before") bridge.track(saving)
    let finished = false
    const flushing = bridge.flush(() => true).then(() => { finished = true })
    if (order === "after") bridge.track(saving)
    bridge.close()
    await Promise.resolve()
    expect(finished).toBe(false)
    commit()
    await flushing
    expect(finished).toBe(true)
  })

  it("propagates the database error after the frame is replaced", async () => {
    const bridge = new CanvasEditorFlush()
    bridge.ready = true
    const flushing = bridge.flush(() => true)
    bridge.track(Promise.reject(new Error("数据库写入失败")))
    bridge.close()
    await expect(flushing).rejects.toThrow("数据库写入失败")
  })

  it("fails promptly when a ready frame disappears without submitting its edits", async () => {
    const bridge = new CanvasEditorFlush()
    bridge.ready = true
    const flushing = bridge.flush(() => true)
    bridge.close()
    await expect(flushing).rejects.toThrow("无法确认")
  })
})
