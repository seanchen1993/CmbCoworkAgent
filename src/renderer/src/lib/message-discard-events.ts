export const MAX_MESSAGE_ATTEMPTS = 500

export interface MessageAttempts {
  revision: number
  generations: ReadonlyMap<string, number>
}

// 与消息快照一起传递；重试才复制，普通 token 保持引用。上限与折叠缓存一致。
export function advanceMessageAttempts(
  previous: MessageAttempts | undefined,
  messageIds: ReadonlySet<string>
): MessageAttempts {
  const revision = (previous?.revision ?? 0) + 1
  const generations = new Map(previous?.generations)
  for (const id of messageIds) {
    generations.delete(id)
    generations.set(id, revision)
  }
  while (generations.size > MAX_MESSAGE_ATTEMPTS) {
    generations.delete(generations.keys().next().value!)
  }
  return { revision, generations }
}

type MessageDiscardListener = (messageIds: ReadonlySet<string>, revision: number) => void

// 只保留已挂载视图的订阅；失败 attempt 的失效事件不进入历史或 token 热路径。
const listenersByThread = new Map<string, Set<MessageDiscardListener>>()

export function subscribeToMessageDiscard(
  threadId: string,
  listener: MessageDiscardListener
): () => void {
  let listeners = listenersByThread.get(threadId)
  if (!listeners) {
    listeners = new Set()
    listenersByThread.set(threadId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByThread.get(threadId) === listeners) {
      listenersByThread.delete(threadId)
    }
  }
}

export function publishMessageDiscard(
  threadId: string,
  messageIds: ReadonlySet<string>,
  revision: number
): void {
  const listeners = listenersByThread.get(threadId)
  if (!listeners) return
  for (const listener of [...listeners]) listener(messageIds, revision)
}
