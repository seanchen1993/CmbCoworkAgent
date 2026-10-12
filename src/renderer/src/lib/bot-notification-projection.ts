import type { BotNotificationSettings } from "../../../shared/bot-notifications"
import type { BotWorkspaceSnapshot } from "../../../shared/bot-types"

/** A mutation receipt can arrive ahead of the snapshot's message cursor. Keep
 * newer preferences within one data generation, including a Bot's first saved
 * preference which is absent from an older snapshot. Deleted Bots are excluded. */
export function mergeBotNotificationSettings(
  current: BotWorkspaceSnapshot | null,
  incoming: BotWorkspaceSnapshot
): BotNotificationSettings[] | undefined {
  if (!current || (current.dataEpoch ?? "initial") !== (incoming.dataEpoch ?? "initial"))
    return incoming.notificationSettings
  const validBots = new Set(incoming.bots.map((bot) => bot.id))
  const settings = new Map(
    (incoming.notificationSettings ?? [])
      .filter((item) => validBots.has(item.botId))
      .map((item) => [item.botId, item])
  )
  for (const item of current.notificationSettings ?? []) {
    const next = settings.get(item.botId)
    if (validBots.has(item.botId) && item.revision > (next?.revision ?? 0))
      settings.set(item.botId, item)
  }
  return incoming.notificationSettings || settings.size ? [...settings.values()] : undefined
}

/** Updating UI from an acknowledgement never changes its DB cursor, Host
 * connection state or another Bot's preference. Old receipts cannot roll back
 * a newer change, even after the menu that issued the request was closed. */
export function applyBotNotificationSettingReceipt(
  snapshot: BotWorkspaceSnapshot | null,
  dataEpoch: string,
  receipt: BotNotificationSettings
): BotWorkspaceSnapshot | null {
  if (
    !snapshot ||
    snapshot.dataEpoch !== dataEpoch ||
    !snapshot.bots.some((bot) => bot.id === receipt.botId)
  )
    return snapshot
  const current = snapshot.notificationSettings?.find((item) => item.botId === receipt.botId)
  if (current && current.revision >= receipt.revision) return snapshot
  return {
    ...snapshot,
    notificationSettings: [
      ...(snapshot.notificationSettings ?? []).filter((item) => item.botId !== receipt.botId),
      receipt
    ]
  }
}
