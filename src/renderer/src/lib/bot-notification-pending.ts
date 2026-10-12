import { botNotificationChange } from "../../../shared/bot-notifications"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

export const createPendingNotificationStore = (storage?: () => PendingSaveStorage) =>
  createFlatSettingsPending({
    input: botNotificationChange,
    key: (botId) => `cmb:bot-notification:pending:${botId}`,
    maxCharacters: 2048,
    storageMessage: "无法保存重试记录，通知设置尚未修改。",
    storage
  })
export const pendingNotificationStore = createPendingNotificationStore()
export const inspectPendingNotification = pendingNotificationStore.inspect
export const readPendingNotification = pendingNotificationStore.read
export const rememberPendingNotification = pendingNotificationStore.remember
export const acknowledgePendingNotification = pendingNotificationStore.acknowledge
export const discardPendingNotification = pendingNotificationStore.discard
