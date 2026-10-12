/** One allowance covers a task and every delegated descendant. */
export const BOT_ROOT_OUTPUT_LIMIT = 200_000

export interface BotModelBudget {
  limit: number
  consumed: number
  reserved: number
  requests: number
}
