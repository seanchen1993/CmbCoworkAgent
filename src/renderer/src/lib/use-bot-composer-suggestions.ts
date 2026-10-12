import { useEffect, useId, useMemo, useState } from "react"
import {
  filterEditorSuggestionEntries,
  selectEditorSuggestion,
  type EditorSuggestionEntry
} from "../components/bots/upstream/grok-editor-suggestions"
import { findSpaceSuggestionMatch } from "../components/bots/upstream/grok-suggestion-match"

/** Shared Grok matching/keyboard behavior for skills and stable Bot recipients. */
export type BotComposerKeyboardEvent = Pick<
  KeyboardEvent,
  "key" | "keyCode" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "preventDefault"
> & { isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }

export function useBotComposerSuggestions(input: {
  scope: string
  char: "/" | "@"
  prompt: string
  caret: number
  enabled: boolean
  entries: EditorSuggestionEntry[]
  /** Explicit actions may open this picker without inserting a trigger into text. */
  activation?: { id: number; query: string; position: number } | null
  dismiss?(): void
  choose(entry: EditorSuggestionEntry, from: number, to: number): void
}) {
  const signature = JSON.stringify([input.scope, input.prompt, input.caret, input.activation])
  const [dismissed, setDismissed] = useState<string | null>(null)
  const match =
    input.enabled && dismissed !== signature
      ? input.activation !== undefined
        ? input.activation && {
            range: { from: input.activation.position, to: input.activation.position },
            query: input.activation.query,
            text: ""
          }
        : findSpaceSuggestionMatch({
            char: input.char,
            $position: {
              pos: input.caret,
              nodeBefore: { isText: true, text: input.prompt.slice(0, input.caret) },
              nodeAfter: { isText: true, text: input.prompt.slice(input.caret) }
            }
          })
      : null
  const open = match !== null
  const [active, setActive] = useState({ signature: "", index: 0 })
  const listId = useId()
  const entries = useMemo(
    () => filterEditorSuggestionEntries(input.entries, match?.query ?? "").slice(0, 8),
    [input.entries, match?.query]
  )
  const activeIndex = Math.min(
    active.signature === signature ? active.index : 0,
    Math.max(0, entries.length - 1)
  )
  useEffect(() => {
    if (open)
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" })
  }, [open, listId, activeIndex, entries.length])
  const choose = (index: number) => {
    const entry = entries[index]
    if (entry && match) input.choose(entry, match.range.from, match.range.to)
  }
  const onKeyDown = (event: BotComposerKeyboardEvent): boolean => {
    if (
      !open ||
      event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.keyCode === 229 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return false
    const result = selectEditorSuggestion(entries, activeIndex, event.key)
    if (result.kind === "noop") return false
    event.preventDefault()
    if (result.kind === "move") setActive({ signature, index: result.activeIndex })
    if (result.kind === "select") choose(entries.indexOf(result.entry))
    if (result.kind === "dismiss") {
      setDismissed(signature)
      input.dismiss?.()
    }
    return true
  }
  return { open, query: match?.query ?? "", entries, activeIndex, listId, choose, onKeyDown }
}
