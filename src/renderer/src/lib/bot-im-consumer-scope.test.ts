import { afterEach, describe, expect, it, vi } from "vitest"
import { Children, isValidElement, type ReactElement } from "react"
import { BotWorkInstruction } from "../components/bots/BotWorkInstruction"
import { buildAttachmentMessageParts } from "../../../shared/attachment-message-parts"
import type { BotClient, BotDefinition, BotSchedule, BotTask } from "../../../shared/bots/contracts"
import { botGroupBrowserScope } from "../../../shared/bots/contracts"
import { botImBrowserScope } from "../../../shared/bots/im-channel"
import { botThreadHistoryHref } from "../../../shared/bots/thread-history"
import { botWorkAttachmentHref, parseBotWorkAttachmentHref, botWorkHistoryHref, type BotWorkHistoryTarget } from "../../../shared/bots/work-history"
import type { BotWorkItem } from "../../../shared/bots/work"
import type { Thread } from "@/types"
import { useChatSourceNavigation } from "./chat-source-navigation"
import type { OpenResourcePreviewDetail, OpenResourcePreviewRequest } from "./resource-preview-events"

const previews = vi.hoisted(() => ({
  request: vi.fn<() => OpenResourcePreviewDetail>(),
  open: vi.fn<(detail: OpenResourcePreviewRequest) => void>()
}))
const updateBotView = vi.hoisted(() => vi.fn())
const stateWrites = vi.hoisted(() => [] as any[])
const navigation = vi.hoisted(() => {
  const route = { mainView: "bots", currentThreadId: "main", showCustomizeView: false }
  return {
    route,
    listeners: new Set<(next: typeof route) => void>(),
    threads: [] as Thread[],
    setActiveTab: vi.fn(),
    selectThread: vi.fn<(threadId: string) => Promise<void>>(),
    getThread: vi.fn(),
    addThreadSummary: vi.fn(),
    loadThreads: vi.fn()
  }
})
vi.mock("./store", () => ({
  isThreadDeletionPending: () => false,
  isThreadRetired: () => false,
  useAppStore: {
    getState: () => ({
      ...navigation.route, threads: navigation.threads, selectThread: navigation.selectThread,
      addThreadSummary: navigation.addThreadSummary, loadThreads: navigation.loadThreads
    }),
    subscribe: (listener: (next: typeof navigation.route) => void) => {
      navigation.listeners.add(listener)
      return () => navigation.listeners.delete(listener)
    }
  }
}))

