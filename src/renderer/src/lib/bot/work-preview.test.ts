import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Message } from "@/types"
import { BotWorkPreview, projectBotWorkPreviewActivity, projectBotWorkPreviewReply } from "@/components/bots/BotWorkPreview"
import { restoreBotWorkPreviewPosition } from "@/components/bots/BotsWorkspace"
import { ThreadProvider } from "@/lib/thread-context"
import type { BotWorkItem } from "../../../../shared/bots/work"

const state = vi.hoisted(() => ({ previewHistory: undefined as unknown }))
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>()
  return {
    ...react,
    useState(initial: unknown) {
      if (initial !== null || state.previewHistory === undefined) return react.useState(initial)
      // SSR does not run the page-read effect. Render the actual preview with its loaded reply.
      const history = state.previewHistory
      state.previewHistory = undefined
      return react.useState(history)
    }
  }
})

function message(id: string, content: Message["content"], rest: Partial<Message> = {}): Message {
  return { id, role: "assistant", content, created_at: new Date(0), ...rest }
}

const deliveryThread = `thread-${"a".repeat(64)}`
const deliveryCall = message("deliver", "", {
  ordinal: 3,
  botHistoryDeliveryScope: { receiptThread: deliveryThread, workIds: ["work"] },
  tool_calls: [{ id: "file", name: "bot_deliver_files", args: { files: ["report.md"] } }]
})
const deliveryReceipt = message("delivery-receipt", JSON.stringify({
  kind: "bot-file-delivery",
  receiptThread: deliveryThread, receiptWorkId: "work",
  files: [{ filePath: "/workspace/report.md", attachmentPath: `/workspace/.bot-deliveries/${"a".repeat(64)}/report.md`,
    name: "report.md", size: 5 }]
}), { role: "tool", ordinal: 4, name: "bot_deliver_files", tool_call_id: "file" })
const activeRequest = { id: "task", requestId: "current-request" }

function renderPreview(
  reply: ReturnType<typeof projectBotWorkPreviewReply>, overrides: Partial<BotWorkItem> = {},
  activeTask?: Parameters<typeof BotWorkPreview>[0]["activeTask"]
): string {
  const work: BotWorkItem = {
    id: "work", botId: "bot", threadId: "thread", parentThreadId: "main",
    title: "Report", goal: "Review the data", audienceKey: "desktop", state: "active",
    threadInitialized: true, version: 1, createdAt: 0, updatedAt: 0,
    executionState: "completed", pendingPeers: 0, backgroundBusy: false,
    ...overrides
  }
  state.previewHistory = { owner: JSON.stringify([work.botId, work.id, work.threadId, work.conversation?.ref]), reply }
  return renderToStaticMarkup(createElement(ThreadProvider, {
    children: createElement(BotWorkPreview, {
      work, title: work.title, directoryError: null, backLabel: "返回任务列表", activeTask,
      onBack() {}, onOpen() {}, onOpenMain() {}, onRetry() {}
    })
  }))
}

