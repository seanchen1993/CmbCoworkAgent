import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createForegroundWorkBudget,
  createForegroundWorkBudgetMiddleware
} from "./foreground-work-budget"
import { ToolMessage } from "@langchain/core/messages"

afterEach(() => vi.useRealTimers())
const receipt = (operation: string) =>
  new ToolMessage({
    tool_call_id: "dispatch",
    content: JSON.stringify({ kind: "bot-work-receipt", operation, receipt: operation === "bot_work_create" ? { work: { id: "work", botId: "bot", threadId: "thread" }, task: { id: "accepted", botId: "bot", workId: "work", threadId: "thread", state: "queued" } } : { operation: { id: "operation", action: "continue", state: "active", threadId: "thread" } } })
  })

describe("main Bot foreground allowance", () => {
  it("allows short work and free coordination, then blocks BEFORE another effect", async () => {
    const budget = createForegroundWorkBudget({ yieldCommand: vi.fn(), maxOperations: 2 })
    const middleware = createForegroundWorkBudgetMiddleware(budget)
    const handler = vi.fn(async () => new ToolMessage({ content: "done", tool_call_id: "call" }))
    const run = (name: string) =>
      (middleware.wrapToolCall as Function)({ toolCall: { name, id: "call", args: {} } }, handler)
    await run("read_file")
    await run("bot_schedule")
    await run("bot_work_read")
    await run("edit_file")
    const blocked = await run("execute")
    expect(handler).toHaveBeenCalledTimes(4)
    expect(blocked.status).toBe("success")
    expect(JSON.parse(blocked.content)).toMatchObject({ kind: "bot-foreground-continuation", executed: false, reason: "foreground_budget" })
    expect(blocked.content).toContain("has NOT run")
    expect(budget.checkFinal()).toContain("remaining assignment")
    // Rejected/invalid dispatches cannot masquerade as a background handoff.
    budget.afterTool(
      "bot_work_create",
      new ToolMessage({ content: "failed", status: "error", tool_call_id: "dispatch" })
    )
    budget.afterTool("bot_feature_update", receipt("bot_feature_update"), { action: "follow" })
    expect(budget.checkFinal()).toBeDefined()
    budget.afterTool("bot_work_create", receipt("bot_work_create"))
    expect(budget.checkFinal()).toBeUndefined()
    expect(budget.beforeTool("execute", {})).toBeDefined()
  })

  it("does not reuse an earlier unrelated dispatch to satisfy a later exhausted assignment", () => {
    const budget = createForegroundWorkBudget({ yieldCommand: vi.fn(), maxOperations: 1 })
    budget.afterTool("bot_work_create", receipt("bot_work_create"))
    budget.beforeTool("read_file", {})
    budget.beforeTool("edit_file", {})
    expect(budget.checkFinal()).toBeDefined()
    budget.afterTool("bot_feature_update", receipt("bot_feature_update"), { action: "continue" })
    expect(budget.checkFinal()).toBeUndefined()
  })

  it("keeps group discovery and delivery outside the execution allowance", () => {
    let clock = 0
    const budget = createForegroundWorkBudget({
      yieldCommand: vi.fn(),
      now: () => clock,
      maxOperations: 1,
      maxDurationMs: 30
    })
    expect(budget.beforeTool("bot_list_groups", {})).toBeUndefined()
    clock += 31
    expect(budget.beforeTool("bot_send_message", {})).toBeUndefined()
    // Group coordination must neither spend an operation nor start the execution timer.
    expect(budget.beforeTool("read_file", {})).toBeUndefined()
    expect(budget.beforeTool("edit_file", {})).toBeDefined()
    // Coordination stays available after execution needs to be handed off.
    expect(budget.beforeTool("bot_list_groups", {})).toBeUndefined()
    expect(budget.beforeTool("bot_send_message", {})).toBeUndefined()
    expect(budget.checkFinal()).toBeDefined()
  })

  it("bounds cumulative execution time, but keeps user interaction and task control available", () => {
    let clock = 0
    const budget = createForegroundWorkBudget({
      yieldCommand: vi.fn(),
      now: () => clock,
      maxDurationMs: 30
    })
    clock = 1000
    expect(budget.beforeTool("request_user_input", {})).toBeUndefined()
    expect(budget.beforeTool("read_file", {})).toBeUndefined()
    clock += 31
    expect(budget.beforeTool("read_file", {})).toBeDefined()
    for (const name of [
      "request_user_input",
      "bot_request_browser_help",
      "bot_work_send",
      "bot_work_list",
      "bot_schedule"
    ])
      expect(budget.beforeTool(name, {})).toBeUndefined()
  })

  it.each(["task", "workflow"])("redirects an awaited %s before it launches", (name) => {
    const budget = createForegroundWorkBudget({ yieldCommand: vi.fn() })
    expect(budget.beforeTool(name, {})).toContain("bot_work_create")
  })

  it("retries same-process yield after a human wait and clears the timer after tool settlement", async () => {
    vi.useFakeTimers()
    let waiting = true
    const handedOff = vi.fn()
    const budget = createForegroundWorkBudget({
      yieldCommand: () => {
        if (!waiting) handedOff()
      }
    })
    let finish!: (value: ToolMessage) => void
    const handler = vi.fn(
      () =>
        new Promise<ToolMessage>((resolve) => {
          finish = resolve
        })
    )
    const pending = (createForegroundWorkBudgetMiddleware(budget).wrapToolCall as Function)(
      { toolCall: { name: "execute", id: "one", args: { command: "long work" } } },
      handler
    )
    await vi.advanceTimersByTimeAsync(20_000)
    expect(handedOff).not.toHaveBeenCalled()
    waiting = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(handedOff).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledOnce()
    finish(new ToolMessage({ content: "original command handed off", tool_call_id: "one" }))
    await pending
    await vi.advanceTimersByTimeAsync(30_000)
    expect(handedOff).toHaveBeenCalledOnce()
  })
})
