import type { BotDefinition } from "../../shared/bots/contracts"
import { isMemoryEnabled } from "../storage"

/** Bot overrides are local to its private memory; normal conversation memory is unchanged. */
export function isBotMemoryEnabled(bot: Pick<BotDefinition, "memoryMode">): boolean {
  if (bot.memoryMode === "enabled") return true
  if (bot.memoryMode === "disabled") return false
  return isMemoryEnabled()
}
