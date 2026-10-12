import { z } from "zod"
import { BOT_PRESENTATION_STYLES, type botPresentationChoice } from "../../shared/bot-presentation"
import { presentationHash } from "./presentation-record"

export function presentationSelectionIdentity(runId: string, callId: string, inputSha256: string) {
  return {
    selectedCall: `presentation-selected:${presentationHash(callId)}`,
    intent: {
      tool: "create_presentation",
      version: 1,
      inputSha256,
      publicationId: `presentation:${presentationHash([runId, callId])}`
    }
  }
}
/** Called only with the Store's already validated answer to its immutable original question. */
export function presentationSelectionForAnswer(
  card: z.infer<typeof botPresentationChoice>,
  answer: string
) {
  const result = z
    .object({
      status: z.literal("submitted"),
      answers: z
        .object({
          presentation_style: z
            .object({
              type: z.literal("option"),
              optionIndex: z.number().int().min(0).max(2),
              additionalText: z.string().optional()
            })
            .passthrough()
        })
        .passthrough()
    })
    .safeParse(JSON.parse(answer))
  if (!result.success || result.data.answers.presentation_style.additionalText) return null
  const index = result.data.answers.presentation_style.optionIndex
  const identity = presentationSelectionIdentity(card.runId, card.callId, card.inputSha256)
  return {
    nonce: `tool:${card.runId}:${identity.selectedCall}`,
    request: identity.intent,
    result: { style: BOT_PRESENTATION_STYLES[index], layoutSha256: card.layoutHashes[index] }
  }
}
