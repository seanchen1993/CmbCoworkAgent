import { pendingBotRecovery } from "../../../shared/bot-recovery"
import { createFlatEpochPending } from "./bot-flat-epoch-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

const key = (id: string) => `cmb:bot-recovery:pending:${id}`
export const createPendingBotRecoveryStore = (storage?: () => PendingSaveStorage) => {
  const store = createFlatEpochPending({
    input: pendingBotRecovery,
    key: (input) => key(input.id),
    maxCharacters: 8_500_000,
    storageMessage: "无法保留核对记录，本次操作尚未提交。请恢复应用存储后重试。",
    storage
  })
  return {
    ...store,
    inspect: (id: string, epoch: string) => store.inspect(key(id), epoch),
    read: (id: string, epoch: string) => store.read(key(id), epoch),
    discard: (id: string, epoch: string, raw: string) => store.discard(key(id), epoch, raw)
  }
}
export const pendingBotRecoveryStore = createPendingBotRecoveryStore()
export const inspectPendingBotRecovery = pendingBotRecoveryStore.inspect
export const readPendingBotRecovery = pendingBotRecoveryStore.read
export const rememberPendingBotRecovery = pendingBotRecoveryStore.remember
export const acknowledgePendingBotRecovery = pendingBotRecoveryStore.acknowledge
export const discardPendingBotRecovery = pendingBotRecoveryStore.discard
