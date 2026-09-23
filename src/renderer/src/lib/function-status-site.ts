import type { ModObject } from "../../../shared/mods/types"

/** Desktop projection of observed live output; it does not invent an engine phase. */
export function functionSpinnerFacts(
  word: string,
  current: unknown,
  runningTools: boolean
): ModObject {
  const message = current && typeof current === "object" ? (current as Record<string, unknown>) : {}
  const assistant = message.role === "assistant"
  const mode = runningTools
    ? "tool-use"
    : assistant && Array.isArray(message.tool_calls) && message.tool_calls.length
      ? "tool-input"
      : assistant &&
          ((typeof message.content === "string" && message.content.length > 0) ||
            (Array.isArray(message.content) && message.content.length > 0))
        ? "responding"
        : assistant && typeof message.reasoning === "string" && message.reasoning.length
          ? "thinking"
          : "requesting"
  // Existing desktop loading phrases already contain their own punctuation.
  return { word, message: null, suffix: "", mode }
}