// Exercise the actual presenter and save callbacks without mounting Electron.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (value: unknown) => [value, vi.fn(next => stateWrites.push(next))],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot()
}))
vi.mock("./thread-context", () => ({
  useThreadContext: () => ({
    getThreadState: () => ({ messages: [] }),
    getThreadActions: () => ({ setActiveTab: navigation.setActiveTab })
  }),
  useThreadStateSelector: (_id: string, select: (state: { messages: never[] }) => unknown) => select({ messages: [] })
}))
vi.mock("../components/bots/view-store", () => ({
  useBotViewStore: Object.assign(() => false, { getState: () => ({ update: updateBotView }) })
}))
vi.mock("./mod-cards-store", () => ({ getModCards: () => [], subscribeModCards: () => () => {} }))
vi.mock("../components/bots/BotExchangePanel", () => ({ BotExchangePanel: () => null }))
vi.mock("../components/bots/BotActivity", () => ({ BotActivity: () => null }))
vi.mock("../components/bots/BotMentionLabel", () => ({ BotMentionLabel: () => null }))
vi.mock("../components/bots/BotQuestionHistory", () => ({ BotQuestionHistory: () => null }))
vi.mock("./resource-preview-events", () => ({
  beginOpenResourcePreviewIntent: () => 42,
  emitOpenResourcePreview: previews.open
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
vi.mock("./use-resource-preview-request", () => ({ useResourcePreviewRequest: () => ({
  request: previews.request() ?? { filePath: "/snapshot/report.md", markdownBasePath: "/original/Report.md", intentId: 1 },
  clear: vi.fn()
}) }))
vi.mock("../components/tabs/FileViewer", () => ({ FileViewer: () => null }))

import { BotConversationTools } from "../components/bots/BotConversationTools"
import { BotHistorySources } from "../components/bots/BotHistorySources"
import { BotDeliveredFile, BotDeliveredFiles } from "../components/bots/BotDeliveredFile"
import { BotFileDeliveryPreview, BotMessageFilePreview } from "../components/bots/BotMessageFilePreview"
import { BotBrowserHelpCard } from "../components/bots/BotBrowserHelpCard"
import { FileViewer } from "../components/tabs/FileViewer"
import { ChatHistorySourceContext, ChatToolPresentationContext, ChatFilePresentationContext, ChatMessagePresentationContext } from "../components/chat/chat-presentation-context"
import { toast } from "sonner"

function find(element: unknown, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (!isValidElement<Record<string, any>>(element)) return undefined
  if (element.type === type) return element
  if (element.type === BotFileDeliveryPreview)
    return find(BotFileDeliveryPreview(element.props as Parameters<typeof BotFileDeliveryPreview>[0]), type)
  for (const child of Children.toArray(element.props.children)) {
    const result = find(child, type)
    if (result) return result
  }
  return undefined
}

describe("Bot conversation scoped consumers", () => {
  it("keeps current live and original archived work deliveries, without reviving copied Fork attachments", () => {
    const tree = BotConversationTools({ client: { hostId: "local" } as BotClient, botId: "bot", desktopWorkId: "current",
      conversationThreadId: "native", tasks: [], bots: [], children: null })
    const tool = find(tree, ChatToolPresentationContext.Provider)!.props.value
    const files = [{ filePath: "/original/report.md", attachmentPath: `/original/.bot-deliveries/${"a".repeat(64)}/report.md`, name: "report.md", size: 2 }]
    const hash = `thread-${"a".repeat(64)}`
    const render = (receipt: Record<string, unknown>, scope?: unknown) => tool(
      { id: "delivery", name: "bot_deliver_files", args: {} },
      { content: JSON.stringify({ kind: "bot-file-delivery", files, ...receipt }) }, "message", scope)
    expect(render({ receiptThread: hash, receiptWorkId: "current" }).props.assistantMessageId).toBe("message")
    expect(render({ receiptThread: hash, receiptWorkId: "former" })).toBeNull()
    expect(render({})).toBeNull()
    const scope = { receiptThread: hash, workIds: ["former", "current"] }
    expect(render({ receiptThread: hash, receiptWorkId: "former" }, scope).type).toBe(BotDeliveredFiles)
    expect(render({ receiptThread: `thread-${"b".repeat(64)}`, receiptWorkId: "current" }, scope)).toBeNull()
    expect(render({}, { ...scope, legacySnapshotPrefix: "/original/.bot-deliveries/" }).type).toBe(BotDeliveredFiles)
    expect(render({}, { ...scope, legacySnapshotPrefix: "/different/.bot-deliveries/" })).toBeNull()
  })
  it.each([["create", "Bot 交办"], ["follow_up", "Bot 补充"]] as const)(
    "shows the attachment name and instruction in a %s task message",
    (dispatch, label) => {
      const requestId = "work-instruction"
      const task = {
        id: "task", requestId, state: "completed",
        origin: { kind: "work", dispatch, sourceTaskId: "source" }
      } as BotTask
      const { attachmentModelBlocks } = buildAttachmentMessageParts([{
        filename: "Report.txt", filePath: "/fixture/.bot-deliveries/report/Report.txt",
        botInputId: "input-fixture", content: "Extracted attachment content", mimeType: "text/plain",
        size: 28, truncated: false
      }])
      const instruction = "Review the report without changing it."
      const tree = BotConversationTools({
        client: { hostId: "local" } as BotClient, botId: "bot", conversationThreadId: "thread",
        bots: [], tasks: [task], children: null
      })
      const presentMessage = find(tree, ChatMessagePresentationContext.Provider)!.props.value
      const contents = [instruction + attachmentModelBlocks, [
        { type: "text", text: instruction }, { type: "text", text: attachmentModelBlocks }
      ]]
      for (const content of contents) {
        const card = presentMessage({ id: requestId, role: "user", content })
        expect(card.type).toBe(BotWorkInstruction)
        expect(card.key).toBe(requestId)
        const rendered = BotWorkInstruction(card.props)
        const [heading, body] = Children.toArray(rendered.props.children) as ReactElement<{ children: string }>[]
        expect(heading.props.children).toBe(label)
        expect(body.props.children).toBe(`📎 Report.txt\n\n${instruction}`)
      }
    }
  )

  it.each([true, false])("opens the existing routine details via the workspace when available (%s)", (inWorkspace) => {
    const onOpenRoutineDetails = vi.fn()
    const schedule: BotSchedule = {
      id: "routine", botId: "bot", version: 1, name: "Report reminder", message: "Review the report",
      enabled: true, frequency: "daily", runAtTime: "14:25", nextRunAt: null, timezone: "UTC"
    }
    const tree = BotConversationTools({
      client: { hostId: "local" } as BotClient, botId: "bot", conversationThreadId: "main",
      bots: [], tasks: [], schedules: [schedule], children: null,
      ...(inWorkspace ? { onOpenRoutineDetails } : {})
    })
    const presentTool = find(tree, ChatToolPresentationContext.Provider)!.props.value
    const routine = presentTool({ id: "save", name: "bot_schedule", args: { action: "save" } }, {
      content: JSON.stringify(schedule)
    })
    const button = find(routine, "button")!
    expect(button.props["aria-label"]).toBe("查看例行任务：Report reminder")
    const stopPropagation = vi.fn()
    updateBotView.mockClear()
    button.props.onClick({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
    if (inWorkspace) {
      expect(onOpenRoutineDetails).toHaveBeenCalledOnce()
      expect(updateBotView).not.toHaveBeenCalled()
    } else {
      expect(updateBotView).toHaveBeenCalledExactlyOnceWith("local", {
        selectedId: "bot", groupId: null, detailOpen: true, detailTab: "details"
      })
    }
  })

  it.each([
    { imConversationId: "im-a", groupId: undefined },
    { imConversationId: "im-b", groupId: undefined },
    { imConversationId: undefined, groupId: "group" },
    { imConversationId: undefined, groupId: undefined }
  ])("keeps help and both attachment paths in their conversation: %o", async (scope) => {
    const methods = {
      hostId: "local", exportFile: vi.fn(), exportGroupFile: vi.fn(),
      im: { exportFile: vi.fn() }
    }
    const client = methods as unknown as BotClient
    const tree = BotConversationTools({
      client, botId: "bot", ...scope, conversationThreadId: "thread", bots: [],
      tasks: [{ state: "waiting_user" } as BotTask], executionDetails: true, children: null
    })
    const tool = find(tree, ChatToolPresentationContext.Provider)!.props.value
    const file = find(tree, ChatFilePresentationContext.Provider)!.props.value
    const help = tool({ id: "help", name: "bot_browser", args: { action: "request_help", instruction: "Verify" } })
    expect(help.type).toBe(BotBrowserHelpCard)
    expect(help.props.scopeId).toBe(scope.imConversationId
      ? botImBrowserScope(scope.imConversationId, "bot")
      : scope.groupId ? botGroupBrowserScope(scope.groupId, "bot") : "bot")
    const delivered = tool({ id: "delivery", name: "bot_deliver_files", args: {} }, {
      content: JSON.stringify({ kind: "bot-file-delivery", files: [
        { filePath: "/original/Report.md", attachmentPath: "/snapshot/report.md", name: "Report.md", size: 12 }
      ] })
    })
    const receipt = find(delivered, BotDeliveredFiles)!
    const cards = [find(BotDeliveredFiles(receipt.props as Parameters<typeof BotDeliveredFiles>[0]), BotDeliveredFile)!, file({ filePath: "/linked/report.md", threadId: "thread" })]
    for (const card of cards) {
      const rendered = BotDeliveredFile(card.props as Parameters<typeof BotDeliveredFile>[0])
      const buttons = Children.toArray(rendered.props.children) as ReactElement<Record<string, any>>[]
      buttons[1].props.onClick()
    }
    const preview = BotMessageFilePreview({ client, botId: "bot", ...scope, threadId: "thread", name: "Result" })
    find(preview, "button")!.props.onClick()
    const expected = scope.imConversationId ? methods.im.exportFile : scope.groupId ? methods.exportGroupFile : methods.exportFile
    await vi.waitFor(() => expect(expected).toHaveBeenCalledTimes(3))
    const prefix = scope.imConversationId ? ["bot", scope.imConversationId] : [scope.groupId ?? "bot"]
    const scopeArgs = scope.imConversationId ? [undefined] : scope.groupId ? [] : [undefined, undefined]
    expect(expected).toHaveBeenNthCalledWith(1, ...prefix, "/snapshot/report.md", ...scopeArgs, "Report.md")
    expect(expected).toHaveBeenNthCalledWith(2, ...prefix, "/linked/report.md", ...scopeArgs, "report.md")
    expect(expected).toHaveBeenNthCalledWith(3, ...prefix, "/snapshot/report.md", ...scopeArgs, "Report.md")
    for (const other of [methods.im.exportFile, methods.exportGroupFile, methods.exportFile])
      if (other !== expected) expect(other).not.toHaveBeenCalled()
  })
})

describe("precise Bot history sources", () => {
  const threadId = "original-thread"
  const source = { workId: "work", messageId: "original-message", incarnation: "source-incarnation" }
  const target: BotWorkHistoryTarget = { threadId, messageId: source.messageId, ordinal: 81 }
  const ref = {
    kind: "local_thread" as const, threadId, incarnation: { token: "original", legacyCreatedAt: 1 }
  }
  const work = {
    id: source.workId, botId: "bot", threadId, audienceKey: "desktop",
    conversation: { state: "bound", origin: "existing", ref }
  } as BotWorkItem
  const row: Thread = {
    thread_id: threadId, created_at: new Date(1), updated_at: new Date(2), status: "idle",
    metadata: { cmb_thread_incarnation: "original" }, thread_values: {}
  }

  function setup() {
    stateWrites.length = 0
    navigation.route.showCustomizeView = false
    navigation.threads = []
    navigation.getThread.mockReset().mockResolvedValue(row)
    navigation.addThreadSummary.mockClear()
    navigation.setActiveTab.mockClear()
    navigation.loadThreads.mockClear()
    navigation.selectThread.mockReset().mockResolvedValue(undefined)
    vi.mocked(toast.error).mockClear()
    vi.stubGlobal("window", { api: { threads: { get: navigation.getThread } } })
    const resolveHistory = vi.fn(async () => target)
    const expose = vi.fn(async () => work)
    const resolveSource = vi.fn(async () => target)
    const get = vi.fn(async () => work)
    const onOpenWork = vi.fn()
    const onPreviewWork = vi.fn()
    const authorizeDeliveredFile = vi.fn(async () => ({ filePath: "/saved/exact.md", grant: "exact-grant",
      expiresAt: Date.now() + 300_000, markdownBasePath: "/original/exact.md" }))
    const openSource = (options: {
      hostId?: string; imConversationId?: string; groupId?: string; conversationThreadId?: string
    } = {}) => {
      const tree = BotConversationTools({
        client: { hostId: options.hostId ?? "local", conversations: { resolveHistory, expose },
          works: { resolveSource, get }, authorizeDeliveredFile } as unknown as BotClient,
        botId: "bot", conversationThreadId: options.conversationThreadId ?? "main",
        bots: [{ id: "bot", threadId: "main" } as BotDefinition], tasks: [],
        imConversationId: options.imConversationId, groupId: options.groupId,
        onOpenWork, onPreviewWork, children: null
      })
      return find(tree, ChatHistorySourceContext.Provider)!.props.value as (href: string) => Promise<void>
    }
    return { resolveHistory, expose, resolveSource, get, openSource, onOpenWork, onPreviewWork, authorizeDeliveredFile }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    useChatSourceNavigation.getState().clear()
  })

  it.each([false, true])("previews an exact original attachment in the main chat without navigation (detached=%s)", async detached => {
    const f = setup()
    f.resolveSource.mockResolvedValueOnce(detached ? { ...target, detached: true } : target)
    const attachment = { ...source, callId: "original-call", fileIndex: 3 }
    await f.openSource()(botWorkAttachmentHref(attachment))
    expect(f.resolveSource).toHaveBeenCalledExactlyOnceWith("bot", source)
    const exactSource = { threadId, assistantMessageId: source.messageId, callId: attachment.callId, fileIndex: 3 }
    expect(f.authorizeDeliveredFile).toHaveBeenCalledExactlyOnceWith(exactSource)
    const preview = stateWrites.find(state => state?.ownerThreadId === "main")
    expect(preview.request).toMatchObject({ threadId, filePath: "/saved/exact.md",
      externalPreviewGrant: "exact-grant", markdownBasePath: "/original/exact.md", botDeliverySource: exactSource })
    const viewer = find(BotFileDeliveryPreview({ client: preview.client, botId: "bot", name: "Result",
      ownerThreadId: preview.ownerThreadId, threadId, request: preview.request, clear: vi.fn() }), FileViewer)!
    expect(viewer.props.threadId).toBe(threadId)
    expect(viewer.props.requestLane).toBe(`bot-delivery:local:main:${threadId}`)
    expect(viewer.props.botDeliveryMarkdown).toEqual(exactSource)
    expect(viewer.props.resolveExternalPreviewGrant).toBeTypeOf("function")
    expect(navigation.selectThread).not.toHaveBeenCalled()
    expect(f.get).not.toHaveBeenCalled()
    expect(f.onOpenWork).not.toHaveBeenCalled()
    expect(useChatSourceNavigation.getState().target).toBeNull()
    expect(previews.open).not.toHaveBeenCalled()
  })

  it.each([{ hostId: "remote" }, { imConversationId: "im" }, { groupId: "group" },
    { conversationThreadId: "work-thread" }])("does not expand direct attachment preview outside the local main chat (%j)", async scope => {
    const f = setup()
    const open = f.openSource(scope)
    if (open) await open(botWorkAttachmentHref({ ...source, callId: "call", fileIndex: 0 }))
    expect(f.resolveSource).not.toHaveBeenCalled()
    expect(f.authorizeDeliveredFile).not.toHaveBeenCalled()
    expect(stateWrites.some(state => state?.ownerThreadId)).toBe(false)
  })

  it("rejects malformed attachment selectors instead of selecting another file", () => {
    const base = botWorkHistoryHref(source) + "?attachment="
    for (const input of [null, {}, { callId: "call", fileIndex: -1 }, { callId: "call", fileIndex: 8 },
      { callId: "call", fileIndex: 0, filePath: "/other.md" }, { callId: "", fileIndex: 0 }])
      expect(parseBotWorkAttachmentHref(base + encodeURIComponent(JSON.stringify(input)))).toBeNull()
    expect(parseBotWorkAttachmentHref(botWorkHistoryHref(source))).toBeNull()
  })

  it("drops a late attachment authorization after leaving the owning main chat", async () => {
    const f = setup()
    let release!: (value: Awaited<ReturnType<typeof f.authorizeDeliveredFile>>) => void
    f.authorizeDeliveredFile.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const opening = f.openSource()(botWorkAttachmentHref({ ...source, callId: "call", fileIndex: 0 }))
    await Promise.resolve()
    expect(f.authorizeDeliveredFile).toHaveBeenCalledOnce()
    for (const listener of navigation.listeners) listener({ ...navigation.route, currentThreadId: "other" })
    release({ filePath: "/saved/exact.md", grant: "late", expiresAt: 1, markdownBasePath: "/original/exact.md" })
    await opening
    expect(stateWrites.some(state => state?.ownerThreadId)).toBe(false)
    expect(navigation.selectThread).not.toHaveBeenCalled()
  })

  it.each([
    ["main", {}, true],
    ["main anchored", { messageId: " original-message " }, true],
    ["IM", { imConversationId: "channel" }, false],
    ["group", { groupId: "group" }, false],
    ["work", { conversationThreadId: "work-thread" }, false],
    ["remote", { hostId: "remote" }, false]
  ] as const)("only exposes the ordinary source on its local main conversation (%s)", async (_name, scope, visible) => {
    const f = setup()
    const ordinarySource = { conversation: ref, messageId: source.messageId }
    const href = botThreadHistoryHref(ordinarySource)
    const client = { hostId: "hostId" in scope ? scope.hostId : "local", conversations: { resolveHistory: f.resolveHistory } } as unknown as BotClient
    const tree = BotConversationTools({
      client, botId: "bot", conversationThreadId: "main", ...scope,
      bots: [{ id: "bot", threadId: "main" } as BotDefinition], tasks: [], children: null
    })
    const present = find(tree, ChatToolPresentationContext.Provider)!.props.value
    const messageId = "messageId" in scope ? scope.messageId : undefined
    const card = present({ id: "call", name: "bot_thread_read", args: { conversation: ref, messageId } }, {
      content: JSON.stringify({ kind: "bot-work-receipt", operation: "bot_thread_read", receipt: {
        thread: { conversation: ref, title: "Original form", workspacePath: "/project", updatedAt: 1 },
        entries: [
          { source: ordinarySource, href, role: "user", ordinal: 81, text: "Unsaved form", truncated: false },
          ...(messageId ? [{ source: { ...ordinarySource, messageId: "later-message" },
            href: botThreadHistoryHref({ ...ordinarySource, messageId: "later-message" }),
            role: "assistant", ordinal: 82, text: "Later reply", truncated: false }] : [])
        ],
        scanned: 1, nextCursor: null, coverage: "exhausted"
      } })
    })
    const sources = find(card, BotHistorySources)
    expect(Boolean(sources)).toBe(visible)
    if (!sources) {
      expect(f.resolveHistory).not.toHaveBeenCalled()
      return
    }
    const content = BotHistorySources(sources.props as Parameters<typeof BotHistorySources>[0])
    const direct = find(content, "button")!
    expect(direct.props["aria-label"]).toBe("打开原会话：Original form")
    await direct.props.onClick()
    expect(f.resolveHistory).toHaveBeenCalledExactlyOnceWith("bot", ordinarySource)
    expect(navigation.selectThread).toHaveBeenCalledExactlyOnceWith(threadId)
    expect(useChatSourceNavigation.getState().target).toEqual(target)
    expect(f.expose).not.toHaveBeenCalled()
    expect(f.onOpenWork).not.toHaveBeenCalled()
    expect(f.onPreviewWork).not.toHaveBeenCalled()
  })

  it.each(["ordinary", "detached", "bound"] as const)("activates the original %s chat and publishes its exact anchor", async (kind) => {
    const f = setup()
    const ordinarySource = { conversation: ref, messageId: source.messageId }
    const exactTarget = kind === "detached" ? { ...target, detached: true as const } : target
    f.resolveSource.mockResolvedValueOnce(exactTarget)
    if (kind === "bound") {
      navigation.getThread.mockResolvedValueOnce({ ...row, metadata: {
        ...row.metadata, botHostId: "local", botId: "bot", botWorkId: work.id,
        botLocalConversation: true, botAudienceKey: "desktop", botWorkOrigin: "existing"
      } })
    }
    navigation.selectThread.mockImplementationOnce(async () => {
      expect(navigation.setActiveTab).toHaveBeenCalledExactlyOnceWith("agent")
      expect(useChatSourceNavigation.getState().target).toEqual(target)
    })

    await f.openSource()(kind === "ordinary" ? botThreadHistoryHref(ordinarySource) : botWorkHistoryHref(source))

    expect(navigation.selectThread).toHaveBeenCalledExactlyOnceWith(threadId)
    expect(navigation.getThread).toHaveBeenCalledExactlyOnceWith(threadId)
    expect(navigation.addThreadSummary).toHaveBeenCalledOnce()
    expect(f.onOpenWork).not.toHaveBeenCalled()
    expect(f.onPreviewWork).not.toHaveBeenCalled()
    if (kind === "ordinary") expect(f.resolveHistory).toHaveBeenCalledExactlyOnceWith("bot", ordinarySource)
    else expect(f.resolveSource).toHaveBeenCalledExactlyOnceWith("bot", source)
    if (kind === "bound") {
      expect(f.get).toHaveBeenCalledExactlyOnceWith("bot", source.workId)
      expect(f.expose).toHaveBeenCalledExactlyOnceWith("bot", source.workId)
    } else {
      expect(f.get).not.toHaveBeenCalled()
      expect(f.expose).not.toHaveBeenCalled()
    }
  })

  it.each(["remote", "im"])("retains the original work navigation for %s", async (kind) => {
    const f = setup()
    await f.openSource(kind === "remote" ? { hostId: "remote" } : { imConversationId: "channel" })(botWorkHistoryHref(source))
    expect(f.onOpenWork).toHaveBeenCalledExactlyOnceWith(source.workId)
    expect(useChatSourceNavigation.getState().target).toEqual(target)
    expect(f.get).not.toHaveBeenCalled()
    expect(navigation.selectThread).not.toHaveBeenCalled()
  })

  it("discards a source when a later settings visit happens before the original summary arrives", async () => {
    const f = setup()
    let finish!: (result: Thread) => void
    navigation.getThread.mockReturnValueOnce(new Promise<Thread>(resolve => { finish = resolve }))
    const pending = f.openSource()(botThreadHistoryHref({ conversation: ref, messageId: source.messageId }))
    await vi.waitFor(() => expect(navigation.getThread).toHaveBeenCalledOnce())
    for (const showCustomizeView of [true, false]) {
      navigation.route.showCustomizeView = showCustomizeView
      for (const listener of navigation.listeners) listener(navigation.route)
    }
    finish(row)
    await pending

    expect(useChatSourceNavigation.getState().target).toBeNull()
    expect(navigation.selectThread).not.toHaveBeenCalled()
    expect(navigation.addThreadSummary).not.toHaveBeenCalled()
    expect(navigation.listeners.size).toBe(0)
  })

  it("clears only its own anchor if opening the validated chat fails", async () => {
    const f = setup()
    navigation.selectThread.mockRejectedValueOnce(new Error("原会话打开失败"))
    await f.openSource()(botThreadHistoryHref({ conversation: ref, messageId: source.messageId }))
    expect(useChatSourceNavigation.getState().target).toBeNull()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("原会话打开失败")
  })
})

const receipt = { threadId: "thread", assistantMessageId: "assistant", callId: "delivery", fileIndex: 0 }
const snapshotPath = "/snapshot/report.md"

function deliveredFileViewer(
  client: BotClient,
  request: Partial<OpenResourcePreviewDetail> = {},
  scope: { groupId?: string; imConversationId?: string } = {}
) {
  previews.request.mockReturnValueOnce({
    threadId: receipt.threadId, intentId: 42, filePath: snapshotPath, workspacePathKind: "absolute",
    externalPreviewGrant: "initial-grant", botDeliverySource: receipt, ...request
  })
  return find(BotMessageFilePreview({ client, botId: "bot", threadId: receipt.threadId, name: "Result", ...scope }), FileViewer)!
    .props as React.ComponentProps<typeof FileViewer>
}

it("carries the actual grant expiry from a delivery card and renews the exact snapshot on a later page read", async () => {
  let now = 100_000
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  try {
    const initial = { filePath: snapshotPath, grant: "initial-grant", expiresAt: now + 300_000 }
    const authorize = vi.fn<NonNullable<BotClient["authorizeDeliveredFile"]>>()
      .mockResolvedValueOnce(initial)
      .mockImplementation(async () => ({ filePath: snapshotPath, grant: "renewed-grant", expiresAt: now + 300_000 }))
    const client = { hostId: "local", authorizeDeliveredFile: authorize } as unknown as BotClient
    const card = BotDeliveredFile({ client, threadId: receipt.threadId, filePath: "/original/report.md", source: receipt })
    find(card, "button")!.props.onClick()
    await Promise.resolve()
    expect(previews.open).toHaveBeenCalledWith(expect.objectContaining({
      filePath: snapshotPath, botDeliverySource: receipt, externalPreviewGrantExpiresAt: initial.expiresAt
    }))
    const resolveGrant = deliveredFileViewer(client, { externalPreviewGrantExpiresAt: initial.expiresAt }).resolveExternalPreviewGrant!
    await expect(resolveGrant()).resolves.toBe("initial-grant")
    expect(authorize).toHaveBeenCalledExactlyOnceWith(receipt)

    now = initial.expiresAt + 1
    await expect(Promise.all([resolveGrant(), resolveGrant()])).resolves.toEqual(["renewed-grant", "renewed-grant"])
    await expect(resolveGrant()).resolves.toBe("renewed-grant")
    expect(authorize.mock.calls).toEqual([[receipt], [receipt]])
  } finally {
    clock.mockRestore()
  }
})

it("keeps a denied or redirected renewal from reading a different or stale snapshot", async () => {
  const authorize = vi.fn<NonNullable<BotClient["authorizeDeliveredFile"]>>()
    .mockRejectedValueOnce(new Error("原交付附件已不可用"))
    .mockResolvedValueOnce({ filePath: "/other/report.md", grant: "other" })
    .mockResolvedValueOnce({ filePath: snapshotPath, grant: "renewed", expiresAt: Date.now() + 300_000 })
  const client = { hostId: "local", authorizeDeliveredFile: authorize } as unknown as BotClient
  const resolveGrant = deliveredFileViewer(client).resolveExternalPreviewGrant!
  await expect(resolveGrant()).rejects.toThrow("原交付附件已不可用")
  await expect(resolveGrant()).rejects.toThrow("原交付附件路径已变化")
  await expect(resolveGrant()).resolves.toBe("renewed")
  await expect(resolveGrant()).resolves.toBe("renewed")
  expect(authorize.mock.calls).toEqual([[receipt], [receipt], [receipt]])
})

it("keeps group, IM and other-thread previews on their original transport", () => {
  const authorize = vi.fn()
  const client = { hostId: "local", authorizeDeliveredFile: authorize } as unknown as BotClient
  expect(deliveredFileViewer(client, {}, { groupId: "group" }).resolveExternalPreviewGrant).toBeUndefined()
  expect(deliveredFileViewer(client, {}, { imConversationId: "im" }).resolveExternalPreviewGrant).toBeUndefined()
  expect(deliveredFileViewer(client, { botDeliverySource: { ...receipt, threadId: "other" } }).resolveExternalPreviewGrant).toBeUndefined()
  expect(deliveredFileViewer(client, { botDeliverySource: undefined }).resolveExternalPreviewGrant).toBeUndefined()
  expect(authorize).not.toHaveBeenCalled()
})

it("opens an ordinary Bot delivery snapshot with Bot Markdown styling but no external grant", () => {
  const authorize = vi.fn()
  const client = { hostId: "local", authorizeDeliveredFile: authorize } as unknown as BotClient
  const card = BotDeliveredFile({ client, threadId: "main", filePath: "/original/report.md", attachmentPath: snapshotPath })
  previews.open.mockClear()
  find(card, "button")!.props.onClick()
  const request = previews.open.mock.calls[0][0]
  expect(request).toMatchObject({ threadId: "main", filePath: snapshotPath, botDelivery: true })
  expect(request.externalPreviewGrant).toBeUndefined()
  expect(request.botDeliverySource).toBeUndefined()
  expect(authorize).not.toHaveBeenCalled()
  expect(deliveredFileViewer(client, { botDelivery: true }).botDelivery).toBe(true)
})
