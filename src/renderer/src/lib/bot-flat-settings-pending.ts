import { z } from "zod"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"

/** Preserve the existing flat settings record, key and budget while sharing exact recovery ownership. */
export function createFlatSettingsPending<
  T extends { botId: string | null; dataEpoch: string }
>(options: {
  input: z.ZodType<T>
  key(botId: T["botId"]): string
  maxCharacters: number
  storageMessage: string
  storage?: () => PendingSaveStorage
}) {
  const wrapped = z
    .object({ dataEpoch: z.string().min(1).max(160), input: options.input })
    .strict()
    .refine((value) => value.dataEpoch === value.input.dataEpoch)
  const store = createProtectedSavePending({
    ...options,
    record: z.union([
      options.input.transform((input) => ({
        dataEpoch: input.dataEpoch,
        input
      })),
      wrapped
    ]),
    key: (input: T) => options.key(input.botId),
    encodeRecord: (record) => record.input,
    oversizeMessage: options.storageMessage
  })
  return {
    inspect: (botId: T["botId"], epoch: string) => store.inspect(options.key(botId), epoch),
    read: (botId: T["botId"], epoch: string) => store.read(options.key(botId), epoch),
    remember: (input: T) => store.remember(input, input.dataEpoch),
    acknowledge: (input: T) => store.acknowledge(input, input.dataEpoch),
    discard: (botId: T["botId"], epoch: string, raw: string) =>
      store.discard(options.key(botId), epoch, raw)
  }
}
