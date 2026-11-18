import type { BotWorkSummary } from "../../../shared/bots/work"
import { resolveBotWorkStatus } from "./bot/work-status"

export function botWorkStatus(work: BotWorkSummary): string {
  return resolveBotWorkStatus(work).label
}
