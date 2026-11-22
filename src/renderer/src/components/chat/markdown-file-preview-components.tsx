import { isValidElement, useContext, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react"
import type { Components, ExtraProps } from "react-markdown"
import { ArrowUpRight } from "lucide-react"
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
import { parseBotWorkAttachmentHref } from "../../../../shared/bots/work-history"
import type { FileInfo } from "@/types"
import {
  ChatHistorySourceContext,
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
    return index
  })()

  workspaceFilePreviewIndexCache.set(files, { workspacePath, pending })
  try {
    const complete = await pending
    if (workspaceFilePreviewIndexCache.get(files)?.pending === pending)
      workspaceFilePreviewIndexCache.set(files, { workspacePath, index: complete })
    return complete
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
      className="cursor-pointer font-medium transition-opacity hover:opacity-80"
      style={{ color: "var(--primary)", textDecoration: "none" }}
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

function MarkdownInlineCode({
  threadId,
  rawCode,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & { threadId?: string; rawCode: string }): React.JSX.Element {
  const fileWorkspace = useContext(ChatFileWorkspaceContext)
  const metadataThreadId = fileWorkspace?.threadId === threadId ? null : (threadId ?? null)
  const threadWorkspace = useThreadStateSelector(metadataThreadId, state => state.workspacePath)
  const workspacePath = fileWorkspace ? fileWorkspace.workspacePath : threadWorkspace
  threadId = fileWorkspace?.threadId ?? threadId
  const workspaceFiles =
    useThreadStateSelector(
      metadataThreadId,
      (state) => state.workspaceFiles
    ) ?? EMPTY_WORKSPACE_FILES
  const cached = workspaceFilePreviewIndexCache.get(workspaceFiles)
  const [resolved, setResolved] = useState<{
    files: FileInfo[]
    workspacePath: string | null | undefined
    index: Map<string, string>
  } | null>(null)
  const filePreviewIndex = cached?.workspacePath === workspacePath && cached?.index
    ? cached.index
    : resolved?.files === workspaceFiles && resolved.workspacePath === workspacePath
      ? resolved.index
      : EMPTY_FILE_PREVIEW_INDEX

  useEffect(() => {
    if (!threadId || !workspacePath || !workspaceFiles.length) return
    if (workspaceFilePreviewIndexCache.get(workspaceFiles)?.workspacePath === workspacePath &&
      workspaceFilePreviewIndexCache.get(workspaceFiles)?.index) return
    let cancelled = false
    void buildWorkspaceFilePreviewIndex(workspacePath, workspaceFiles)
      .then((index) => {
        if (!cancelled) setResolved({ files: workspaceFiles, workspacePath, index })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [threadId, workspaceFiles, workspacePath])

  const previewPath = threadId ? resolveInlinePreviewPath(rawCode, filePreviewIndex, workspacePath) : null
  return threadId && previewPath
    ? <MarkdownFilePreviewLink href={previewPath} previewPath={previewPath} threadId={threadId}>
        <span {...props}>{children}</span>
      </MarkdownFilePreviewLink>
    : <code className="streaming-markdown-inline-code" {...props}>{children}</code>
}

function MarkdownPreviewAnchor({
  threadId,
  href,
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps & { threadId?: string }): React.JSX.Element {
  const botPresentation = useContext(ChatPresentationContext) === "bot"
  const presentFile = useContext(ChatFilePresentationContext)
  const openHistorySource = useContext(ChatHistorySourceContext)
  const fileWorkspace = useContext(ChatFileWorkspaceContext)
  const messageId = useContext(ChatMessageIdentityContext)
  const metadataThreadId = fileWorkspace?.threadId === threadId ? null : (threadId ?? null)
  const threadWorkspace = useThreadStateSelector(metadataThreadId, state => state.workspacePath)
  const workspacePath = fileWorkspace ? fileWorkspace.workspacePath : threadWorkspace
  const workspaceFiles = useThreadStateSelector(botPresentation ? metadataThreadId : null,
    state => state.workspaceFiles) ?? EMPTY_WORKSPACE_FILES
  const [resolved, setResolved] = useState<{ files: FileInfo[]; workspacePath: string | null | undefined;
    index: Map<string, string> } | null>(null)
  useEffect(() => {
    if (!botPresentation || !workspacePath || !workspaceFiles.length) return
    let current = true
    void buildWorkspaceFilePreviewIndex(workspacePath, workspaceFiles).then(index => {
      if (current) setResolved({ files: workspaceFiles, workspacePath, index })
    }).catch(() => {})
    return () => { current = false }
  }, [botPresentation, workspaceFiles, workspacePath])
  const filePreviewIndex = resolved?.files === workspaceFiles && resolved.workspacePath === workspacePath
    ? resolved.index : EMPTY_FILE_PREVIEW_INDEX
  threadId = fileWorkspace?.threadId ?? threadId
  if (!href) return <span>{children}</span>
  if (href.startsWith("#bot-history/") || href.startsWith("#bot-thread-history/") || href.startsWith("#bot-work/")) {
    return openHistorySource ? (
      <button
        type="button"
        className="bot-history-citation"
        data-history-source={href}
        title={parseBotWorkAttachmentHref(href) ? "预览附件" :
          href.startsWith("#bot-work/") ? "查看原任务" : "打开原会话并定位这条消息"}
        onClick={() => openHistorySource(href)}
      >
        {children}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    ) : (
      <span>{children}</span>
    )
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

}

/** File-index updates rerender only inline links, not the whole parsed Markdown document. */
export function useMarkdownFilePreviewComponents({
  baseComponents,
  threadId,
  renderCodeBlock
}: {
  baseComponents: Components
  threadId?: string
  renderCodeBlock: CodeRenderer
}): Components {
  return useMemo<Components>(
    () => ({
      ...baseComponents,
      a({ node, href, children, ...props }) {
        return <MarkdownPreviewAnchor threadId={threadId} node={node} href={href} {...props}>
          {children}
        </MarkdownPreviewAnchor>
      },
      code({ node: _node, className, children, ...props }) {
        const rawCode = getMarkdownNodeText(children)
        const language = getMarkdownLanguageLabel(className)
        const isBlock = !!language || rawCode.includes("\n")

        if (isBlock) {
          return renderCodeBlock({ rawCode, language, className, children })
        }

        return <MarkdownInlineCode threadId={threadId} rawCode={rawCode} {...props}>
          {children}
        </MarkdownInlineCode>
      }
    }),
    [baseComponents, renderCodeBlock, threadId]
  )
}
