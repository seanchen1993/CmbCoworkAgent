import { useCallback, useMemo, useState } from "react"
import type { SkillMetadata } from "@/types"
import { isGoalClearAlias, splitGoalTransportPayload } from "../../../../shared/goal-slash"

export type SlashCommandItem = {
  id: string
  title: string
  command: string
  usage?: string
  description: string
  insertText: string
  keywords: string[]
}

export type PopoverMode =
  | { kind: "closed" }
  | {
      kind: "slash"
      filter: string
      commands: SlashCommandItem[]
      skills: SkillMetadata[]
    }

const GENERAL_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "goal",
    title: "目标",
    command: "/goal",
    usage: "/goal <目标/完成标准>",
    description: "设置可验收的长期任务；完成前会自动继续，/goal 查看状态",
    insertText: "/goal ",
    keywords: ["goal", "目标", "长期任务", "自动续跑", "完成条件"]
  }
]

export function isGoalSlashCommandInput(input: string): boolean {
  const trimmed = input.trim()
  return /^\/goal(?:$|\s+)/i.test(trimmed)
}

export function isBareGoalSlashCommandInput(input: string): boolean {
  return input.trim().toLowerCase() === "/goal"
}

export function isGoalSlashControlCommandInput(input: string): boolean {
  const { commandText, payload } = splitGoalTransportPayload(input)
  const trimmed = commandText.trim()
  if (!/^\/goal(?:$|\s+)/i.test(trimmed)) return false
  if (payload) return false

  const arg = trimmed.slice("/goal".length).trim().toLowerCase()
  return arg === "" || arg === "status" || arg === "pause" || isGoalClearAlias(arg)
}

export function isGoalSlashResumeCommandInput(input: string): boolean {
  const { commandText, payload } = splitGoalTransportPayload(input)
  const trimmed = commandText.trim()
  if (!/^\/goal(?:$|\s+)/i.test(trimmed)) return false
  if (payload) return false

  const arg = trimmed.slice("/goal".length).trim().toLowerCase()
  return arg === "resume"
}

export function isGoalSlashTransportSensitiveControlCommandInput(input: string): boolean {
  const { commandText } = splitGoalTransportPayload(input)
  const trimmed = commandText.trim()
  if (!/^\/goal(?:$|\s+)/i.test(trimmed)) return false

  const arg = trimmed.slice("/goal".length).trim().toLowerCase()
  return (
    arg === "" ||
    arg === "status" ||
    arg === "pause" ||
    arg === "resume" ||
    isGoalClearAlias(arg)
  )
}

export function isGoalTerminatingControlCommandInput(input: string): boolean {
  const { commandText, payload } = splitGoalTransportPayload(input)
  const trimmed = commandText.trim()
  if (!/^\/goal(?:$|\s+)/i.test(trimmed)) return false
  if (payload) return false

  const arg = trimmed.slice("/goal".length).trim().toLowerCase()
  return arg === "pause" || isGoalClearAlias(arg)
}

export function resolveGoalRuntimeComposerState(params: {
  input: string
  isLoading: boolean
  historyLoading: boolean
  slashModeKind: PopoverMode["kind"]
  hasPendingTransportPayload?: boolean
  goalControlAllowedWhileLoading?: boolean
}) {
  const {
    input,
    isLoading,
    historyLoading,
    slashModeKind,
    hasPendingTransportPayload = false,
    goalControlAllowedWhileLoading = true
  } = params
  const bareGoalWithPendingTransport =
    hasPendingTransportPayload && isBareGoalSlashCommandInput(input)
  const goalControlWithPendingTransport =
    hasPendingTransportPayload && isGoalSlashTransportSensitiveControlCommandInput(input)
  const canSubmitGoalCommandWhileLoading =
    isLoading &&
    goalControlAllowedWhileLoading &&
    isGoalSlashControlCommandInput(input) &&
    !bareGoalWithPendingTransport &&
    !goalControlWithPendingTransport

  return {
    inputDisabled: historyLoading,
    composerControlsDisabled: isLoading || historyLoading,
    canSubmitGoalCommandWhileLoading,
    allowSubmitWhileLoading: canSubmitGoalCommandWhileLoading,
    showGoalSendButtonWhileLoading: canSubmitGoalCommandWhileLoading,
    goalSendButtonDisabledWhileLoading:
      slashModeKind === "slash" && !isBareGoalSlashCommandInput(input)
  }
}

function commandMatchesFilter(command: SlashCommandItem, filter: string): boolean {
  if (!filter) return true
  return [command.command, command.title, command.description, ...command.keywords].some((value) =>
    value.toLowerCase().includes(filter)
  )
}

export function buildSlashPopoverMode(params: {
  input: string
  skills: SkillMetadata[]
  skillSelected: boolean
}): PopoverMode {
  const { input, skills, skillSelected } = params

  if (skillSelected) return { kind: "closed" }
  if (!input.startsWith("/")) return { kind: "closed" }

  const filter = input.slice(1).toLowerCase()
  if (/\s/.test(filter)) return { kind: "closed" }

  const commands = GENERAL_SLASH_COMMANDS.filter((command) => commandMatchesFilter(command, filter))
  const filteredSkills = filter
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(filter) ||
          (s.description ?? "").toLowerCase().includes(filter)
      )
    : skills

  return { kind: "slash", filter, commands, skills: filteredSkills }
}

/**
 * Popover state machine for `/<filter>` command and skill selection.
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
    return buildSlashPopoverMode({ input, skills, skillSelected })
  }, [input, skills, skillSelected])

  // Reset highlight to top whenever the popover (re-)opens or the filter changes,
  // so pressing Enter right after typing never selects a stale carry-over item.
  // useState rather than a ref to play nicely with StrictMode's double-invoke.
  const currentKey = mode.kind === "slash" ? `slash:${mode.filter}` : "closed"
  const [prevKey, setPrevKey] = useState(currentKey)
  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    if (selectedIdx !== 0) setSelectedIdx(0)
  }

  const totalItems = mode.kind === "slash" ? mode.commands.length + mode.skills.length : 0
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
