import { useCallback, useEffect, useRef, useState } from "react"
import { PenLine } from "lucide-react"
import { CodeViewer } from "@/components/tabs/CodeViewer"
import { inlineHtmlSiblingAssets } from "@/lib/html-srcdoc"
import { VisualEditLayer } from "@/components/visual-edit/VisualEditLayer"
import type {
  ClawVisualAnnotation,
  ClawVisualFeedbackContext,
  ClawVisualTargetKind
} from "@/components/visual-edit/visual-edit-types"

interface HtmlPreviewProps {
  content: string
  path?: string
  fillHeight?: boolean
  showHeader?: boolean
  showModeToggle?: boolean
  viewMode?: "preview" | "source"
  readDependencyFile?: (resolvedPath: string) => Promise<string | null>
  visualEdit?: {
    threadId: string
    targetKind?: ClawVisualTargetKind
    targetPath?: string
    targetUrl?: string
    submitDisabled?: boolean
    submitDisabledReason?: string | null
    annotations: ClawVisualAnnotation[]
    onAnnotationsChange: (
      next: ClawVisualAnnotation[] | ((prev: ClawVisualAnnotation[]) => ClawVisualAnnotation[])
    ) => void
    onSubmit: (context: ClawVisualFeedbackContext) => Promise<boolean | void> | boolean | void
  }
}

function getFileName(path: string): string {
  return path.split("/").pop() || path
}

export function HtmlPreview({
  content,
  path,
  fillHeight = false,
  showHeader = true,
  showModeToggle = true,
  viewMode,
  readDependencyFile,
  visualEdit
}: HtmlPreviewProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeHeight, setIframeHeight] = useState<number>(480)
  const [internalViewMode, setInternalViewMode] = useState<"preview" | "source">("preview")
  const [srcDocContent, setSrcDocContent] = useState(content)
  const [visualEditActive, setVisualEditActive] = useState(false)
  const currentViewMode = viewMode ?? internalViewMode
  const canUseVisualEdit = Boolean(visualEdit && currentViewMode === "preview")

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
          <div
            className="relative"
            style={
              fillHeight
                ? { height: "100%", minWidth: "1000px", width: "max(100%, 1000px)" }
                : {
                    height: `max(${iframeHeight}px, 90vh)`,
                    minWidth: "1000px",
                    width: "max(100%, 1000px)"
                  }
            }
          >
            <iframe
              ref={iframeRef}
              title={path || "html-preview"}
              srcDoc={srcDocContent}
              className="h-full w-full border-0"
              // 预览场景需要脚本和同源能力（例如 localStorage）；同时保留 sandbox 隔离主页面上下文。
              sandbox="allow-scripts allow-same-origin"
              scrolling={fillHeight ? "auto" : "no"}
              onLoad={syncHeight}
            />
            {canUseVisualEdit && !visualEditActive && (
              <button
                type="button"
                disabled={visualEdit?.submitDisabled}
                title={
                  visualEdit?.submitDisabled
                    ? visualEdit.submitDisabledReason || undefined
                    : undefined
                }
                className="absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background/95"
                onClick={() => setVisualEditActive(true)}
              >
                <PenLine className="size-3.5" />
                标注修改
              </button>
            )}
            {visualEdit && visualEditActive && (
              <VisualEditLayer
                threadId={visualEdit.threadId}
                targetKind={visualEdit.targetKind ?? "html-preview"}
                targetPath={visualEdit.targetPath ?? path}
                targetUrl={visualEdit.targetUrl}
                iframeRef={iframeRef}
                active={visualEditActive}
                annotations={visualEdit.annotations}
                submitDisabled={visualEdit.submitDisabled}
                onClose={() => setVisualEditActive(false)}
                onAnnotationsChange={visualEdit.onAnnotationsChange}
                onSubmit={visualEdit.onSubmit}
              />
            )}
          </div>
        ) : (
          <div className={fillHeight ? "flex h-full min-h-0" : "h-[80vh]"}>
            <CodeViewer filePath={path ?? "preview.html"} content={content} />
          </div>
        )}
      </div>
    </div>
  )
}

export default HtmlPreview
