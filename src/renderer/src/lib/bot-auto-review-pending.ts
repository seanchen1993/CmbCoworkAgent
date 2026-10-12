import { botAutoReviewChange } from "../../../shared/bot-auto-review"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

export const createPendingAutoReviewStore = (storage?: () => PendingSaveStorage) =>
  createFlatSettingsPending({
    input: botAutoReviewChange,
    key: (botId) => `cmb:bot-auto-review:pending:${botId}`,
    maxCharacters: 256_000,
    storageMessage: "无法保存操作记录，自动审核设置尚未修改。",
    storage
  })
export const pendingAutoReviewStore = createPendingAutoReviewStore()
export const inspectPendingAutoReview = pendingAutoReviewStore.inspect
export const readPendingAutoReview = pendingAutoReviewStore.read
export const rememberPendingAutoReview = pendingAutoReviewStore.remember
export const acknowledgePendingAutoReview = pendingAutoReviewStore.acknowledge
export const discardPendingAutoReview = pendingAutoReviewStore.discard
