import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileAttachment } from "../../../shared/file-attachment"
import {
  bindBotConversationDraft,
  restoreBotConversationDraft,
  saveBotConversationDraft,
  pruneBotConversationDrafts
} from "./bot-conversation-draft"

type Context = Parameters<typeof bindBotConversationDraft>[0]
const file: FileAttachment = {
  filename: "核验.csv",
  filePath: "/retained/核验.csv",
  content: "amount\n38.55",
  mimeType: "text/csv",
  size: 12,
  truncated: false
}
const fixture = () => {
  let state = { draftInput: "", draftAttachments: [] as FileAttachment[], messages: [] }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const actions = {
    setDraftInput: (draftInput: string) => publish({ draftInput }),
    setDraftAttachments: (draftAttachments: FileAttachment[]) => publish({ draftAttachments })
  }
  return {
    state: () => state,
    publish,
    actions,
    listeners,
    context: {
      initializeThread: vi.fn(),
      getThreadState: () => state,
      getThreadActions: () => actions,
      subscribeToThreadState: (_: string, listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    } as unknown as Context
  }
}

let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("private Bot drafts in the original ThreadContext", () => {
  it("initializes the original queue and history before any restored composer action", () => {
    const f = fixture()
    f.actions.setDraftInput("Saved")
    saveBotConversationDraft(f.context, "local", "a", "t")
    const cold = fixture()
    const order: string[] = []
    cold.context.initializeThread = () => {
      order.push("initialize")
    }
    const write = cold.actions.setDraftInput
    cold.actions.setDraftInput = (text) => {
      order.push("draft")
      write(text)
    }
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(order).toEqual(["initialize", "draft"])
    expect(cold.state().draftInput).toBe("Saved")
  })
  it("restores unsent text and retained files after a cold reload, then removes consumed content", () => {
    const first = fixture()
    const stop = bindBotConversationDraft(first.context, "local", "a", "thread-a", vi.fn())
    first.actions.setDraftInput("核对这份文件")
    first.actions.setDraftAttachments([file])
    const writes = vi.mocked(localStorage.setItem).mock.calls.length
    first.publish({ messages: [] })
    first.publish({ messages: [] })
    expect(localStorage.setItem).toHaveBeenCalledTimes(writes)
    stop()
    expect(first.listeners.size).toBe(0)
    const cold = fixture()
    const unsubscribe = bindBotConversationDraft(cold.context, "local", "a", "thread-a", vi.fn())
    expect(cold.state()).toMatchObject({ draftInput: "核对这份文件", draftAttachments: [file] })
    cold.actions.setDraftInput("")
    cold.actions.setDraftAttachments([])
    unsubscribe()
    const afterSend = fixture()
    restoreBotConversationDraft(afterSend.context, "local", "a", "thread-a")
    expect(afterSend.state()).toMatchObject({ draftInput: "", draftAttachments: [] })
  })

  it("lets new chat restore before merging and keeps hosts, private Bots and in-memory edits separate", () => {
    const original = fixture()
    original.actions.setDraftInput("Old")
    original.actions.setDraftAttachments([file])
    saveBotConversationDraft(original.context, "local", "a", "t")
    const newChat = fixture()
    restoreBotConversationDraft(newChat.context, "local", "a", "t")
    newChat.actions.setDraftInput(newChat.state().draftInput + "\nNew")
    saveBotConversationDraft(newChat.context, "local", "a", "t")
    const cold = fixture()
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state()).toMatchObject({ draftInput: "Old\nNew", draftAttachments: [file] })
    cold.actions.setDraftInput("Newer local edit")
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state().draftInput).toBe("Newer local edit")
    for (const [host, bot] of [
      ["remote", "a"],
      ["local", "b"]
    ]) {
      const other = fixture()
      restoreBotConversationDraft(other.context, host, bot, "t")
      expect(other.state().draftInput).toBe("")
    }
  })

  it("preserves malformed recovery records through mounting, stream updates and unmounting", () => {
    const storageKey = 'cmb-bot-conversation-draft-v1:["local","a"]'
    values.set(storageKey, '{"version":1,"attachments":[{"filePath":null}]}')
    const context = fixture(),
      onError = vi.fn()
    const stop = bindBotConversationDraft(context.context, "local", "a", "t", onError)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("未能恢复"))
    context.publish({ messages: [] })
    stop()
    expect(values.get(storageKey)).toContain('"filePath":null')
  })

  it("reports quota failure without losing current text or files and retries when the conversation reopens", () => {
    const current = fixture(),
      onError = vi.fn()
    const stop = bindBotConversationDraft(current.context, "local", "a", "t", onError)
    const setter = vi.mocked(localStorage.setItem)
    setter.mockImplementation(() => {
      throw new Error("Quota exceeded")
    })
    current.actions.setDraftInput("Keep")
    current.actions.setDraftAttachments([file])
    expect(current.state()).toMatchObject({ draftInput: "Keep", draftAttachments: [file] })
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("未保存"))
    stop()
    setter.mockImplementation((key, value) => {
      values.set(key, value)
    })
    const cleanup = bindBotConversationDraft(current.context, "local", "a", "t", onError)
    expect(onError).toHaveBeenLastCalledWith(null)
    cleanup()
    const cold = fixture()
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state()).toMatchObject({ draftInput: "Keep", draftAttachments: [file] })
  })

  it("prunes deleted Bot drafts without deleting another host or group record, and unbound updates cannot revive them", () => {
    const removed = fixture()
    const stop = bindBotConversationDraft(removed.context, "prune-local", "removed", "t", vi.fn())
    removed.actions.setDraftInput("Discarded synthetic draft")
    const other = fixture()
    other.actions.setDraftInput("Retained")
    saveBotConversationDraft(other.context, "other-host", "removed", "t")
    const groupKey = 'cmb-bot-group-draft-v1:["prune-local","group"]'
    values.set(groupKey, "group record")
    stop()
    pruneBotConversationDrafts("prune-local", [])
    removed.publish({ messages: [] })
    expect([...values.keys()]).not.toContain(
      'cmb-bot-conversation-draft-v1:["prune-local","removed"]'
    )
    expect(values.has('cmb-bot-conversation-draft-v1:["other-host","removed"]')).toBe(true)
    expect(values.get(groupKey)).toBe("group record")
  })
})
