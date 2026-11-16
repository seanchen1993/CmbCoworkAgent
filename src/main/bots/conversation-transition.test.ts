import { EventEmitter } from "node:events"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import type { BotWorkConversationResolution } from "../../shared/bots/conversation"
import { afterEach, describe, expect, it, vi } from "vitest"
import { finishBotConversationTransition, listenBotConversationTransitions, requestBotConversationTransition } from "./conversation-transition"

const senders: WebContents[] = []
function desktop(id = 1) {
  const events = new EventEmitter()
  const sender = Object.assign(events, { id, isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
  senders.push(sender)
  listenBotConversationTransitions(sender, true)
  return sender
}
afterEach(() => {
  for (const sender of senders.splice(0)) listenBotConversationTransitions(sender, false)
  vi.useRealTimers()
})
const input = {
  action: "link" as const, threadId: "existing",
  incarnation: { token: "existing-incarnation", legacyCreatedAt: 1 }
}
const requestId = (sender: WebContents) => vi.mocked(sender.send).mock.calls.filter(call => call[0] === "bots:conversation:transition").at(-1)![1].id as string

describe("Bot desktop conversation transition", () => {
  it("requires a real main-frame confirmation and returns only the committed deletion facts", async () => {
    const sender = desktop()
    Object.assign(sender, { mainFrame: {} })
    const apply = vi.fn(async () => ({ state: "cleanup_pending", deletedThreadId: "original", error: "工作回执待补" }))
    const result = requestBotConversationTransition(
      { action: "delete", title: "Original", threadId: "original", work: { botId: "bot", workId: "work" } },
      new AbortController().signal, apply,
      receipt => ({ deletedThreadId: receipt.deletedThreadId, error: receipt.error })
    )
    const id = requestId(sender)
    await expect(finishBotConversationTransition(sender.id, id)).rejects.toThrow("桌面确认")
    await expect(finishBotConversationTransition(sender.id, id, undefined,
      { sender, senderFrame: {} } as IpcMainInvokeEvent)).rejects.toThrow("桌面确认")
    expect(apply).not.toHaveBeenCalled()
    const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent
    await expect(finishBotConversationTransition(sender.id, id, undefined, event)).resolves.toEqual({ deletedThreadId: "original", error: "工作回执待补" })
    expect(apply).toHaveBeenCalledExactlyOnceWith(event)
    await expect(result).resolves.toMatchObject({ state: "cleanup_pending" })
  })

  it("expires an unconfirmed deletion without touching its target", async () => {
    vi.useFakeTimers()
    const sender = desktop(), apply = vi.fn(async () => undefined)
    const result = requestBotConversationTransition({ action: "delete", title: "Original", threadId: "original" }, new AbortController().signal, apply)
    const check = expect(result).rejects.toThrow("未执行删除")
    await vi.advanceTimersByTimeAsync(120_000)
    await check
    expect(sender.send).toHaveBeenLastCalledWith("bots:conversation:transition-dismissed", requestId(sender))
    expect(apply).not.toHaveBeenCalled()
  })
  it("leaves time for unlink confirmation and expires without applying an unconfirmed request", async () => {
    vi.useFakeTimers()
    const sender = desktop(), apply = vi.fn(async () => undefined)
    const link = { work: { id: "work" }, bot: { id: "bot" } } as BotWorkConversationResolution
    const result = requestBotConversationTransition({ action: "unlink", threadId: "original", link }, new AbortController().signal, apply)
    const check = expect(result).rejects.toThrow("解除关联尚未完成确认")
    const id = requestId(sender)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sender.send).not.toHaveBeenCalledWith("bots:conversation:transition-dismissed", id)
    await vi.advanceTimersByTimeAsync(105_000)
    await check
    expect(sender.send).toHaveBeenLastCalledWith("bots:conversation:transition-dismissed", id)
    expect(apply).not.toHaveBeenCalled()
  })
  it("waits for the registered desktop's draft reconciliation before applying once", async () => {
    const sender = desktop(), apply = vi.fn(async () => ({ workId: "original" }))
    const result = requestBotConversationTransition(input, new AbortController().signal, apply)
    const id = requestId(sender)
    expect(apply).not.toHaveBeenCalled()
    await expect(finishBotConversationTransition(999, id)).rejects.toThrow("已失效")
    expect(apply).not.toHaveBeenCalled()
    await finishBotConversationTransition(sender.id, id)
    await expect(result).resolves.toEqual({ workId: "original" })
    await expect(finishBotConversationTransition(sender.id, id)).rejects.toThrow("已失效")
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("does not change association when drafts, cancellation or a closed window prevent reconciliation", async () => {
    const sender = desktop(), apply = vi.fn(async () => undefined)
    const failed = requestBotConversationTransition(input, new AbortController().signal, apply)
    const checked = expect(failed).rejects.toThrow("原发送回执未知")
    await finishBotConversationTransition(sender.id, requestId(sender), "原发送回执未知")
    await checked
    const abort = new AbortController()
    const cancelled = requestBotConversationTransition(input, abort.signal, apply)
    const cancelledCheck = expect(cancelled).rejects.toThrow("原任务已停止")
    const id = requestId(sender)
    abort.abort()
    await cancelledCheck
    await expect(finishBotConversationTransition(sender.id, id)).rejects.toThrow("已失效")
    const closing = requestBotConversationTransition(input, new AbortController().signal, apply)
    const closingCheck = expect(closing).rejects.toThrow("窗口已关闭")
    sender.emit("destroyed")
    await closingCheck
    expect(apply).not.toHaveBeenCalled()
  })

  it("reports a missing or unresponsive desktop without creating or running a task", async () => {
    const apply = vi.fn(async () => undefined)
    await expect(requestBotConversationTransition(input, new AbortController().signal, apply)).rejects.toThrow("窗口尚未就绪")
    vi.useFakeTimers()
    const sender = desktop()
    const result = requestBotConversationTransition(input, new AbortController().signal, apply)
    const checked = expect(result).rejects.toThrow("草稿尚未完成核对")
    await vi.advanceTimersByTimeAsync(15_000)
    await checked
    await expect(finishBotConversationTransition(sender.id, requestId(sender))).rejects.toThrow("已失效")
    expect(apply).not.toHaveBeenCalled()
  })

  it("does not time out or duplicate an already acknowledged mutation, and preserves its error", async () => {
    vi.useFakeTimers()
    const sender = desktop()
    let finish!: () => void
    const apply = vi.fn(() => new Promise<string>(resolve => { finish = () => resolve("same work") }))
    const result = requestBotConversationTransition(input, new AbortController().signal, apply)
    const id = requestId(sender), acknowledgement = finishBotConversationTransition(sender.id, id)
    await expect(finishBotConversationTransition(sender.id, id)).rejects.toThrow("正在处理")
    await vi.advanceTimersByTimeAsync(16_000)
    finish()
    await acknowledgement
    await expect(result).resolves.toBe("same work")
    expect(apply).toHaveBeenCalledTimes(1)
    const failure = requestBotConversationTransition(input, new AbortController().signal, async () => { throw new Error("原身份已变") })
    const checked = expect(failure).rejects.toThrow("原身份已变")
    await expect(finishBotConversationTransition(sender.id, requestId(sender))).rejects.toThrow("原身份已变")
    await checked
  })

  it("removes listeners when the desktop subscription is replaced", () => {
    const sender = desktop()
    for (let i = 0; i < 5; i++) {
      listenBotConversationTransitions(sender, false)
      listenBotConversationTransitions(sender, true)
    }
    expect(sender.listenerCount("destroyed")).toBe(1)
    listenBotConversationTransitions(sender, false)
    expect(sender.listenerCount("destroyed")).toBe(0)
  })
})
