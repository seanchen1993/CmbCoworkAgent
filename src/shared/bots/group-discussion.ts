import { splitBotInlineReasoning } from "./inline-reasoning"

/** Only optional discussion interprets this marker; direct replies remain visible. */
export const BOT_GROUP_PASS = "(pass)"
export function isBotGroupPass(value: string | undefined): boolean {
  // Match only the complete silent marker; width variants are equivalent protocol text.
  return (
    typeof value === "string" &&
    /^(?:\(\s*pass\s*\)|pass)\.?$/i.test(
      splitBotInlineReasoning(value).body.normalize("NFKC").trim()
    )
  )
}
