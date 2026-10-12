import { botApi } from "./bot-api"
import { useBotEpochOperation } from "./use-bot-epoch-operation"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import {
  pendingPrivateMemoryStore,
  pendingPrivateMemorySchema,
  type PendingPrivateMemoryMutation
} from "./bot-private-memory-pending"
import type { BotMemory } from "../../../shared/bot-types"
import type { BotMemoryDeleteReceipt } from "../../../shared/bot-memory"
interface Receipt {
  input: PendingPrivateMemoryMutation
  result: BotMemory | BotMemoryDeleteReceipt
}
export function useBotPrivateMemoryMutation(
  botId: string,
  onConfirmed: (receipt: Receipt, live: () => boolean) => Promise<void>
) {
  const supported = useBotWorkspaceStore((state) =>
    Boolean(
      state.snapshot?.dataEpoch &&
      state.host?.capabilities?.includes("mutation-data-epoch-v2") &&
      state.host.capabilities.includes("memory-mutation-epoch") &&
      state.host.capabilities.includes("private-memory-receipts")
    )
  )
  const session = useBotEpochOperation<PendingPrivateMemoryMutation, Receipt>({
    scope: botId,
    pending: {
      inspect: (epoch) => pendingPrivateMemoryStore.inspect(botId, epoch),
      remember: pendingPrivateMemoryStore.remember,
      acknowledge: pendingPrivateMemoryStore.acknowledge,
      discard: (epoch, raw) => pendingPrivateMemoryStore.discard(botId, epoch, raw)
    },
    matchesInput: (input) => input.request.botId === botId,
    verifies: (input, receipt) => {
      if (
        JSON.stringify(input) !== JSON.stringify(receipt.input) ||
        receipt.result === null ||
        typeof receipt.result !== "object"
      )
        return false
      if (input.operation === "delete")
        return (
          "deletedAt" in receipt.result &&
          receipt.result.id === input.request.id &&
          receipt.result.botId === input.request.botId &&
          receipt.result.revision === input.request.revision + 1 &&
          typeof receipt.result.deletedAt === "number" &&
          Number.isSafeInteger(receipt.result.deletedAt) &&
          receipt.result.deletedAt >= 0
        )
      const request = input.request,
        result = receipt.result
      return (
        "text" in result &&
        result.botId === request.botId &&
        !!result.id &&
        (!request.id || result.id === request.id) &&
        result.revision === (request.revision ?? 0) + 1 &&
        result.text === request.text &&
        result.deletedAt === null
      )
    },
    change: async (input) => ({
      input,
      result:
        input.operation === "save"
          ? await botApi.saveMemory(input.request)
          : await botApi.deleteMemory(input.request)
    }),
    definitiveErrors: [
      "invalid_input",
      "invalid_source",
      "revision_conflict",
      "not_found",
      "nonce_conflict",
      "memory_scope"
    ],
    onConfirmed
  })
  return {
    ...session,
    supported,
    fieldsDisabled: session.fieldsDisabled || !supported,
    saveDisabled: session.saveDisabled || !supported,
    saveMemory: (fields?: { id?: string; revision?: number; text: string }) =>
      supported
        ? session.save(
            fields
              ? () => {
                  const nonce = crypto.randomUUID()
                  return pendingPrivateMemorySchema.parse({
                    operation: "save",
                    dataEpoch: session.epoch,
                    nonce,
                    request: { botId, expectedDataEpoch: session.epoch, nonce, ...fields }
                  })
                }
              : undefined
          )
        : Promise.resolve(false),
    removeMemory: (id: string, revision: number) =>
      supported
        ? session.save(() => {
            const nonce = crypto.randomUUID()
            return pendingPrivateMemorySchema.parse({
              operation: "delete",
              dataEpoch: session.epoch,
              nonce,
              request: { botId, id, revision, expectedDataEpoch: session.epoch, nonce }
            })
          })
        : Promise.resolve(false)
  }
}
export type BotPrivateMemorySession = ReturnType<typeof useBotPrivateMemoryMutation>
