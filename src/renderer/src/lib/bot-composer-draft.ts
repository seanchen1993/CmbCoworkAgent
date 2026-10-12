import { botEntityReferences, type BotEntityReference } from "../../../shared/bot-entity-references"
import { z } from "zod"
import { botSkillReference, type BotSkillReference } from "../../../shared/bot-skill-references"
import { botRecipientIds } from "../../../shared/bot-recipients"
import {
  parseComposerDraft,
  type ComposerDraft
} from "../components/bots/upstream/grok-composer-draft"

export interface BotComposerDraft extends ComposerDraft {
  revision?: string
  skills?: BotSkillReference[]
  recipients?: string[]
  references?: BotEntityReference[]
}
export function parseBotComposerDraft(value: unknown): BotComposerDraft | null {
  const draft = parseComposerDraft(value)
  if (!draft) return null
  if (draft.replyToId !== undefined && !/^[\w:.-]{1,160}$/.test(draft.replyToId)) return null
  const parsed = z
    .object({
      revision: z.string().uuid().optional(),
      skills: z.array(botSkillReference).max(6).optional(),
      recipients: botRecipientIds.optional(),
      references: botEntityReferences.optional()
    })
    .safeParse(value)
  return parsed.success ? { ...draft, ...parsed.data } : null
}

/** A restore invalidates persisted IDs; preserve the person's text without retrying old work. */
export function parseStoredBotDraft(
  value: unknown,
  dataEpoch = "initial"
): BotComposerDraft | null {
  const draft = parseBotComposerDraft(value)
  if (!draft) return null
  const savedEpoch =
    value && typeof value === "object" && "dataEpoch" in value ? value.dataEpoch : "initial"
  return savedEpoch === dataEpoch ? draft : { prompt: draft.prompt, attachments: [] }
}
