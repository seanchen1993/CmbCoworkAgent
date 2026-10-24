import { describe, expect, it } from "vitest"
import type { Message, ToolCallState } from "@/types"
import { isBotExecutionTool, projectBotExecution } from "./bot-execution-visibility"
import { botWorkReceipt } from "./bot-work-receipt"
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
  it.each([
    ["bot_request_browser_help", {}],
    ["bot_browser", { action: "request_help" }]
  ] as const)("keeps an explicit %s ended/skipped product receipt without exposing raw browser results", (name, args) => {
    const message = call("help-history", name)
    message.tool_calls![0].args = { ...args, instruction: "请核对合成页面" }
    for (const payload of [
      { control: "bot", helpSkipped: true },
      { control: "bot", note: "Human control ended. You now have control again. The pending action was replaced with this fresh observation; it was not replayed." }
    ]) {
      const returned = result("help-history", false, JSON.stringify(payload))
      expect(isBotExecutionTool(message.tool_calls![0], { content: returned.content })).toBe(false)
      for (const active of [false, true]) {
        const view = projectBotExecution([message, returned], active, new Set())
        expect(view.hiddenMessages.size).toBe(0)
        expect(view.foldedTools.size).toBe(0)
      }
    }
  })
  it.each(["bot_work_create", "bot_work_send", "bot_work_complete", "bot_work_continue"])(
    "keeps a verified %s navigation card visible after beta folds execution details",
    (name) => {
      const work = { id: "work-id", workId: "work-id", botId: "owner", title: "Draft", threadId: "work-thread" }
      const receipt = name === "bot_work_create"
        ? { work, task: { workId: work.id, threadId: work.threadId } }
        : work
      const message = call("work", name)
      const returned = result("work", false, JSON.stringify({ kind: "bot-work-receipt", operation: name, receipt }))
      const tool = message.tool_calls![0]
      expect(projectBotExecution([message, returned], false, new Set()).hiddenMessages.size).toBe(0)
      expect(botWorkReceipt(tool, { content: returned.content }, "owner")?.id).toBe(work.id)
      expect(botWorkReceipt(tool, { content: returned.content }, "another-bot")).toBeNull()
      expect(botWorkReceipt(tool, { content: returned.content, is_error: true }, "owner")).toBeNull()
    }
  )
  it.each([
    [
      "bot_deliver_files",
      {},
      {
        kind: "bot-file-delivery",
        files: [{ filePath: "/workspace/result.md", name: "result.md", size: 2 }]
      }
    ],
    ["bot_delegate", {}, { taskId: "delegation-id" }],
    ["bot_update_profile", { name: "核对助手" }, { name: "核对助手", instructions: "核对" }],
    [
      "bot_schedule",
      { action: "save" },
      {
        id: "routine",
        botId: "bot",
        version: 1,
        name: "Review",
        message: "Review",
        frequency: "once",
        enabled: false,
        nextRunAt: null,
        timezone: "UTC",
        runAt: "2030-01-01T00:00:00Z"
      }
    ],
    [
      "request_user_input",
      {
        questions: [
          {
            id: "choice",
            header: "选择",
            question: "继续吗？",
            options: [
              { label: "Continue", description: "继续" },
              { label: "End", description: "结束" }
            ]
          }
        ]
      },
      {
        status: "submitted",
        answers: {
          choice: { type: "option", questionId: "choice", optionIndex: 0, label: "Continue" }
        }
      }
    ]
  ] as const)("preserves validated user-facing %s presentations", (name, args, receipt) => {
    const message = {
      ...call("product", name),
      tool_calls: [{ id: "call-product", name, args }]
    } as Message
    const returned = result("product", false, JSON.stringify(receipt))
    expect(isBotExecutionTool(message.tool_calls![0], { content: returned.content })).toBe(false)
    expect(projectBotExecution([message, returned], false, new Set()).hiddenMessages.size).toBe(0)
  })

  it("folds a returned subagent task without hiding its visible reply or Mod card", () => {
    const task = call("child", "task")
    const reply = call("reply", "task", "核对完成，合计43。")
    const messages = [task, result("child", false, "合计43"), reply, result("reply")]
    const view = projectBotExecution(messages, false, new Set())
    expect([...view.hiddenMessages]).toEqual(["child"])
    expect(view.foldedTools.size).toBe(2)
    expect(projectBotExecution(messages, false, new Set(["call-child"])).hiddenMessages.size).toBe(
      0
    )
  })

  it("folds live subagent records while preserving approvals and exceptional results", () => {
    const task = call("child", "task")
    expect(isBotExecutionTool(task.tool_calls![0])).toBe(true)
    const live = new Map<string, Pick<ToolCallState, "status">>([
      [getWorkerToolUiKey("child", "call-child", 0), { status: "running" as const }]
    ])
    expect(projectBotExecution([task], true, new Set(), null, live).foldedTools.size).toBe(1)
    live.set(getWorkerToolUiKey("child", "call-child", 0), { status: "awaiting_approval" })
    expect(projectBotExecution([task], true, new Set(), null, live).foldedTools.size).toBe(0)
    for (const returned of [
      result("child", true, "Child failed"),
      result(
        "child",
        false,
        "Tool call task with id call-child was cancelled - another message came in before it could be completed."
      )
    ]) {
      const view = projectBotExecution([task, returned], false, new Set())
      expect(view.hiddenMessages.size).toBe(0)
      expect(view.foldedTools.size).toBe(0)
    }
  })

  it("folds a confirmed background launch without hiding its progress, approval or Mod card", () => {
    const receipt = JSON.stringify({
      status: "launched",
      runId: "wf_57f008292efd",
      name: "资料核对",
      scriptPath: "/workspace/task.workflow.js",
      phases: ["核对"],
      note: "The workflow now runs in the background."
    })
    const launch = call("launch", "workflow")
    const progress = call("progress", "workflow", "已开始核对，完成后交付文件。")
    const messages = [
      launch,
      result("launch", false, receipt),
      progress,
      result("progress", false, receipt)
    ]
    expect([...projectBotExecution(messages, true, new Set()).hiddenMessages]).toEqual(["launch"])
    expect(isBotExecutionTool(launch.tool_calls![0])).toBe(true)
    expect(projectBotExecution([launch], true, new Set()).foldedTools.size).toBe(0)
    expect(
      projectBotExecution(messages, false, new Set(["call-launch", "call-progress"])).hiddenMessages
        .size
    ).toBe(0)

    for (const content of [
      JSON.stringify({ ...JSON.parse(receipt), warning: "Initial state was not saved" }),
      JSON.stringify({ status: "rejected", name: "资料核对", note: "User declined" }),
      JSON.stringify({ ...JSON.parse(receipt), error: "post-hook error" }),
      '{"status":"launched","runId":"wf_57f008292efd"}',
      "unknown hook result"
    ]) {
      expect(
        projectBotExecution([launch, result("launch", false, content)], false, new Set())
          .hiddenMessages.size
      ).toBe(1)
    }
    expect(
      projectBotExecution([launch, result("launch", true, receipt)], false, new Set())
        .hiddenMessages.size
    ).toBe(0)
  })

  it.each([
    ["mcp__br1018__br_total", '{"total":"9.33"}'],
    ["search_tool", '{"tools":[]}'],
    ["inspect_tool", '{"loaded_tools":[]}'],
    ["invoke_deferred_tool", '{"ok":true,"data":{"total":"9.33"}}']
  ])("folds MCP data tool %s without hiding replies, errors or Mod cards", (name, content) => {
    const messages = [
      call("data", name),
      result("data", false, content),
      call("answer", name, "合计9.33元。"),
      result("answer", false, content),
      call("error", name),
      result("error", true, "Synthetic connector failure"),
      call("cancelled", name),
      result(
        "cancelled",
        false,
        `Tool call ${name} with id call-cancelled was cancelled - another message came in before it could be completed.`
      ),
      call("card", name),
      result("card")
    ]
    const view = projectBotExecution(messages, true, new Set(["call-card"]))
    expect([...view.hiddenMessages]).toEqual(["data"])
    expect([...view.foldedTools]).toEqual([
      getWorkerToolUiKey("data", "call-data", 0),
      getWorkerToolUiKey("answer", "call-answer", 0)
    ])
    expect(isBotExecutionTool(messages[0].tool_calls![0])).toBe(true)
    expect(isBotExecutionTool(messages[6].tool_calls![0], { content: messages[7].content })).toBe(
      true
    )
    expect(projectBotExecution([call("pending", name)], true, new Set()).hiddenMessages.size).toBe(
      0
    )
  })

  it.each([
    ["invoke_deferred_tool", '{"ok":false,"error":"Synthetic protocol failure"}'],
    [
      "inspect_tool",
      '{"loaded_tools":[{"tool_id":"allowed","schema":{}},{"tool_id":"missing","error":"Tool not found"}]}'
    ]
  ])("keeps native %s failures visible without an is_error flag", (name, content) => {
    const message = call("error", name)
    const receipt = { content }
    expect(isBotExecutionTool(message.tool_calls![0], receipt)).toBe(true)
    const view = projectBotExecution([message, result("error", false, content)], true, new Set())
    expect(view.hiddenMessages.size).toBe(0)
    expect(view.foldedTools.size).toBe(0)
  })

  it.each(["search_tool", "inspect_tool", "invoke_deferred_tool"])(
    "keeps unknown %s receipts in execution details rather than exposing raw cards",
    (name) => {
      const message = call("unknown", name)
      const content = '{"error":"post-hook response"}'
      expect(isBotExecutionTool(message.tool_calls![0], { content })).toBe(true)
      expect(
        projectBotExecution([message, result("unknown", false, content)], false, new Set())
          .hiddenMessages.size
      ).toBe(1)
    }
  )

  it.each(["custom_tool", "mcp_custom_tool", "mcp__unknown", "mcp____tool", "mcp__server__"])(
    "folds unrecognized tool family %s by default",
    (name) => {
      expect(isBotExecutionTool({ id: "unknown", name, args: {} })).toBe(true)
      expect(
        projectBotExecution([call("unknown", name), result("unknown")], false, new Set())
          .hiddenMessages.size
      ).toBe(1)
    }
  )

  it.each([
    ["native success", "V_READY\n[Command succeeded with exit code 0, elapsed: 47s]"],
    ["empty success", "<no output>\n[Command succeeded with exit code 0, elapsed: 0s]"],
    [
      "not ready",
      JSON.stringify({ retrieval_status: "not_ready", elapsed: 2, command: "node job.mjs" })
    ],
    [
      "wait timeout",
      JSON.stringify({
        retrieval_status: "timeout",
        elapsed: 30,
        command: "node job.mjs",
        partialOutput: "working",
        partialTruncated: false,
        idleSeconds: 2
      })
    ]
  ])("folds a validated task_output %s without leaving an empty message shell", (_, content) => {
    const messages = [call("output", "task_output"), result("output", false, content)]
    for (const active of [false, true]) {
      const view = projectBotExecution(messages, active, new Set())
      expect([...view.hiddenMessages]).toEqual(["output"])
      expect([...view.foldedTools]).toEqual([getWorkerToolUiKey("output", "call-output", 0)])
    }
    expect(projectBotExecution(messages, false, new Set(["call-output"])).hiddenMessages.size).toBe(
      0
    )
  })

  it.each([
    "Y_FAILED\n[Command failed with exit code 7, elapsed: 3s]",
    'Error: No background task found with id "missing-1017Y".',
    "Task polling aborted: conversation was cancelled by user.",
    "[Hook blocked] denied"
  ])("keeps exceptional task_output records available for the compact issue UI: %s", (content) => {
    const view = projectBotExecution(
      [call("output", "task_output"), result("output", false, content)],
      true,
      new Set()
    )
    expect(view.hiddenMessages.size).toBe(0)
    expect(view.foldedTools.size).toBe(0)
  })

  it.each([
    "custom post-hook response",
    "[Command succeeded with exit code 0, elapsed: 1s]\npost-hook warning",
    JSON.stringify({ retrieval_status: "not_ready", elapsed: 2 }),
    JSON.stringify({ retrieval_status: "timeout", elapsed: -1, command: "node job.mjs" }),
    JSON.stringify({
      retrieval_status: "not_ready",
      elapsed: 2,
      command: "node job.mjs",
      error: "denied"
    }),
    JSON.stringify({
      retrieval_status: "not_ready",
      elapsed: 2,
      command: "node job.mjs",
      partialOutput: { error: "denied" }
    }),
    "{broken json"
  ])("keeps unrecognized task_output payloads out of default chat: %s", (content) => {
    const view = projectBotExecution(
      [call("output", "task_output"), result("output", false, content)],
      true,
      new Set()
    )
    expect([...view.hiddenMessages]).toEqual(["output"])
    expect(view.foldedTools.size).toBe(1)
  })

  it("keeps missing and explicitly failed task_output results visible", () => {
    const output = call("output", "task_output")
    expect(projectBotExecution([output], true, new Set()).foldedTools.size).toBe(0)
    expect(
      projectBotExecution(
        [
          output,
          result("output", true, "Y_READY\n[Command succeeded with exit code 0, elapsed: 1s]")
        ],
        true,
        new Set()
      ).foldedTools.size
    ).toBe(0)
  })

  it("only folds a pending question behind its real inline card and preserves returned errors", () => {
    const question = call("question", "request_user_input")
    expect(projectBotExecution([question], true, new Set()).hiddenMessages.size).toBe(0)
    expect([
      ...projectBotExecution([question], true, new Set(), "call-question").hiddenMessages
    ]).toEqual(["question"])
    expect(
      projectBotExecution([question], true, new Set(["call-question"]), "call-question")
        .hiddenMessages.size
    ).toBe(0)
    expect(
      projectBotExecution([question, result("question", true)], true, new Set(), "call-question")
        .hiddenMessages.size
    ).toBe(0)
  })
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
      result(
        "files",
        false,
        JSON.stringify({
          kind: "bot-file-delivery",
          files: [{ filePath: "/workspace/result.md", name: "result.md", size: 2 }]
        })
      ),
      call("peer", "bot_delegate"),
      result("peer", false, '{"taskId":"delegation-id"}'),
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
  it("folds unknown records but keeps pending, failed, cancelled and interactive presentations", () => {
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
      {
        ...call("legacy-help", "bot_browser"),
        tool_calls: [
          { id: "call-legacy-help", name: "bot_browser", args: { action: "request_help" } }
        ]
      },
      call("mod"),
      result("mod")
    ]
    const view = projectBotExecution(messages, false, new Set(["call-mod"]))
    expect([...view.hiddenMessages]).toEqual(["custom"])
    expect([...view.foldedTools]).toEqual([getWorkerToolUiKey("custom", "call-custom", 0)])
  })
  it.each([
    ["bot_request_browser_help", {}],
    ["bot_browser", { action: "request_help" }]
  ] as const)("settles %s history without hiding live handoffs or exceptions", (name, args) => {
    const message = call("handoff", name)
    message.tool_calls![0].args = args
    const tool = message.tool_calls![0]
    expect(isBotExecutionTool(tool)).toBe(false)
    expect(projectBotExecution([message], true, new Set()).hiddenMessages.size).toBe(0)

    const returned = result("handoff", false, '{"title":"Synthetic page","generation":2}')
    for (const active of [false, true]) {
      const view = projectBotExecution([message, returned], active, new Set())
      expect([...view.hiddenMessages]).toEqual(["handoff"])
      expect([...view.foldedTools]).toEqual([getWorkerToolUiKey("handoff", tool.id, 0)])
    }
    expect(
      projectBotExecution([message, returned], false, new Set([tool.id])).hiddenMessages.size
    ).toBe(0)

    for (const exceptional of [
      result("handoff", true, "Browser task was cancelled"),
      result(
        "handoff",
        false,
        `Tool call ${name} with id ${tool.id} was cancelled - another message came in before it could be completed.`
      )
    ]) {
      // Exceptions use the existing compact issue UI rather than disappearing with successes.
      expect(isBotExecutionTool(tool, exceptional)).toBe(true)
      expect(
        projectBotExecution([message, exceptional], false, new Set()).hiddenMessages.size
      ).toBe(0)
    }
  })
  it("keeps hidden thinking rows out of layout, then reveals their actual reply", () => {
    const messages: Message[] = [
      {
        id: "image",
        role: "assistant",
        created_at,
        content: [{ type: "image", content: "data:image/png;base64,test" }]
      },
      { id: "stream", role: "assistant", content: "", reasoning: "thinking", created_at }
    ]
    expect([...projectBotExecution(messages, true, new Set()).hiddenMessages]).toEqual(["stream"])
    expect([...projectBotExecution(messages, false, new Set()).hiddenMessages]).toEqual(["stream"])
    messages[1] = { ...messages[1], content: "<think>private</think>正文" }
    expect([...projectBotExecution(messages, true, new Set()).hiddenMessages]).toEqual([])
  })
  it("folds live execution shells without hiding approvals, failures or interactive UI", () => {
    const messages = [
      call("running"),
      call("queued", "execute"),
      call("approval", "execute"),
      call("interrupted"),
      call("failed"),
      call("mod"),
      call("help", "bot_request_browser_help"),
      call("unknown", "custom_tool"),
      call("progress", "read_file", "正在读取文件。")
    ]
    const states = new Map<string, Pick<ToolCallState, "status">>(
      messages.map((message) => [
        getWorkerToolUiKey(message.id, message.tool_calls![0].id, 0),
        { status: "running" }
      ])
    )
    states.set(getWorkerToolUiKey("queued", "call-queued", 0), { status: "queued" })
    states.set(getWorkerToolUiKey("approval", "call-approval", 0), { status: "awaiting_approval" })
    states.set(getWorkerToolUiKey("interrupted", "call-interrupted", 0), { status: "interrupted" })
    states.set(getWorkerToolUiKey("failed", "call-failed", 0), { status: "failed" })
    expect([
      ...projectBotExecution(messages, true, new Set(["call-mod"]), null, states).hiddenMessages
    ]).toEqual(["running", "queued", "unknown"])
    expect(projectBotExecution(messages, false, new Set(), null, states).hiddenMessages.size).toBe(
      0
    )
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
    expect([...view.hiddenMessages]).toEqual([
      ...Array.from({ length: 6 }, (_, i) => `write-${i}`),
      "reply"
    ])
    expect(committed).toHaveLength(1)
    expect(live.at(-1)?.content).toBe("")
  })
  it("folds routine records, preserving validated changes, errors, pending and Mod UI", () => {
    const scheduleCall = (id: string, action: string): Message => ({
      ...call(id, "bot_schedule"),
      tool_calls: [
        {
          id: `call-${id}`,
          name: "bot_schedule",
          args: { action, ...(action === "remove" ? { id: "routine" } : {}) }
        }
      ]
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
      result(
        "saved",
        false,
        JSON.stringify({
          id: "routine",
          botId: "bot",
          version: 1,
          name: "Review",
          message: "Review",
          frequency: "once",
          enabled: false,
          nextRunAt: null,
          timezone: "UTC",
          runAt: "2030-01-01T00:00:00Z"
        })
      ),
      scheduleCall("removed", "remove"),
      result("removed", false, "例行任务已删除，排队中的触发已取消。"),
      scheduleCall("mod-routine", "list"),
      result("mod-routine", false, "[]")
    ]
    expect([
      ...projectBotExecution(messages, false, new Set(["call-mod-routine"])).hiddenMessages
    ]).toEqual(["list", "invalid-list"])
    expect([
      ...projectBotExecution(messages, true, new Set(["call-mod-routine"])).hiddenMessages
    ]).toEqual(["list", "invalid-list"])
  })
})
