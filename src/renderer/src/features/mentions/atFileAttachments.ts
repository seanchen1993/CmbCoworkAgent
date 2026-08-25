/**
 * 是“@文件专属”的逻辑。它负责把用户已经输入/选中的 @文件 解析成真正的附件，
 * 同时收口这类文件专用的去重、扩展名过滤、数量/字符上限控制和路径转换。
 */
import type { FileAttachment, FileInfo } from "@/types"
import type { WorkspaceFilePreviewReadResult } from "../../../../shared/workspace-file-preview"
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

// 输入框里已经选中的 @文件项。相比 suggestion，多带一个绝对路径，
// 方便在“显式添加的 @文件”和“用户直接输入的 @路径”之间统一去重。
export type MentionedWorkspaceFile = AtFileSuggestion & {
  absolutePath: string
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

// workspace.readFile 读取的是工作区相对路径，这里统一补成绝对路径，
// 便于在 UI 展示、附件 payload 和去重集合中都使用同一种 key。
export function resolveWorkspaceMentionAbsolutePath(
  workspacePath: string,
  workspaceFilePath: string
): string {
  const workspaceRoot = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  const relativePath = workspaceFilePath.replace(/\\/g, "/").replace(/^\/+/, "")
  return `${workspaceRoot}/${relativePath}`
}

// 把弹窗候选项提升成输入框里真正选中的 mention 文件实体，
// 这样发送前和渲染 chip 都能复用同一种结构。
export function toMentionedWorkspaceFile(
  file: AtFileSuggestion,
  workspacePath: string
): MentionedWorkspaceFile {
  return {
    ...file,
    absolutePath: resolveWorkspaceMentionAbsolutePath(workspacePath, file.workspaceFilePath)
  }
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

// 发送前把 @文件语法替换回普通路径文本：
// 1. 只有真正被转换成附件（或已由现有附件覆盖）的 mention 才会被消费；
// 2. 失败/不支持/未命中的 @文本 会保留原样，避免功能异常时悄悄吞掉用户输入。
function stripHandledAtFileMentions(rawMessage: string, handledMentionPaths: ReadonlySet<string>): string {
  if (handledMentionPaths.size === 0) return rawMessage

  const replaceHandledMention = (match: string, pathValue: string): string => {
    const normalized = normalizeAtFileMentionPath(pathValue)
    if (!normalized || !handledMentionPaths.has(normalized)) {
      return match
    }
    return `${/^\s/u.test(match) ? " " : ""}${normalized}`
  }

  return rawMessage
    .replace(/(?:^|\s)@"([^"]+)"/gu, replaceHandledMention)
    .replace(/(?:^|\s)@([^\s"]+)/gu, replaceHandledMention)
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
          {
            id: workspaceFile.path,
            displayPath: normalizeAtFileMentionPath(workspaceFile.path),
            workspaceFilePath: workspaceFile.path.startsWith("/")
              ? workspaceFile.path
              : `/${normalizeAtFileMentionPath(workspaceFile.path)}`,
            filename: workspaceFile.path.split("/").pop() || workspaceFile.path,
            size: workspaceFile.size,
            absolutePath: resolveWorkspaceMentionAbsolutePath(workspacePath, workspaceFile.path)
          },
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
