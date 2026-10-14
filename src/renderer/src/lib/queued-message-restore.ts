import type { QueuedMessage } from "../types"
import {
  captureComposerMentionSubmission,
  COMPOSER_MENTION_MAX_CHARS,
  COMPOSER_MENTION_MAX_FILES,
  formatComposerAttachments,
  type ComposerFileAttachment,
  type ComposerPendingMention
} from "../../../shared/mods/v2/composer-mentions"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import {
  collectPendingAtFileMentions,
  toMentionedWorkspaceFile
} from "../features/mentions/atFileAttachments"
import { normalizeAtFileMentionPath } from "../features/mentions/useAtFileMentions"
import { getQueuedComposerSubmission, getQueuedModelContent } from "./queued-message-content"

const queuedFields = new Set([
  "id",
  "text",
  "attachmentModelBlocks",
  "attachmentDisplayPrefix",
  "skillBlock",
  "builtinBrowser",
  "modelId",
  "handoffRequestedAt",
  "created_at",
  "updated_at",
  "pendingMentions",
  "existingUploads",
  "fileOnly"
])
const uploadFields = ["filename", "filePath", "content", "mimeType", "size", "truncated"]
const mentionFields = [
  "mention",
  "workspacePath",
  "relativePath",
  "filename",
  "source",
  "offset",
  "limit"
]
const invalid = (): never => {
  throw Error("文件提及草稿无效，请重新选择文件")
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return invalid()
  return value as Record<string, unknown>
}

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor && !("value" in descriptor)) return invalid()
  return descriptor?.value
}

