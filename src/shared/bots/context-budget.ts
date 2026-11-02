/** Fallback Bot working-context ceiling, in tokens. Compaction normally starts at 75%. */
export const BOT_CONTEXT_BUDGET_DEFAULT = 500_000
export const BOT_CONTEXT_BUDGET_MIN = 16_000

export function isBotContextBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= BOT_CONTEXT_BUDGET_MIN
}

export function normalizeBotContextBudget(value: unknown): number {
  return isBotContextBudget(value) ? value : BOT_CONTEXT_BUDGET_DEFAULT
}
