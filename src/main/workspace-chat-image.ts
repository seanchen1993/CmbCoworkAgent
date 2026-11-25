import { basename, isAbsolute } from "node:path"
import { getThreadCore } from "./db"
import { findBotWorkThreadOwner } from "./bots/conversation-link-authority"
import { hasOrdinaryBotConversationShape } from "./bots/ordinary-thread-policy"
import { stageChatImage } from "./chat-images"
import { captureThreadIncarnation, matchesThreadIncarnation } from "./services/thread-incarnation"
import { openStableFileHandle, readStableFileHandleBounded } from "./services/stable-file-handle"
import { resolveWorkspacePreviewCandidate } from "./workspace-file-preview/reader"
import { isChatImagePath, MAX_ATTACHMENT_FILE_BYTES,
  type WorkspaceChatImageRequest } from "../shared/file-attachment"
import { isSameGitWorkspacePath, normalizeGitWorkspacePathKey } from "../shared/workspace-path"

export function captureOrdinaryImageDraft(
  threadId: string, workspacePath: string | null | undefined, assertSender: () => void
) {
  if (typeof threadId !== "string" || !threadId || threadId.length > 256)
    throw new Error("图片所属会话无效")
  function readScope() {
    assertSender()
    const row = getThreadCore(threadId)
    const metadata = row?.metadata && JSON.parse(row.metadata)
    const root = typeof metadata?.workspacePath === "string" ? metadata.workspacePath : null
    if (!row || !metadata || !hasOrdinaryBotConversationShape(metadata) ||
        findBotWorkThreadOwner(threadId) || (workspacePath !== undefined &&
          !(root === workspacePath || isSameGitWorkspacePath(root, workspacePath))))
      throw new Error("@图片所属会话或工作区已变更，请重新选择。")
    return { row, root }
  }
  const { row, root } = readScope()
  const identity = captureThreadIncarnation(row)
  const assertCurrent = () => {
    const current = readScope()
    if (current.root !== root || !matchesThreadIncarnation(current.row, identity)) throw new Error("@图片所属会话已变更")
  }
  return { root, assertCurrent, identity }
}

/** The submitted workspace is a consistency check. Only the stored thread root grants access. */
export async function stageWorkspaceChatImage(request: WorkspaceChatImageRequest, assertSender: () => void) {
  if (!request || typeof request.filePath !== "string" || request.filePath.length > 32_768 ||
      !isChatImagePath(request.filePath) || typeof request.workspacePath !== "string" ||
      !isAbsolute(request.workspacePath)) throw new Error("@图片请求无效")
  const { threadId, workspacePath, filePath } = request
  const { root, assertCurrent } = captureOrdinaryImageDraft(threadId, workspacePath, assertSender)
  if (!root) throw new Error("请先选择工作区")
  const { candidate } = resolveWorkspacePreviewCandidate(filePath, root, "relative")
  const opened = await openStableFileHandle(root, candidate)
  try {
    const bytes = await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)
    assertCurrent()
    const attachment = await stageChatImage(threadId, basename(candidate), Uint8Array.from(bytes).buffer,
      { beforePublish: assertCurrent, draftWorkspace: normalizeGitWorkspacePathKey(root) })
    assertCurrent()
    return attachment
  } finally {
    await opened.handle.close()
  }
}
