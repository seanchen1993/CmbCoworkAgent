import { afterEach, describe, expect, it, vi } from "vitest"
import { DesignDraftPublisher } from "./draft-preview"

afterEach(() => vi.useRealTimers())
const html = (text: string) =>
  `<!doctype html><html><body><section data-design-section="main">${text}</section></body></html>`
describe("draft mutation publishing", () => {
  it("retains checkpoint section identities before the resumed run publishes its first write", async () => {
    const controller = new AbortController(), publish = vi.fn()
    let content = html("a restarted page")
    const publisher = new DesignDraftPublisher({ runId: "continued", workspacePath: "/work",
      draftPath: "continued.html", signal: controller.signal, publish,
      expectedSections: ["main", "details"], read: async () => content })
    expect(publisher.expectedSections).toEqual(["main", "details"])
    publisher.notify("continued.html")
    await publisher.flush()
    expect(publish).not.toHaveBeenCalled()
    content = content.replace("</body>", '<section data-design-section="details">接续完成</section></body>')
    publisher.notify("continued.html")
    await publisher.flush()
    expect(publish).toHaveBeenCalledOnce()
    expect(publisher.latest!.sections).toEqual(["main", "details"])
    controller.abort()
  })
  it("coalesces successful target writes, deduplicates content and retains valid state after malformed writes", async () => {
    vi.useFakeTimers()
    let content = html("first")
    const publish = vi.fn(),
      controller = new AbortController()
    const publisher = new DesignDraftPublisher({
      runId: "run",
      workspacePath: "/work",
      draftPath: "/work/draft.html",
      signal: controller.signal,
      publish,
      read: async () => content
    })
    publisher.notify("/work/unrelated.html")
    await publisher.flush()
    expect(publish).not.toHaveBeenCalled()
    publisher.notify("draft.html")
    await publisher.flush()
    expect(publish).toHaveBeenCalledOnce()
    publisher.notify("draft.html")
    await publisher.flush()
    expect(publish).toHaveBeenCalledOnce()
    content = html("broken").replace("</section>", "")
    publisher.notify("draft.html")
    await publisher.flush()
    expect(publish).toHaveBeenCalledOnce()
    content = html("second")
    publisher.notify("draft.html")
    publisher.notify("draft.html")
    await publisher.flush()
    expect(publisher.latest!.revision).toBe(2)
    expect(publish).toHaveBeenCalledTimes(2)
    controller.abort()
    content = html("late")
    publisher.notify("draft.html")
    await publisher.flush()
    expect(publish).toHaveBeenCalledTimes(2)
  })
  it("fences asynchronous reads when the recovery candidate changes or the run stops", async () => {
    const controller = new AbortController(),
      publish = vi.fn()
    let finish!: (value: string) => void
    const publisher = new DesignDraftPublisher({
      runId: "run",
      workspacePath: "/work",
      draftPath: "old.html",
      signal: controller.signal,
      publish,
      read: () =>
        new Promise((done) => {
          finish = done
        })
    })
    publisher.notify("old.html")
    const reading = publisher.flush()
    await Promise.resolve()
    await Promise.resolve()
    publisher.setCandidate("new.html")
    finish(html("old"))
    await reading
    expect(publish).not.toHaveBeenCalled()
    publisher.notify("new.html")
    const next = publisher.flush()
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    finish(html("new"))
    await next
    expect(publish).not.toHaveBeenCalled()
  })
})
