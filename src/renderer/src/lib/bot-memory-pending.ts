import { botMemoryRetryInput } from "../../../shared/bot-memory"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

export const createPendingMemoryRetryStore = (storage?: () => PendingSaveStorage) =>
  createFlatSettingsPending({
    input: botMemoryRetryInput,
    key: (botId) => `cmb:bot-memory-retry:pending:${botId}`,
    maxCharacters: 2048,
    storageMessage: "无法保存重试记录，尚未重新整理。",
    storage
  })
export const pendingMemoryRetryStore = createPendingMemoryRetryStore()
export const inspectPendingMemoryRetry = pendingMemoryRetryStore.inspect
export const readPendingMemoryRetry = pendingMemoryRetryStore.read
export const rememberPendingMemoryRetry = pendingMemoryRetryStore.remember
export const acknowledgePendingMemoryRetry = pendingMemoryRetryStore.acknowledge
export const discardPendingMemoryRetry = pendingMemoryRetryStore.discard
