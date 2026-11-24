import { describe, expect, it } from "vitest"
import type { ToolCall, ToolResult } from "@/types"
import { botBrowserHelpHistory } from "./bot-browser-help-history"

const note =
  "Human control ended. You now have control again. The pending action was replaced with this fresh observation; it was not replayed. Verify the result before requesting any further user action."
const receipt = (value: unknown): Pick<ToolResult, "content"> => ({ content: JSON.stringify(value) })
const help = (legacy = false): ToolCall => ({
  id: "exact-help-call",
  name: legacy ? "bot_browser" : "bot_request_browser_help",
  args: { ...(legacy ? { action: "request_help" } : {}), instruction: " 请确认合成页面 " }
})

describe("persisted browser help history", () => {
  it.each([false, true])("projects explicit skip for the original help call (legacy=%s)", (legacy) => {
    expect(botBrowserHelpHistory(help(legacy), receipt({ helpSkipped: true, control: "bot" }))).toEqual({
      status: "skipped", instruction: "请确认合成页面"
    })
    // A skip remains an explicit receipt even if the page was closed during the handoff.
    expect(botBrowserHelpHistory(help(legacy), receipt({ helpSkipped: true, closed: "page", pages: [], control: "bot" }))?.status).toBe("skipped")
  })
  it("requires the host's fresh human-return marker for a normal ended card", () => {
    expect(botBrowserHelpHistory(help(), receipt({ control: "bot", note }))).toEqual({
      status: "ended", instruction: "请确认合成页面"
    })
    for (const value of [{ control: "bot", title: "Page" }, { note }, { control: "bot", note: "ordinary observe" }, { title: "Old receipt", generation: 2 }])
      expect(botBrowserHelpHistory(help(), receipt(value))).toBeNull()
    expect(botBrowserHelpHistory({ ...help(), name: "bot_browser", args: { action: "observe", instruction: "请确认合成页面" } }, receipt({ control: "bot", note, helpSkipped: true }))).toBeNull()
  })
  it("preserves existing failure/cancellation/malformed handling without inventing completion", () => {
    const tool = help()
    for (const result of [
      { ...receipt({ helpSkipped: true }), is_error: true },
      receipt({ ok: false, helpSkipped: true }), receipt({ error: "failed", helpSkipped: true }),
      receipt({ helpSkipped: "true" }), receipt({ control: "human", helpSkipped: true }),
      receipt(null), receipt([]), { content: "not JSON" },
      { content: `Tool call ${tool.name} with id ${tool.id} was cancelled - another message came in before it could be completed.` }
    ]) expect(botBrowserHelpHistory(tool, result)).toBeNull()
    expect(botBrowserHelpHistory({ ...tool, args: {} }, receipt({ helpSkipped: true }))).toBeNull()
    expect(botBrowserHelpHistory({ ...tool, args: { instruction: " " } }, receipt({ helpSkipped: true }))).toBeNull()
  })
  it("accepts original text-block receipts and remains a pure rebuild after reload", () => {
    const tool = help(), result = { content: [{ type: "text" as const, text: '{"helpSkipped":true}' }] }
    const expected = { status: "skipped", instruction: "请确认合成页面" }
    expect(botBrowserHelpHistory(tool, result)).toEqual(expected)
    expect(botBrowserHelpHistory(JSON.parse(JSON.stringify(tool)), JSON.parse(JSON.stringify(result)))).toEqual(expected)
  })
})
