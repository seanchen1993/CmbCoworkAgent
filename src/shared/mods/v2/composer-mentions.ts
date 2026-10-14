import { encodeModJson, parseModJson } from "../validation"
import type { ModJson } from "../types"
import { isModObject, ModFunctionError } from "./contracts"
import type { PlainComposerSubmission } from "./prompt-submission"

export const COMPOSER_MENTION_MAX_FILES = 3
export const COMPOSER_MENTION_MAX_CHARS = 24000
export interface ComposerFileAttachment {
  filename: string
  filePath: string
  content: string
  mimeType: string
  size: number
  truncated: boolean
}
export interface ComposerPendingMention {
  mention: string
  workspacePath: string
  relativePath: string
  filename: string
  source: "typed" | "chip"
  offset?: number
  limit?: number
}
export interface ComposerMentionSubmission {
  kind: "file-mentions"
  text: string
  pendingMentions: ComposerPendingMention[]
  existingUploads: ComposerFileAttachment[]
  messageParts: { text: string; skillBlock: string; fileOnly: boolean }
}
export type ComposerSubmission = PlainComposerSubmission | ComposerMentionSubmission

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
/** The existing desktop attachment bytes, shared with the Main cross-check. */
export function formatComposerAttachments(attachments: readonly ComposerFileAttachment[]): string {
  return attachments.map(attachment => {
    const truncated = attachment.truncated ? ' truncated="true"' : ""
    const path = attachment.filePath ? ` path="${escapeXml(attachment.filePath)}"` : ""
    const content = attachment.content.replace(/<\/attachment>/gi, "< /attachment>")
    return `\n\n<attachment filename="${escapeXml(attachment.filename)}"${path} type="${attachment.mimeType}" size="${attachment.size}"${truncated}>\n${content}\n</attachment>`
  }).join("")
}
export function formatComposerMentionMessage(
  parts: ComposerMentionSubmission["messageParts"], attachments: readonly ComposerFileAttachment[]
): string {
  const primary = `${parts.text}${formatComposerAttachments(attachments)}`.trim()
  return [primary, parts.skillBlock].filter(part => part && part.trim()).join("\n\n")
}

/** Capture request data; this does not authenticate an OS read or a desktop gesture. */
export function captureComposerMentionSubmission(
  value: unknown, message: string
): ComposerMentionSubmission | undefined {
  if (!value || typeof value !== "object") return undefined
  let copied: ModJson
  try { copied = parseModJson(encodeModJson(value as ModJson)) as ModJson }
  catch { throw new ModFunctionError("MODS_COMPOSER_MENTION_SUBMISSION") }
  if (!isModObject(copied) || !Object.hasOwn(copied, "kind") || copied.kind !== "file-mentions") return undefined
  const parts = copied.messageParts, mentions = copied.pendingMentions, uploads = copied.existingUploads
  const invalid = () => { throw new ModFunctionError("MODS_COMPOSER_MENTION_SUBMISSION") }
  if (["kind", "text", "pendingMentions", "existingUploads", "messageParts"].some(key => !Object.hasOwn(copied, key)) ||
    Object.keys(copied).some(key => !["kind", "text", "pendingMentions", "existingUploads", "messageParts"].includes(key)) ||
    copied.text !== message || message.length > 512 * 1024 || !isModObject(parts) ||
    !Object.hasOwn(parts, "text") || !Object.hasOwn(parts, "skillBlock") || !Object.hasOwn(parts, "fileOnly") ||
    typeof parts.text !== "string" || parts.text.length > 32000 || typeof parts.skillBlock !== "string" ||
    parts.skillBlock.length > 32000 || typeof parts.fileOnly !== "boolean" ||
    (parts.fileOnly && (parts.text !== "请分析以下文件内容。" || parts.skillBlock !== "")) ||
    Object.keys(parts).some(key => !["text", "skillBlock", "fileOnly"].includes(key)) ||
    !Array.isArray(mentions) || !mentions.length || mentions.length > COMPOSER_MENTION_MAX_FILES ||
    !Array.isArray(uploads) || uploads.length > COMPOSER_MENTION_MAX_FILES) return invalid()
  let totalChars = 0
  for (const attachment of uploads) {
    if (!isModObject(attachment) ||
      ["filename", "filePath", "content", "mimeType", "size", "truncated"].some(key => !Object.hasOwn(attachment, key)) ||
      typeof attachment.filename !== "string" || !attachment.filename ||
      attachment.filename.length > 512 || typeof attachment.filePath !== "string" || attachment.filePath.length > 8192 ||
      typeof attachment.content !== "string" || typeof attachment.mimeType !== "string" ||
      attachment.mimeType.length > 256 || typeof attachment.size !== "number" ||
      !Number.isSafeInteger(attachment.size) || attachment.size < 0 || typeof attachment.truncated !== "boolean" ||
      Object.keys(attachment).some(key => !["filename", "filePath", "content", "mimeType", "size", "truncated"].includes(key)))
      return invalid()
    totalChars += attachment.content.length
  }
  if (totalChars > COMPOSER_MENTION_MAX_CHARS || uploads.length + mentions.length > COMPOSER_MENTION_MAX_FILES)
    return invalid()
  for (const mention of mentions) {
    if (!isModObject(mention) ||
      ["mention", "relativePath", "workspacePath", "filename", "source"].some(key => !Object.hasOwn(mention, key)) ||
      typeof mention.mention !== "string" || !mention.mention || mention.mention.length > 8192 ||
      typeof mention.relativePath !== "string" || !mention.relativePath || mention.relativePath.length > 8192 ||
      typeof mention.workspacePath !== "string" || !mention.workspacePath || mention.workspacePath.length > 8192 ||
      typeof mention.filename !== "string" || !mention.filename || mention.filename.length > 512 ||
      (mention.source !== "typed" && mention.source !== "chip") ||
      (Object.hasOwn(mention, "offset") && (typeof mention.offset !== "number" || !Number.isSafeInteger(mention.offset) || mention.offset < 1)) ||
      (Object.hasOwn(mention, "limit") && (typeof mention.limit !== "number" || !Number.isSafeInteger(mention.limit) || mention.limit < 1)) ||
      Object.keys(mention).some(key => !["mention", "relativePath", "workspacePath", "filename", "source", "offset", "limit"].includes(key)))
      return invalid()
  }
  const snapshot = copied as unknown as ComposerMentionSubmission
  if (formatComposerMentionMessage(snapshot.messageParts, snapshot.existingUploads) !== message)
    return invalid()
  for (const item of snapshot.pendingMentions) Object.freeze(item)
  for (const item of snapshot.existingUploads) Object.freeze(item)
  Object.freeze(snapshot.pendingMentions)
  Object.freeze(snapshot.existingUploads)
  Object.freeze(snapshot.messageParts)
  return Object.freeze(snapshot)
}
