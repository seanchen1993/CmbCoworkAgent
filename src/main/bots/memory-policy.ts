import type { BotDefinition } from "../../shared/bots/contracts"

export function isBotMemoryEnabled(bot: Pick<BotDefinition, "memoryMode">): boolean {
  return bot.memoryMode !== "disabled"
}
