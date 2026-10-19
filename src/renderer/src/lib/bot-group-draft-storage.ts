import { z } from "zod"
import {
  botDraftContentSchema,
  loadBotDraftRecord,
  saveBotDraftRecord,
  pruneBotDraftRecords
} from "./bot-draft-storage"

const prefix = "cmb-bot-group-draft-v1:"
const identifier = z.string().min(1).max(128)
const savedDraft = botDraftContentSchema.extend({
  version: z.literal(1),
  targets: z.array(identifier).max(8).nullable(),
  replyTo: z
    .object({
      id: identifier,
      ordinal: z.number().int().positive(),
      authorBotId: identifier.nullable().default(null),
      text: z.string().max(1000)
    })
    .nullable()
    .default(null),
  mentions: z
    .array(
      z.object({
        start: z.number().int().min(0).max(30_000),
        end: z.number().int().min(1).max(30_000),
        botId: identifier.nullable(),
        label: z.string().min(1).max(200)
      })
    )
    .max(128)
    .default([]),
  revision: z.number().int().nonnegative(),
  request: z
    .object({
      id: identifier,
      text: z.string().max(30_000),
      targets: z.string().max(4096),
      mentions: z.string().max(64_000).optional(),
      replyToId: identifier.optional(),
      revision: z.number().int().nonnegative()
    })
    .nullable()
})
export type SavedGroupDraft = Omit<z.input<typeof savedDraft>, "version">

/** Same per-conversation local storage strategy as the original pending-message queue.
 * Save only the edited group; never serialize every draft on each keystroke.
 * Attachments already point at retained originals in the group workspace.
 */
export function saveGroupDraft(key: string, draft: SavedGroupDraft): string | null {
  return saveBotDraftRecord(
    prefix + key,
    { ...draft, version: 1 as const },
    savedDraft,
    !draft.text &&
      !draft.attachments.length &&
      draft.targets === null &&
      !draft.request &&
      !draft.replyTo
  )
}

export function loadGroupDraft(key: string): { draft?: SavedGroupDraft; error?: string } {
  return loadBotDraftRecord(prefix + key, savedDraft)
}

export function pruneSavedGroupDrafts(hostId: string, groupIds: readonly string[]): void {
  pruneBotDraftRecords(prefix, hostId, groupIds)
}
