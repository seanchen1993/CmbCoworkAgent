import type { Message } from "@/types"
import type { StreamFallbackIndexBaselines } from "./electron-transport"
import { isInternalGoalPromptMessage } from "./goal-notice-messages"

export interface FallbackIndexBaselineCache {
  messages: readonly Message[]
  baselines: StreamFallbackIndexBaselines
}

function emptyFallbackIndexBaselines(): StreamFallbackIndexBaselines {
  return { ai: 0, tool: 0, system: 0, human: 0 }
}

function countMessage(
  baselines: StreamFallbackIndexBaselines,
  message: Message
): void {
  if (message.role === "user") {
    if (isInternalGoalPromptMessage(message)) baselines.human += 1
    return
  }
  if (message.role === "tool") {
    baselines.tool += 1
    return
  }
  if (message.role === "system") {
    baselines.system += 1
    return
  }
  baselines.ai += 1
}

/**
 * Advances the fallback counters without rescanning an immutable append-only
 * message prefix. Replacements, prepends and truncations deliberately fall
 * back to a complete count so transport identities remain correct.
 */
export function updateFallbackIndexBaselineCache(
  previous: FallbackIndexBaselineCache | undefined,
  messages: readonly Message[]
): FallbackIndexBaselineCache {
  if (previous?.messages === messages) return previous

  const previousLength = previous?.messages.length ?? 0
  const extendsPreviousPrefix =
    !!previous &&
    previousLength <= messages.length &&
    (previousLength === 0 || previous.messages[previousLength - 1] === messages[previousLength - 1])
  const baselines = extendsPreviousPrefix
    ? { ...previous.baselines }
    : emptyFallbackIndexBaselines()
  const startIndex = extendsPreviousPrefix ? previousLength : 0

  for (let index = startIndex; index < messages.length; index += 1) {
    countMessage(baselines, messages[index])
  }

  return { messages, baselines }
}

export function fallbackIndexBaselinesFromMessages(
  messages: readonly Message[]
): StreamFallbackIndexBaselines {
  return updateFallbackIndexBaselineCache(undefined, messages).baselines
}
