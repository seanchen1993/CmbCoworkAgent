import type { ModObject } from "../types"
import { encodeModJson } from "../validation"
import { ModFunctionError } from "./contracts"
import { functionQuestionPresentation, functionSiteProps } from "./sites"

/** Host-owned fields in the pinned v2.1.278 contracts; required identity fields cannot be omitted. */
const pinned: Record<string, readonly string[]> = {
  "command.run": ["command", "origin", "presentation"],
  "command.describe": ["command", "immediate", "provider"],
  "config.describe": ["key", "provider"],
  "tool.call": ["tool", "tool_use_id", "agentId"],
  "classic.PreToolUse": ["tool", "tool_use_id"],
  "tool.check": ["tool", "input", "tool_use_id"],
  "turn.step": ["turnId", "index", "messageCount", "agentId"],
  "turn.complete": ["agentId"],
  "ui.open": ["id"],
  "ui.notice": ["tool_use_id"],
  "ui.close": ["id", "origin"],
  "ui.render": ["surface", "component", "requestId", "viewport"],
  "ui.press": ["plugin", "element", "component", "requestId", "surface"],
  "ui.input": ["plugin", "element", "component", "requestId", "surface", "kind"],
  "ui.select": ["plugin", "element", "component", "requestId", "surface"],
  "ui.focus": ["plugin", "component", "requestId", "surface", "origin", "focused"],
  "ui.message": ["surface", "component", "requestId", "element", "module"]
}
const required: Record<string, readonly string[]> = {
  "command.run": ["command", "origin"],
  "command.describe": ["command", "immediate"],
  "config.describe": ["key"],
  "turn.step": ["turnId", "index", "messageCount"]
}
const classicIdentity = [
  "hook_event_name",
  "session_id",
  "transcript_path",
  "cwd",
  "prompt_id",
  "permission_mode",
  "agent_id",
  "agent_type",
  "effort"
] as const

const classicFacts: Record<string, readonly string[]> = {
  "classic.StopFailure": ["error", "error_details", "last_assistant_message"],
  "classic.Stop": ["stop_hook_active", "last_assistant_message", "background_tasks", "session_crons"],
  "classic.SubagentStop": [
    "stop_hook_active",
    "last_assistant_message",
    "background_tasks",
    "session_crons",
    "agent_transcript_path"
  ],
  "classic.PostToolUse": [
    "tool_name",
    "tool_input",
    "tool_use_id",
    "tool_response",
    "duration_ms",
    "mcp_server",
    "is_interrupt"
  ],
  "classic.PostToolUseFailure": [
    "tool_name",
    "tool_input",
    "tool_use_id",
    "error",
    "is_interrupt",
    "duration_ms",
    "mcp_server"
  ],
  "classic.PostToolBatch": ["tool_calls"],
  "classic.UserPromptExpansion": ["expansion_type", "command_name", "command_args", "command_source", "prompt"],
  "classic.InstructionsLoaded": [
    "file_path", "memory_type", "load_reason", "globs", "trigger_file_path", "parent_file_path"
  ]
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.keys(a)
  const right = Object.keys(b)
  return (
    left.length === right.length &&
    left.every((key) => Object.hasOwn(b, key) && same((a as ModObject)[key], (b as ModObject)[key]))
  )
}

export function normalizeFunctionInput(
  event: string,
  received: ModObject,
  original: ModObject
): ModObject {
  encodeModJson(received)
  if (event === "ui.scroll" && Object.hasOwn(original, "offset")) {
    for (const key of Object.keys(received)) {
      if (
        key !== "offset" &&
        (!Object.hasOwn(original, key) || !same(received[key], original[key]))
      )
        throw new ModFunctionError("MODS_PINNED_INPUT", `MODS_PINNED_INPUT: ui.scroll.${key}`)
    }
    const input = { ...original, ...received }
    if (typeof input.offset !== "number" || !Number.isFinite(input.offset))
      throw new ModFunctionError("MODS_PINNED_INPUT", "MODS_PINNED_INPUT: ui.scroll.offset")
    return input
  }
  const result = { ...received }
  const fields = pinned[event] ?? (
    event.startsWith("classic.") ? [...classicIdentity, ...(classicFacts[event] ?? [])] : []
  )
  for (const key of fields) {
    if (
      required[event]?.includes(key) &&
      Object.hasOwn(original, key) &&
      !Object.hasOwn(received, key)
    )
      throw new ModFunctionError("MODS_PINNED_INPUT", `MODS_PINNED_INPUT: ${event}.${key}`)
    if (Object.hasOwn(received, key) && !same(received[key], original[key]))
      throw new ModFunctionError("MODS_PINNED_INPUT", `MODS_PINNED_INPUT: ${event}.${key}`)
    if (Object.hasOwn(original, key)) result[key] = original[key]
  }
  if (event === "ui.render" && original.props && typeof original.props === "object") {
    const facts =
      original.component === "AskUserQuestion"
        ? ["tool", "metadataSource"]
        : original.component === "ToolGroup"
          ? ["calls", "isActive", "onScreen"]
          : original.component === "ToolUse"
            ? ["tool_use_id", "isRunning", "isErrored", "isInterrupted", "onScreen"]
            : original.component === "ToolResult"
              ? ["tool_use_id", "tool", "isErrored", "onScreen"]
              : original.component === "CommandOutput"
                ? ["command", "args", "isErrored", "onScreen"]
                : original.component === "UserMessage"
                  ? ["origin", "isExpanded", "task", "from", "onScreen"]
                  : original.component === "AssistantMessage"
                    ? ["isFirstOfReply", "onScreen"]
                    : original.component === "AbovePrompt"
                      ? ["hasSurvey", "isWorking", "maxRows", "bodyColumns", "scroll", "view"]
                      : original.component === "PromptHint"
                        ? ["isDraft", "isWorking"]
                        : original.component === "InfoNotice" ||
                            original.component === "TurnDuration"
                          ? ["onScreen"]
                          : []
    for (const key of facts) {
      const props = result.props as ModObject | undefined
      const before = original.props as ModObject
      if (!props || !same(props[key], before[key]))
        throw new ModFunctionError("MODS_PINNED_INPUT", `MODS_PINNED_INPUT: ui.render.props.${key}`)
    }
    if (original.component === "AskUserQuestion") {
      const before = original.props as ModObject
      const after = result.props as ModObject
      functionQuestionPresentation(before.questions, after.questions)
      functionSiteProps("AskUserQuestion", after)
    }
    if (
      original.component === "PromptHint" ||
      original.component === "InfoNotice" ||
      original.component === "Spinner" ||
      original.component === "TurnDuration" ||
      original.component === "SessionMode" ||
      original.component === "UserMessage" ||
      original.component === "AssistantMessage" ||
      original.component === "CommandOutput" ||
      original.component === "ToolUse" ||
      original.component === "ToolResult" ||
      original.component === "ToolGroup"
    )
      functionSiteProps(original.component, result.props)
  }
  return result
}
