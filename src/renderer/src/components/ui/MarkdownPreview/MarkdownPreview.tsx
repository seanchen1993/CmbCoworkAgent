import { useState, useCallback, useEffect, useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import rehypeHighlight from "rehype-highlight"
import { Copy, Check, FolderOpen, Eye, Code2, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

// Import highlight.js CSS for code syntax highlighting
import "highlight.js/styles/github.css"

interface MarkdownPreviewProps {
  content: string
  path?: string
  className?: string
  showHeader?: boolean
  showModeToggle?: boolean
  defaultExpanded?: boolean
  whiteBackground?: boolean
  viewMode?: "preview" | "source"
  /**
   * 读取本地图片（相对路径已解析为可读路径），返回 base64 内容。
   * 未提供时本地相对路径图片按原样渲染（一般会裂图）。
   */
  readBinaryFile?: (resolvedPath: string) => Promise<string | null>
}

// Hoisted to module scope so prop identities stay stable across renders.
// Wide tables must scroll horizontally instead of overflowing the preview
// (same treatment as StreamingMarkdown / DashboardAnalysisMarkdown).
const MARKDOWN_COMPONENTS: Components = {
  // `node` is destructured out so it isn't spread onto the DOM element.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  table({ node: _node, children, ...props }) {
    return (
      <div className="streaming-markdown-table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  }
}

// 常见图片扩展名 -> MIME，用于把 base64 拼成 data URL。
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif"
}

function hasProtocol(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//")
}

function stripQueryAndHash(value: string): string {
  const queryIndex = value.indexOf("?")
  const hashIndex = value.indexOf("#")
  let end = value.length
  if (queryIndex >= 0) end = Math.min(end, queryIndex)
  if (hashIndex >= 0) end = Math.min(end, hashIndex)
  return value.slice(0, end)
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 把 markdown 文件里的相对图片路径解析为可读取的路径。
 * - mdPath 为绝对路径时返回绝对路径（外部文件由 main 签发的 grant 约束）；
 * - mdPath 为工作区相对路径时返回工作区相对路径（走 readBinaryFile）。
 * 支持 `./`、`../`、子目录；越界（`..` 超出根）时收敛到根。
 */
function resolveMarkdownImagePath(mdPath: string, src: string): string | null {
  const raw = stripQueryAndHash(src.trim())
  if (!raw || raw.startsWith("#") || raw.startsWith("/")) return null
  if (hasProtocol(raw)) return null

  const normalized = safeDecodeUri(raw).replace(/\\/g, "/")
  if (!normalized) return null

  const mdNormalized = mdPath.replace(/\\/g, "/")
  // 绝对路径（/xxx）需要保留前导 `/`，拼回结果时补上。
  const isAbsolute = mdNormalized.startsWith("/")
  const segments = mdNormalized.split("/")
  segments.pop() // 去掉 md 文件名，剩下的都是目录段
  const baseSegments = segments.filter(Boolean)

  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      baseSegments.pop()
      continue
    }
    baseSegments.push(segment)
  }

  let resolved = baseSegments.join("/")
  if (isAbsolute) resolved = `/${resolved}`
  return resolved || null
}

function MarkdownImage({
  src,
  alt,
  mdPath,
  readBinaryFile,
  ...props
}: {
  src?: string
  alt?: string
  mdPath: string
  readBinaryFile?: (resolvedPath: string) => Promise<string | null>
} & React.ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  const [loadedImage, setLoadedImage] = useState<{ src: string; url: string } | null>(null)
  const directUrl = src && (hasProtocol(src) || src.startsWith("data:")) ? src : undefined

  useEffect(() => {
    let cancelled = false
    if (!src) return

    // 远程/内联图片直接渲染，无需本地读取。
    if (hasProtocol(src) || src.startsWith("data:")) return
    if (!readBinaryFile) return

    const resolved = resolveMarkdownImagePath(mdPath, src)
    if (!resolved) return

    readBinaryFile(resolved)
      .then((base64) => {
        if (cancelled || !base64) return
        if (hasProtocol(base64) || base64.startsWith("data:")) {
          setLoadedImage({ src, url: base64 })
          return
        }
        const ext = resolved.split(".").pop()?.toLowerCase() ?? ""
        const mime = IMAGE_MIME_BY_EXT[ext] ?? "image/png"
        setLoadedImage({ src, url: `data:${mime};base64,${base64}` })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [src, mdPath, readBinaryFile])

  const loadedUrl = loadedImage && loadedImage.src === src ? loadedImage.url : undefined
  return <img src={directUrl ?? loadedUrl ?? src ?? ""} alt={alt ?? ""} {...props} />
}

export function MarkdownPreview({
  content,
  path,
  className,
  showHeader = true,
  showModeToggle = true,
  defaultExpanded = true,
  whiteBackground = false,
  viewMode,
  readBinaryFile
}: MarkdownPreviewProps) {
  const [copySuccess, setCopySuccess] = useState(false)
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [internalViewMode, setInternalViewMode] = useState<"preview" | "source">("preview")
  const currentViewMode = viewMode ?? internalViewMode

  // img 需要访问当前文件的 path 和读取回调，无法用模块级常量组件，按实例组装。
  const markdownComponents = useMemo<Components>(
    () => ({
      ...MARKDOWN_COMPONENTS,
      // `node` is destructured out so it isn't spread onto the DOM element.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      img({ node: _node, src, alt, ...props }) {
        return (
          <MarkdownImage
            src={src}
            alt={alt}
            mdPath={path ?? ""}
            readBinaryFile={readBinaryFile}
            {...props}
          />
        )
      }
    }),
    [path, readBinaryFile]
  )

  const toggleExpanded = useCallback(() => {
    setIsExpanded(!isExpanded)
  }, [isExpanded])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }, [content])

  const handleOpenFolder = useCallback(async () => {
    if (!path) return

    try {
      const normalizedPath = path.replace(/\\/g, "/")
      const folderPath = normalizedPath.split("/").slice(0, -1).join("/") || "."
      const platform = await window.electron.ipcRenderer.invoke("get-platform")

      if (platform === "win32") {
        const windowsPath = folderPath.replace(/\//g, "\\")
        await window.electron.ipcRenderer.invoke("open-folder", windowsPath)
      } else {
        await window.electron.ipcRenderer.invoke("open-folder", folderPath)
      }
    } catch (error) {
      console.error("Failed to open folder:", error)
    }
  }, [path])

  const modeToggle = (
    <div className="inline-flex items-center rounded-md border border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setInternalViewMode("preview")}
        aria-pressed={currentViewMode === "preview"}
        className={cn(
          "px-2 py-1 text-xs transition-colors",
          currentViewMode === "preview"
            ? "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
            : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        )}
      >
        预览
      </button>
      <button
        type="button"
        onClick={() => setInternalViewMode("source")}
        aria-pressed={currentViewMode === "source"}
        className={cn(
          "border-l border-gray-200 dark:border-gray-700 px-2 py-1 text-xs transition-colors",
          currentViewMode === "source"
            ? "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
            : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        )}
      >
        源码
      </button>
    </div>
  )

  return (
    <div className={cn("w-full", className)}>
      {/* 简化的头部 */}
      {showHeader && (
        <div className="flex items-center justify-between gap-2 p-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleExpanded}
              className="p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
              title={isExpanded ? "收起预览" : "展开预览"}
            >
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {currentViewMode === "preview" ? (
              <Eye className="h-4 w-4 text-gray-500" />
            ) : (
              <Code2 className="h-4 w-4 text-gray-500" />
            )}
            <span className="text-sm font-medium">
              Markdown{currentViewMode === "preview" ? "预览" : "源码"}
            </span>
            {path && (
              <span className="text-xs text-gray-500 font-mono">{path.split(/[/\\]/).pop()}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {showModeToggle ? modeToggle : null}
            <button
              onClick={handleCopy}
              className="p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
              title="复制内容"
            >
              {copySuccess ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
            {path && (
              <button
                onClick={handleOpenFolder}
                className="p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                title="打开文件夹"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
      {!showHeader && showModeToggle && (
        <div
          className={cn(
            "flex items-center justify-end p-2 border-b border-gray-200",
            whiteBackground ? "bg-white" : "bg-gray-50 dark:bg-gray-800 dark:border-gray-700"
          )}
        >
          {modeToggle}
        </div>
      )}

      {/* 简化的内容区域 */}
      {isExpanded ? (
        currentViewMode === "preview" ? (
          <div
            className={`p-6 max-w-none ${whiteBackground ? "bg-white prose prose-gray" : "prose prose-gray dark:prose-invert"}`}
          >
            <div className="streaming-markdown text-sm leading-relaxed overflow-auto">
              <ReactMarkdown
                components={markdownComponents}
                rehypePlugins={[rehypeHighlight]}
                remarkPlugins={[remarkGfm, remarkBreaks]}
              >
                {content ?? ""}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <div className={cn("p-4", whiteBackground ? "bg-white" : "bg-gray-50 dark:bg-gray-900")}>
            <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto text-gray-700 dark:text-gray-200">
              {content ?? ""}
            </pre>
          </div>
        )
      ) : (
        <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800">
          <div className="truncate">
            {content.split("\n")[0] ||
              (currentViewMode === "preview" ? "Markdown 内容已收起..." : "Markdown 源码已收起...")}
          </div>
        </div>
      )}
    </div>
  )
}

export default MarkdownPreview
