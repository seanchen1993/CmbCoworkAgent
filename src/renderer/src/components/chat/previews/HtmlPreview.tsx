import { useCallback, useEffect, useRef, useState } from "react"
import { CodeViewer } from "@/components/tabs/CodeViewer"
import { buildHtmlPreviewDocument, type HtmlPreviewDocument } from "@/lib/html-srcdoc"
import { isHtmlPreviewRuntimeStatus } from "../../../../../shared/html-preview-runtime"

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
  return path.split(/[/\\]/).pop() || path
}

interface BuiltPreview extends HtmlPreviewDocument {
  content: string
  path?: string
  reader?: HtmlPreviewProps["readDependencyFile"]
}

function HtmlPreviewCanvas({
  content,
  path,
  fillHeight = false,
  readDependencyFile
}: HtmlPreviewProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeHeight, setIframeHeight] = useState<number>(480)
  const [preview, setPreview] = useState<BuiltPreview | null>(null)
  const [runtimeIssue, setRuntimeIssue] = useState<string | null>(null)
  // Effects clean up asynchronously. Do not display a previous file in the first new-file render.
  const currentPreview =
    preview?.content === content && preview.path === path && preview.reader === readDependencyFile
      ? preview
      : null

  useEffect(() => {
    let isCancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const runtimeId = crypto.randomUUID()
    const received = new Set<string>()
    const onMessage = (event: MessageEvent): void => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        !isHtmlPreviewRuntimeStatus(event.data, runtimeId) ||
        received.has(event.data.kind)
      )
        return
      received.add(event.data.kind)
      if (event.data.kind === "ready") {
        if (timer) clearTimeout(timer)
      } else if (event.data.kind === "error") {
        setRuntimeIssue("页面脚本运行出错，部分内容可能无法显示。可切换原文检查文件。")
      } else {
        setRuntimeIssue(
          (previous) => previous ?? "页面引用了当前预览无法加载的资源，部分内容可能不完整。"
        )
      }
    }
    window.addEventListener("message", onMessage)

    async function buildSrcDoc(): Promise<void> {
      setPreview(null)
      const safeDocument = await buildHtmlPreviewDocument({
        html: content,
        htmlPath: path,
        runtimeId,
        readTextFile: readDependencyFile
      })

      if (!isCancelled) {
        setRuntimeIssue(null)
        setPreview({ ...safeDocument, content, path, reader: readDependencyFile })
        timer = setTimeout(() => {
          setRuntimeIssue((previous) => previous ?? "页面未能完成加载，可切换原文检查文件。")
        }, 10_000)
      }
    }

    buildSrcDoc().catch(() => {
      if (!isCancelled) {
        setRuntimeIssue("无法生成 HTML 预览，可切换原文检查文件。")
      }
    })

    return () => {
      isCancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener("message", onMessage)
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
    <>
      {runtimeIssue || currentPreview?.issues.length ? (
        <div
          role="status"
          data-testid="html-preview-issue"
          className="shrink-0 border-b border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-muted-foreground break-words"
        >
          {[runtimeIssue, ...(currentPreview?.issues ?? [])].filter(Boolean).join("；")}
        </div>
      ) : null}
      <div
        className={`w-full overflow-auto ${fillHeight ? "flex-1 min-h-0" : ""}`}
        style={fillHeight ? undefined : { maxHeight: "80vh" }}
      >
        {currentPreview === null ? (
          <div
            className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground"
            aria-busy={!runtimeIssue}
          >
            {runtimeIssue ? "可点击右上角“原文”查看文件内容。" : "正在生成 HTML 预览..."}
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            title={path || "html-preview"}
            srcDoc={currentPreview?.srcDoc}
            className={`html-preview-light-canvas border-0 ${fillHeight ? "h-full" : ""}`}
            style={
              fillHeight
                ? { height: "100%", minWidth: "1000px", width: "max(100%, 1000px)" }
                : {
                    height: `max(${iframeHeight}px, 90vh)`,
                    minWidth: "1000px",
                    width: "max(100%, 1000px)"
                  }
            }
            // Opaque origin: scripts can render UI, but cannot read the parent DOM or preload API.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            scrolling={fillHeight ? "auto" : "no"}
            onLoad={syncHeight}
          />
        )}
      </div>
    </>
  )
}

export function HtmlPreview(props: HtmlPreviewProps): React.JSX.Element {
  const { content, path, fillHeight = false, showHeader = true, showModeToggle = true } = props
  const [internalViewMode, setInternalViewMode] = useState<"preview" | "source">("preview")
  const currentViewMode = props.viewMode ?? internalViewMode
  return (
    <div
      className={`rounded-sm border border-border bg-background ${fillHeight ? "h-full min-h-0 flex flex-col" : ""}`}
    >
      {showHeader && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1 border-b border-border bg-background-elevated">
          <div className="min-w-0 truncate text-[11px] text-muted-foreground">
            HTML 预览{path ? ` · ${getFileName(path)}` : ""}
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
                原文
              </button>
            </div>
          )}
        </div>
      )}
      {/* Source mode unmounts the runtime, listeners and timers; preview restarts a fresh sandbox. */}
      {currentViewMode === "preview" ? (
        <HtmlPreviewCanvas {...props} />
      ) : (
        <div className={fillHeight ? "flex flex-1 min-h-0" : "h-[80vh]"}>
          <CodeViewer filePath={path ?? "preview.html"} content={content} />
        </div>
      )}
    </div>
  )
}

export default HtmlPreview
