/**
 * 是“输入时”的逻辑。它负责在用户输入框里识别 @ 文件语法，计算当前光标是不是在 mention 里，给 popover 提供候选文件列表，并处理选择状态、关闭状态这些交互。
 */
import { useCallback, useMemo, useState } from "react"
import type { FileInfo } from "@/types"

export type AtFileSuggestion = {
  id: string
  displayPath: string
  workspaceFilePath: string
  filename: string
  size?: number
}

export type AtFilePopoverMode =
  | { kind: "closed" }
  | {
      kind: "at-file"
      query: string
      startPos: number
      endPos: number
      quoted: boolean
      suggestions: AtFileSuggestion[]
    }

const MAX_SUGGESTIONS = 15
const QUOTED_AT_RE = /(?:^|\s)@"([^"]*)"?$/u
const PLAIN_AT_RE = /(?:^|\s)@([^\s"]*)$/u

export const SUPPORTED_WORKSPACE_MENTION_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".sh",
  ".zsh",
  ".bash",
  ".py",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".csv"
])

function getFileExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  const lastSlash = normalized.lastIndexOf("/")
  const lastDot = normalized.lastIndexOf(".")
  if (lastDot <= lastSlash) return ""
  return normalized.slice(lastDot).toLowerCase()
}

// @文件只接收当前可按文本读取的工作区文件类型；没有扩展名的文件保持兼容，交给发送阶段继续判断。
export function isSupportedWorkspaceMentionFilePath(filePath: string): boolean {
  const ext = getFileExtension(filePath)
  return !ext || SUPPORTED_WORKSPACE_MENTION_EXTS.has(ext)
}

// 把磁盘路径统一成 UI 可展示/可比对的格式，避免 Windows 反斜杠和多余前缀干扰匹配。
function normalizeWorkspaceDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "")
}

// 提取最后一级文件名，用于排序和模糊匹配时优先对齐文件名而不是整条路径。
function basename(displayPath: string): string {
  const parts = displayPath.split("/")
  return parts[parts.length - 1] || displayPath
}

// 先按“文件名优先”再按“整条路径优先”做简单打分，保证候选列表更符合用户直觉。
function scoreSuggestion(displayPath: string, query: string): number {
  const normalizedPath = displayPath.toLowerCase()
  const normalizedName = basename(displayPath).toLowerCase()
  const normalizedQuery = query.toLowerCase()

  if (!normalizedQuery) return displayPath.length
  if (normalizedPath === normalizedQuery) return 0
  if (normalizedName === normalizedQuery) return 1
  if (normalizedName.startsWith(normalizedQuery)) return 2
  if (normalizedPath.startsWith(normalizedQuery)) return 3
  if (normalizedName.includes(normalizedQuery)) return 4
  if (normalizedPath.includes(normalizedQuery)) return 5
  return Number.POSITIVE_INFINITY
}

// 从当前光标位置向前回溯，判断是否正处在 @文件 片段中，
// 并返回用于弹窗展示和替换的 token 边界。
function extractAtFileToken(
  input: string,
  cursorOffset: number
): {
  query: string
  startPos: number
  endPos: number
  quoted: boolean
} | null {
  const beforeCursor = input.slice(0, cursorOffset)
  const afterCursor = input.slice(cursorOffset)

  const quotedMatch = beforeCursor.match(QUOTED_AT_RE)
  if (quotedMatch && quotedMatch.index !== undefined) {
    const suffix = afterCursor.match(/^[^"]*"?/u)?.[0] ?? ""
    const fullToken = quotedMatch[0] + suffix
    const startPos = beforeCursor.length - quotedMatch[0].length + quotedMatch[0].lastIndexOf("@")
    return {
      query: `${quotedMatch[1] ?? ""}${suffix.replace(/"$/, "")}`,
      startPos,
      endPos: startPos + fullToken.length,
      quoted: true
    }
  }

  const plainMatch = beforeCursor.match(PLAIN_AT_RE)
  if (!plainMatch || plainMatch.index === undefined) return null

  const suffix = afterCursor.match(/^[^\s"]*/u)?.[0] ?? ""
  const prefix = plainMatch[1] ?? ""
  const tokenStartInMatch = plainMatch[0].lastIndexOf("@")
  const startPos = beforeCursor.length - plainMatch[0].length + tokenStartInMatch

  return {
    query: `${prefix}${suffix}`,
    startPos,
    endPos: startPos + 1 + prefix.length + suffix.length,
    quoted: false
  }
}

// 统一补上引号规则：包含空格的路径会被包进 @"..."，否则用普通 @path。
export function formatAtFileMention(displayPath: string, forceQuoted = false): string {
  const needsQuotes = forceQuoted || displayPath.includes(" ")
  return needsQuotes ? `@"${displayPath}" ` : `@${displayPath} `
}

// 从整段输入里提取所有 @文件 引用，供发送前转换成附件。
export function extractAtFileMentions(input: string): string[] {
  const quotedRegex = /(?:^|\s)@"([^"]+)"/gu
  const regularRegex = /(?:^|\s)@([^\s"]+)/gu
  const results: string[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = quotedRegex.exec(input)) !== null) {
    const value = (match[1] ?? "").trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      results.push(value)
    }
  }

  while ((match = regularRegex.exec(input)) !== null) {
    const value = (match[1] ?? "").trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      results.push(value)
    }
  }

  return results
}

