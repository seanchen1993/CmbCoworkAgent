import type { BotDefinition } from "../../shared/bots/contracts"
import { intersectSkillNames } from "../../shared/skill-selection"
import type { RemoteTurnPolicy } from "../agent/standard-thread-turn"

/** Bot templates select features; they never grant capabilities removed by a transport. */
export function applyBotSkillSelection(
  bot: Pick<BotDefinition, "allowedSkillNames">,
  policy: RemoteTurnPolicy
): RemoteTurnPolicy {
  return {
    ...policy,
    // manage_skill owns a separate whole-library read/write surface. A selected
    // Bot uses the normal skill loader; library management stays in Settings.
    ...(bot.allowedSkillNames != null ? { disableSkillEvolution: true } : {}),
    allowedSkillNames: intersectSkillNames(bot.allowedSkillNames, policy.allowedSkillNames)
  }
}