describe("Bot task preview reply", () => {
  it("keeps the desktop preview a non-modal region beside the original conversation", () => {
    const html = renderPreview({ text: "Progress", partial: false })
    expect(html).toMatch(/<section[^>]*aria-label="任务预览"/)
    expect(html).not.toMatch(/role="dialog"|data-cmb-modal-dialog|bot-work-preview-overlay/)
    expect(html).toContain("打开聊天")
  })

  it("shows the latest user-visible assistant reply and keeps its Markdown", () => {
    expect(projectBotWorkPreviewReply([
      message("older", "First reply"),
      message("tool-call", "I'll check the files", {
        tool_calls: [{ id: "search", name: "list_files", args: {} }]
      }),
      message("tool-result", "Internal tool output", { role: "tool" }),
      message("reply", [
        { type: "text", text: "<think>Internal reasoning</think>\n**Final answer**" },
        { type: "text", text: "The requested update." }
      ]),
      message("routine-silence", "BOT_ROUTINE_SILENT"),
      message("reasoning-only", "<think>Still working"),
      message("original-input", "Unprepared user input", { role: "user" })
    ])).toEqual({ text: "**Final answer**\nThe requested update.", partial: false })
  })

  it("identifies bounded replies as partial", () => {
    const text = "x".repeat(3000)
    expect(projectBotWorkPreviewReply([message("long", text)])).toEqual({
      text: text.slice(0, 2400), partial: true
    })
    expect(projectBotWorkPreviewReply([message("short-projection", "Shortened")], ["short-projection"]))
      .toEqual({ text: "Shortened", partial: true })
  })

  it("recovers progress after a supplement joins the current run and the live tail moves on", () => {
    const progress = "13 项测试已通过。接下来写入并回读说明。"
    const call = { id: "write", name: "write_file", args: { path: "/project/README.md" } }
    const transcript = [
      message("old-reply", "Earlier reply"),
      message(activeRequest.requestId, "Check tests and write instructions", { role: "user" }),
      message("work-message-supplement", "同时更新变更日志。", { role: "user" }),
      message("progress", [
        { type: "text", text: "<think>Private reasoning" },
        { type: "text", text: `still private</think>${progress}` }
      ], { tool_calls: [call] }),
      message("written", "Raw tool output", { role: "tool", tool_call_id: call.id }),
      ...Array.from({ length: 12 }, (_, index) => {
        const id = `later-read-${index}`
        return [
          message(id, "", { tool_calls: [{ id, name: "read_file", args: {} }] }),
          message(`${id}-result`, "Raw tool output", { role: "tool", tool_call_id: id })
        ]
      }).flat(),
      message("awaiting", "<think>Private shell planning</think>", {
        tool_calls: [{ id: "shell", name: "execute", args: { command: "private command" } }]
      })
    ]
    expect(projectBotWorkPreviewActivity(transcript, 0, {}, false, activeRequest).text).toBe("")
    expect(projectBotWorkPreviewReply(transcript.slice(-16), [], true)).toBeNull()
    const reply = projectBotWorkPreviewReply(transcript)
    expect(reply).toEqual({ text: progress, partial: false, progress: "recent" })
    const html = renderPreview(reply, { executionState: "waiting_user" }, {
      ...activeRequest, threadId: "thread", state: "waiting_user", updatedAt: 100
    })
    expect(html).toContain('aria-label="最近进展"')
    expect(html).toContain(progress)
    expect(html).not.toMatch(/当前进展|Earlier reply|Raw tool output|Private reasoning|private command/)
  })

  it("keeps a settled quiet routine's whole span hidden, including a page without its request", () => {
    const earlier = message("reply", "Last visible reply")
    const request = message("routine-request", "Check for changes", { role: "user" })
    const progress = message("check", "Checking the current output", {
      tool_calls: [{ id: "read", name: "read_file", args: {} }]
    })
    const silent = message("quiet", "<think>Nothing changed</think>\nBOT_ROUTINE_SILENT")
    expect(projectBotWorkPreviewReply([earlier, request, progress, silent], [], false, [{
      id: "routine-task", requestId: request.id, origin: { kind: "schedule", scheduleId: "schedule" },
      state: "completed"
    }])).toEqual({ text: earlier.content, partial: false })
    expect(projectBotWorkPreviewReply([progress, silent], [], true)).toBeNull()
  })

  it("keeps a legitimate short reply that is a prefix of the silent routine marker", () => {
    expect(projectBotWorkPreviewReply([message("choice", "B")])).toEqual({ text: "B", partial: false })
  })

  it("keeps a guided follow-up ahead of a late copy of the preceding reply", () => {
    const previous = message("provider-first", "校验结束。", {
      ordinal: 15,
      created_at: new Date(7000)
    })
    const followUp = message("provider-guided", "已附送的就是首次交付的 V1 原版本文件本身。", {
      ordinal: 21,
      provider_source_id: "provider-guided",
      provider_occurrence: 1,
      created_at: new Date(5000)
    })
    const lateCopy = message("current-run-assistant:late-copy", previous.content, {
      ordinal: 37,
      provider_source_id: previous.id,
      provider_occurrence: 1,
      created_at: new Date(1000)
    })
    expect(projectBotWorkPreviewReply([followUp, lateCopy], [], true)).toEqual({
      text: previous.content, partial: false, orderUnconfirmed: true
    })
    expect(projectBotWorkPreviewReply([
      previous,
      message("work-message-steer", "请补发原版本。", { role: "user", ordinal: 16 }),
      followUp,
      lateCopy
    ])).toEqual({ text: followUp.content, partial: false })
  })

  it("shows the latest confirmed attachment instead of the preceding reply", () => {
    const reply = projectBotWorkPreviewReply([
      message("first-version", "The first report found no problems.", { ordinal: 1 }),
      message("revise", "Send only the corrected report.", { role: "user", ordinal: 2 }),
      deliveryCall,
      deliveryReceipt,
      message("empty-final", "", { ordinal: 5 })
    ])
    expect(reply).toEqual({ delivered: true })
    const html = renderPreview(reply)
    expect(html).toContain("已交付附件，打开聊天查看")
    expect(html).not.toContain("The first report found no problems.")
    expect(html).toMatch(/<button type="button">.*打开聊天<\/button>/)
  })

  it("keeps a newer text reply after a confirmed attachment", () => {
    expect(projectBotWorkPreviewReply([
      deliveryCall, deliveryReceipt, message("updated-result", "The corrected report is ready.", { ordinal: 5 })
    ])).toEqual({ text: "The corrected report is ready.", partial: false })
  })

  it("keeps the previous reply when a copied delivery cannot be opened from the Fork", () => {
    const previous = message("previous", "Original report summary", { ordinal: 1 })
    const forkDelivery = { ...deliveryCall, botHistoryDeliveryScope: {
      receiptThread: `thread-${"b".repeat(64)}`, workIds: ["fork-work"], legacySnapshotPrefix: "/workspace/.bot-deliveries/"
    } }
    expect(projectBotWorkPreviewReply([previous, forkDelivery, deliveryReceipt]))
      .toEqual({ text: previous.content, partial: false })
    const legacy = JSON.stringify({ kind: "bot-file-delivery", files: JSON.parse(String(deliveryReceipt.content)).files })
    expect(projectBotWorkPreviewReply([previous, forkDelivery, { ...deliveryReceipt, content: legacy }]))
      .toEqual({ delivered: true })
    const movedFork = { ...forkDelivery, botHistoryDeliveryScope: { ...forkDelivery.botHistoryDeliveryScope,
      legacySnapshotPrefix: "/another/.bot-deliveries/" } }
    expect(projectBotWorkPreviewReply([previous, movedFork, { ...deliveryReceipt, content: legacy }]))
      .toEqual({ text: previous.content, partial: false })
  })

  it.each([
    { name: "absent", receipt: undefined },
    { name: "error flag", receipt: { ...deliveryReceipt, is_error: true } },
    { name: "error status", receipt: { ...deliveryReceipt, status: "error" as const } },
    { name: "unrelated", receipt: { ...deliveryReceipt, tool_call_id: "unrelated" } },
    { name: "invalid", receipt: { ...deliveryReceipt, content: '{"kind":"bot-file-delivery","files":[]}' } }
  ])("requires a matching successful delivery receipt ($name)", ({ receipt }) => {
    expect(projectBotWorkPreviewReply([
      deliveryCall, ...(receipt ? [receipt] : []),
      message("thinking", "<think>Looking for results</think>", { ordinal: 5 })
    ])).toBeNull()
  })

  it("resolves a late alias of the preceding reply before showing the attachment", () => {
    const previous = message("provider-first", "The first report is ready.", { ordinal: 1 })
    const lateCopy = message("current-run-assistant:late-copy", previous.content, {
      ordinal: 5, provider_source_id: previous.id, provider_occurrence: 1
    })
    expect(projectBotWorkPreviewReply([deliveryCall, deliveryReceipt, lateCopy], [], true)).toEqual({
      text: previous.content, partial: false, orderUnconfirmed: true
    })
    expect(projectBotWorkPreviewReply([previous, deliveryCall, deliveryReceipt, lateCopy]))
      .toEqual({ delivered: true })
  })

  it("renders report links safely while keeping external links and the full task entry", () => {
    const html = renderPreview(projectBotWorkPreviewReply([
      message("reply", "[报告](report.md) · [引用](https://example.com/source)")
    ]))
    expect(html).toContain('<span title="文件路径暂不可预览">报告</span>')
    expect(html).not.toContain('href="report.md"')
    expect(html).toContain('<a href="https://example.com/source">引用</a>')
    expect(html).toMatch(/<button type="button">.*打开聊天<\/button>/)
  })
})

