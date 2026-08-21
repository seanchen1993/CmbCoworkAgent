export const DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT = 200
export const CHAT_AUTO_SCROLL_ALWAYS = "always" as const

export type ChatAutoScrollMessageLimit = number | typeof CHAT_AUTO_SCROLL_ALWAYS

export interface ChatScrollSettings {
  autoScrollMessageLimit: ChatAutoScrollMessageLimit
}

export function normalizeChatAutoScrollMessageLimit(value: unknown): ChatAutoScrollMessageLimit {
  if (value === CHAT_AUTO_SCROLL_ALWAYS) return CHAT_AUTO_SCROLL_ALWAYS

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT
  }

  return Math.min(100_000, Math.max(1, Math.floor(numericValue)))
}

export function normalizeChatScrollSettings(
  settings: Partial<ChatScrollSettings> | null | undefined
): ChatScrollSettings {
  return {
    autoScrollMessageLimit: normalizeChatAutoScrollMessageLimit(settings?.autoScrollMessageLimit)
  }
}
