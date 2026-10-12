// Extracted unchanged from Grok Bot 0.18 reconstruction model.ts; see PROVENANCE.json.
export const COMPOSER_ATTACHMENT_LIMIT = 6

export type AttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "table"
  | "json"
  | "document"
  | "archive"
  | "text"
  | "file"

export interface DraftAttachment {
  path: string
  name: string
  size?: number
  mimeType?: string
}

export interface ComposerDraft {
  prompt: string
  attachments: DraftAttachment[]
  richText?: string
  replyToId?: string
  isFork?: boolean
}

export const COMPOSER_DRAFT_METADATA = {
  slice: "composer-drafts",
  schemaVersion: 1,
  scope: "client-persisted",
  accountSensitive: true
} as const

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return draft.prompt.trim().length === 0 && draft.attachments.length === 0
}

function emptyToNull(value: string | undefined): string | null {
  return value == null || value.length === 0 ? null : value
}

export function areComposerDraftContentsEqual(left: ComposerDraft, right: ComposerDraft): boolean {
  return (
    left.prompt === right.prompt &&
    emptyToNull(left.richText) === emptyToNull(right.richText) &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((attachment, index) => {
      const candidate = right.attachments[index]
      return attachment.path === candidate?.path && attachment.name === candidate.name
    })
  )
}

export function areComposerDraftsEqual(left: ComposerDraft, right: ComposerDraft): boolean {
  return (
    areComposerDraftContentsEqual(left, right) &&
    (left.replyToId ?? null) === (right.replyToId ?? null) &&
    (left.isFork ?? false) === (right.isFork ?? false)
  )
}

export function parseComposerDraft(value: unknown): ComposerDraft | null {
  if (typeof value !== "object" || value == null) return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.prompt !== "string" ||
    (candidate.richText !== undefined && typeof candidate.richText !== "string") ||
    (candidate.replyToId !== undefined && typeof candidate.replyToId !== "string") ||
    (candidate.isFork !== undefined && typeof candidate.isFork !== "boolean") ||
    !Array.isArray(candidate.attachments)
  )
    return null

  const attachments: DraftAttachment[] = []
  for (const valueAttachment of candidate.attachments) {
    if (typeof valueAttachment !== "object" || valueAttachment == null) return null
    const attachment = valueAttachment as Record<string, unknown>
    if (typeof attachment.path !== "string" || typeof attachment.name !== "string") return null
    const size =
      typeof attachment.size === "number" && Number.isFinite(attachment.size)
        ? attachment.size
        : undefined
    attachments.push({
      path: attachment.path,
      name: attachment.name,
      ...(size === undefined ? {} : { size })
    })
  }

  return {
    prompt: candidate.prompt,
    attachments,
    ...(candidate.richText === undefined ? {} : { richText: candidate.richText }),
    ...(candidate.replyToId === undefined ? {} : { replyToId: candidate.replyToId }),
    ...(candidate.isFork === undefined ? {} : { isFork: candidate.isFork })
  }
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
