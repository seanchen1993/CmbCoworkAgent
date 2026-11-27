import { randomUUID } from "node:crypto"
import { basename, isAbsolute } from "node:path"
import type { ParsedDocument } from "./file-parser"
import { documentImageLabel } from "./document-attachment-images"
import type { ChatImageRef, FileAttachment } from "../shared/file-attachment"
import { getThreadCore } from "./db"
import { findBotWorkThreadOwner, verifyWorkConversationThread } from "./bots/conversation-link-authority"
import { hasOrdinaryBotConversationShape } from "./bots/ordinary-thread-policy"
import { discardChatDraftImage, stageChatImage } from "./chat-images"
import { captureThreadIncarnation, matchesThreadIncarnation } from "./services/thread-incarnation"
import { openStableFileHandle, readStableFileHandleBounded } from "./services/stable-file-handle"
import { resolveWorkspacePreviewCandidate } from "./workspace-file-preview/reader"
import { isChatImagePath, isVisualDocumentPath, MAX_ATTACHMENT_FILE_BYTES,
  type WorkspaceChatImageRequest } from "../shared/file-attachment"
import { isSameGitWorkspacePath, normalizeGitWorkspacePathKey } from "../shared/workspace-path"

export function captureOrdinaryImageDraft(
  threadId: string, workspacePath: string | null | undefined, assertSender: () => void
) {
  return captureDesktopImageScope(threadId, workspacePath, assertSender, false)
}

/** A bound local desktop work keeps its ordinary prefix in the same native thread. */
export function captureMessageImageHistory(
  threadId: string, workspacePath: string | null, assertSender: () => void
) {
  return captureDesktopImageScope(threadId, workspacePath, assertSender, true)
}

function captureDesktopImageScope(threadId: string, workspacePath: string | null | undefined,
  assertSender: () => void, history: boolean) {
  if (typeof threadId !== "string" || !threadId || threadId.length > 256)
    throw new Error("图片所属会话无效")
  function readScope() {
    assertSender()
    const row = getThreadCore(threadId)
    const metadata = row?.metadata && JSON.parse(row.metadata)
    const root = typeof metadata?.workspacePath === "string" ? metadata.workspacePath : null
    const work = findBotWorkThreadOwner(threadId)
    if (!row || !metadata || (workspacePath !== undefined &&
        !(root === workspacePath || isSameGitWorkspacePath(root, workspacePath))))
      throw new Error("@图片所属会话或工作区已变更，请重新选择。")
    if (work || !hasOrdinaryBotConversationShape(metadata)) {
      if (!history || !work || work.source || work.audienceKey !== "desktop" ||
          work.threadId !== threadId || work.conversation?.ref.kind !== "local_thread" ||
          work.conversation.ref.threadId !== threadId || work.conversation.state !== "bound" ||
          ["remoteState", "remoteReadOnly", "remoteThread", "remoteImContext", "imDeliveryContext", "targetKind"]
            .some(key => metadata[key] != null))
        throw new Error("@图片所属会话或工作区已变更，请重新选择。")
      verifyWorkConversationThread(work, row, metadata)
    }
    return { row, root, ownerId: work?.id }
  }
  const { row, root, ownerId } = readScope()
  const identity = captureThreadIncarnation(row)
  const assertCurrent = () => {
    const current = readScope()
    if (current.root !== root || current.ownerId !== ownerId || !matchesThreadIncarnation(current.row, identity)) throw new Error("@图片所属会话已变更")
    return current.row
  }
  return { root, assertCurrent, identity }
}

export async function stageOrdinaryDocument(
  threadId: string, parsed: ParsedDocument, scope?: ReturnType<typeof captureOrdinaryImageDraft>
): Promise<FileAttachment> {
  const { documentImages, ...attachment } = parsed
  if (!documentImages?.length) {
    if (attachment.embeddedImageCount) throw new Error("请先选择会话再上传含图文档")
    return attachment
  }
  if (!scope) throw new Error("请先选择会话再上传含图文档")
  const { root, assertCurrent } = scope
  const draftWorkspace = normalizeGitWorkspacePathKey(root ?? "")
  const staged: ChatImageRef[] = []
  try {
    for (const image of documentImages) {
      assertCurrent()
      const result = await stageChatImage(threadId, "embedded" + image.extension, image.bytes,
        { beforePublish: assertCurrent, draftWorkspace })
      if (!result.image) throw new Error("文档内嵌图片解码失败")
      staged.push({ ...result.image, filename: documentImageLabel(attachment.filename, image.index), draftWorkspace })
    }
    assertCurrent()
    return { ...attachment, embeddedImages: staged }
  } catch (error) {
    await Promise.allSettled(staged.map(image => discardChatDraftImage(threadId, root, image.id)))
    throw error
  }
}

/** The submitted workspace is a consistency check. Only the stored thread root grants access. */
export async function stageWorkspaceChatImage(request: WorkspaceChatImageRequest, assertSender: () => void) {
  if (!request || typeof request.filePath !== "string" || request.filePath.length > 32_768 ||
      !(isChatImagePath(request.filePath) || isVisualDocumentPath(request.filePath)) ||
      (request.maxLength !== undefined && (!Number.isSafeInteger(request.maxLength) ||
        request.maxLength < 1 || request.maxLength > 24_000)) || typeof request.workspacePath !== "string" ||
      !isAbsolute(request.workspacePath)) throw new Error("@图片请求无效")
  const { threadId, workspacePath, filePath } = request
  const { root, assertCurrent, identity } = captureOrdinaryImageDraft(threadId, workspacePath, assertSender)
  if (!root) throw new Error("请先选择工作区")
  const { candidate } = resolveWorkspacePreviewCandidate(filePath, root, "relative")
  const opened = await openStableFileHandle(root, candidate)
  try {
    const bytes = await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)
    assertCurrent()
    if (isVisualDocumentPath(candidate)) {
      const { getFileAttachmentParserClient } = await import("./file-attachment-parser/client")
      const parsed = await getFileAttachmentParserClient().parse({
        kind: "bytes", fileName: basename(candidate), bytes: Uint8Array.from(bytes).buffer, allowHtmlSource: true
      }, request.maxLength, "workspace-document:" + randomUUID(), true)
      assertCurrent()
      return stageOrdinaryDocument(threadId, { ...parsed, filePath: candidate }, { root, assertCurrent, identity })
    }
    const attachment = await stageChatImage(threadId, basename(candidate), Uint8Array.from(bytes).buffer,
      { beforePublish: assertCurrent, draftWorkspace: normalizeGitWorkspacePathKey(root) })
    assertCurrent()
    return attachment
  } finally {
    await opened.handle.close()
  }
}
