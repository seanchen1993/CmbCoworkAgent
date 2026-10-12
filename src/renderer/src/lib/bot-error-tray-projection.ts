import {
  botErrorTraySnapshotSchema,
  type BotErrorTrayAuthority,
  type BotErrorTraySnapshot
} from "../../../shared/bot-error-trays"

export function sameBotErrorTrayAuthority(
  left: BotErrorTrayAuthority | null | undefined,
  right: BotErrorTrayAuthority | null | undefined
): boolean {
  return !!left && !!right && left.hostId === right.hostId && left.dataEpoch === right.dataEpoch
}

/** Notification revisions have their own clock. A pending transcript read or
 * an unchanged DB cursor must not resurrect a notification already dismissed.
 * Only the accepted Host envelope can establish a new authority; mutation
 * responses cannot switch to a different Host or restored data generation. */
export function projectBotErrorTraySnapshot(
  current: BotErrorTraySnapshot | null,
  incoming: unknown,
  authority: BotErrorTrayAuthority | null
): BotErrorTraySnapshot | null {
  const retained = sameBotErrorTrayAuthority(current, authority) ? current : null
  const parsed = botErrorTraySnapshotSchema.safeParse(incoming)
  if (!parsed.success || !sameBotErrorTrayAuthority(parsed.data, authority)) return retained
  if (retained && parsed.data.revision <= retained.revision) return retained
  return parsed.data
}
