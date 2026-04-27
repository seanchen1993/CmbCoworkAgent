import { useCallback, useMemo, useState } from "react"
import type { SkillMetadata } from "@/types"

export type PopoverMode =
  | { kind: "closed" }
  | { kind: "skill"; filter: string; skills: SkillMetadata[] }

/**
 * Popover state machine for `/<filter>` skill selection.
 *
 * Open when: input starts with `/` AND no skill is already picked AND the filter
 * has no whitespace (anything with a space is plain text, not a command).
 *
 * `skillSelected = true` keeps the popover closed so typing `/` again after
 * selection doesn't reopen it — the user has to remove the chip first.
 */
export function useSlashCommands(params: {
  input: string
  skills: SkillMetadata[]
  skillSelected: boolean
}) {
  const { input, skills, skillSelected } = params
  const [selectedIdx, setSelectedIdx] = useState(0)

  const mode = useMemo<PopoverMode>(() => {
    if (skillSelected) return { kind: "closed" }
    if (!input.startsWith("/")) return { kind: "closed" }
    const filter = input.slice(1).toLowerCase()
    if (/\s/.test(filter)) return { kind: "closed" }

    const filtered = filter
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(filter) ||
            (s.description ?? "").toLowerCase().includes(filter)
        )
      : skills
    return { kind: "skill", filter, skills: filtered }
  }, [input, skills, skillSelected])

  // Reset highlight to top whenever the popover (re-)opens or the filter changes,
  // so pressing Enter right after typing never selects a stale carry-over item.
  // useState rather than a ref to play nicely with StrictMode's double-invoke.
  const currentKey = mode.kind === "skill" ? `skill:${mode.filter}` : "closed"
  const [prevKey, setPrevKey] = useState(currentKey)
  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    if (selectedIdx !== 0) setSelectedIdx(0)
  }

  const totalItems = mode.kind === "skill" ? mode.skills.length : 0
  const clampedIdx = totalItems === 0 ? 0 : Math.min(selectedIdx, totalItems - 1)

  const moveSelection = useCallback(
    (delta: number) => {
      if (totalItems === 0) return
      setSelectedIdx((prev) => (prev + delta + totalItems) % totalItems)
    },
    [totalItems]
  )

  const resetSelection = useCallback(() => setSelectedIdx(0), [])

  return {
    mode,
    selectedIdx: clampedIdx,
    moveSelection,
    resetSelection,
    setSelectedIdx
  }
}
