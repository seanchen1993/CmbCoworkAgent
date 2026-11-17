import { describe, expect, it, vi } from "vitest"
import { createRuntimeToolDenylistMiddleware } from "./runtime"
import { createForegroundWorkBudget, createForegroundWorkBudgetMiddleware } from "./foreground-work-budget"
import { BOT_COMMUNICATION_BLOCKED_TOOLS } from "../bots/prompt"

describe("main Bot browser boundary", () => {
  it("hides both browser entry points and rejects recovered calls before the budget or handler", async () => {
    const guard = createRuntimeToolDenylistMiddleware(BOT_COMMUNICATION_BLOCKED_TOOLS)
    const budget = createForegroundWorkBudget({ yieldCommand: vi.fn() })
    const budgetLayer = createForegroundWorkBudgetMiddleware(budget)
    const beforeTool = vi.spyOn(budget, "beforeTool")
    const execute = vi.fn(async () => "executed")
    const next = (request: unknown) => (budgetLayer.wrapToolCall as Function)(request, execute)
    const tools = ["bot_browser", "bot_request_browser_help", "execute", "bot_work_create", "bot_work_send", "request_user_input"].map(name => ({ name }))
    const visible = (guard.wrapModelCall as Function)({ tools }, (value: unknown) => value)
    expect(visible.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "execute", "bot_work_create", "bot_work_send", "request_user_input"
    ])
    for (const [name, args] of [
      ["bot_browser", { action: "observe" }],
      ["bot_browser", { action: "navigate", url: "https://example.test" }],
      ["bot_browser", { action: "read_wps_document" }],
      ["bot_browser", { action: "request_help" }],
      ["bot_request_browser_help", { instruction: "Login" }]
    ]) {
      const result = await (guard.wrapToolCall as Function)({ toolCall: { name, args, id: "old-call" } }, next)
      expect(result.status).toBe("error")
      expect(result.content).not.toContain("budget")
    }
    expect(execute).not.toHaveBeenCalled()
    expect(beforeTool).not.toHaveBeenCalled()
    expect(budget.checkFinal()).toBeUndefined()
    await (guard.wrapToolCall as Function)({ toolCall: { name: "execute", args: { command: "pwd" }, id: "short" } }, next)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