describe("Bot task preview live activity", () => {
  const activeAt = new Date(10)
  const call = { id: "find", name: "glob", args: { pattern: "src/**/run-manager.ts" } }
  const active = (id: string, content: Message["content"], rest: Partial<Message> = {}) =>
    message(id, content, { created_at: activeAt, ...rest })

  it("combines current assistant text and the pending file search", () => {
    const messages = [
      active("progress", [
        { type: "text", text: "<think>Internal reasoning" },
        { type: "text", text: "still private</think>正在检查运行入口。" }
      ]),
      active("tool-request", "", { tool_calls: [call] })
    ]
    expect(projectBotWorkPreviewActivity(messages, 10, {}, true)).toEqual({
      text: "正在检查运行入口。", partial: false, tool: "查找文件 · run-manager.ts"
    })
    expect(projectBotWorkPreviewActivity(messages, 10, {}, false).tool).toBeNull()
  })

  it("skips completed, blocked, and earlier tools while retaining the current text", () => {
    const messages = [
      message("prior", "Previous turn", { tool_calls: [{ ...call, id: "old" }] }),
      active("tool-request", "Checking current files", { tool_calls: [
        call, { id: "shell", name: "execute", args: { command: "curl -H 'Authorization: secret'" } }
      ] }),
      active("result", "secret raw output", { role: "tool", tool_call_id: call.id })
    ]
    expect(projectBotWorkPreviewActivity(messages, 10, {}, true)).toEqual({
      text: "Checking current files", partial: false, tool: "执行命令"
    })
    expect(projectBotWorkPreviewActivity(messages, 10, {
      shell: { status: "awaiting_approval", updatedAt: activeAt }
    }, true).tool).toBeNull()
    expect(projectBotWorkPreviewActivity(messages, 11, {}, true)).toEqual({
      text: "", partial: false, tool: null
    })
    expect(projectBotWorkPreviewActivity([...messages, active("reply", "Now reviewing")], 10, {}, true)).toEqual({
      text: "Now reviewing", partial: false, tool: null
    })
  })

  it("uses the exact current request even when a later wait transition advanced the task timestamp", () => {
    const messages = [
      active("old-progress", "Earlier tool progress", { tool_calls: [call] }),
      active(activeRequest.requestId, "Check the tests", { role: "user" }),
      ...Array.from({ length: 24 }, (_, index) => active(`tool-result-${index}`, "raw output", {
        role: "tool", tool_call_id: `tool-${index}`
      })),
      active("progress", "13 tests passed. Writing the instructions.", { tool_calls: [call] }),
      active("written", "Raw tool output", { role: "tool", tool_call_id: call.id })
    ]
    expect(projectBotWorkPreviewActivity(messages, 100, {}, false, activeRequest)).toEqual({
      text: "13 tests passed. Writing the instructions.", partial: false, tool: null
    })
    expect(projectBotWorkPreviewActivity(messages, 100, {}, true, activeRequest).tool).toBeNull()
    expect(projectBotWorkPreviewActivity(messages, 100, {}, true, { ...activeRequest, requestId: "unrelated" })).toEqual({
      text: "", partial: false, tool: null
    })
  })

  it("only recovers a resumed turn after its own continuation boundary", () => {
    const messages = [
      active("old-progress", "Earlier tool progress", { tool_calls: [call] }),
      active(`bot-continuation:${activeRequest.id}:${"a".repeat(64)}`, "Internal continuation", { role: "user" }),
      active("new-progress", "Checking the saved result.", { tool_calls: [call] })
    ]
    expect(projectBotWorkPreviewActivity(messages, 100, {}, false, activeRequest)).toEqual({
      text: "Checking the saved result.", partial: false, tool: null
    })
  })

  it("does not surface partial reasoning markers or routine-only text", () => {
    expect(projectBotWorkPreviewActivity([
      active("reasoning", "<thi"),
      active("silent", "BOT_ROUTINE_SIL")
    ], 10, {}, true)).toEqual({ text: "", partial: false, tool: null })
    expect(projectBotWorkPreviewActivity([
      active("checking", "Checking whether anything changed.", { tool_calls: [call] }),
      active("quiet", "BOT_ROUTINE_SILENT")
    ], 10, {}, true)).toEqual({ text: "", partial: false, tool: null })
  })

  it("keeps newly streamed text visible after the preview limit", () => {
    const progress = projectBotWorkPreviewActivity([
      { id: "long-stream", type: "ai", start_at: activeAt, content: "x".repeat(2500) + "Latest progress" }
    ], 10, {}, true)
    expect(progress).toEqual({ text: "x".repeat(2385) + "Latest progress", partial: true, tool: null })
  })
})

