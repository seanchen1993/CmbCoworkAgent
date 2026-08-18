import { useEffect, useState, useMemo, useRef } from "react"
import { Loader2, AlertCircle, FileCode } from "lucide-react"
import { useThreadState } from "@/lib/thread-context"
import { getFileType, isBinaryFile } from "@/lib/file-types"
import { CodeViewer } from "./CodeViewer"
import { ImageViewer } from "./ImageViewer"
import { MediaViewer } from "./MediaViewer"
import { PDFViewer } from "./PDFViewer"
import { BinaryFileViewer } from "./BinaryFileViewer"
import MarkdownPreview from "@/components/ui/MarkdownPreview/MarkdownPreview"

interface FileViewerProps {
  filePath: string
  threadId?: string
  externalFullPath?: string
  reloadToken?: number
  previewMode?: "preview" | "source"
}

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

export function FileViewer({
  filePath,
  threadId,
  externalFullPath,
  reloadToken,
  previewMode
}: FileViewerProps): React.JSX.Element | null {
  const threadState = useThreadState(threadId ?? null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [binaryContent, setBinaryContent] = useState<string | null>(null)
  const [externalTextContent, setExternalTextContent] = useState<string | undefined>()
  const [fileSize, setFileSize] = useState<number | undefined>()
  const cacheKey = externalFullPath || filePath
  const displayPath = externalFullPath || filePath
  const fileContents = threadState?.fileContents ?? {}
  const setThreadFileContents = threadState?.setFileContents
  const content = externalFullPath ? externalTextContent : fileContents[cacheKey]

  // Get file type info
  const fileName = displayPath.split("/").pop() || displayPath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : ""
  const markdownLike = ext === "md" || ext === "markdown" || ext === "mdx"
  const fileTypeInfo = useMemo(() => getFileType(fileName), [fileName])
  const isBinary = useMemo(() => isBinaryFile(fileName), [fileName])
  const lastLoadedReloadTokenRef = useRef<number | undefined>(undefined)

  const readHtmlDependencyFile = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      // HTML 依赖读取统一走 preload 暴露的 API，避免 file:// 直链受限。
      if (externalFullPath) {
        const tokenRes = await window.api.workspace.requestExternalFileRead(resolvedPath)
        if (!tokenRes.success || !tokenRes.token) {
          return null
        }
        const result = await window.api.workspace.readExternalFile(tokenRes.token)
        if (result?.success && typeof result.content === "string") {
          return result.content
        }
        return null
      }

      const result = threadId
        ? await window.api.workspace.readFile(threadId, resolvedPath)
        : null

      if (result?.success && typeof result.content === "string") {
        return result.content
      }

      return null
    },
    [externalFullPath, threadId]
  )

  // Markdown 本地图片读取：相对路径已解析为可读路径，这里返回 base64 内容。
  const readBinaryDependencyFile = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      if (externalFullPath) {
        const tokenRes = await window.api.workspace.requestExternalFileRead(resolvedPath)
        if (!tokenRes.success || !tokenRes.token) {
          return null
        }
        const result = await window.api.workspace.readExternalBinaryFile(tokenRes.token)
        if (result?.success && typeof result.content === "string") {
          return result.content
        }
        return null
      }

      const result = threadId
        ? await window.api.workspace.readBinaryFile(threadId, resolvedPath)
        : null

      if (result?.success && typeof result.content === "string") {
        return result.content
      }

      return null
    },
    [externalFullPath, threadId]
  )

  // Reset state when filePath changes
  useEffect(() => {
    setError(null)
    setBinaryContent(null)
    setExternalTextContent(undefined)
    setFileSize(undefined)
  }, [cacheKey, reloadToken])

  // Load file content (text or binary depending on file type)
  useEffect(() => {
    async function loadFile(): Promise<void> {
      const shouldForceReload =
        reloadToken !== undefined && lastLoadedReloadTokenRef.current !== reloadToken

      // Skip if already loaded
      if (!shouldForceReload && (content !== undefined || binaryContent !== null)) {
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        if (!externalFullPath && !threadId) {
          setError("Missing thread id for workspace file preview")
          return
        }

        if (isBinary) {
          // Read as binary file (base64)
          if (externalFullPath) {
            const tokenRes = await window.api.workspace.requestExternalFileRead(externalFullPath)
            if (!tokenRes.success || !tokenRes.token) {
              setError(tokenRes.error || "Failed to request file read token")
              return
            }
            const result = await window.api.workspace.readExternalBinaryFile(tokenRes.token)
            if (result.success && result.content !== undefined) {
              setBinaryContent(result.content)
              setFileSize(result.size)
              lastLoadedReloadTokenRef.current = reloadToken
            } else {
              setError(result.error || "Failed to read file")
            }
          } else {
            const result = threadId
              ? await window.api.workspace.readBinaryFile(threadId, filePath)
              : { success: false, error: "Missing thread id for workspace file preview" }
            if (result.success && result.content !== undefined) {
              setBinaryContent(result.content)
              setFileSize(result.size)
              lastLoadedReloadTokenRef.current = reloadToken
            } else {
              setError(result.error || "Failed to read file")
            }
          }
        } else {
          // Read as text file
          if (externalFullPath) {
            const tokenRes = await window.api.workspace.requestExternalFileRead(externalFullPath)
            if (!tokenRes.success || !tokenRes.token) {
              setError(tokenRes.error || "Failed to request file read token")
              return
            }
            const result = await window.api.workspace.readExternalFile(tokenRes.token)
            if (result.success && result.content !== undefined) {
              setExternalTextContent(result.content)
              setFileSize(result.size)
              lastLoadedReloadTokenRef.current = reloadToken
            } else {
              setError(result.error || "Failed to read file")
            }
          } else {
            const result = threadId
              ? await window.api.workspace.readFile(threadId, filePath)
              : { success: false, error: "Missing thread id for workspace file preview" }
            if (result.success && result.content !== undefined) {
              setThreadFileContents?.(cacheKey, result.content)
              setFileSize(result.size)
              lastLoadedReloadTokenRef.current = reloadToken
            } else {
              setError(result.error || "Failed to read file")
            }
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to read file")
      } finally {
        setIsLoading(false)
      }
    }

    loadFile()
  }, [
    threadId,
    filePath,
    content,
    binaryContent,
    setThreadFileContents,
    isBinary,
    externalFullPath,
    cacheKey,
    reloadToken
  ])

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
              <div className="text-sm text-muted-foreground leading-6">{friendlyError.description}</div>
              {friendlyError.detail ? (
                <div className="text-xs text-muted-foreground/90 leading-5">{friendlyError.detail}</div>
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

  if (content === undefined && binaryContent === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <FileCode className="size-6 mr-2" />
        <span>No content</span>
      </div>
    )
  }

  // Route to appropriate viewer based on file type
  if (fileTypeInfo.type === "image" && binaryContent) {
    return (
      <ImageViewer
        filePath={displayPath}
        base64Content={binaryContent}
        mimeType={fileTypeInfo.mimeType || "image/png"}
      />
    )
  }

  if (fileTypeInfo.type === "video" && binaryContent) {
    return (
      <MediaViewer
        filePath={displayPath}
        base64Content={binaryContent}
        mimeType={fileTypeInfo.mimeType || "video/mp4"}
        mediaType="video"
      />
    )
  }

  if (fileTypeInfo.type === "audio" && binaryContent) {
    return (
      <MediaViewer
        filePath={displayPath}
        base64Content={binaryContent}
        mimeType={fileTypeInfo.mimeType || "audio/mpeg"}
        mediaType="audio"
      />
    )
  }

  if (fileTypeInfo.type === "pdf" && binaryContent) {
    return <PDFViewer filePath={displayPath} base64Content={binaryContent} />
  }

  if (fileTypeInfo.type === "binary") {
    return <BinaryFileViewer filePath={displayPath} size={fileSize} />
  }

  if (markdownLike && content !== undefined) {
    return (
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
  }

  // Default to code/text viewer
  if (content !== undefined) {
    return <CodeViewer filePath={displayPath} content={content} />
  }

  return null
}
