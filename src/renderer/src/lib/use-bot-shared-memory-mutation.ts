import { botApi } from "./bot-api"
import { useBotEpochOperation } from "./use-bot-epoch-operation"
import {
  pendingSharedMemoryStore,
  type PendingSharedMemoryMutation
} from "./bot-shared-memory-pending"
import type { BotMemory } from "../../../shared/bot-types"
import type { BotSharedMemoryScope } from "../../../shared/bot-memory"
interface Receipt {
  input: PendingSharedMemoryMutation
  result: BotMemory | { id: string }
}
export function useBotSharedMemoryMutation(
  botId: string,
  scope: BotSharedMemoryScope,
  onConfirmed: (receipt: Receipt, live: () => boolean) => Promise<void>
) {
  return useBotEpochOperation<PendingSharedMemoryMutation, Receipt>({
    scope: `${botId}:${scope}`,
    pending: {
      inspect: (epoch) => pendingSharedMemoryStore.inspect(botId, scope, epoch),
      remember: pendingSharedMemoryStore.remember,
      acknowledge: pendingSharedMemoryStore.acknowledge,
      discard: (epoch, raw) => pendingSharedMemoryStore.discard(botId, scope, epoch, raw)
    },
    matchesInput: (input) => input.request.botId === botId && input.request.scope === scope,
    verifies: (input, receipt) => {
      if (JSON.stringify(input) !== JSON.stringify(receipt.input)) return false
      if (input.operation === "delete") return receipt.result.id === input.request.id
      const request = input.request,
        result = receipt.result
      return (
        "text" in result &&
        result.botId === request.botId &&
        result.scope === request.scope &&
        !!result.id &&
        (!request.id || result.id === request.id) &&
        result.revision === (request.revision ?? 0) + 1 &&
        result.text === request.text.trim() &&
        result.deletedAt === null
      )
    },
    change: async (input) => ({
      input,
      result:
        input.operation === "save"
          ? await botApi.saveSharedMemory(input.request)
          : await botApi.deleteSharedMemory(input.request)
    }),
    definitiveErrors: [
      "invalid_input",
      "revision_conflict",
      "not_found",
      "nonce_conflict",
      "memory_project_required",
      "memory_project_unavailable",
      "memory_capacity"
    ],
    onConfirmed
  })
}
export type BotSharedMemorySession = ReturnType<typeof useBotSharedMemoryMutation>
