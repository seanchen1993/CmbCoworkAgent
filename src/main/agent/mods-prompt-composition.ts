import { SystemMessage, type BaseMessage } from "@langchain/core/messages"
import type { ModObject } from "../../shared/mods/types"
import type { PromptContribution } from "./mods-prompt-sources"
import { applyModPromptContext } from "./mods-prompt-context"
import {
  validatePromptCompositionResult,
  type FunctionPromptCore,
  type FunctionPromptEvent
} from "../../shared/mods/v2/prompt-composition"

export type FunctionPromptDispatch = (
  event: FunctionPromptEvent,
  input: ModObject,
  signal: AbortSignal,
  core: FunctionPromptCore
) => Promise<ModObject>

/** Compose at the final transport boundary, after all graph middleware has assembled its input. */
export async function composeModPrompt(
  messages: BaseMessage[],
  facts: ModObject,
  signal: AbortSignal,
  dispatch: FunctionPromptDispatch,
  assertLive: () => void,
  contributions?: readonly PromptContribution[]
): Promise<{ messages: BaseMessage[]; text: string }> {
  const system = messages.flatMap((message, index) =>
    message.type === "system" ? [{ message, index }] : []
  )
  const nativeSections = contributions ?? system.map(({ message, index }) => ({
    id: `cmb:system:${index}`,
    text:
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => String(part.text))
            .join("\n\n"),
    scope: "session"
  }))
  const sections = contributions
    ? await applyModPromptContext(contributions, dispatch, signal, assertLive)
    : nativeSections
  const original = { sections: nativeSections.filter((section) => section.text !== null) }
  const result = await dispatch("prompt.compose", facts, signal, async (_facts, active) => {
    assertLive()
    active.throwIfAborted()
    const expanded: ModObject[] = []
    for (const section of sections) {
      assertLive()
      active.throwIfAborted()
      const value = await dispatch(
        "prompt.section",
        { name: section.id, text: section.text },
        active,
        async (input) => ({ text: input.text })
      )
      validatePromptCompositionResult("prompt.section", value)
      if (value.text !== null) expanded.push({ id: section.id, scope: section.scope, text: value.text })
    }
    assertLive()
    active.throwIfAborted()
    return { sections: expanded }
  })
  assertLive()
  signal.throwIfAborted()
  validatePromptCompositionResult("prompt.compose", result)
  const output = result.sections as ModObject[]
  if (output.length === original.sections.length && output.every((section, index) => {
    const source = original.sections[index]
    return section.id === source.id && section.text === source.text && section.scope === source.scope
  })) return {
    messages,
    text: contributions
      ? contributions.map((section) => section.text ?? "").join("")
      : output.map((section) => String(section.text)).join("\n\n")
  }
  const text = output.map((section) => String(section.text)).join("\n\n")
  if (
    system.some(
      ({ message }) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type !== "text" || typeof part.text !== "string")
    )
  )
    throw Error("MODS_PROMPT_NON_TEXT_REPLACEMENT_UNSUPPORTED")
  const first = system[0]?.index ?? 0
  const composed = messages.filter((message) => message.type !== "system")
  // Empty sections really removes the system prompt; it does not restore an old copy.
  if (output.length) composed.splice(first, 0, new SystemMessage(text))
  return { messages: composed, text }
}
