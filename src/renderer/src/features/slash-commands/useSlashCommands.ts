/**
 * Slash-command composer hook.
 *
 * Minimal state machine driven by the composer input:
 *   - "/" at start of input with no whitespace → popover OPEN, filter by text after slash
 *   - space anywhere after a selected command → popover CLOSED, args mode
 *   - ESC or non-slash input → popover CLOSED
 *   - Enter picks the highlighted command and sets it as the active selection
 *
 * The hook owns only the popover state and the selected command. Actual send
 * wiring (what to put on the wire) lives in ChatContainer.submitMessage.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import type { SlashCommandListItem } from "./types"

export type PopoverMode = { kind: "closed" } | { kind: "open"; filter: string }

export interface UseSlashCommandsResult {
  commands: SlashCommandListItem[]
  loading: boolean
  popover: PopoverMode
  filtered: SlashCommandListItem[]
  selectedIdx: number
  setSelectedIdx: (n: number) => void
  /** Selected command (slash chip visible in composer while truthy). */
  selected: SlashCommandListItem | null
  /** Pick the command at the popover's highlighted index. Returns picked command or null. */
  pick: (item?: SlashCommandListItem) => SlashCommandListItem | null
  /** Drop the selected command (e.g. user clicked the chip's close button). */
  clearSelection: () => void
  /** Force refresh the command list (called when skills were added/removed). */
  refresh: () => Promise<void>
}

export function useSlashCommands(input: string): UseSlashCommandsResult {
  const [commands, setCommands] = useState<SlashCommandListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<SlashCommandListItem | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.slashCommands.list()
      setCommands(list)
    } catch (e) {
      console.warn("[useSlashCommands] list failed", e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Popover state derives purely from the current input text. A selected
  // command with args does NOT reopen the popover — once picked, the user is
  // free-typing args. Typing another "/" at the start would have to clear the
  // selection first, which matches the "one command per turn" UX.
  const popover: PopoverMode = useMemo(() => {
    if (selected) return { kind: "closed" }
    if (!input.startsWith("/")) return { kind: "closed" }
    const rest = input.slice(1)
    if (/\s/.test(rest)) return { kind: "closed" }
    return { kind: "open", filter: rest }
  }, [input, selected])

  const filtered = useMemo(() => {
    if (popover.kind !== "open") return []
    const needle = popover.filter.toLowerCase()
    if (!needle) return commands
    return commands.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle)
    )
  }, [commands, popover])

  // Clamp selection when filter changes length.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedIdx(0)
      return
    }
    setSelectedIdx((i) => Math.min(i, filtered.length - 1))
  }, [filtered])

  const pick = useCallback(
    (item?: SlashCommandListItem) => {
      const target = item ?? filtered[selectedIdx] ?? null
      if (!target) return null
      setSelected(target)
      return target
    },
    [filtered, selectedIdx]
  )

  const clearSelection = useCallback(() => {
    setSelected(null)
    setSelectedIdx(0)
  }, [])

  return {
    commands,
    loading,
    popover,
    filtered,
    selectedIdx,
    setSelectedIdx,
    selected,
    pick,
    clearSelection,
    refresh
  }
}
