import type { BotPrimaryState } from "../../../shared/bot-primary"

/** A late poll cannot erase a role/configuration receipt from the same workspace. */
export function mergeBotPrimaryState(
  previous: BotPrimaryState | undefined,
  incoming: BotPrimaryState | undefined,
  dataEpoch: string
): BotPrimaryState | undefined {
  if (!incoming || incoming.dataEpoch !== dataEpoch) return undefined
  if (!previous || previous.dataEpoch !== dataEpoch) return incoming
  if (previous.revision > incoming.revision) return previous
  if (previous.revision < incoming.revision) return incoming
  return previous.checkInRevision > incoming.checkInRevision ? previous : incoming
}
