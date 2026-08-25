import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { AlertCircle, ChevronLeft, ChevronRight, FileCode, Loader2 } from "lucide-react"
import {
  type WorkspaceFilePreviewMediaResult,
  type WorkspaceFilePreviewSource,
  type WorkspaceFilePreviewTextResult
} from "../../../../shared/workspace-file-preview"
import { getFileType, isBinaryFile } from "@/lib/file-types"
import {
  clearWorkspaceFilePreviewCachePrefix,
  readWorkspaceFilePreviewCache,
  writeWorkspaceFilePreviewCache
} from "@/lib/workspace-file-preview-cache"
import { CodeViewer } from "./CodeViewer"
import { ImageViewer } from "./ImageViewer"
import { MediaViewer } from "./MediaViewer"
import { PDFViewer } from "./PDFViewer"
import { BinaryFileViewer } from "./BinaryFileViewer"
import MarkdownPreview from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { HtmlPreview } from "@/components/chat/previews/HtmlPreview"

interface FileViewerProps {
  filePath: string
  threadId?: string
  externalFullPath?: string
  /** Opaque capability issued by a trusted main-process source. */
  externalPreviewGrant?: string
  htmlFillHeight?: boolean
  reloadToken?: number
  previewMode?: "preview" | "source"
  /** Stable per surface so a persisted file tab cancels the prior task's preview. */
  requestLane?: string
}

const MAX_HTML_DEPENDENCY_REQUESTS = 8
const MAX_HTML_DEPENDENCY_BYTES = 256 * 1024
const MAX_MARKDOWN_IMAGE_REQUESTS = 32
const MAX_MARKDOWN_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024

function formatFileLoadError(rawError: string): {
  title: string
  description: string
  detail?: string
  missingPath?: string
} {
  const trimmed = rawError.trim()
  const missingPathMatch = trimmed.match(/'([^']+)'/)
  if (trimmed.includes("ENOENT") || /no such file or directory/i.test(trimmed)) {
    return {
      title: "文件不存在或已被移动",
      description: "预览文件失败，当前路径下未找到该文件。",
      detail: "请确认文件仍在原位置，或重新生成后再预览。",
      missingPath: missingPathMatch?.[1]
    }
  }
  if (/access denied|permission denied|eacces|eperm/i.test(trimmed)) {
    return {
      title: "没有文件访问权限",
      description: "当前进程无权限读取该文件。",
      detail: "请检查文件权限或将文件移动到可访问目录后重试。"
    }
  }
  return {
    title: "文件加载失败",
    description: "预览时发生异常，请稍后重试。",
    detail: trimmed
  }
}

function createRequestToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function shortPathHash(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function FileViewer({
  filePath,
  threadId,
  externalFullPath,
  externalPreviewGrant,
  htmlFillHeight = true,
  reloadToken,
  previewMode,
  requestLane
}: FileViewerProps): React.JSX.Element | null {
  const generatedLane = useId().replace(/[^a-zA-Z\d_-]/g, "")
  const lane = requestLane ?? `file-viewer-${generatedLane}`
  const displayPath = externalFullPath || filePath
  const sourceCachePrefix = externalFullPath
    ? `external:${externalFullPath}\u0000`
    : `workspace:${threadId ?? ""}:${filePath}\u0000`

  const fileName = displayPath.split(/[/\\]/).pop() || displayPath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : ""
  const markdownLike = ext === "md" || ext === "markdown" || ext === "mdx"
  const htmlLike = ext === "html" || ext === "htm"
  const fileTypeInfo = useMemo(() => getFileType(fileName), [fileName])
  const isBinary = useMemo(() => isBinaryFile(fileName), [fileName])

  const [textPage, setTextPage] = useState<WorkspaceFilePreviewTextResult | null>(null)
  const [media, setMedia] = useState<WorkspaceFilePreviewMediaResult | null>(null)
  const [pageOffsets, setPageOffsets] = useState([0])
  const [pageIndex, setPageIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const requestTokenRef = useRef("")
  const dependencyBudgetRef = useRef({
    htmlRequests: 0,
    htmlBytes: 0,
    imageRequests: 0,
    imageBytes: 0
  })

  const previewSourceForPath = useCallback(
    async (resolvedPath: string): Promise<WorkspaceFilePreviewSource> => {
      if (externalFullPath) {
        if (!externalPreviewGrant) {
          throw new Error("Access denied: external file preview has no trusted source grant")
        }
        return { externalGrant: externalPreviewGrant, filePath: resolvedPath }
      }
      return { threadId: threadId ?? "", filePath: resolvedPath }
    },
    [externalFullPath, externalPreviewGrant, threadId]
  )

  const loadTextPage = useCallback(
    async (
      offset: number,
      generation: number,
      requestToken: string,
      allowCache: boolean
    ): Promise<WorkspaceFilePreviewTextResult | null> => {
      const cacheKey = `${sourceCachePrefix}${offset}`
      const cached = allowCache ? readWorkspaceFilePreviewCache(cacheKey) : undefined
      if (cached) {
        if (generation === generationRef.current) {
          setTextPage(cached)
          setIsLoading(false)
        }
        return cached
      }

      const previewSource = await previewSourceForPath(displayPath)
      if (generation !== generationRef.current) return null
      const result = await window.api.workspace.readFilePreview({
        source: previewSource,
        offset,
        lane,
        requestToken
      })
      if (generation !== generationRef.current) return null
      if (!result.success) {
        if (!result.cancelled) setError(result.error || "Failed to read file")
        return null
      }
      writeWorkspaceFilePreviewCache(cacheKey, result)
      setTextPage(result)
      return result
    },
    [displayPath, lane, previewSourceForPath, sourceCachePrefix]
  )

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const requestToken = createRequestToken()
    requestTokenRef.current = requestToken
    dependencyBudgetRef.current = {
      htmlRequests: 0,
      htmlBytes: 0,
      imageRequests: 0,
      imageBytes: 0
    }
    let releasedMediaUrl: string | null = null

    setError(null)
    setTextPage(null)
    setMedia(null)
    setPageOffsets([0])
    setPageIndex(0)
    setIsLoading(true)
    if (reloadToken !== undefined) clearWorkspaceFilePreviewCachePrefix(sourceCachePrefix)

    void (async () => {
      try {
        if (!externalFullPath && !threadId) {
          setError("Missing thread id for workspace file preview")
          return
        }
        if (isBinary) {
          const previewSource = await previewSourceForPath(displayPath)
          if (generation !== generationRef.current) return
          const result = await window.api.workspace.openMediaPreview({
            source: previewSource,
            lane,
            requestToken,
            mimeType: fileTypeInfo.mimeType
          })
          if (generation !== generationRef.current) {
            if (result.success && result.previewUrl) {
              void window.api.workspace.releaseFilePreview({ previewUrl: result.previewUrl })
            }
            return
          }
          if (!result.success) {
            if (!result.cancelled) setError(result.error || "Failed to read file")
            return
          }
          releasedMediaUrl = result.previewUrl
          setMedia(result)
        } else {
          await loadTextPage(0, generation, requestToken, reloadToken === undefined)
        }
      } catch (caught) {
        if (generation === generationRef.current) {
          setError(caught instanceof Error ? caught.message : "Failed to read file")
        }
      } finally {
        if (generation === generationRef.current) setIsLoading(false)
      }
    })()

    return () => {
      if (generationRef.current === generation) generationRef.current += 1
      void window.api.workspace.cancelFilePreview({ lanePrefix: lane, requestToken })
      if (releasedMediaUrl) {
        void window.api.workspace.releaseFilePreview({ previewUrl: releasedMediaUrl })
      }
    }
  }, [
    externalFullPath,
    externalPreviewGrant,
    fileTypeInfo.mimeType,
    isBinary,
    lane,
    loadTextPage,
    displayPath,
    previewSourceForPath,
    reloadToken,
    sourceCachePrefix,
    threadId
  ])

  const navigateToOffset = useCallback(
    async (offset: number, nextIndex: number, nextOffsets: number[]): Promise<void> => {
      const generation = generationRef.current
      const requestToken = requestTokenRef.current
      dependencyBudgetRef.current = {
        htmlRequests: 0,
        htmlBytes: 0,
        imageRequests: 0,
        imageBytes: 0
      }
      void window.api.workspace.cancelFilePreview({
        lanePrefix: `${lane}:html`,
        requestToken
      })
      void window.api.workspace.cancelFilePreview({
        lanePrefix: `${lane}:image`,
        requestToken
      })
      setIsLoading(true)
      setError(null)
      try {
        const result = await loadTextPage(offset, generation, requestToken, true)
        if (!result || generation !== generationRef.current) return
        setPageOffsets(nextOffsets)
        setPageIndex(nextIndex)
      } finally {
        if (generation === generationRef.current) setIsLoading(false)
      }
    },
    [lane, loadTextPage]
  )

  const showNextPage = useCallback((): void => {
    if (!textPage?.hasMore || textPage.nextOffset === null) return
    const nextIndex = pageIndex + 1
    const nextOffsets = pageOffsets.slice(0, nextIndex)
    nextOffsets[nextIndex] = textPage.nextOffset
    void navigateToOffset(textPage.nextOffset, nextIndex, nextOffsets)
  }, [navigateToOffset, pageIndex, pageOffsets, textPage])

  const showPreviousPage = useCallback((): void => {
    if (pageIndex <= 0) return
    const nextIndex = pageIndex - 1
    void navigateToOffset(pageOffsets[nextIndex], nextIndex, pageOffsets)
  }, [navigateToOffset, pageIndex, pageOffsets])

  const readHtmlDependencyFile = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      const generation = generationRef.current
      const budget = dependencyBudgetRef.current
      if (budget.htmlRequests >= MAX_HTML_DEPENDENCY_REQUESTS) return null
      budget.htmlRequests += 1
      const previewSource = await previewSourceForPath(resolvedPath)
      if (generation !== generationRef.current) return null
      const result = await window.api.workspace.readFilePreview({
        source: previewSource,
        offset: 0,
        lane: `${lane}:html:${shortPathHash(resolvedPath)}`,
        requestToken: requestTokenRef.current
      })
      if (generation !== generationRef.current || !result.success) return null
      if (budget.htmlBytes + result.contentBytes > MAX_HTML_DEPENDENCY_BYTES) return null
      budget.htmlBytes += result.contentBytes
      return result.content
    },
    [lane, previewSourceForPath]
  )

  // Markdown images receive a short-lived protocol URL, never a base64 IPC payload.
  const readBinaryDependencyFile = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      const generation = generationRef.current
      const budget = dependencyBudgetRef.current
      if (budget.imageRequests >= MAX_MARKDOWN_IMAGE_REQUESTS) return null
      budget.imageRequests += 1
      const previewSource = await previewSourceForPath(resolvedPath)
      if (generation !== generationRef.current) return null
      const result = await window.api.workspace.openMediaPreview({
        source: previewSource,
        lane: `${lane}:image:${shortPathHash(resolvedPath)}`,
        requestToken: requestTokenRef.current
      })
      if (generation !== generationRef.current) {
        if (result.success && result.previewUrl) {
          void window.api.workspace.releaseFilePreview({ previewUrl: result.previewUrl })
        }
        return null
      }
      if (!result.success) return null
      if (!result.inlineAllowed && result.previewUrl) {
        void window.api.workspace.releaseFilePreview({ previewUrl: result.previewUrl })
        return null
      }
      if (budget.imageBytes + result.size > MAX_MARKDOWN_IMAGE_SOURCE_BYTES) {
        if (result.previewUrl) {
          void window.api.workspace.releaseFilePreview({ previewUrl: result.previewUrl })
        }
        return null
      }
      budget.imageBytes += result.size
      return result.previewUrl
    },
    [lane, previewSourceForPath]
  )

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin mr-2" />
        <span>Loading file...</span>
      </div>
    )
  }

  if (error) {
    const friendlyError = formatFileLoadError(error)
    return (
      <div className="flex flex-1 h-full min-h-0 items-center justify-center p-6">
        <div className="w-full max-w-[560px] rounded-2xl border border-border/60 bg-muted/20 px-5 py-4 shadow-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="mt-0.5 rounded-lg bg-status-critical/10 p-2 text-status-critical">
              <AlertCircle className="size-4" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="text-sm font-semibold text-foreground">{friendlyError.title}</div>
              <div className="text-sm text-muted-foreground leading-6">
                {friendlyError.description}
              </div>
              {friendlyError.detail ? (
                <div className="text-xs text-muted-foreground/90 leading-5">
                  {friendlyError.detail}
                </div>
              ) : null}
              {friendlyError.missingPath ? (
                <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs text-muted-foreground break-all text-left">
                  路径：{friendlyError.missingPath}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!textPage && !media) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <FileCode className="size-6 mr-2" />
        <span>No content</span>
      </div>
    )
  }

  if (media) {
    const mediaPreviewUrl = media.previewUrl
    if (!media.inlineAllowed || !mediaPreviewUrl) {
      return (
        <BinaryFileViewer
          filePath={displayPath}
          size={media.size}
          reason={media.inlineBlockedReason}
        />
      )
    }
    if (fileTypeInfo.type === "image") {
      return (
        <ImageViewer
          filePath={displayPath}
          sourceUrl={mediaPreviewUrl}
        />
      )
    }
    if (fileTypeInfo.type === "video" || fileTypeInfo.type === "audio") {
      return (
        <MediaViewer
          filePath={displayPath}
          sourceUrl={mediaPreviewUrl}
          mimeType={media.mimeType}
          mediaType={fileTypeInfo.type}
        />
      )
    }
    if (fileTypeInfo.type === "pdf") {
      return <PDFViewer filePath={displayPath} sourceUrl={mediaPreviewUrl} />
    }
    return <BinaryFileViewer filePath={displayPath} size={media.size} />
  }

  const content = textPage?.content ?? ""
  let body: React.JSX.Element
  if (markdownLike) {
    body = (
      <div className="h-full min-h-0 overflow-y-auto right-panel-scroll">
        <MarkdownPreview
          content={content}
          path={displayPath}
          showHeader={false}
          showModeToggle={false}
          viewMode={previewMode}
          whiteBackground
          className="markdown-preview"
          readBinaryFile={readBinaryDependencyFile}
        />
      </div>
    )
  } else if (htmlLike) {
    body = (
      <HtmlPreview
        content={content}
        path={displayPath}
        fillHeight={htmlFillHeight}
        showHeader={false}
        showModeToggle={false}
        viewMode={previewMode}
        readDependencyFile={readHtmlDependencyFile}
      />
    )
  } else {
    body = <CodeViewer filePath={displayPath} content={content} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {textPage?.truncated ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-muted-foreground">
          <span>
            大文件按页预览 · 第 {pageIndex + 1} 页 · 文件 {formatBytes(textPage.size)}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={pageIndex <= 0}
              onClick={showPreviousPage}
              className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-background-interactive disabled:opacity-40"
            >
              <ChevronLeft className="size-3" />
              上一页
            </button>
            <button
              type="button"
              disabled={!textPage.hasMore}
              onClick={showNextPage}
              className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-background-interactive disabled:opacity-40"
            >
              下一页
              <ChevronRight className="size-3" />
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </div>
  )
}
