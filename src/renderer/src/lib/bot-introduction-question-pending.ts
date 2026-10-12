import { z } from "zod"
import { botIntroductionQuestionReply } from "../../../shared/bot-introduction-question"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"

const key = (runId: string) => `bot-introduction-question-pending:${encodeURIComponent(runId)}`
export function createPendingIntroductionQuestionStore(storage?: () => PendingSaveStorage) {
  const pending = createProtectedSavePending({
    input: botIntroductionQuestionReply,
    record: z
      .object({ dataEpoch: z.string().min(1).max(160), input: botIntroductionQuestionReply })
      .strict()
      .refine((value) => value.dataEpoch === value.input.dataEpoch),
    key: (input) => key(input.runId),
    maxCharacters: 128_000,
    oversizeMessage: "回答记录过长，本次回答尚未提交。",
    storageMessage: "无法保留回答记录，本次回答尚未提交。",
    storage
  })
  return {
    inspect: (runId: string, epoch: string) => pending.inspect(key(runId), epoch),
    remember: (input: z.infer<typeof botIntroductionQuestionReply>) =>
      pending.remember(input, input.dataEpoch),
    acknowledge: (input: z.infer<typeof botIntroductionQuestionReply>) =>
      pending.acknowledge(input, input.dataEpoch),
    discard: (runId: string, epoch: string, raw: string) => pending.discard(key(runId), epoch, raw)
  }
}
export const pendingIntroductionQuestionStore = createPendingIntroductionQuestionStore()
