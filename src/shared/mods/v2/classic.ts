import { isModObject, ModFunctionError } from "./contracts"
import { isClaudeEventName } from "./event-catalog"

export interface ClassicToolBatchCall {
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  tool_response?: unknown
}
const MAX_TEXT = 32000
const MAX_ITEMS = 256
type Validator = (value: unknown) => boolean
const text: Validator = (value) => typeof value === "string" && value.length <= MAX_TEXT
const flag: Validator = (value) => value === true
const record: Validator = (value) => isModObject(value)
const strings: Validator = (value) =>
  Array.isArray(value) && value.length <= MAX_ITEMS && value.every(text)
const oneOf =
  (allowed: readonly string[]): Validator =>
  (value) =>
    typeof value === "string" && allowed.includes(value)

function shape(
  value: unknown,
  fields: Record<string, Validator>,
  required: string[] = []
): boolean {
  return (
    isModObject(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, child]) => Object.hasOwn(fields, key) && fields[key](child))
  )
}

/** Keep classic's arbitrary JSON tool outputs bounded before examining their event shape. */
function bounded(value: unknown): boolean {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  let characters = 0
  while (queue.length) {
    const item = queue.pop()!
    if (++nodes > 20000 || item.depth > 32) return false
    if (typeof item.value === "string") characters += item.value.length
    else if (typeof item.value === "number") {
      if (!Number.isFinite(item.value)) return false
    } else if (item.value !== null && typeof item.value !== "boolean") {
      if (typeof item.value !== "object") return false
      for (const [key, child] of Object.entries(item.value)) {
        characters += key.length
        queue.push({ value: child, depth: item.depth + 1 })
        if (queue.length > 20000) return false
      }
    }
    if (characters > 128000) return false
  }
  return true
}

const destination = oneOf(["userSettings", "projectSettings", "localSettings", "session", "cliArg"])
const behavior = oneOf(["allow", "deny", "ask"])
const permissionRules: Validator = (value) =>
  Array.isArray(value) &&
  value.length <= MAX_ITEMS &&
  value.every((rule) => shape(rule, { toolName: text, ruleContent: text }, ["toolName"]))
const permissionUpdate: Validator = (value) => {
  if (!isModObject(value)) return false
  if (["addRules", "replaceRules", "removeRules"].includes(String(value.type)))
    return shape(value, { type: text, rules: permissionRules, behavior, destination }, [
      "type",
      "rules",
      "behavior",
      "destination"
    ])
  if (value.type === "setMode")
    return shape(
      value,
      {
        type: text,
        mode: oneOf(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]),
        destination
      },
      ["type", "mode", "destination"]
    )
  if (value.type === "addDirectories" || value.type === "removeDirectories")
    return shape(value, { type: text, directories: strings, destination }, [
      "type",
      "directories",
      "destination"
    ])
  return false
}
const permissionDecision: Validator = (value) => {
  if (!isModObject(value)) return false
  if (value.behavior === "allow")
    return shape(
      value,
      {
        behavior: oneOf(["allow"]),
        updatedInput: record,
        updatedPermissions: (updates) =>
          Array.isArray(updates) && updates.length <= MAX_ITEMS && updates.every(permissionUpdate)
      },
      ["behavior"]
    )
  return shape(value, { behavior: oneOf(["deny"]), message: text, interrupt: flag }, ["behavior"])
}

