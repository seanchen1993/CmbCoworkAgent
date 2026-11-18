import { describe, expect, it } from "vitest"
import { botThreadHistoryHref, type BotThreadHistoryPage } from "../../../shared/bots/thread-history"
import type { ToolCall, Message } from "@/types"
import { botHistoryReceipt } from "./bot-history-receipt"
import { projectBotExecution } from "./bot-execution-visibility"

const conversation = {
  kind: "local_thread" as const, threadId: "ordinary-thread",
  incarnation: { token: "original", legacyCreatedAt: 123 }
}
const source = { conversation, messageId: "original-message" }
const tool: ToolCall = { id: "read-call", name: "bot_thread_read", args: { conversation } }
const page: BotThreadHistoryPage = {
  thread: { conversation, title: "Original form", workspacePath: "/project", updatedAt: 1 },
  entries: [{ source, href: botThreadHistoryHref(source), role: "user", ordinal: 1, text: "Keep the unsaved form", truncated: false }],
  nextCursor: null, scanned: 1, coverage: "exhausted"
}
const result = (receipt: unknown = page) => ({
  content: JSON.stringify({ kind: "bot-work-receipt", operation: tool.name, receipt })
})

describe("ordinary thread history receipt", () => {
  it("keeps the exact successful source visible even when the assistant writes no link", () => {
    expect(botHistoryReceipt(tool, result())).toEqual(page)
    const messages = [
      { id: "assistant", role: "assistant", content: "", tool_calls: [tool] },
      { id: "result", role: "tool", tool_call_id: tool.id, ...result() }
    ] as Message[]
    const view = projectBotExecution(messages, false, new Set())
    expect(view.hiddenMessages.has("assistant")).toBe(false)
    expect(view.foldedTools.size).toBe(0)
    messages[1].content = result({ ...page, entries: [] }).content
    expect(projectBotExecution(messages, false, new Set()).hiddenMessages.has("assistant")).toBe(true)
  })

  it.each([
    ["thread", { ...conversation, threadId: "another" }],
    ["token", { ...conversation, incarnation: { ...conversation.incarnation, token: "recreated" } }],
    ["legacy identity", { ...conversation, incarnation: { ...conversation.incarnation, legacyCreatedAt: 456 } }]
  ])("rejects a mismatched %s in the request, page or source", (_name, other) => {
    expect(botHistoryReceipt({ ...tool, args: { conversation: other } }, result())).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, thread: { ...page.thread, conversation: other } }))).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, entries: [{ ...page.entries[0], source: { ...source, conversation: other } }] }))).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, entries: [{ ...page.entries[0], href: botThreadHistoryHref({ ...source, conversation: other as typeof conversation }) }] }))).toBeNull()
  })

  it("rejects failed, malformed and unrelated receipts instead of inventing navigation", () => {
    expect(botHistoryReceipt(tool, { ...result(), is_error: true })).toBeNull()
    expect(botHistoryReceipt(tool, { content: "not JSON" })).toBeNull()
    expect(botHistoryReceipt(tool, { content: JSON.stringify({ kind: "bot-work-receipt", operation: "bot_thread_list", receipt: page }) })).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, entries: [null] }))).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, entries: Array(25).fill(page.entries[0]) }))).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, entries: [{ ...page.entries[0], source: { ...source, messageId: "different" } }] }))).toBeNull()
    expect(botHistoryReceipt(tool, result({ ...page, entries: [{ ...page.entries[0], href: "https://example.com" }] }))).toBeNull()
    expect(botHistoryReceipt({ ...tool, args: { conversation, messageId: "absent" } }, result())).toBeNull()
    expect(botHistoryReceipt({ ...tool, args: { conversation, messageId: " original-message " } }, result())).toEqual(page)
  })
})
