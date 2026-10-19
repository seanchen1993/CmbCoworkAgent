import { splitBotInlineReasoning } from "./inline-reasoning"

/** Exact durable marker for a scheduled Bot run that found no user-visible change. */
export const BOT_ROUTINE_SILENT = "BOT_ROUTINE_SILENT"

/** Keep matching deliberately strict: ordinary user-facing results must never be suppressed. */
export function isBotRoutineSilent(value: string | undefined): boolean {
  return (
    typeof value === "string" && splitBotInlineReasoning(value).body.trim() === BOT_ROUTINE_SILENT
  )
}
