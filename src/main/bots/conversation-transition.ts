import { randomUUID } from "node:crypto"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { BotError } from "../../shared/bots/contracts"
import type { BotConversationDeletionOutcome, BotConversationTransitionRequest } from "../../shared/bots/conversation"

type Input = BotConversationTransitionRequest extends infer T
  ? T extends BotConversationTransitionRequest ? Omit<T, "id"> : never : never
type Pending = { owner: number; apply(event?: IpcMainInvokeEvent): Promise<BotConversationDeletionOutcome | void>; fail(error: Error): void }
const windows = new Map<number, WebContents>()
const closed = new Map<number, () => void>()
const pending = new Map<string, Pending>()

/** One short desktop handshake; no new execution queue or persistent task state. */
export function listenBotConversationTransitions(sender: WebContents, listening: boolean) {
  if (listening) {
    if (windows.has(sender.id)) return
    windows.set(sender.id, sender)
    const remove = () => listenBotConversationTransitions(sender, false)
    closed.set(sender.id, remove)
    sender.once("destroyed", remove)
  } else {
    windows.delete(sender.id)
    const remove = closed.get(sender.id)
    if (remove) sender.removeListener("destroyed", remove)
    closed.delete(sender.id)
    for (const request of pending.values()) if (request.owner === sender.id)
      request.fail(new BotError("CONFLICT", "会话窗口已关闭，未确认的关联操作已停止。"))
  }
}

export function requestBotConversationTransition<T>(
  input: Input, signal: AbortSignal, apply: (event?: IpcMainInvokeEvent) => Promise<T>,
  desktopOutcome?: (result: T) => BotConversationDeletionOutcome
): Promise<T> {
  signal.throwIfAborted()
  const window = [...windows.values()].find(window => !window.isDestroyed())
  if (!window) return Promise.reject(new BotError("CONFLICT", "桌面窗口尚未就绪，无法安全停放原会话草稿。"))
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID()
    let applying = false
    const clean = () => {
      clearTimeout(timer)
      pending.delete(id)
      signal.removeEventListener("abort", abort)
    }
    const fail = (error: Error) => { if (!applying) {
      clean()
      try { if (!window.isDestroyed()) window.send("bots:conversation:transition-dismissed", id) } catch { /* Window is closing. */ }
      reject(error)
    } }
    const abort = () => fail(new BotError("CONFLICT", "原任务已停止，未执行会话关联变更。"))
    const timer = setTimeout(() => fail(new BotError("CONFLICT", input.action === "delete"
      ? "删除未在确认窗口中完成，未执行删除。"
      : input.action === "unlink"
        ? "解除关联尚未完成确认或草稿核对，未执行操作。"
        : "原会话草稿尚未完成核对，未执行关联变更；请先检查原会话。")),
    input.action === "link" ? 15_000 : 120_000)
    pending.set(id, { owner: window.id, fail, apply: async (event) => {
      if (applying) throw new BotError("CONFLICT", "原关联操作正在处理，请读取原回执。")
      if (input.action === "delete" && (!event || event.sender.id !== window.id || event.senderFrame !== event.sender.mainFrame))
        throw new BotError("CONFLICT", "删除必须由当前桌面确认窗口提交。")
      signal.throwIfAborted()
      applying = true
      clearTimeout(timer)
      try {
        const result = await apply(event)
        resolve(result)
        return desktopOutcome?.(result)
      } catch (error) { reject(error); throw error } finally { clean() }
    } })
    signal.addEventListener("abort", abort, { once: true })
    try { window.send("bots:conversation:transition", { ...input, id }) }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
}

export async function finishBotConversationTransition(senderId: number, id: string, error?: string, event?: IpcMainInvokeEvent): Promise<BotConversationDeletionOutcome | void> {
  const request = pending.get(id)
  if (!request || request.owner !== senderId)
    throw new BotError("CONFLICT", "会话关联请求已失效，未执行操作。")
  if (error !== undefined) { request.fail(new BotError("CONFLICT", error)); return }
  return request.apply(event)
}
