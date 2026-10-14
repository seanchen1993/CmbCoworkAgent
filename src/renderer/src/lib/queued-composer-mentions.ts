import type { QueuedMessage } from "../types"
import { COMPOSER_MENTION_MAX_FILES } from "../../../shared/mods/v2/composer-mentions"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { collectPendingAtFileMentions, toMentionedWorkspaceFile } from "../features/mentions/atFileAttachments"

/** Editing a structured draft replaces its typed references and retains its selected chips. */
export function editQueuedComposerMentionText(message: QueuedMessage, text: string,
  workspacePath: string | null | undefined): QueuedMessage {
  if (!message.pendingMentions?.length) return { ...message, text }
  if (!workspacePath || message.pendingMentions.some(item =>
    normalizeWorkspacePathKey(item.workspacePath) !== normalizeWorkspacePathKey(workspacePath)))
    throw Error("工作区已变化，请重新选择该草稿的 @文件")
  const chips = message.pendingMentions.filter(item => item.source === "chip").map(item =>
    toMentionedWorkspaceFile({ id: item.relativePath, displayPath: item.mention,
      workspaceFilePath: item.relativePath, filename: item.filename, size: 0 }, workspacePath))
  const uploads = message.existingUploads ?? []
  const pending = collectPendingAtFileMentions({ rawMessage: text, attachments: uploads,
    mentionedFiles: chips, workspacePath, maxAttachments: COMPOSER_MENTION_MAX_FILES })
  if (pending.countLimitHit) throw Error("文件数量超过上限，请移除部分 @文件后再保存")
  const fileOnly = !text && pending.pendingMentions.length > 0 &&
    !message.skillBlock && !message.builtinBrowser
  return { ...message, text: fileOnly ? "请分析以下文件内容。" : text,
    pendingMentions: pending.pendingMentions, fileOnly,
    attachmentDisplayPrefix: [...uploads.map(item => `📎 ${item.filename}`),
      ...pending.pendingMentions.map(item => `📎 ${item.filename}`)].join("\n") }
}
