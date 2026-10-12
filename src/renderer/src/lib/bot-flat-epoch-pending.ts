import { z } from "zod"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"

/** Keep a domain's actual key and flat request encoding while sharing protected record ownership. */
export function createFlatEpochPending<T extends { dataEpoch: string }>(options: {
  input: z.ZodType<T>
  key(input: T): string
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
      options.input.transform((input) => ({ dataEpoch: input.dataEpoch, input })),
      wrapped
    ]),
    encodeRecord: (record) => record.input,
    oversizeMessage: options.storageMessage
  })
  return {
    inspect: store.inspect,
    read: store.read,
    remember: (input: T) => store.remember(input, input.dataEpoch),
    acknowledge: (input: T) => store.acknowledge(input, input.dataEpoch),
    discard: store.discard
  }
}
