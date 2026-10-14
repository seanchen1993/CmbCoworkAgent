/**
 * 是“@文件专属”的逻辑。它负责把用户已经输入/选中的 @文件 解析成真正的附件，
 * 同时收口这类文件专用的去重、扩展名过滤、数量/字符上限控制和路径转换。
 */
import type { FileAttachment, FileInfo } from "@/types"
import type { WorkspaceFilePreviewReadResult } from "../../../../shared/workspace-file-preview"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import type { ComposerPendingMention } from "../../../../shared/mods/v2/composer-mentions"
import { resolveWorkspaceMentionAbsolutePath, stripHandledAtFileMentions } from
  "../../../../shared/at-file-mention-text"
import {
  isSupportedWorkspaceMentionFilePath,
  extractAtFileMentions,
  normalizeAtFileMentionPath,
  type AtFileSuggestion
} from "./useAtFileMentions"

interface WorkspaceReadFileResult {
  success: boolean
  content?: string
  size?: number
  truncated?: boolean
}

const MENTION_READ_TIMEOUT_MS = 3000
const MENTION_MAX_PREVIEW_PAGES = 64
export { resolveWorkspaceMentionAbsolutePath } from "../../../../shared/at-file-mention-text"

// 输入框里已经选中的 @文件项。相比 suggestion，多带一个绝对路径，
// 方便在“显式添加的 @文件”和“用户直接输入的 @路径”之间统一去重。
export type MentionedWorkspaceFile = AtFileSuggestion & {
  absolutePath: string
  /** Normalized identity of the workspace that produced this chip. */
  workspaceKey: string
  contentChars?: number
}

interface ResolveAtFileAttachmentsParams {
  rawMessage: string
  attachments: readonly FileAttachment[]
  mentionedFiles: readonly MentionedWorkspaceFile[]
  workspacePath?: string | null
  workspaceFiles: readonly FileInfo[]
  maxAttachments: number
  maxTotalChars: number
  readWorkspaceFile: (
    filePath: string,
    maxChars: number
  ) => Promise<WorkspaceReadFileResult>
  cancelWorkspaceFileReads?: () => void
}

interface ResolveAtFileAttachmentsResult {
  cleanedMessage: string
  attachments: FileAttachment[]
  mentionCountLimitHit: boolean
  mentionAttachmentLimitHit: boolean
  warningMessage?: string
}

export type ResolveAtFileSelectionResult =
  | { kind: "duplicate"; filename: string }
  | { kind: "limit" }
  | { kind: "unsupported"; filename: string }
  | { kind: "success"; mentionedFile: MentionedWorkspaceFile }

// 把弹窗候选项提升成输入框里真正选中的 mention 文件实体，
// 这样发送前和渲染 chip 都能复用同一种结构。
export function toMentionedWorkspaceFile(
  file: AtFileSuggestion,
  workspacePath: string
): MentionedWorkspaceFile {
  return {
    ...file,
    absolutePath: resolveWorkspaceMentionAbsolutePath(workspacePath, file.workspaceFilePath),
    workspaceKey: normalizeWorkspacePathKey(workspacePath)
  }
}

/**
 * A selected @file chip is meaningful only inside the workspace that produced it.
 * Check both the bound workspace identity and the derived absolute path so stale
 * state can never read a same-named relative file from a different workspace and
 * then label that content with the old absolute path.
 */
export function isMentionedWorkspaceFileForWorkspace(
  file: MentionedWorkspaceFile,
  workspacePath: string | null | undefined
): boolean {
  if (!workspacePath) return false
  const workspaceKey = normalizeWorkspacePathKey(workspacePath)
  if (!workspaceKey || file.workspaceKey !== workspaceKey) return false
  const expectedAbsolutePath = resolveWorkspaceMentionAbsolutePath(
    workspacePath,
    file.workspaceFilePath
  )
  return (
    normalizeWorkspacePathKey(file.absolutePath) ===
    normalizeWorkspacePathKey(expectedAbsolutePath)
  )
}

export function retainMentionedWorkspaceFilesForWorkspace(
  files: readonly MentionedWorkspaceFile[],
  workspacePath: string | null | undefined
): MentionedWorkspaceFile[] {
  if (!workspacePath) return []
  return files.filter((file) => isMentionedWorkspaceFileForWorkspace(file, workspacePath))
}

