import { isValidElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import type { Components } from "react-markdown"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { openResourcePanelOverlay } from "@/lib/resource-panel-overlay-events"
import {
  decodePreviewFileHref,
  isLocalFileLikeHref,
  normalizePreviewFileHref
} from "@/lib/markdown-file-preview-links"
import { resolveResourcePreviewPaths } from "@/lib/resource-preview-paths"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import { useThreadStateSelector } from "@/lib/thread-context"
import type { FileInfo } from "@/types"
import {
  ChatFilePresentationContext,
  ChatFileWorkspaceContext,
  ChatPresentationContext,
  ChatMessageIdentityContext
} from "./chat-presentation-context"

type CodeRenderer = (args: {
  rawCode: string
  language: string | null
  className?: string
  children: ReactNode
}) => React.JSX.Element

export function getMarkdownNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(getMarkdownNodeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node))
    return getMarkdownNodeText(node.props.children)
  return ""
}

export function getMarkdownLanguageLabel(className?: string): string | null {
  const match = /language-([\w-]+)/.exec(className || "")
  return match?.[1] ?? null
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "")
}

function getPathBaseName(filePath: string): string {
  return stripLineSuffix(filePath).split(/[\\/]/).pop() || filePath
}

function joinWorkspacePath(workspacePath: string, filePath: string): string {
  const separator = workspacePath.includes("\\") ? "\\" : "/"
  const normalizedFilePath = filePath.replace(/[\\/]+/g, separator)
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${normalizedFilePath.replace(/^[\\/]+/, "")}`
}

const workspaceFilePreviewIndexCache = new WeakMap<
  FileInfo[],
  {
    workspacePath: string | null | undefined
    index?: Map<string, string>
    pending?: Promise<Map<string, string>>
  }
>()
const EMPTY_FILE_PREVIEW_INDEX = new Map<string, string>()
const EMPTY_WORKSPACE_FILES: FileInfo[] = []
const FILE_PREVIEW_INDEX_BATCH_SIZE = 512
const yieldResolvers: Array<() => void> = []
let cooperativeYieldCount = 0
const yieldChannel =
  typeof MessageChannel === "undefined"
    ? null
    : (() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => yieldResolvers.shift()?.()
        return channel
      })()

function yieldFilePreviewIndexTask(): Promise<void> {
  cooperativeYieldCount += 1
  if (!yieldChannel || cooperativeYieldCount % 8 === 0) {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
  return new Promise((resolve) => {
    yieldResolvers.push(resolve)
    yieldChannel.port2.postMessage(0)
  })
}

async function buildWorkspaceFilePreviewIndex(
  workspacePath: string | null | undefined,
  files: FileInfo[]
): Promise<Map<string, string>> {
  const cached = workspaceFilePreviewIndexCache.get(files)
  if (cached && cached.workspacePath === workspacePath) {
    if (cached.index) return cached.index
    if (cached.pending) return cached.pending
  }

  const index = new Map<string, string>()
  const duplicateKeys = new Set<string>()
  if (!workspacePath) {
    workspaceFilePreviewIndexCache.set(files, { workspacePath, index })
    return index
  }

  const addCandidate = (key: string, fullPath: string): void => {
    if (!key || duplicateKeys.has(key)) return
    if (index.has(key) && index.get(key) !== fullPath) {
      index.delete(key)
      duplicateKeys.add(key)
      return
    }
    index.set(key, fullPath)
  }

  const pending = (async () => {
    for (let offset = 0; offset < files.length; offset += FILE_PREVIEW_INDEX_BATCH_SIZE) {
      const end = Math.min(files.length, offset + FILE_PREVIEW_INDEX_BATCH_SIZE)
      for (let index = offset; index < end; index += 1) {
        const file = files[index]
        if (file.is_dir) continue
        const relativePath = file.path.replace(/^[\\/]+/, "")
        const fullPath = joinWorkspacePath(workspacePath, relativePath)
        addCandidate(relativePath, fullPath)
        addCandidate(`./${relativePath}`, fullPath)
        const name = getPathBaseName(relativePath)
        if (name) addCandidate(name, fullPath)
      }
      if (end < files.length) await yieldFilePreviewIndexTask()
    }
    workspaceFilePreviewIndexCache.set(files, { workspacePath, index })
    return index
  })()

  workspaceFilePreviewIndexCache.set(files, { workspacePath, pending })
  try {
    return await pending
  } catch (error) {
    const latest = workspaceFilePreviewIndexCache.get(files)
    if (latest?.pending === pending) workspaceFilePreviewIndexCache.delete(files)
    throw error
  }
}

function resolveInlinePreviewPath(
  value: string,
  filePreviewIndex: Map<string, string>,
  workspacePath: string | null | undefined
): string | null {
  const candidate = stripLineSuffix(value.trim())
  if (!candidate || candidate.endsWith("/") || candidate.endsWith("\\")) return null
  if (isAbsoluteFilePath(candidate)) {
    const resolved = resolveResourcePreviewPaths(
      candidate,
      workspacePath ?? null,
      undefined,
      "absolute"
    )
    return resolved.inWorkspace ? resolved.fullPath : null
  }
  return filePreviewIndex.get(candidate) ?? null
}

function MarkdownFilePreviewLink({
  href,
  previewPath,
  threadId,
  children
}: {
  href: string
  previewPath: string
  threadId: string
  children: ReactNode
}): React.JSX.Element {
  const link = (
    <a
      href={href}
      className="relative inline-block text-primary hover:text-primary/80 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:origin-bottom after:scale-y-50 after:bg-primary/20 hover:after:bg-primary/30"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.nativeEvent.stopImmediatePropagation()
        try {
          // Let the overlay coordinator choose between the standard right panel
          // and the resource drawer. Updating the collapsed state directly here
          // can unmount the only request listener before it consumes this event.
          openResourcePanelOverlay("preview")
          emitOpenResourcePreview({
            threadId,
            filePath: previewPath,
            workspacePathKind: "absolute"
          })
        } catch (error) {
          console.error("[MarkdownFilePreviewLink] Failed to open file preview:", error)
        }
      }}
    >
      {children}
    </a>
  )

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-80 break-all text-xs">
          完整路径是：{previewPath}，你可以点击查看内容
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function useMarkdownFilePreviewComponents({
  baseComponents,
  threadId: messageThreadId,
  text,
  renderCodeBlock
}: {
  baseComponents: Components
  threadId?: string
  text: string
  renderCodeBlock: CodeRenderer
}): Components {
  const botPresentation = useContext(ChatPresentationContext) === "bot"
  const presentFile = useContext(ChatFilePresentationContext)
  const fileWorkspace = useContext(ChatFileWorkspaceContext)
  const threadId = fileWorkspace?.threadId ?? messageThreadId
  // Retain a live author's existing file index; the group event key is not a Runtime thread.
  const metadataThreadId =
    fileWorkspace?.threadId === messageThreadId ? null : (messageThreadId ?? null)
  const messageId = useContext(ChatMessageIdentityContext)
  const shouldResolveInlineFiles = Boolean(
    threadId && (text.includes("`") || (botPresentation && text.includes("](")))
  )
  const threadWorkspace = useThreadStateSelector(
    metadataThreadId,
    (state) => state.workspacePath
  )
  const workspacePath = fileWorkspace ? fileWorkspace.workspacePath : threadWorkspace
  const workspaceFiles =
    useThreadStateSelector(
      shouldResolveInlineFiles ? metadataThreadId : null,
      (state) => state.workspaceFiles
    ) ?? EMPTY_WORKSPACE_FILES
  const [filePreviewIndex, setFilePreviewIndex] =
    useState<Map<string, string>>(EMPTY_FILE_PREVIEW_INDEX)

  useEffect(() => {
    if (!shouldResolveInlineFiles) {
      setFilePreviewIndex(EMPTY_FILE_PREVIEW_INDEX)
      return
    }

    let cancelled = false
    const cached = workspaceFilePreviewIndexCache.get(workspaceFiles)
    if (cached?.workspacePath === workspacePath && cached.index) {
      setFilePreviewIndex(cached.index)
      return
    }

    setFilePreviewIndex(EMPTY_FILE_PREVIEW_INDEX)
    void buildWorkspaceFilePreviewIndex(workspacePath, workspaceFiles)
      .then((index) => {
        if (!cancelled) setFilePreviewIndex(index)
      })
      .catch(() => {
        if (!cancelled) setFilePreviewIndex(EMPTY_FILE_PREVIEW_INDEX)
      })

    return () => {
      cancelled = true
    }
  }, [shouldResolveInlineFiles, workspaceFiles, workspacePath])

  return useMemo<Components>(
    () => ({
      ...baseComponents,
      a({ node, href, children, ...props }) {
        // [文件](D:\...) 这类 Windows 本地路径会被 react-markdown 默认 URL 安全规则
        // 清空 href。与其渲染成看似可用、点击无反应的 <a href="">，不如退化为普通文本。
        if (!href) {
          return <span>{children}</span>
        }

        const relativeBotFile =
          botPresentation &&
          !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href) &&
          !isLocalFileLikeHref(href)
        const relativeHrefPath = relativeBotFile ? decodePreviewFileHref(href) : null
        // The Host root is a literal path; only the href carries URI escapes.
        const previewPath =
          normalizePreviewFileHref(href, workspacePath) ??
          (fileWorkspace && relativeBotFile && workspacePath
            ? normalizePreviewFileHref(
                joinWorkspacePath(encodeURI(workspacePath), href),
                workspacePath
              )
            : null) ??
          (relativeHrefPath
            ? (filePreviewIndex.get(stripLineSuffix(relativeHrefPath)) ?? null)
            : null)
        if (!threadId || !previewPath) {
          if (isLocalFileLikeHref(href) || relativeBotFile) {
            return (
              <span title="文件路径暂不可预览" {...props}>
                {children}
              </span>
            )
          }
          return (
            <a href={href} {...props}>
              {children}
            </a>
          )
        }

        if (botPresentation && presentFile && node?.properties["data-bot-file-card"] === "true") {
          const card = presentFile({
            filePath: previewPath,
            threadId,
            label: children,
            messageId: messageId ?? undefined
          })
          if (card != null) return <>{card}</>
        }
        return (
          <MarkdownFilePreviewLink
            href={href ?? previewPath}
            previewPath={previewPath}
            threadId={threadId}
          >
            {children}
          </MarkdownFilePreviewLink>
        )
      },
      code({ node: _node, className, children, ...props }) {
        const rawCode = getMarkdownNodeText(children)
        const language = getMarkdownLanguageLabel(className)
        const isBlock = !!language || rawCode.includes("\n")

        if (isBlock) {
          return renderCodeBlock({ rawCode, language, className, children })
        }

        const previewPath = threadId
          ? resolveInlinePreviewPath(rawCode, filePreviewIndex, workspacePath)
          : null
        if (threadId && previewPath) {
          return (
            <MarkdownFilePreviewLink
              href={previewPath}
              previewPath={previewPath}
              threadId={threadId}
            >
              <span {...props}>{children}</span>
            </MarkdownFilePreviewLink>
          )
        }

        return (
          <code className="streaming-markdown-inline-code" {...props}>
            {children}
          </code>
        )
      }
    }),
    [
      baseComponents,
      botPresentation,
      presentFile,
      messageId,
      filePreviewIndex,
      fileWorkspace,
      renderCodeBlock,
      threadId,
      workspacePath
    ]
  )
}
