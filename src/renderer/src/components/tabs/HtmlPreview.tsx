import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import { inlineHtmlSiblingAssets } from "@/lib/html-srcdoc"

import "highlight.js/styles/github.css"

interface HtmlPreviewProps {
  content: string
  path?: string
  fillHeight?: boolean
  showHeader?: boolean
  showModeToggle?: boolean
  viewMode?: "preview" | "source"
  readDependencyFile?: (resolvedPath: string) => Promise<string | null>
}

function getFileName(path: string): string {
  return path.split("/").pop() || path
}

function getFencedCodeBlock(source: string, language: string): string {
  const backtickMatches = source.match(/`+/g)
  const maxBackticks = backtickMatches
    ? backtickMatches.reduce((max, current) => Math.max(max, current.length), 0)
    : 0
  const fence = "`".repeat(Math.max(3, maxBackticks + 1))
  return `${fence}${language}\n${source}\n${fence}`
}

export function HtmlPreview({
  content,
  path,
  fillHeight = false,
  showHeader = true,
  showModeToggle = true,
  viewMode,
  readDependencyFile
}: HtmlPreviewProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeHeight, setIframeHeight] = useState<number>(480)
  const [internalViewMode, setInternalViewMode] = useState<"preview" | "source">("preview")
  const [srcDocContent, setSrcDocContent] = useState(content)
  const currentViewMode = viewMode ?? internalViewMode
  const highlightedSourceMarkdown = useMemo(() => getFencedCodeBlock(content, "html"), [content])

  useEffect(() => {
    let isCancelled = false

    async function buildSrcDoc(): Promise<void> {
      if (!path || !readDependencyFile) {
        setSrcDocContent(content)
        return
      }

      // 先渲染原始内容，再异步替换为“内联同级依赖”后的 srcDoc，避免空白闪烁。
      setSrcDocContent(content)
      const htmlWithInlinedAssets = await inlineHtmlSiblingAssets({
        html: content,
        htmlPath: path,
        readTextFile: readDependencyFile
      })

      if (!isCancelled) {
        setSrcDocContent(htmlWithInlinedAssets)
      }
    }

    buildSrcDoc().catch(() => {
      if (!isCancelled) {
        setSrcDocContent(content)
      }
    })

    return () => {
      isCancelled = true
    }
  }, [content, path, readDependencyFile])

  const syncHeight = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    try {
      const doc = iframe.contentDocument
      if (!doc) return
      const body = doc.body
      const html = doc.documentElement
      const nextHeight = Math.max(
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
        html?.scrollHeight || 0,
        html?.offsetHeight || 0
      )
      if (nextHeight > 0) {
        setIframeHeight(nextHeight)
      }
    } catch {
      // If cross-origin protection blocks access, keep default height.
    }
  }, [])

  return (
    <div
      className={`rounded-sm border border-border bg-background ${fillHeight ? "h-full flex flex-col" : ""}`}
    >
      {showHeader && (
        <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border bg-background-elevated">
          <div className="min-w-0 truncate text-[11px] text-muted-foreground">
            HTML Preview{path ? ` · ${getFileName(path)}` : ""}
          </div>
          {showModeToggle && (
            <div className="inline-flex items-center rounded-md border border-border bg-background text-[11px]">
              <button
                type="button"
                onClick={() => setInternalViewMode("preview")}
                aria-pressed={currentViewMode === "preview"}
                className={`px-2 py-0.5 transition-colors ${
                  currentViewMode === "preview"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                预览
              </button>
              <button
                type="button"
                onClick={() => setInternalViewMode("source")}
                aria-pressed={currentViewMode === "source"}
                className={`border-l border-border px-2 py-0.5 transition-colors ${
                  currentViewMode === "source"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                源码
              </button>
            </div>
          )}
        </div>
      )}
      <div
        className={`w-full overflow-auto ${fillHeight ? "flex-1 min-h-0" : ""}`}
        style={fillHeight ? undefined : { maxHeight: "80vh" }}
      >
        {currentViewMode === "preview" ? (
          <iframe
            ref={iframeRef}
            title={path || "html-preview"}
            srcDoc={srcDocContent}
            className={`border-0 ${fillHeight ? "h-full" : ""}`}
            style={
              fillHeight
                ? { height: "100%", minWidth: "1000px", width: "max(100%, 1000px)" }
                : {
                    height: `max(${iframeHeight}px, 90vh)`,
                    minWidth: "1000px",
                    width: "max(100%, 1000px)"
                  }
            }
            // 预览场景需要脚本和同源能力（例如 localStorage）；同时保留 sandbox 隔离主页面上下文。
            sandbox="allow-scripts allow-same-origin"
            scrolling={fillHeight ? "auto" : "no"}
            onLoad={syncHeight}
          />
        ) : (
          <div className={fillHeight ? "min-h-full" : ""}>
            <div className="prose prose-sm max-w-none dark:prose-invert p-3">
              <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                {highlightedSourceMarkdown}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default HtmlPreview