// 进入发送阶段前，把路径中的多余斜杠和空格规范掉，
// 让后续匹配、去重和展示都使用同一种路径格式。
export function normalizeAtFileMentionPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "")
}

// 用户从候选列表确认某个 @文件 后，输入框里原来的 @token 会被消费掉，
// 已选文件改为通过独立 chip 展示，因此这里统一计算移除 token 后的新文本和光标位置。
export function removeAtFileTokenFromInput(
  input: string,
  range: {
    startPos: number
    endPos: number
  }
): {
  nextInput: string
  nextCursor: number
} {
  const before = input.slice(0, range.startPos)
  const after = input.slice(range.endPos)
  const nextAfter = /\s$/u.test(before) && /^\s/u.test(after) ? after.replace(/^\s+/u, "") : after

  return {
    nextInput: `${before}${nextAfter}`,
    nextCursor: range.startPos
  }
}

export function useAtFileMentions(params: {
  input: string
  cursorOffset: number
  workspaceFiles: FileInfo[]
  disabled?: boolean
}) {
  const { input, cursorOffset, workspaceFiles, disabled = false } = params
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  // 这里专门负责“输入时”的交互态：识别光标所在的 @文件 token，生成候选项并控制弹窗显示。
  const mode = useMemo<AtFilePopoverMode>(() => {
    if (disabled) return { kind: "closed" }

    const token = extractAtFileToken(input, cursorOffset)
    if (!token) return { kind: "closed" }

    const query = normalizeAtFileMentionPath(token.query)
    const modeKey = `${token.startPos}:${token.endPos}:${token.quoted ? "q" : "p"}:${query}`
    if (dismissedKey === modeKey) return { kind: "closed" }

  const suggestions = workspaceFiles
      // 输入阶段先把明显不支持的文件类型过滤掉，避免用户选中后又在发送阶段才发现失效。
      .filter((file) => !file.is_dir && isSupportedWorkspaceMentionFilePath(file.path))
      .map((file) => {
        const displayPath = normalizeWorkspaceDisplayPath(file.path)
        return {
          id: file.path,
          displayPath,
          workspaceFilePath: file.path.startsWith("/") ? file.path : `/${displayPath}`,
          filename: basename(displayPath),
          size: file.size
        } satisfies AtFileSuggestion
      })
      .map((suggestion) => ({
        suggestion,
        score: scoreSuggestion(suggestion.displayPath, query)
      }))
      .filter((entry) => entry.score !== Number.POSITIVE_INFINITY)
      .sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score
        if (left.suggestion.displayPath.length !== right.suggestion.displayPath.length) {
          return left.suggestion.displayPath.length - right.suggestion.displayPath.length
        }
        return left.suggestion.displayPath.localeCompare(right.suggestion.displayPath)
      })
      .slice(0, MAX_SUGGESTIONS)
      .map((entry) => entry.suggestion)

    return {
      kind: "at-file",
      query,
      startPos: token.startPos,
      endPos: token.endPos,
      quoted: token.quoted,
      suggestions
    }
  }, [cursorOffset, disabled, dismissedKey, input, workspaceFiles])

  // mode 变化后重置选中项，避免用户切换到新的 @文件 片段时还停留在旧索引。
  const currentKey = useMemo(() => {
    if (mode.kind !== "at-file") return "closed"
    return `${mode.startPos}:${mode.endPos}:${mode.quoted ? "q" : "p"}:${mode.query}`
  }, [mode])
  const [previousKey, setPreviousKey] = useState(currentKey)
  if (currentKey !== previousKey) {
    setPreviousKey(currentKey)
    if (selectedIdx !== 0) setSelectedIdx(0)
    if (dismissedKey && currentKey !== dismissedKey) {
      setDismissedKey(null)
    }
  }

  const totalItems = mode.kind === "at-file" ? mode.suggestions.length : 0
  const clampedIdx = totalItems === 0 ? 0 : Math.min(selectedIdx, totalItems - 1)

  const moveSelection = useCallback(
    (delta: number) => {
      if (totalItems === 0) return
      setSelectedIdx((prev) => (prev + delta + totalItems) % totalItems)
    },
    [totalItems]
  )

  const dismiss = useCallback(() => {
    if (mode.kind !== "at-file") return
    setDismissedKey(currentKey)
  }, [currentKey, mode.kind])

  return {
    mode,
    selectedIdx: clampedIdx,
    moveSelection,
    setSelectedIdx,
    dismiss
  }
}