const additionalContext = { additionalContext: strings }
const eventFields: Record<string, Record<string, Validator>> = {
  UserPromptSubmit: { ...additionalContext, sessionTitle: text, suppressOriginalPrompt: flag },
  UserPromptExpansion: { ...additionalContext, suppressOriginalPrompt: flag },
  SessionStart: {
    ...additionalContext,
    initialUserMessage: text,
    sessionTitle: text,
    watchPaths: strings,
    reloadSkills: flag
  },
  Setup: additionalContext,
  PreModelSwitch: { permissionDecision: behavior, permissionDecisionReason: text },
  PostModelSwitch: additionalContext,
  SubagentStart: additionalContext,
  PostToolUse: {
    ...additionalContext,
    updatedToolOutput: () => true,
    updatedMCPToolOutput: () => true
  },
  PostToolUseFailure: additionalContext,
  PostToolBatch: additionalContext,
  Stop: additionalContext,
  SubagentStop: additionalContext,
  PermissionDenied: { retry: flag },
  PermissionRequest: { decision: permissionDecision },
  MessageDisplay: { displayContent: text },
  WorktreeCreate: { worktreePath: text }
}

function classicName(event: string): string {
  if (!event.startsWith("classic.") || !isClaudeEventName(event))
    throw new ModFunctionError("MODS_CLASSIC_EVENT_INVALID")
  return event.slice("classic.".length)
}

/** Inputs keep native tool arguments; the common host identities must use upstream names. */
export function validateClassicInput(event: string, value: unknown): void {
  if (!event.startsWith("classic.")) return
  const name = classicName(event)
  if (!isModObject(value) || !bounded(value)) throw new ModFunctionError("MODS_CLASSIC_INPUT")
  if (name === "PreToolUse") {
    if (!text(value.tool) || !value.tool || !text(value.tool_use_id) || !value.tool_use_id)
      throw new ModFunctionError("MODS_CLASSIC_INPUT")
    return
  }
  if (
    value.hook_event_name !== name ||
    ![value.session_id, value.transcript_path, value.cwd].every(text) ||
    ["prompt_id", "permission_mode", "agent_id", "agent_type"].some(
      (key) => value[key] !== undefined && !text(value[key])
    ) ||
    (value.effort !== undefined && !shape(value.effort, { level: text }, ["level"]))
  )
    throw new ModFunctionError("MODS_CLASSIC_INPUT")
  if (name === "PostToolBatch") {
    const calls = value.tool_calls
    if (
      !Array.isArray(calls) ||
      calls.length === 0 ||
      calls.length > 128 ||
      calls.some(
        (call) =>
          !shape(
            call,
            {
              tool_name: (value) => text(value) && !!value,
              tool_use_id: (value) => text(value) && !!value,
              tool_input: () => true,
              tool_response: () => true
            },
            ["tool_name", "tool_use_id", "tool_input"]
          )
      ) ||
      new Set(calls.map((call) => (call as { tool_use_id: string }).tool_use_id)).size !==
        calls.length
    )
      throw new ModFunctionError("MODS_CLASSIC_INPUT")
  }
  if (name === "PreCompact" || name === "PostCompact") {
    if (
      !oneOf(["manual", "auto"])(value.trigger) ||
      (name === "PreCompact" &&
        value.custom_instructions !== null &&
        !text(value.custom_instructions)) ||
      (name === "PostCompact" && !text(value.compact_summary))
    )
      throw new ModFunctionError("MODS_CLASSIC_INPUT")
  }
}

/** ClassicResultOf per event; invalid optional hooks are recovered by the dispatcher. */
export function validateClassicResult(event: string, value: unknown): void {
  if (!event.startsWith("classic.")) return
  const name = classicName(event)
  if (!bounded(value)) throw new ModFunctionError("MODS_CLASSIC_RESULT")
  if (name === "PreToolUse") {
    if (
      !shape(value, {
        allow: flag,
        ask: text,
        deny: text,
        updatedInput: record,
        additionalContext: strings
      }) ||
      !isModObject(value) ||
      ["allow", "ask", "deny"].filter((key) => Object.hasOwn(value, key)).length > 1
    )
      throw new ModFunctionError("MODS_CLASSIC_RESULT")
    return
  }
  if (
    !shape(value, {
      block: text,
      preventContinuation: flag,
      stopReason: text,
      ...eventFields[name]
    })
  )
    throw new ModFunctionError("MODS_CLASSIC_RESULT")
}
