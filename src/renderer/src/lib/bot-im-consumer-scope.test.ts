import { describe, expect, it, vi } from "vitest"
import { Children, isValidElement, type ReactElement } from "react"
import type { BotClient, BotTask } from "../../../shared/bots/contracts"
import { botGroupBrowserScope } from "../../../shared/bots/contracts"
import { botImBrowserScope } from "../../../shared/bots/im-channel"

// Exercise the actual presenter and save callbacks without mounting Electron.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot()
}))
vi.mock("./thread-context", () => ({
  useThreadContext: () => ({ getThreadState: () => ({ messages: [] }) }),
  useThreadStateSelector: (_id: string, select: (state: { messages: never[] }) => unknown) =>
    select({ messages: [] })
}))
vi.mock("../components/bots/view-store", () => ({ useBotViewStore: () => false }))
vi.mock("../components/bots/BotExchangePanel", () => ({ BotExchangePanel: () => null }))
vi.mock("../components/bots/BotActivity", () => ({ BotActivity: () => null }))
vi.mock("../components/bots/BotMentionLabel", () => ({ BotMentionLabel: () => null }))
vi.mock("../components/bots/BotQuestionHistory", () => ({ BotQuestionHistory: () => null }))
vi.mock("../components/bots/BotHistorySources", () => ({ BotHistorySources: () => null }))
vi.mock("./resource-preview-events", () => ({ emitOpenResourcePreview: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { BotConversationTools } from "../components/bots/BotConversationTools"
import { BotDeliveredFile, BotDeliveredFiles } from "../components/bots/BotDeliveredFile"
import { BotBrowserHelpCard } from "../components/bots/BotBrowserHelpCard"
import {
  ChatToolPresentationContext,
  ChatFilePresentationContext
} from "../components/chat/chat-presentation-context"

function find(element: unknown, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (!isValidElement<Record<string, any>>(element)) return undefined
  if (element.type === type) return element
  for (const child of Children.toArray(element.props.children)) {
    const result = find(child, type)
    if (result) return result
  }
  return undefined
}

describe("Bot conversation scoped consumers", () => {
  it.each([
    { imConversationId: "im-a", groupId: undefined },
    { imConversationId: "im-b", groupId: undefined },
    { imConversationId: undefined, groupId: "group" },
    { imConversationId: undefined, groupId: undefined }
  ])("keeps help and both attachment paths in their conversation: %o", async (scope) => {
    const methods = {
      hostId: "local",
      exportFile: vi.fn(),
      exportGroupFile: vi.fn(),
      im: { exportFile: vi.fn() }
    }
    const client = methods as unknown as BotClient
    const tree = BotConversationTools({
      client,
      botId: "bot",
      ...scope,
      conversationThreadId: "thread",
      bots: [],
      tasks: [{ state: "waiting_user" } as BotTask],
      executionDetails: true,
      children: null
    })
    const tool = find(tree, ChatToolPresentationContext.Provider)!.props.value
    const file = find(tree, ChatFilePresentationContext.Provider)!.props.value
    const help = tool({
      id: "help",
      name: "bot_browser",
      args: { action: "request_help", instruction: "Verify" }
    })
    expect(help.type).toBe(BotBrowserHelpCard)
    expect(help.props.scopeId).toBe(
      scope.imConversationId
        ? botImBrowserScope(scope.imConversationId, "bot")
        : scope.groupId
          ? botGroupBrowserScope(scope.groupId, "bot")
          : "bot"
    )
    const delivered = tool(
      { id: "delivery", name: "bot_deliver_files", args: {} },
      {
        content: JSON.stringify({
          kind: "bot-file-delivery",
          files: [
            {
              filePath: "/original/report.md",
              attachmentPath: "/snapshot/report.md",
              name: "report.md",
              size: 12
            }
          ]
        })
      }
    )
    expect(delivered.type).toBe(BotDeliveredFiles)
    const batch = BotDeliveredFiles(delivered.props)
    const cards = [
      find(batch, BotDeliveredFile)!,
      file({ filePath: "/linked/report.md", threadId: "thread" })
    ]
    for (const card of cards) {
      const rendered = BotDeliveredFile(card.props as Parameters<typeof BotDeliveredFile>[0])
      const buttons = Children.toArray(rendered.props.children) as ReactElement<
        Record<string, any>
      >[]
      buttons[1].props.onClick()
    }
    const expected = scope.imConversationId
      ? methods.im.exportFile
      : scope.groupId
        ? methods.exportGroupFile
        : methods.exportFile
    await vi.waitFor(() => expect(expected).toHaveBeenCalledTimes(2))
    const prefix = scope.imConversationId
      ? ["bot", scope.imConversationId]
      : [scope.groupId ?? "bot"]
    expect(expected).toHaveBeenNthCalledWith(
      1,
      ...prefix,
      "/snapshot/report.md",
      ...(scope.imConversationId ? [undefined] : [])
    )
    expect(expected).toHaveBeenNthCalledWith(
      2,
      ...prefix,
      "/linked/report.md",
      ...(scope.imConversationId ? [undefined] : [])
    )
    for (const other of [methods.im.exportFile, methods.exportGroupFile, methods.exportFile])
      if (other !== expected) expect(other).not.toHaveBeenCalled()
  })
})
