import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { watchPromptHistory, type PromptHistoryCursor, type PromptHistoryEntry } from "@/lib/prompt-history"

type Arrow = "ArrowUp" | "ArrowDown"
function step(index: number | null, key: Arrow, length: number): number | null {
  if (index === null) return length - 1
  if (key === "ArrowUp") return Math.max(0, index - 1)
  return index === length - 1 ? null : index + 1
}

function applyChoice(
  workspace: string,
  entries: PromptHistoryEntry[],
  index: number | null,
  setInput: (value: string, cursor?: PromptHistoryCursor) => void
) {
  const choice = index === null ? undefined : entries[index]
  setInput(choice?.text ?? "", choice && { workspace, ...choice })
}

export function usePromptHistory(
  workspace: string | null,
  threadId: string,
  input: string,
  cursor: PromptHistoryCursor | undefined,
  setInput: (value: string, cursor?: PromptHistoryCursor) => void
) {
  const [history, setHistory] = useState<{ workspace: string; entries: PromptHistoryEntry[] } | null>(null)
  const pending = useRef<{ workspace: string; threadId: string; target: HTMLTextAreaElement; keys: Arrow[] } | null>(null)
  const cancelPending = () => { pending.current = null }
  useEffect(() => workspace
    ? watchPromptHistory(workspace, entries => setHistory({ workspace, entries }))
    : undefined, [workspace])

  const entries = history && history.workspace === workspace ? history.entries : null
  const recalled = Boolean(cursor && workspace === cursor.workspace && input === cursor.text)
  // An out-of-order admission may split a run of equal prompts. Prefer its newest surviving copy.
  const withdrawn = cursor?.previews?.every(source => source.rejected)
  let index = -1
  if (recalled && cursor && entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.text !== input) continue
      if (withdrawn && index < 0) index = i
      if (entry.order <= (cursor.through ?? cursor.order) &&
          cursor.order <= (entry.through ?? entry.order)) {
        index = i
        break
      }
    }
  }
  // A recalled row can age out while another chat in this workspace sends a message.
  const browsing = recalled
  const navigationIndex = browsing ? index : null
  useLayoutEffect(() => {
    const rejected = entries && index < 0 && withdrawn
    if (recalled && rejected) {
      setInput("")
      return
    }
    const queued = pending.current
    if (!queued) return
    if (queued.threadId !== threadId || queued.workspace !== workspace) {
      pending.current = null
      return
    }
    if (!entries) return
    pending.current = null
    if (!workspace || queued.target !== document.activeElement || (!browsing && input) || !entries.length) return
    const next = queued.keys.reduce<number | null>((i, key) => step(i, key, entries.length), navigationIndex)
    applyChoice(workspace, entries, next, setInput)
  }, [workspace, threadId, input, recalled, entries, index, navigationIndex, browsing, withdrawn, setInput])

  function navigate(event: KeyboardEvent): boolean {
    if (!workspace || (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      (!browsing && input !== "") || !(event.target instanceof HTMLTextAreaElement)) return false

    if (!entries) {
      // Replay early keystrokes when IndexedDB opens, provided the same draft still has focus.
      const prior = pending.current
      if (prior && prior.workspace === workspace && prior.threadId === threadId) prior.keys.push(event.key)
      else pending.current = { workspace, threadId, target: event.target, keys: [event.key] }
    } else {
      if (!entries.length) return false
      const next = step(navigationIndex, event.key, entries.length)
      applyChoice(workspace, entries, next, setInput)
      if (next !== null && entries[next].text === input) event.target.setSelectionRange(input.length, input.length)
    }
    event.preventDefault()
    return true
  }

  return { browsing, navigate, cancelPending }
}
