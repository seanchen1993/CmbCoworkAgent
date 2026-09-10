import { isValidElement, useMemo, type ReactNode } from "react"
import type { Components } from "react-markdown"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import { useAppStore } from "@/lib/store"
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

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "")
}

function getPathBaseName(filePath: string): string {
  return stripLineSuffix(filePath).split(/[\\/]/).pop() || filePath
}

function normalizePreviewFileHref(href?: string): string | null {
  if (!href) return null
  let decoded: string
  try {
    decoded = decodeURI(href)
  } catch {
    return null
  }
  if (decoded.startsWith("codex-file://")) {
    try {
      const url = new URL(decoded)
      return `${url.hostname ? `/${url.hostname}` : ""}${url.pathname}`
    } catch {
      return null
    }
  }
  const withoutLine = stripLineSuffix(decoded)
  return isAbsoluteFilePath(withoutLine) ? withoutLine : null
}

function joinWorkspacePath(workspacePath: string, filePath: string): string {
  const separator = workspacePath.includes("\\") ? "\\" : "/"
  const normalizedFilePath = filePath.replace(/[\\/]+/g, separator)
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${normalizedFilePath.replace(/^[\\/]+/, "")}`
}

const workspaceFilePreviewIndexCache = new WeakMap<
  FileInfo[],
  { workspacePath: string | null | undefined; index: Map<string, string> }
>()

function buildWorkspaceFilePreviewIndex(
  workspacePath: string | null | undefined,
  files: FileInfo[]
): Map<string, string> {
  const cached = workspaceFilePreviewIndexCache.get(files)
  if (cached && cached.workspacePath === workspacePath) return cached.index

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

  for (const file of files) {
    if (file.is_dir) continue
    const relativePath = file.path.replace(/^[\\/]+/, "")
    const fullPath = joinWorkspacePath(workspacePath, relativePath)
    addCandidate(relativePath, fullPath)
    addCandidate(`./${relativePath}`, fullPath)
    const name = getPathBaseName(relativePath)
    if (name) addCandidate(name, fullPath)
  }

  workspaceFilePreviewIndexCache.set(files, { workspacePath, index })
  return index
}

function resolveInlinePreviewPath(
  value: string,
  filePreviewIndex: Map<string, string>
): string | null {
  const candidate = stripLineSuffix(value.trim())
  if (!candidate || candidate.endsWith("/") || candidate.endsWith("\\")) return null
  if (isAbsoluteFilePath(candidate)) return candidate
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
  const setRightModule = useAppStore((state) => state.setRightModule)
  const setRightPanelCollapsed = useAppStore((state) => state.setRightPanelCollapsed)

  const link = (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.nativeEvent.stopImmediatePropagation()
        setRightPanelCollapsed(false)
        setRightModule("preview")
        emitOpenResourcePreview({
          threadId,
          filePath: previewPath,
          workspacePathKind: "absolute"
        })
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
  threadId,
  text,
  renderCodeBlock
}: {
  baseComponents: Components
  threadId?: string
  text: string
  renderCodeBlock: CodeRenderer
}): Components {
  const shouldResolveInlineFiles = Boolean(threadId && text.includes("`"))
  const workspacePath = useThreadStateSelector(
    shouldResolveInlineFiles ? (threadId ?? null) : null,
    (state) => state.workspacePath
  )
  const workspaceFiles =
    useThreadStateSelector(
      shouldResolveInlineFiles ? (threadId ?? null) : null,
      (state) => state.workspaceFiles
    ) ?? []
  const filePreviewIndex = useMemo(
    () =>
      shouldResolveInlineFiles
        ? buildWorkspaceFilePreviewIndex(workspacePath, workspaceFiles)
        : new Map<string, string>(),
    [shouldResolveInlineFiles, workspaceFiles, workspacePath]
  )

  return useMemo<Components>(
    () => ({
      ...baseComponents,
      a({ node: _node, href, children, ...props }) {
        const previewPath = normalizePreviewFileHref(href)
        if (!threadId || !previewPath) {
          return (
            <a href={href} {...props}>
              {children}
            </a>
          )
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

        const previewPath = threadId ? resolveInlinePreviewPath(rawCode, filePreviewIndex) : null
        if (threadId && previewPath) {
          return (
            <MarkdownFilePreviewLink href={previewPath} previewPath={previewPath} threadId={threadId}>
              <span
                className="text-primary underline decoration-primary/45 decoration-[0.1px] underline-offset-2 hover:text-primary/80"
                {...props}
              >
                {children}
              </span>
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
    [baseComponents, filePreviewIndex, renderCodeBlock, threadId]
  )
}
