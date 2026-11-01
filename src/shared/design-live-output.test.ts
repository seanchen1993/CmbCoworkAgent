import { describe, expect, it } from "vitest"
import { DesignLiveOutputTracker, DESIGN_LIVE_OUTPUT_LIMIT, extractDesignPublicText } from "./design-live-output"

describe("Design recent public output", () => {
  it("keeps a bounded tail while counting actual output and last activity", () => {
    let now = 10
    const tracker = new DesignLiveOutputTracker(() => now)
    expect(tracker.snapshot().phase).toBe("waiting")
    tracker.text("<html>" + "x".repeat(20_000))
    const before = tracker.snapshot()
    expect(before.chars).toBe(20_006)
    expect(before.text).toHaveLength(DESIGN_LIVE_OUTPUT_LIMIT)
    now = 5000
    tracker.activity({ scope: "next" })
    expect(tracker.snapshot()).toMatchObject({ updatedAt: 5000, outputAt: 10, text: before.text, chars: before.chars })
  })
  it("excludes private reasoning blocks and split think tags but retains public code", () => {
    expect(extractDesignPublicText([
      { type: "thinking", text: "hidden" }, { type: "reasoning", text: "hidden" },
      { type: "text", text: "visible" }, { type: "output_text", text: " code" }
    ])).toBe("visible code")
    const tracker = new DesignLiveOutputTracker()
    for (const text of ["<thi", "nk>hidden", "</th", "ink>公开内容\n<html>", "\n", "<body>页面</body></html>"]) tracker.text(text)
    expect(tracker.snapshot().text).toBe("公开内容\n<html>\n<body>页面</body></html>")
    tracker.activity({ scope: "new-message" })
    tracker.text("继续")
    expect(tracker.snapshot().text).toContain("继续")
  })
  it("shows generated arguments before the JSON is complete, including escaped/split Unicode", () => {
    const tracker = new DesignLiveOutputTracker()
    const json = JSON.stringify({ file_path: "/private/file.html", old_string: "OLD", new_string: '<h1>新内容</h1>\n<style>.card{color:"red"}</style>' })
    // One character per chunk exercises escapes and field names crossing chunk boundaries.
    for (let i = 0; i < json.length - 1; i++) tracker.activity({
      scope: "ai-1", toolCallChunks: [{ index: 0, ...(i === 0 ? { id: "call-1", name: "edit_file" } : {}), args: json[i] }]
    })
    expect(tracker.snapshot()).toMatchObject({ phase: "file", toolName: "edit_file", text: '<h1>新内容</h1>\n<style>.card{color:"red"}</style>' })
    expect(tracker.snapshot().text).not.toMatch(/OLD|private/)
    tracker.activity({ scope: "ai-2", toolCallChunks: [{ id: "call-2", name: "write_file", args: '{"content":"\\u4f60' }] })
    tracker.activity({ scope: "ai-2", toolCallChunks: [{ args: '\\u597d"}' }] })
    expect(tracker.snapshot().text).toContain("你好")
  })
  it("never prints read tool data or arbitrary arguments", () => {
    const tracker = new DesignLiveOutputTracker()
    tracker.activity({ scope: "ai-1", toolCallChunks: [{ name: "read_file", args: '{"content":"not generated"}' }] })
    tracker.activity({ scope: "ai-1", toolCallChunks: [{ index: 1, name: "other", args: '{"content":"not generated"}' }] })
    expect(tracker.snapshot().text).toBe("")
    tracker.phase("tool", "read_file")
    expect(tracker.snapshot().phase).toBe("tool")
  })
})