/** Collect this real draft's unresolved references without opening any file. */
export function collectPendingAtFileMentions(params: {
  rawMessage: string
  attachments: readonly Pick<FileAttachment, "filePath">[]
  mentionedFiles: readonly MentionedWorkspaceFile[]
  workspacePath?: string | null
  maxAttachments: number
}): { pendingMentions: ComposerPendingMention[]; countLimitHit: boolean; staleWorkspace: boolean } {
  const { workspacePath } = params
  if (!workspacePath) return { pendingMentions: [], countLimitHit: false, staleWorkspace: params.mentionedFiles.length > 0 }
  const pendingMentions: ComposerPendingMention[] = []
  const seen = new Set(params.attachments.map(file => normalizeWorkspacePathKey(file.filePath)))
  let countLimitHit = false, staleWorkspace = false
  const add = (mention: string, relativePath: string, filename: string, source: "typed" | "chip",
    lines?: { offset: number; limit?: number }) => {
    const key = normalizeWorkspacePathKey(resolveWorkspaceMentionAbsolutePath(workspacePath, relativePath))
    if (seen.has(key)) return
    if (params.attachments.length + pendingMentions.length >= params.maxAttachments) {
      countLimitHit = true
      return
    }
    seen.add(key)
    pendingMentions.push({ mention, workspacePath, relativePath, filename, source, ...lines })
  }
  for (const file of params.mentionedFiles) {
    if (!isMentionedWorkspaceFileForWorkspace(file, workspacePath)) { staleWorkspace = true; continue }
    add(file.displayPath, file.workspaceFilePath, file.filename, "chip")
  }
  for (const mention of extractAtFileMentions(params.rawMessage)) {
    const fragment = /#L([1-9]\d*)(?:-([1-9]\d*))?$/u.exec(mention)
    const spelling = fragment ? mention.slice(0, fragment.index) : mention
    const relativePath = normalizeAtFileMentionPath(spelling)
    if (!relativePath || !isSupportedWorkspaceMentionFilePath(relativePath)) continue
    let lines: { offset: number; limit?: number } | undefined
    if (fragment) {
      const offset = Number(fragment[1]), end = fragment[2] ? Number(fragment[2]) : undefined
      if (!Number.isSafeInteger(offset) || (end !== undefined && (!Number.isSafeInteger(end) || end < offset))) continue
      lines = { offset, ...(end === undefined ? {} : { limit: end - offset + 1 }) }
    }
    add(mention, relativePath, relativePath.split("/").pop() || relativePath, "typed", lines)
  }
  return { pendingMentions, countLimitHit, staleWorkspace }
}

// 选择 @文件时的校验也统一放到这里：
// 1. 与已有附件/mention 做绝对路径去重；
// 2. 沿用统一的文件数量上限；
// 3. 成功时返回可直接写入 state 的 MentionedWorkspaceFile。
export function resolveAtFileSelection(params: {
  file: AtFileSuggestion
  workspacePath: string
  attachments: readonly Pick<FileAttachment, "filePath">[]
  mentionedFiles: readonly MentionedWorkspaceFile[]
  maxAttachments: number
}): ResolveAtFileSelectionResult {
  const { file, workspacePath, attachments, mentionedFiles, maxAttachments } = params
  if (!isSupportedWorkspaceMentionFilePath(file.workspaceFilePath)) {
    return { kind: "unsupported", filename: file.filename }
  }

  const mentionedFile = toMentionedWorkspaceFile(file, workspacePath)
  const existingPaths = new Set([
    ...attachments.map((item) => item.filePath),
    ...mentionedFiles.map((item) => item.absolutePath)
  ])

  if (existingPaths.has(mentionedFile.absolutePath)) {
    return { kind: "duplicate", filename: file.filename }
  }
  if (attachments.length + mentionedFiles.length >= maxAttachments) {
    return { kind: "limit" }
  }

  return { kind: "success", mentionedFile }
}

