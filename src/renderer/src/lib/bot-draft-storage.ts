import { botEntitySelections } from "../../../shared/bot-entity-references"
import {
  botInlineReferenceSpans,
  validInlineReferenceSpans
} from "../../../shared/bot-inline-references"
import {
  botSelectionQuoteSpans,
  validSelectionQuoteSpans
} from "../../../shared/bot-selection-quotes"
import type { BotSendInput } from "../../../shared/bot-types"
import { parseStoredBotDraft, type BotComposerDraft } from "./bot-composer-draft"
import { botViewAddress } from "./bot-thread-view"

export interface BotStoredDraft {
  draft?: BotComposerDraft
  pending?: BotSendInput
  pendingDraftRevision?: string
  draftRaw: string | null
  pendingRaw: string | null
  malformed: boolean
  unavailable: boolean
}
/** The original select parser, with its failure state exposed for an explicit draft handoff. */
export function readStoredBotDraft(
  viewId: string,
  epoch: string | undefined,
  storage: Pick<Storage, "getItem">,
  readDraft = true
): BotStoredDraft {
  const result: BotStoredDraft = {
    draftRaw: null,
    pendingRaw: null,
    malformed: false,
    unavailable: false
  }
  if (readDraft) {
    try {
      result.draftRaw = storage.getItem(`bot-draft:${viewId}`)
      result.draft = parseStoredBotDraft(JSON.parse(result.draftRaw || "null"), epoch) ?? undefined
      if (result.draftRaw && !result.draft) result.malformed = true
    } catch {
      result.malformed = true
      result.unavailable = true
    }
  }
  try {
    result.pendingRaw = storage.getItem(`bot-pending:${viewId}`)
    const value = JSON.parse(result.pendingRaw || "null")
    const address = botViewAddress(viewId)
    if (
      (value?.dataEpoch ?? "initial") === (epoch ?? "initial") &&
      value?.conversationId === address.conversationId &&
      value?.threadRootId === address.threadRootId &&
      typeof value.nonce === "string" &&
      typeof value.text === "string"
    ) {
      if (value.references !== undefined) botEntitySelections.parse(value.references)
      if (
        value.inlineReferences !== undefined &&
        !validInlineReferenceSpans(
          value.text,
          botInlineReferenceSpans.parse(value.inlineReferences)
        )
      )
        throw new Error("Invalid saved references")
      if (
        value.selectionQuotes !== undefined &&
        !validSelectionQuoteSpans(value.text, botSelectionQuoteSpans.parse(value.selectionQuotes))
      )
        throw new Error("Invalid saved selection quotes")
      result.pendingDraftRevision =
        typeof value.draftRevision === "string" ? value.draftRevision : undefined
      result.pending = { ...value }
      delete (result.pending as BotSendInput & { dataEpoch?: string }).dataEpoch
      delete (result.pending as BotSendInput & { draftRevision?: string }).draftRevision
    } else if (result.pendingRaw) result.malformed = true
  } catch {
    result.malformed = true
    result.unavailable = true
  }
  return result
}