function date(value: unknown, fallback: Date): Date {
  const parsed =
    typeof value === "string" && value
      ? new Date(value)
      : typeof value === "number" && value
        ? new Date(value)
        : value === true
          ? new Date(1)
          : fallback
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function captureUploads(value: unknown): ComposerFileAttachment[] {
  if (!Array.isArray(value) || value.length > COMPOSER_MENTION_MAX_FILES) return invalid()
  let characters = 0
  const result: ComposerFileAttachment[] = []
  for (const entry of value) {
    const item = object(entry)
    if (
      uploadFields.some((key) => !Object.hasOwn(item, key)) ||
      Object.keys(item).some((key) => !uploadFields.includes(key))
    )
      return invalid()
    const filename = own(item, "filename"),
      filePath = own(item, "filePath")
    const content = own(item, "content"),
      mimeType = own(item, "mimeType")
    const size = own(item, "size"),
      truncated = own(item, "truncated")
    if (
      typeof filename !== "string" ||
      !filename ||
      filename.length > 512 ||
      typeof filePath !== "string" ||
      filePath.length > 8192 ||
      typeof content !== "string" ||
      typeof mimeType !== "string" ||
      mimeType.length > 256 ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof truncated !== "boolean"
    )
      return invalid()
    characters += content.length
    if (characters > COMPOSER_MENTION_MAX_CHARS) return invalid()
    result.push(Object.freeze({ filename, filePath, content, mimeType, size, truncated }))
  }
  Object.freeze(result)
  return result
}

function sameMention(left: ComposerPendingMention, right: ComposerPendingMention): boolean {
  return mentionFields.every(
    (key) =>
      Object.hasOwn(left, key) === Object.hasOwn(right, key) && own(left, key) === own(right, key)
  )
}

function assertReferences(
  message: QueuedMessage,
  pending: ComposerPendingMention[],
  uploads: ComposerFileAttachment[],
  workspacePath: string
): void {
  const workspaceKey = normalizeWorkspacePathKey(workspacePath)
  if (
    !workspaceKey ||
    pending.some((item) => normalizeWorkspacePathKey(item.workspacePath) !== workspaceKey)
  )
    throw Error("工作区已变化，请重新选择该草稿的 @文件")
  const chips = pending
    .filter((item) => item.source === "chip")
    .map((item) => {
      const filename = item.relativePath.replaceAll("\\", "/").split("/").at(-1)
      if (
        normalizeAtFileMentionPath(item.mention) !==
          normalizeAtFileMentionPath(item.relativePath) ||
        item.filename !== filename
      )
        return invalid()
      return toMentionedWorkspaceFile(
        {
          id: item.relativePath,
          displayPath: item.mention,
          workspaceFilePath: item.relativePath,
          filename: item.filename,
          size: 0
        },
        workspacePath
      )
    })
  const collected = collectPendingAtFileMentions({
    rawMessage: message.text,
    attachments: uploads,
    mentionedFiles: chips,
    workspacePath,
    maxAttachments: COMPOSER_MENTION_MAX_FILES
  })
  if (
    collected.countLimitHit ||
    collected.staleWorkspace ||
    collected.pendingMentions.length !== pending.length ||
    pending.some((item, index) => !sameMention(item, collected.pendingMentions[index]))
  )
    return invalid()
}

function captureStructured(message: QueuedMessage, raw: Record<string, unknown>): QueuedMessage {
  for (const key of Object.keys(raw)) if (!queuedFields.has(key)) return invalid()
  const rawPending = own(raw, "pendingMentions"),
    rawUploads = own(raw, "existingUploads")
  const rawFileOnly = own(raw, "fileOnly")
  if (
    !Array.isArray(rawPending) ||
    !Array.isArray(rawUploads) ||
    (rawFileOnly !== undefined && typeof rawFileOnly !== "boolean")
  )
    return invalid()
  const json = object(
    parseModJson(
      encodeModJson({
        pendingMentions: rawPending,
        existingUploads: rawUploads,
        fileOnly: rawFileOnly === true
      })
    )
  )
  const uploads = captureUploads(own(json, "existingUploads")),
    fileOnly = own(json, "fileOnly") === true
  const pending = own(json, "pendingMentions")
  if (
    !Array.isArray(pending) ||
    pending.length > COMPOSER_MENTION_MAX_FILES ||
    uploads.length + pending.length > COMPOSER_MENTION_MAX_FILES ||
    message.text.length > 32000 ||
    (message.skillBlock?.length ?? 0) > 32000
  )
    return invalid()
  const expectedBlocks = formatComposerAttachments(uploads)
  if ((message.attachmentModelBlocks ?? "") !== expectedBlocks) return invalid()
  if (
    fileOnly &&
    (message.text !== "请分析以下文件内容。" || message.skillBlock || message.builtinBrowser)
  )
    return invalid()
  const candidate: QueuedMessage = {
    ...message,
    pendingMentions: pending as ComposerPendingMention[],
    existingUploads: uploads,
    fileOnly
  }
  if (!pending.length) {
    const empty: ComposerPendingMention[] = []
    Object.freeze(empty)
    return {
      ...candidate,
      pendingMentions: empty,
      attachmentDisplayPrefix: uploads.map((item) => `📎 ${item.filename}`).join("\n")
    }
  }
  const captured = captureComposerMentionSubmission(
    getQueuedComposerSubmission(candidate),
    getQueuedModelContent(candidate)
  )
  if (!captured) return invalid()
  assertReferences(
    candidate,
    captured.pendingMentions,
    captured.existingUploads,
    captured.pendingMentions[0].workspacePath
  )
  return {
    ...candidate,
    pendingMentions: captured.pendingMentions,
    existingUploads: captured.existingUploads,
    attachmentDisplayPrefix: [
      ...uploads.map((item) => `📎 ${item.filename}`),
      ...captured.pendingMentions.map((item) => `📎 ${item.filename}`)
    ].join("\n")
  }
}

/** Restore JSON request data. Main still authenticates every actual file read and submission. */
export function normalizeQueuedMessage(raw: unknown): QueuedMessage | null {
  try {
    const item = object(raw),
      id = own(item, "id"),
      text = own(item, "text")
    if (typeof id !== "string" || !id || typeof text !== "string") return null
    const createdAt = date(own(item, "created_at"), new Date())
    const updatedAt = date(own(item, "updated_at"), createdAt)
    const handoff = own(item, "handoffRequestedAt")
    const handoffRequestedAt = handoff ? date(handoff, new Date(NaN)) : undefined
    const blocks = own(item, "attachmentModelBlocks"),
      display = own(item, "attachmentDisplayPrefix")
    const skill = own(item, "skillBlock"),
      model = own(item, "modelId")
    const message: QueuedMessage = {
      id,
      text,
      attachmentModelBlocks: typeof blocks === "string" ? blocks : undefined,
      attachmentDisplayPrefix: typeof display === "string" ? display : undefined,
      skillBlock: typeof skill === "string" ? skill : undefined,
      builtinBrowser: own(item, "builtinBrowser") === true,
      modelId: typeof model === "string" ? model : undefined,
      handoffRequestedAt:
        handoffRequestedAt && !Number.isNaN(handoffRequestedAt.getTime())
          ? handoffRequestedAt
          : undefined,
      created_at: createdAt,
      updated_at: updatedAt
    }
    const structured = ["pendingMentions", "existingUploads", "fileOnly"].some((key) =>
      Object.hasOwn(item, key)
    )
    return structured ? captureStructured(message, item) : message
  } catch {
    return null
  }
}

/** Recheck the actual current workspace immediately before this unread draft crosses IPC. */
export function assertQueuedComposerMentionWorkspace(
  message: QueuedMessage,
  workspacePath: string | null | undefined
): void {
  if (!message.pendingMentions?.length) return
  if (!workspacePath) throw Error("工作区已变化，请重新选择该草稿的 @文件")
  const captured = captureComposerMentionSubmission(
    getQueuedComposerSubmission(message),
    getQueuedModelContent(message)
  )
  if (!captured) return invalid()
  const savedWorkspace = captured.pendingMentions[0].workspacePath
  if (normalizeWorkspacePathKey(savedWorkspace) !== normalizeWorkspacePathKey(workspacePath))
    throw Error("工作区已变化，请重新选择该草稿的 @文件")
  // Recollection uses the saved spelling; the actual workspace comparison above uses platform keys.
  assertReferences(message, captured.pendingMentions, captured.existingUploads, savedWorkspace)
}
