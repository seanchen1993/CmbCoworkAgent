import { useCallback, useMemo, useState } from "react"
import type { SkillMetadata } from "@/types"

export type PopoverMode =
  | { kind: "closed" }
  | { kind: "skill"; filter: string; skills: SkillMetadata[] }

/**
 * Triggered when input starts with `/` (skill is already selected => popover stays closed).
 * If `skillSelected` is true, typing `/` again does nothing (skill already chosen).
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
    // Only trigger at the very start; once there's a space, treat as plain text.
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

  // Reset highlight to the top whenever the popover (re-)opens or the filter term changes,
  // so pressing Enter right after typing never selects a stale carry-over item.
  // Store the previous key in state (per React docs: "storing information from previous
  // renders"). Using useState rather than a ref here is safer under StrictMode's double
  // invocation — setState triggers a second render that self-corrects, whereas a ref
  // mutated during the first render would stick and then mismatch on the re-run.
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
