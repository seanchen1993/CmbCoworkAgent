import { splitBotInlineReasoning } from "./inline-reasoning"

/** Only optional discussion interprets this marker; direct replies remain visible. */
export const BOT_GROUP_PASS = "(pass)"
export function isBotGroupPass(value: string | undefined): boolean {
  // Grok's isPassContent also accepts bare pass, case variants and a final period.
  return (
    typeof value === "string" &&
    /^(?:\(pass\)|pass)\.?$/i.test(splitBotInlineReasoning(value).body.trim())
  )
}
