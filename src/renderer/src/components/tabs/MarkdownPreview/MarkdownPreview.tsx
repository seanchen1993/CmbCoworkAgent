import { useState, useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import rehypeHighlight from "rehype-highlight"
import { Copy, Check, FolderOpen, Eye, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

// Import highlight.js CSS for code syntax highlighting
import "highlight.js/styles/github.css"

interface MarkdownPreviewProps {
  content: string
  path?: string
  className?: string
  showHeader?: boolean
  defaultExpanded?: boolean
  whiteBackground?: boolean
}

export function MarkdownPreview({
  content,
  path,
  className,
  showHeader = true,
  defaultExpanded = true,
  whiteBackground = false
}: MarkdownPreviewProps) {
  const [copySuccess, setCopySuccess] = useState(false)
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

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
            <Eye className="h-4 w-4 text-gray-500" />
            <span className="text-sm font-medium">Markdown预览</span>
            {path && (
              <span className="text-xs text-gray-500 font-mono">{path.split(/[/\\]/).pop()}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
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

      {/* 简化的内容区域 */}
      {isExpanded ? (
        <div className={`p-6 max-w-none ${whiteBackground ? "bg-white prose prose-gray" : "prose prose-gray dark:prose-invert"}`}>
          <div className="streaming-markdown text-sm leading-relaxed">
            <ReactMarkdown   rehypePlugins={[rehypeHighlight]} remarkPlugins={[remarkGfm, remarkBreaks]}>{content ?? ""}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800">
          <div className="truncate">{content.split("\n")[0] || "Markdown 内容已收起..."}</div>
        </div>
      )}
    </div>
  )
}

export default MarkdownPreview
