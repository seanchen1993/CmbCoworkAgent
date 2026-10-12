import { botBackupScheduleChange } from "../../../shared/bot-backup-schedule"
import { createFlatEpochPending } from "./bot-flat-epoch-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

const key = "cmb:bot-backup-schedule:pending"
export const createPendingBackupScheduleStore = (storage?: () => PendingSaveStorage) => {
  const store = createFlatEpochPending({
    input: botBackupScheduleChange,
    key: () => key,
    maxCharacters: 4096,
    storageMessage: "无法保留操作记录，本次配置尚未提交。",
    storage
  })
  return {
    ...store,
    inspect: (epoch: string) => store.inspect(key, epoch),
    read: (epoch: string) => store.read(key, epoch),
    discard: (epoch: string, raw: string) => store.discard(key, epoch, raw)
  }
}
export const pendingBackupScheduleStore = createPendingBackupScheduleStore()
export const inspectPendingBackupSchedule = pendingBackupScheduleStore.inspect
export const readPendingBackupSchedule = pendingBackupScheduleStore.read
export const rememberPendingBackupSchedule = pendingBackupScheduleStore.remember
export const acknowledgePendingBackupSchedule = pendingBackupScheduleStore.acknowledge
export const discardPendingBackupSchedule = pendingBackupScheduleStore.discard
