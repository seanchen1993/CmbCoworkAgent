import type { WebContents } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readWpsDocumentText } from "./wps-document"

const frame = (name: string, text = "需求正文") => ({
  name,
  url: "https://fixture.test/document",
  detached: false,
  executeJavaScript: vi.fn<(script: string) => Promise<{ text: string; totalChars: number }>>(
    async () => ({ text, totalChars: text.length })
  )
})
function contents(frames: ReturnType<typeof frame>[]) {
  const main = { framesInSubtree: [] as unknown[] }
  main.framesInSubtree = [main, ...frames]
  return { mainFrame: main, isDestroyed: () => false } as unknown as WebContents
}
afterEach(() => vi.useRealTimers())

describe("shared WPS document reader", () => {
  it("reads the preferred office frame with the async API and keeps the full workbench result", async () => {
    const unrelated = frame("other")
    const office = frame("office-iframe")
    expect(await readWpsDocumentText(contents([unrelated, office]))).toEqual({
      text: "需求正文",
      totalChars: 4,
      textOffset: 0
    })
    expect(unrelated.executeJavaScript).not.toHaveBeenCalled()
    const script = office.executeJavaScript.mock.calls[0][0]
    expect(script).toContain("await doc.GetDocumentRange()")
    expect(script).toContain("await range.Text")
  })
  it("returns an explicit continuation offset for bounded Bot reads", async () => {
    const office = frame("office-iframe")
    office.executeJavaScript.mockResolvedValue({ text: "正文", totalChars: 9 })
    expect(
      await readWpsDocumentText(contents([office]), { textOffset: 2, maxTextChars: 2 })
    ).toEqual({ text: "正文", totalChars: 9, textOffset: 2, nextTextOffset: 4 })
    expect(office.executeJavaScript.mock.calls[0][0]).toContain("text.slice(2, 4)")
  })
  it("falls back to other child frames but never to another page", async () => {
    const office = frame("office-iframe")
    office.executeJavaScript.mockRejectedValue(new Error("not ready"))
    const alternate = frame("editor")
    expect((await readWpsDocumentText(contents([office, alternate]))).text).toBe("需求正文")
    await expect(readWpsDocumentText(contents([]))).rejects.toThrow("office-iframe")
  })
  it("bounds a stalled WPS promise and does not start further frame reads after timeout", async () => {
    vi.useFakeTimers()
    const office = frame("office-iframe")
    let fail!: (reason: Error) => void
    office.executeJavaScript.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject
        })
    )
    const next = frame("editor")
    const result = readWpsDocumentText(contents([office, next])).catch((error) => error.message)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await result).toContain("超时")
    fail(new Error("late failure"))
    await Promise.resolve()
    expect(next.executeJavaScript).not.toHaveBeenCalled()
  })
  it("rejects invalid read sizes and results from a navigated frame", async () => {
    const office = frame("office-iframe")
    const page = contents([office])
    await expect(readWpsDocumentText(page, { textOffset: -1 })).rejects.toThrow("范围")
    await expect(readWpsDocumentText(page, { maxTextChars: 50_001 })).rejects.toThrow("范围")
    office.executeJavaScript.mockImplementation(async () => {
      office.url = "https://fixture.test/replaced"
      return { text: "stale", totalChars: 5 }
    })
    await expect(readWpsDocumentText(page)).rejects.toThrow("页面已改变")
  })
})
