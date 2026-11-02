import { describe, expect, it } from "vitest"
import { AIMessageChunk } from "@langchain/core/messages"
import { DesignLiveOutputTracker, DESIGN_LIVE_OUTPUT_LIMIT, createDesignModelActivity, extractDesignModelReasoning, extractDesignPublicText } from "./design-live-output"
import { TRANSCRIPT_REASONING_MAX_CHARS } from "./transcript-reasoning"

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
  it("reads chat-compatible provider fields and typed reasoning blocks without treating answer text as reasoning", () => {
    const chunk = new AIMessageChunk({ content: "", additional_kwargs: { reasoning_content: "先规划页面" } })
    expect(createDesignModelActivity(chunk, "ai")).toMatchObject({ scope: "ai", reasoning: "先规划页面", reasoningMode: "delta" })
    expect(extractDesignModelReasoning({ kwargs: { additional_kwargs: { reasoning_details: [{ text: "检查布局" }] } } })).toBe("检查布局")
    expect(extractDesignModelReasoning({ content: [
      { type: "thinking", thinking: "先分析" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "再设计" }] },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "最终回答" },
    ] })).toBe("先分析再设计")
    expect(extractDesignModelReasoning({ content: "最终回答" }, true)).toBe("")
  })
  it("keeps reasoning activity visible, honors repeated deltas and reconciles complete snapshots per model call", () => {
    let now = 10
    const tracker = new DesignLiveOutputTracker(() => now)
    tracker.activity({ scope: "one", reasoning: "检查", reasoningMode: "delta" })
    tracker.activity({ scope: "one", reasoning: "检查", reasoningMode: "delta" })
    expect(tracker.reasoning).toBe("检查检查")
    tracker.activity({ scope: "one", reasoning: "检查检查布局", reasoningMode: "snapshot" })
    tracker.activity({ scope: "one", reasoning: "检查检查布局", reasoningMode: "snapshot" })
    now = 1000
    tracker.activity({ scope: "one" })
    tracker.text("\n")
    expect(tracker.snapshot()).toMatchObject({ phase: "thinking", reasoning: "检查检查布局", reasoningChars: 6, updatedAt: 1000 })
    tracker.text("准备生成页面")
    tracker.activity({ scope: "one", reasoning: "检查检查布局", completed: true })
    expect(tracker.snapshot().phase).toBe("model")
    tracker.activity({ scope: "two", reasoning: "再调整配色" })
    // A repeated values snapshot of an earlier call must not change the live call.
    tracker.activity({ scope: "one", reasoning: "检查检查布局", completed: true })
    expect(tracker.reasoning).toBe("检查检查布局\n\n再调整配色")
    expect(tracker.snapshot()).toMatchObject({ phase: "thinking", reasoning: "再调整配色", reasoningScope: "two" })
  })
  it("captures inline thinking for every tag split while keeping reasoning out of generated HTML", () => {
    const source = "<think>先分析</think>\n<html>页面</html>"
    for (let split = 1; split < source.length; split++) {
      const tracker = new DesignLiveOutputTracker()
      tracker.activity({ scope: "inline" })
      tracker.text(source.slice(0, split))
      tracker.text(source.slice(split))
      expect(tracker.reasoning, `split ${split}`).toBe("先分析")
      expect(tracker.snapshot().text, `split ${split}`).toBe("\n<html>页面</html>")
    }
    const tracker = new DesignLiveOutputTracker()
    tracker.activity({ scope: "inline" })
    for (const char of source) tracker.text(char)
    expect(tracker.reasoning).toBe("先分析")
    expect(tracker.snapshot().text).toBe("\n<html>页面</html>")
    tracker.activity(createDesignModelActivity({ content: source }, "inline", "snapshot", true))
    expect(tracker.reasoning).toBe("先分析")
  })
  it("bounds live reasoning independently from the saved transcript and gives provider fields precedence over inline copies", () => {
    const tracker = new DesignLiveOutputTracker()
    tracker.activity({ scope: "ai", reasoning: "思".repeat(2000) })
    tracker.text("<think>重复思考</think>")
    expect(tracker.reasoning).toBe("思".repeat(2000))
    expect(tracker.snapshot().reasoning).toHaveLength(DESIGN_LIVE_OUTPUT_LIMIT)
    expect(tracker.snapshot().chars).toBe(0)
    tracker.activity({ scope: "ai", reasoning: "考".repeat(TRANSCRIPT_REASONING_MAX_CHARS) })
    tracker.activity({ scope: "other", reasoning: "later" })
    expect(tracker.reasoning.length).toBeLessThanOrEqual(TRANSCRIPT_REASONING_MAX_CHARS + 30)
    expect(tracker.snapshot()).toMatchObject({ phase: "thinking", reasoning: "later", reasoningChars: 5 })
  })
})
