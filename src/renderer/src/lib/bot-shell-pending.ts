import { botShellJobStop, type BotShellJobRead } from "../../../shared/bot-shell-jobs"
import { createFlatEpochPending } from "./bot-flat-epoch-pending"
import type { PendingSaveStorage } from "./bot-protected-save-pending"

const key = (id: string) => `bot-shell-stop:${id}`
export const createPendingShellStopStore = (storage?: () => PendingSaveStorage) => {
  const store = createFlatEpochPending({
    input: botShellJobStop,
    key: (input) => key(input.jobId),
    maxCharacters: 8000,
    storageMessage: "无法保留停止请求，本次操作尚未提交。",
    storage
  })
  return {
    ...store,
    inspect: (id: string, epoch: string, address?: Omit<BotShellJobRead, "offset">) => {
      const record = store.inspect(key(id), epoch)
      if (
        address &&
        (record.kind === "valid" || record.kind === "obsolete") &&
        (record.input.conversationId !== address.conversationId ||
          record.input.runId !== address.runId ||
          record.input.threadRootId !== address.threadRootId ||
          record.input.jobId !== address.jobId)
      )
        return { kind: "corrupt" as const, raw: record.raw }
      return record
    },
    read: (id: string, epoch: string) => store.read(key(id), epoch),
    discard: (id: string, epoch: string, raw: string) => store.discard(key(id), epoch, raw)
  }
}
export const pendingShellStopStore = createPendingShellStopStore()
export const inspectPendingShellStop = pendingShellStopStore.inspect
export const readPendingShellStop = pendingShellStopStore.read
export const rememberShellStop = pendingShellStopStore.remember
export const acknowledgeShellStop = pendingShellStopStore.acknowledge
export const discardPendingShellStop = pendingShellStopStore.discard