function readWorkspaceFileWithTimeout(
  readWorkspaceFile: (
    filePath: string,
    maxChars: number
  ) => Promise<WorkspaceReadFileResult>,
  filePath: string,
  maxChars: number,
  cancelWorkspaceFileReads?: () => void
): Promise<WorkspaceReadFileResult> {
  // 超时时显式取消底层 worker 请求，不能只丢弃 renderer Promise。
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cancelWorkspaceFileReads?.()
      resolve({ success: false })
    }, MENTION_READ_TIMEOUT_MS)
    void readWorkspaceFile(filePath, maxChars).then(
      (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function readBoundedWorkspaceMentionFile(params: {
  maxChars: number
  readPage: (offset: number) => Promise<WorkspaceFilePreviewReadResult>
}): Promise<WorkspaceReadFileResult> {
  const maxChars = Math.max(0, Math.floor(params.maxChars))
  if (maxChars === 0) return { success: false }
  let offset = 0
  let content = ""
  let size = 0
  let truncated = false
  let finished = false

  for (let page = 0; page < MENTION_MAX_PREVIEW_PAGES; page += 1) {
    const result = await params.readPage(offset)
    if (!result.success) return { success: false }
    size = result.size
    const remaining = maxChars - content.length
    content += result.content.slice(0, remaining)
    if (result.content.length > remaining || content.length >= maxChars) {
      truncated = result.hasMore || result.content.length > remaining
      finished = true
      break
    }
    if (!result.hasMore || result.nextOffset === null) {
      finished = true
      break
    }
    if (result.nextOffset <= offset) return { success: false }
    offset = result.nextOffset
  }

  return { success: true, content, size, truncated: truncated || !finished }
}

// 这里把“用户输入的 @文件”统一折算成最终附件列表：
// 先合并显式添加的 mentionedFiles，再补充 rawMessage 中手打的 @path，
// 然后做去重、扩展名过滤、数量/字符上限控制，最后才真正读文件。
export async function resolveAtFileAttachments(
  params: ResolveAtFileAttachmentsParams
): Promise<ResolveAtFileAttachmentsResult> {
  const {
    rawMessage,
    attachments,
    mentionedFiles,
    workspacePath,
    workspaceFiles,
    maxAttachments,
    maxTotalChars,
    readWorkspaceFile,
    cancelWorkspaceFileReads
  } = params
  const fallbackAttachments = attachments.length > 0 ? [...attachments] : []

  try {
    // 以当前附件列表为基线继续累加 @文件带入的内容，这样显式上传的附件
    // 和 @文件解析出的附件会共用同一套数量/字符预算。
    const mentionPaths = extractAtFileMentions(rawMessage)
    const currentAttachments = attachments.length > 0 ? [...attachments] : []
    const existingAttachmentPaths = new Set(currentAttachments.map((item) => item.filePath))
    let currentAttachmentChars = currentAttachments.reduce(
      (sum, item) => sum + item.content.length,
      0
    )
    let mentionCountLimitHit = false
    let mentionAttachmentLimitHit = false
    // warningMessage 只做“非致命提醒”，不影响最终发送。
    let warningMessage: string | undefined
    const handledMentionPaths = new Set<string>()
    // 用绝对路径做 key，可以把“手选的 mention”和“手打的 @path”合并成一份最终附件。
    const mentionCandidates = new Map<
      string,
      {
        mentionFile: MentionedWorkspaceFile
        sourcePaths: Set<string>
      }
    >()

    const addMentionCandidate = (
      mentionFile: MentionedWorkspaceFile,
      sourcePath?: string
    ): void => {
      const existing = mentionCandidates.get(mentionFile.absolutePath)
      if (existing) {
        // 同一个文件如果同时来自 popover 选择和 rawMessage 解析，只记录一份，来源继续累加。
        if (sourcePath) existing.sourcePaths.add(sourcePath)
        return
      }
      mentionCandidates.set(mentionFile.absolutePath, {
        mentionFile,
        sourcePaths: sourcePath ? new Set([sourcePath]) : new Set<string>()
      })
    }

    // 先纳入输入框里已经通过 popover 选中过的 @文件，保证它们优先参与去重和带入。
    for (const mentionFile of mentionedFiles) {
      if (!isMentionedWorkspaceFileForWorkspace(mentionFile, workspacePath)) {
        warningMessage = "@文件所属工作区已变更，旧工作区引用未被发送。"
        continue
      }
      addMentionCandidate(mentionFile)
    }

    // 再解析用户仍保留在 rawMessage 里的 @路径，把“手选”和“手打”两种来源合并。
    if (mentionPaths.length > 0 && workspacePath) {
      for (const mentionPath of mentionPaths) {
        const normalizedMention = normalizeAtFileMentionPath(mentionPath)
        if (!normalizedMention) continue

        // 这里只在当前 workspace 文件清单中做精确匹配，避免把普通 @文本误识别成附件。
        const workspaceFile = workspaceFiles.find(
          (file) => !file.is_dir && normalizeAtFileMentionPath(file.path) === normalizedMention
        )
        if (!workspaceFile) continue
        // 输入阶段已经做过一次过滤，这里再做一层防御，确保发送阶段也不会把不支持的文件带进去。
        if (!isSupportedWorkspaceMentionFilePath(workspaceFile.path)) continue

        addMentionCandidate(
          toMentionedWorkspaceFile(
            {
              id: workspaceFile.path,
              displayPath: normalizeAtFileMentionPath(workspaceFile.path),
              workspaceFilePath: workspaceFile.path.startsWith("/")
                ? workspaceFile.path
                : `/${normalizeAtFileMentionPath(workspaceFile.path)}`,
              filename: workspaceFile.path.split("/").pop() || workspaceFile.path,
              size: workspaceFile.size
            },
            workspacePath
          ),
          normalizedMention
        )
      }
    }

    if (mentionCandidates.size > 0) {
      for (const { mentionFile, sourcePaths } of mentionCandidates.values()) {
        // 数量上限命中后直接停止，和普通附件的 UX 保持一致。
        if (currentAttachments.length >= maxAttachments) {
          mentionCountLimitHit = true
          break
        }

        // 已经作为显式附件或前序 mention 带入的文件不再重复追加。
        if (existingAttachmentPaths.has(mentionFile.absolutePath)) {
          // 这个路径已经在附件列表里了，说明对应的 mention 文本可以安全消费掉。
          sourcePaths.forEach((path) => handledMentionPaths.add(path))
          continue
        }

        const remaining = maxTotalChars - currentAttachmentChars
        if (remaining <= 0) {
          mentionAttachmentLimitHit = true
          break
        }

        // 真正读取文件内容时才触发异步 IO，前面先把过滤/去重做完，尽量减少无效读取。
        let readResult: WorkspaceReadFileResult
        try {
          readResult = await readWorkspaceFileWithTimeout(
            readWorkspaceFile,
            mentionFile.workspaceFilePath,
            remaining,
            cancelWorkspaceFileReads
          )
        } catch {
          // 任何异常都只降级成提示，不让 @文件 阻塞正常发送。
          warningMessage = "@文件部分处理失败，已按普通消息继续发送。"
          continue
        }
        if (!readResult.success || typeof readResult.content !== "string") {
          // 失败文件不带入附件，但也不影响其它消息/附件继续发送。
          warningMessage = "@文件部分处理失败，已按普通消息继续发送。"
          continue
        }
        if (!readResult.content.trim()) continue

        // 超过剩余额度时只截断内容，不丢掉这个附件，尽量保留用户意图。
        const truncated = Boolean(readResult.truncated) || readResult.content.length > remaining
        const content = truncated
          ? `${readResult.content.slice(0, remaining)}\n\n... [内容已截取：显示前 ${remaining.toLocaleString()} 个字符]`
          : readResult.content

        currentAttachments.push({
          filename: mentionFile.filename,
          filePath: mentionFile.absolutePath,
          content,
          mimeType: "text/plain",
          size: readResult.size ?? content.length,
          truncated
        })
        sourcePaths.forEach((path) => handledMentionPaths.add(path))
        existingAttachmentPaths.add(mentionFile.absolutePath)
        currentAttachmentChars += content.length
      }
    }

    return {
      // 返回清洗后的文本给调用方继续构造最终消息，避免 ChatContainer 再重复理解 @语法细节。
      cleanedMessage: stripHandledAtFileMentions(rawMessage, handledMentionPaths),
      attachments: currentAttachments,
      mentionCountLimitHit,
      mentionAttachmentLimitHit,
      warningMessage
    }
  } catch {
    return {
      cleanedMessage: rawMessage,
      attachments: fallbackAttachments,
      mentionCountLimitHit: false,
      mentionAttachmentLimitHit: false,
      warningMessage: "@文件处理失败，已按普通消息继续发送。"
    }
  }
}
