import { isValidElement, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react"
import type { Components } from "react-markdown"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { openResourcePanelOverlay } from "@/lib/resource-panel-overlay-events"
import { isLocalFileLikeHref, normalizePreviewFileHref } from "@/lib/markdown-file-preview-links"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import { useThreadStateSelector } from "@/lib/thread-context"
import type { FileInfo } from "@/types"

type CodeRenderer = (args: {
  rawCode: string
  language: string | null
  className?: string
  children: ReactNode
}) => React.JSX.Element

export function getMarkdownNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(getMarkdownNodeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return getMarkdownNodeText(node.props.children)
  return ""
}

export function getMarkdownLanguageLabel(className?: string): string | null {
  const match = /language-([\w-]+)/.exec(className || "")
  return match?.[1] ?? null
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)
}

function normalizePathForCompare(value: string): string {
  return stripLineSuffix(value).replace(/\\/g, "/").replace(/\/+$/, "")
}

function isWorkspaceFilePath(
  filePath: string,
  workspacePath: string | null | undefined
): boolean {
  if (!workspacePath) return false
  const normalizedFilePath = normalizePathForCompare(filePath)
  const normalizedWorkspacePath = normalizePathForCompare(workspacePath)
  return (
    normalizedFilePath === normalizedWorkspacePath ||
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  )
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
    return isWorkspaceFilePath(candidate, workspacePath) ? candidate : null
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
  const workspacePath = useThreadStateSelector(
    threadId ?? null,
    (state) => state.workspacePath
  )
  const workspaceFiles =
    useThreadStateSelector(
      threadId ?? null,
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
  ...props
}: ComponentPropsWithoutRef<"a"> & { threadId?: string }): React.JSX.Element {
  const workspacePath = useThreadStateSelector(threadId ?? null, state => state.workspacePath)
  if (!href) return <span>{children}</span>
  const previewPath = normalizePreviewFileHref(href, workspacePath)
  if (threadId && previewPath) {
    return <MarkdownFilePreviewLink href={href} previewPath={previewPath} threadId={threadId}>
      {children}
    </MarkdownFilePreviewLink>
  }
  return isLocalFileLikeHref(href)
    ? <span title="文件路径暂不可预览" {...props}>{children}</span>
    : <a href={href} {...props}>{children}</a>
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
      a({ node: _node, href, children, ...props }) {
        return <MarkdownPreviewAnchor threadId={threadId} href={href} {...props}>
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
