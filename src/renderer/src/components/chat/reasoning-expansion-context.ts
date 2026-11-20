import { createContext, useContext, useLayoutEffect, useState } from "react"

export interface ReasoningExpansionState {
  open: boolean
  autoOpened: boolean
  autoCollapsed: boolean
}

interface SavedReasoningExpansion {
  generation: number
  state: ReasoningExpansionState
}

// 重试失效仅清理缓存。代次随父级消息快照进入 hook，避免旧 props 消费新 attempt。
export class ReasoningExpansionStore extends Map<string, SavedReasoningExpansion> {
  latestRevision = 0

  discardMessages(threadId: string, messageIds: ReadonlySet<string>, revision: number): void {
    this.latestRevision = Math.max(this.latestRevision, revision)
    for (const id of messageIds) {
      for (const role of ["user", "assistant", "system", "tool"]) {
        this.delete(`${threadId}:${role}:${id}`)
      }
    }
  }
}

export const ReasoningExpansionContext = createContext<ReasoningExpansionStore | null>(null)
const MAX_SAVED_REASONING_CHOICES = 500
const INITIAL_REASONING_STATE: ReasoningExpansionState = {
  open: false,
  autoOpened: false,
  autoCollapsed: false
}

// Match the original two one-shot effects, in order. A manual toggle changes only `open`:
// starting an answer still auto-collapses once, but later tokens cannot override a toggle.
export function advanceReasoningExpansion(
  previous: ReasoningExpansionState,
  hasReasoning: boolean,
  isStreaming: boolean,
  hasAnswer: boolean
): ReasoningExpansionState {
  if (!hasReasoning) return previous
  let next = previous
  if (isStreaming && !next.autoOpened) next = { ...next, open: true, autoOpened: true }
  // 消息可能在虚拟行卸载期间完成回答，恢复时补齐已开始的自动收起阶段。
  // 普通历史消息从未自动展开；用户在自动收起后手动重开，也都保持原选择。
  if (hasAnswer && next.autoOpened && !next.autoCollapsed) {
    next = { ...next, open: false, autoCollapsed: true }
  }
  return next
}

export function rememberReasoningExpansion(
  choices: ReasoningExpansionStore,
  messageId: string,
  state: ReasoningExpansionState,
  generation = 0,
  revision = 0
): void {
  // 旧 Virtuoso 回调可能在 reset 后提交；不能把上一 attempt 的状态写回。
  if (revision < choices.latestRevision) return
  choices.latestRevision = revision
  choices.delete(messageId)
  choices.set(messageId, { generation, state })
  if (choices.size > MAX_SAVED_REASONING_CHOICES) {
    const oldest = choices.keys().next().value
    if (oldest !== undefined) choices.delete(oldest)
  }
}

export function useReasoningExpansion(
  messageId: string,
  hasReasoning: boolean,
  isStreaming: boolean,
  hasAnswer: boolean,
  snapshotGeneration = 0,
  revision = 0
): [boolean, () => void] {
  const choices = useContext(ReasoningExpansionContext)
  const cached = choices?.get(messageId)
  // 0 也可能表示代次记录已淘汰。保留仍在缓存中的历史选择，但不借用未来快照的代次。
  const generation =
    snapshotGeneration || (cached && cached.generation <= revision ? cached.generation : 0)
  const initial = cached?.generation === generation ? cached.state : INITIAL_REASONING_STATE
  const [saved, setSaved] = useState(() => ({
    messageId,
    choices,
    generation,
    revision,
    state: advanceReasoningExpansion(initial, hasReasoning, isStreaming, hasAnswer)
  }))
  const matches =
    saved.messageId === messageId && saved.choices === choices && saved.generation === generation
  // 超过有界代次窗口的 ID 回到 0；缓存已被 discard 时也不能沿用挂载行的旧状态。
  const discardedOutsideWindow = choices && saved.revision !== revision && !cached
  const previous = matches && !discardedOutsideWindow ? saved.state : initial
  const state = advanceReasoningExpansion(previous, hasReasoning, isStreaming, hasAnswer)
  // 在提交 DOM 前调整本组件状态，避免 ResizeObserver 先测到错误的折叠高度。
  if (!matches || saved.state !== state || saved.revision !== revision) {
    setSaved({ messageId, choices, generation, revision, state })
  }

  useLayoutEffect(() => {
    if (!choices || !hasReasoning) return
    rememberReasoningExpansion(choices, messageId, state, generation, revision)
  }, [choices, hasReasoning, messageId, state, generation, revision])

  const toggle = (): void => {
    setSaved({ messageId, choices, generation, revision, state: { ...state, open: !state.open } })
  }

  return [state.open, toggle]
}
