import { splitBotInlineReasoning } from "./inline-reasoning"

/** Only an optional group continuation may use this exact Grok/Hermes silence marker. */
export const BOT_GROUP_PASS = "(pass)"
export function isBotGroupPass(value: string | undefined): boolean {
  return typeof value === "string" && splitBotInlineReasoning(value).body.trim() === BOT_GROUP_PASS
}
