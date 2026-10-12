import type { BotArtifact } from "../../../shared/bot-types"
import { parseBotComposerDraft, type BotComposerDraft } from "./bot-composer-draft"
import {
  composerDocument,
  composerDocumentText,
  parseComposerDocument
} from "./bot-composer-document"
import { botViewAddress } from "./bot-thread-view"
import { readStoredBotDraft } from "./bot-draft-storage"
import type { BotViewportPositionLease } from "./bot-viewport-position"
import type { useBotWorkspaceStore } from "./bot-workspace-store"

export interface NewChatLocalFile {
  localId: string
  file: File
  name: string
  mime: string
  size: number
}
export interface NewChatDraftAdoption {
  openNonce: string
  sourceRevision: string
  hostId: string
  dataEpoch: string
  targetViewId: string
  targetDraftRevision: string
}
export interface BotLocalFileBatch {
  batchId: string
  adoption: NewChatDraftAdoption
  targetViewportGeneration: number
  files: readonly NewChatLocalFile[]
}
export interface BotAcceptedFileJob {
  localId: string
  nonce: string
}
export interface BotFileBatchCompletion {
  confirmed: readonly {
    localId: string
    nonce: string
    artifact: BotArtifact
  }[]
  remaining: readonly BotAcceptedFileJob[]
  state: "complete" | "retry" | "cancelled" | "retired"
}
export interface NewChatLocalSession {
  openNonce: string
  hostId: string
  dataEpoch: string
  originViewId: string | null
  originViewportGeneration: number | null
  revision: string
  draft: BotComposerDraft
  files: readonly NewChatLocalFile[]
  phase: "editing" | "resolving" | "handoff"
  groupMode?: boolean
  error?: string
  handoff?: {
    adoption: NewChatDraftAdoption
    lease: BotViewportPositionLease
    batchId: string
    ready: boolean
    accepted?: readonly BotAcceptedFileJob[]
  }
}
export type BotNewChatWorkspaceState = ReturnType<typeof useBotWorkspaceStore.getState>
export type NewChatAdoptResult =
  | { kind: "adopted"; receipt: NewChatDraftAdoption }
  | { kind: "blocked" | "retired"; reason: string }
export const NEW_CHAT_DRAFT_CONFLICT = "这个对话已有草稿或待确认操作，原内容和本次输入均已保留。"
export function newChatHasContent(session: Pick<NewChatLocalSession, "draft" | "files">) {
  return Boolean(session.files.length || !botDraftIsBlank(session.draft))
}
/** Clearing the editor supplies richText: undefined; only an omitted field retains it. */
export function patchNewChatText(
  draft: BotComposerDraft,
  changes: Partial<BotComposerDraft>
): BotComposerDraft {
  return {
    prompt: changes.prompt ?? draft.prompt,
    richText: Object.hasOwn(changes, "richText") ? changes.richText : draft.richText,
    attachments: [],
    revision: draft.revision
  }
}
export function botDraftIsBlank(draft: BotComposerDraft) {
  if (draft.richText) {
    try {
      if (!parseComposerDocument(JSON.parse(draft.richText))) return false
    } catch {
      return false
    }
  }
  return (
    !draft.prompt.trim() &&
    !composerDocumentText(composerDocument(draft)).trim() &&
    !draft.attachments.length &&
    !draft.replyToId &&
    !draft.isFork &&
    !draft.skills?.length &&
    !draft.references?.length &&
    !draft.recipients?.length
  )
}
export function newChatSessionCurrent(
  session: NewChatLocalSession,
  state: BotNewChatWorkspaceState
) {
  if (
    (state.host?.hostId ?? "unconnected") !== session.hostId ||
    (state.snapshot?.dataEpoch ?? "initial") !== session.dataEpoch
  )
    return false
  const originViewId = session.originViewId
  const target = session.phase === "handoff" ? session.handoff?.lease : undefined
  return (
    state.selected === (target?.viewId ?? session.originViewId) &&
    (state.viewportLease?.generation ?? null) ===
      (target?.generation ?? session.originViewportGeneration) &&
    (!originViewId ||
      state.snapshot?.conversations.some(
        (item) => item.id === botViewAddress(originViewId).conversationId
      ))
  )
}
/** Same-renderer synchronous compare/read/adopt; this is not a cross-window localStorage CAS. */
export function adoptNewChatDraft(
  session: NewChatLocalSession,
  state: BotNewChatWorkspaceState,
  targetViewId: string,
  storage: Pick<Storage, "getItem">
): NewChatAdoptResult {
  if (!newChatSessionCurrent(session, state) || session.phase === "handoff")
    return {
      kind: "retired",
      reason: "本次新聊天已关闭或工作区已切换，输入仍保留在原位置。"
    }
  const stored = readStoredBotDraft(targetViewId, session.dataEpoch, storage)
  const memory = state.drafts[targetViewId]
  // The original Store appends revision after changes, while its parser rebuilds
  // fields in schema order. Compare the same canonical draft shape on both sides.
  const canonicalMemory = memory ? parseBotComposerDraft(memory) : null
  if (
    stored.unavailable ||
    stored.malformed ||
    (memory && !canonicalMemory) ||
    (canonicalMemory &&
      stored.draft &&
      (canonicalMemory.revision !== stored.draft.revision ||
        JSON.stringify(canonicalMemory) !== JSON.stringify(stored.draft))) ||
    stored.pendingRaw ||
    state.pending[targetViewId] ||
    state.sending[targetViewId] ||
    state.uploading[targetViewId] ||
    (memory && !botDraftIsBlank(memory)) ||
    (stored.draft && !botDraftIsBlank(stored.draft))
  )
    return { kind: "blocked", reason: NEW_CHAT_DRAFT_CONFLICT }
  if (session.draft.richText) {
    let raw
    try {
      raw = parseComposerDocument(JSON.parse(session.draft.richText))
    } catch {
      /* fail closed below */
    }
    if (
      !raw ||
      raw.content.some((paragraph) =>
        paragraph.content?.some((node) => node.type === "botReference")
      )
    )
      return { kind: "blocked", reason: "请在选择收件人后重新添加引用对象，本次输入已保留。" }
  }
  const doc = composerDocument(session.draft)
  if (
    doc.content.some((paragraph) => paragraph.content?.some((node) => node.type === "botReference"))
  )
    return {
      kind: "blocked",
      reason: "请在选择收件人后重新添加引用对象，本次输入已保留。"
    }
  const check = readStoredBotDraft(targetViewId, session.dataEpoch, storage)
  if (
    check.unavailable ||
    check.malformed ||
    check.draftRaw !== stored.draftRaw ||
    check.pendingRaw !== stored.pendingRaw
  )
    return { kind: "blocked", reason: NEW_CHAT_DRAFT_CONFLICT }
  state.updateDraft(targetViewId, {
    prompt: session.draft.prompt,
    richText: session.draft.richText
  })
  const revision = stateRevision(state, targetViewId)
  if (!revision) return { kind: "blocked", reason: "输入转交尚未确认，本次内容已保留。" }
  return {
    kind: "adopted",
    receipt: {
      openNonce: session.openNonce,
      sourceRevision: session.revision,
      hostId: session.hostId,
      dataEpoch: session.dataEpoch,
      targetViewId,
      targetDraftRevision: revision
    }
  }
}
// Zustand's action closes over its owner; read the accepted state through its actual port.
function stateRevision(state: BotNewChatWorkspaceState, viewId: string) {
  return state.readDraft(viewId)?.revision
}
