import type { ModJson, ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"

export type FunctionPluginPromptOrigin = ModObject & {
  kind: "plugin"
  name: string
  asUser?: true
}

export type FunctionPluginPromptArgs = ModObject & {
  text: string
  asUser?: true
}

/** SDK authors supply words, never a host origin, turn identity or execution receipt. */
export function functionPluginPromptArgs(value: ModJson): FunctionPluginPromptArgs {
  if (
    !isModObject(value) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 32000 ||
    (value.asUser !== undefined && value.asUser !== true) ||
    (value.attachments !== undefined &&
      (!Array.isArray(value.attachments) || value.attachments.length !== 0)) ||
    Object.keys(value).some((key) => !["text", "asUser", "attachments"].includes(key))
  )
    throw new ModFunctionError("MODS_PLUGIN_PROMPT_ARGUMENTS")
  return { text: value.text, ...(value.asUser === true ? { asUser: true } : {}) }
}

export function isFunctionPluginPromptOrigin(value: unknown): value is FunctionPluginPromptOrigin {
  return (
    isModObject(value) &&
    value.kind === "plugin" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 128 &&
    (value.asUser === undefined || value.asUser === true) &&
    Object.keys(value).every((key) => ["kind", "name", "asUser"].includes(key))
  )
}

const allowedSources = new Set([
  "session.start",
  "turn.start",
  "turn.step",
  "turn.complete",
  "clock.after",
  "clock.every",
  "ui.render",
  "ui.press",
  "ui.message"
])
const heldSources = new Set(["command.run", "prompt.submit", "tool.call", "prompt.compose"])

/** The caller is the current host invocation; a captured SDK cannot launder a blocked source. */
export function assertFunctionPluginPromptSource(event: string, held?: string): void {
  if (heldSources.has(event) || (held !== undefined && heldSources.has(held)))
    throw new ModFunctionError(
      "MODS_PLUGIN_PROMPT_SOURCE_HELD",
      `${heldSources.has(event) ? event : held}: 请在任务完成、组件点击或定时回调中提交新任务。`
    )
  if (!allowedSources.has(event))
    throw new ModFunctionError("MODS_PLUGIN_PROMPT_SOURCE_UNSUPPORTED")
}

/** Model framing is separate from visible text and the persistent host origin. */
export function functionPluginPromptModelText(
  text: string,
  origin: FunctionPluginPromptOrigin,
  framed: boolean
): string {
  return framed && origin.asUser !== true
    ? `The ${origin.name} plugin sent a message:\n\n${text}`
    : text
}