describe("Bot task preview navigation", () => {
  it.each(["ready", "blocked"] as const)("shows the published %s conclusion in the task preview", kind => {
    const summary = kind === "ready" ? "源码和测试已核对。" : "缺少要求中的兼容性检查。"
    const html = renderPreview({ text: "Original work claims success", partial: false }, {
      resultConclusion: { kind, summary }
    })
    expect(html).toContain(summary)
    expect(html).toContain(kind === "ready" ? "成果已就绪" : "成果待核对")
    expect(html).toContain("前往主对话")
    expect(html).toContain("打开聊天")
    expect(html).not.toContain("服务运行中")
  })

  it("shows the published decision alongside both conversation entry points", () => {
    const html = renderPreview({ text: "Original work reply", partial: false }, {
      resultNeedsUser: "请确认要采用哪个发布口径。"
    })
    expect(html).toContain("成果需确认")
    expect(html).toContain("请确认要采用哪个发布口径。")
    expect(html).toContain("前往主对话")
    expect(html).toContain("打开聊天")
    expect(html).toContain("Original work reply")
  })

  it("does not show a previous conclusion over new live progress", () => {
    const html = renderPreview({ text: "A new execution", partial: false }, {
      executionState: "running", resultConclusion: { kind: "ready", summary: "Previous result is ready" }
    })
    expect(html).toContain("正在处理")
    expect(html).not.toContain("Previous result is ready")
    expect(html).not.toContain("成果已就绪")
  })

  it.each([
    { executionState: "failed" as const, backgroundBusy: false, label: "执行失败" },
    { executionState: "completed" as const, backgroundBusy: true, label: "后台处理中" }
  ])("keeps $label and the published blocking reason together", ({ label, ...status }) => {
    const html = renderPreview({ text: "Original response", partial: false }, {
      ...status, resultConclusion: { kind: "blocked", summary: "已有结果仍缺一项核验。" }
    })
    expect(html).toContain(label)
    expect(html).toContain("已有结果仍缺一项核验。")
    expect(html).not.toContain("成果已就绪")
  })

  it("shows when the service stays running after the result is ready", () => {
    const html = renderPreview(null, { backgroundBusy: true, readyServiceState: "result_ready" })
    expect(html).toContain("成果已就绪")
    expect(html).toContain("服务运行中")
  })

  it.each([
    { linkState: "detached", deletionPending: true, canOpen: false, label: "打开聊天" },
    { linkState: "detached", deletionPending: false, canOpen: true, label: "打开聊天" },
    { linkState: "bound", deletionPending: true, canOpen: false, label: "打开聊天" },
    { linkState: "bound", deletionPending: false, canOpen: true, label: "打开聊天" },
    { linkState: undefined, deletionPending: true, canOpen: false, label: "打开聊天" },
    { linkState: undefined, deletionPending: false, canOpen: true, label: "打开聊天" }
  ] as const)("uses the recovery state for $linkState work (pending=$deletionPending)", ({ linkState, deletionPending, canOpen, label }) => {
    const html = renderPreview({ text: "Earlier reply", partial: false }, {
      deletionPending,
      threadInitialized: linkState !== undefined,
      conversation: linkState ? {
        ref: { kind: "local_thread", threadId: "thread", incarnation: { token: "original", legacyCreatedAt: 0 } },
        origin: "existing",
        state: linkState
      } : undefined
    })
    expect(html).toMatch(new RegExp(`<button type="button"${canOpen ? "" : ' disabled=""'}>.*${label}</button>`))
    expect(html.includes("清理尚未完成，可在主对话继续删除此任务。")).toBe(deletionPending)
    expect(html).not.toContain("正在读取任务")
    expect(html.includes("Earlier reply")).toBe(linkState === "bound" && !deletionPending)
  })
})

describe("return from Bot task preview", () => {
  it.each([false, true])("restores the saved directory before focusing the row (moved=%s)", moved => {
    const container = {
      isConnected: true,
      scrollTop: 2,
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0, bottom: 640 })
    }
    const trigger = {
      isConnected: true,
      focus: vi.fn(() => expect(container.scrollTop).toBe(1549)),
      getBoundingClientRect: () => ({ top: moved ? 675 : 298, bottom: moved ? 711 : 334 }),
      scrollIntoView: vi.fn()
    }
    restoreBotWorkPreviewPosition({
      trigger: trigger as unknown as HTMLButtonElement,
      scroll: { container: container as unknown as HTMLElement, top: 1549 }
    }, null)
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(trigger.scrollIntoView).toHaveBeenCalledTimes(Number(moved))
    if (moved) expect(trigger.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
  })
})
