import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import { projectBotExecution } from "./bot-execution-visibility"
import { getWorkerToolUiKey } from "./worker-tool-result-key"
const created_at = new Date(2026, 9, 14)

const call = (id: string, name = "read_file", content = ""): Message => ({
  id,
  role: "assistant",
  content,
  created_at,
  tool_calls: [{ id: `call-${id}`, name, args: {} }]
})
const result = (id: string, is_error = false, content = "done"): Message => ({
  id: `result-${id}`,
  role: "tool",
  tool_call_id: `call-${id}`,
  content,
  created_at,
  is_error
})

describe("Bot execution presentation", () => {
  it("folds completed directory and memory reads but preserves errors and the user-facing answer", () => {
    const tools = [
      "bot_list_peers",
      "bot_memory_search",
      "bot_memory_list",
      "bot_memory_get",
      "bot_remember",
      "bot_forget"
    ]
    const messages = tools.flatMap((name) => [call(name, name), result(name)])
    messages.push(
      call("conflict", "bot_forget"),
      result("conflict", true, "记忆已更新，请刷新后重试"),
      call("answer", "bot_memory_get", "当前保存的偏好是24小时制。"),
      result("answer")
    )
    const view = projectBotExecution(messages, false, new Set())
    expect([...view.hiddenMessages]).toEqual(tools)
    expect(view.foldedTools.has(getWorkerToolUiKey("answer", "call-answer", 0))).toBe(true)
    expect(view.foldedTools.has(getWorkerToolUiKey("conflict", "call-conflict", 0))).toBe(false)
  })
  it("folds successful execution records while preserving messages and delivered files", () => {
    const messages = [
      { id: "user", role: "user", content: "read and deliver" } as Message,
      call("read"),
      result("read"),
      call("answer", "read_file", "Here is the result"),
      result("answer"),
      call("files", "bot_deliver_files"),
      result("files"),
      call("peer", "bot_delegate"),
      result("peer"),
      { id: "thought", role: "assistant", content: "<think>analysis</think>" } as Message
    ]
    const view = projectBotExecution(messages, false, new Set())
    expect([...view.hiddenMessages]).toEqual(["read", "thought"])
    expect([...view.foldedTools]).toEqual([
      getWorkerToolUiKey("read", "call-read", 0),
      getWorkerToolUiKey("answer", "call-answer", 0)
    ])
    expect(messages).toHaveLength(10)
  })
  it("never folds pending, failed, cancelled, unknown or interactive tools", () => {
    const messages = [
      call("pending"),
      call("failed"),
      result("failed", true),
      call("failed-command", "execute"),
      result("failed-command", false, "[Command failed with exit code 1]"),
      call("cancelled"),
      result(
        "cancelled",
        false,
        "Tool call read_file with id call-cancelled was cancelled - another message came in before it could be completed."
      ),
      call("custom", "custom_tool"),
      result("custom"),
      call("help", "bot_request_browser_help"),
      result("help"),
      {
        ...call("legacy-help", "bot_browser"),
        tool_calls: [
          { id: "call-legacy-help", name: "bot_browser", args: { action: "request_help" } }
        ]
      },
      result("legacy-help"),
      call("mod"),
      result("mod")
    ]
    const view = projectBotExecution(messages, false, new Set(["call-mod"]))
    expect([...view.hiddenMessages]).toEqual([])
    expect([...view.foldedTools]).toEqual([])
  })
  it("keeps the active last response until it is settled and preserves nontext content", () => {
    const messages: Message[] = [
      {
        id: "image",
        role: "assistant",
        created_at,
        content: [{ type: "image", content: "data:image/png;base64,test" }]
      },
      { id: "stream", role: "assistant", content: "", reasoning: "thinking", created_at }
    ]
    expect([...projectBotExecution(messages, true, new Set()).hiddenMessages]).toEqual([])
    expect([...projectBotExecution(messages, false, new Set()).hiddenMessages]).toEqual(["stream"])
  })
  it("folds confirmed live tools and restores the same row when a result is enriched into an error", () => {
    const messages: Message[] = [
      call("old"),
      result("old"),
      { id: "user", role: "user", content: "next", created_at },
      call("active"),
      result("active")
    ]
    expect([...projectBotExecution(messages, true, new Set()).hiddenMessages]).toEqual([
      "old",
      "active"
    ])
    messages[4] = result("active", true, "late failure")
    expect([...projectBotExecution(messages, true, new Set()).hiddenMessages]).toEqual(["old"])
  })
  it("removes consecutive live execution shells without removing progress, cards or the growing reply", () => {
    const committed: Message[] = [
      { id: "user", role: "user", content: "build six files", created_at }
    ]
    const live = [
      call("progress", "execute", "开始创建文件。"),
      result("progress"),
      ...Array.from({ length: 6 }, (_, i) => [
        call(`write-${i}`, "write_file"),
        result(`write-${i}`)
      ]).flat(),
      call("mod"),
      result("mod"),
      call("pending"),
      call("choice", "request_user_input"),
      { id: "reply", role: "assistant", content: "", reasoning: "pending", created_at } as Message
    ]
    // The committed parent cannot see these rows; the list must project the merged timeline.
    expect(projectBotExecution(committed, true, new Set()).hiddenMessages.size).toBe(0)
    const view = projectBotExecution([...committed, ...live], true, new Set(["call-mod"]))
    expect([...view.hiddenMessages]).toEqual(Array.from({ length: 6 }, (_, i) => `write-${i}`))
    expect(committed).toHaveLength(1)
    expect(live.at(-1)?.content).toBe("")
  })
  it("folds only valid successful routine reads, preserving changes, errors, pending and Mod UI", () => {
    const scheduleCall = (id: string, action: string): Message => ({
      ...call(id, "bot_schedule"),
      tool_calls: [{ id: `call-${id}`, name: "bot_schedule", args: { action } }]
    })
    const messages = [
      scheduleCall("list", "list"),
      result("list", false, "[]"),
      scheduleCall("pending-routine", "list"),
      scheduleCall("invalid-list", "list"),
      result("invalid-list", false, '[{"error":"failed"}]'),
      scheduleCall("failed-routine", "list"),
      result("failed-routine", true, "[]"),
      scheduleCall("saved", "save"),
      result("saved", false, "{}"),
      scheduleCall("removed", "remove"),
      result("removed", false, "例行任务已删除，排队中的触发已取消。"),
      scheduleCall("mod-routine", "list"),
      result("mod-routine", false, "[]")
    ]
    expect([
      ...projectBotExecution(messages, false, new Set(["call-mod-routine"])).hiddenMessages
    ]).toEqual(["list"])
    expect([
      ...projectBotExecution(messages, true, new Set(["call-mod-routine"])).hiddenMessages
    ]).toEqual(["list"])
  })
})
