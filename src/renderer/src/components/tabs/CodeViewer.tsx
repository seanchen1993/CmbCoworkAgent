import { useEffect, useState, useMemo, useRef } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { VirtualList } from "@/components/ui/virtual-list"
import { shouldSoftWrapCodePreview } from "@/lib/code-preview-layout"
import { requestCodeHighlight } from "./code-highlight-client"

interface CodeViewerProps {
  filePath: string
  content: string
  /** Native source-only navigation. No HTML/Markdown rendering or external dependency reads. */
  target?: { id: string; line: number; column: number }
  onTargetLocated?(located: boolean): void
}

const VIRTUAL_SCROLL_LINE_THRESHOLD = 100
const CODE_LINE_HEIGHT = 22
const CODE_OVERSCAN_LINES = 16
const MAX_HIGHLIGHT_CONTENT_CHARS = 64 * 1024

// Map file extensions to Shiki language identifiers (only languages we've loaded)
const SUPPORTED_LANGS = new Set([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "json",
  "css",
  "html",
  "markdown",
  "yaml",
  "bash",
  "sql"
])

function getLanguage(ext: string | undefined): string | null {
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    json: "json",
    css: "css",
    html: "html",
    htm: "html",
    md: "markdown",
    mdx: "markdown",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql"
  }

  const lang = ext ? langMap[ext] : null
  return lang && SUPPORTED_LANGS.has(lang) ? lang : null
}

export function CodeViewer({ filePath, content, target, onTargetLocated }: CodeViewerProps) {
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null)
  const targetElement = useRef<HTMLElement | null>(null)
  const located = useRef(onTargetLocated)
  useEffect(() => {
    located.current = onTargetLocated
  }, [onTargetLocated])
  const targetId = target?.id,
    targetLine = target?.line,
    targetColumn = target?.column

  // Get file extension for syntax highlighting
  const fileName = filePath.split("/").pop() || filePath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined
  const language = useMemo(() => getLanguage(ext), [ext])
  const lines = useMemo(() => content.split("\n"), [content])
  const shouldSoftWrap = useMemo(() => shouldSoftWrapCodePreview(lines), [lines])
  const shouldVirtualize = lines.length > VIRTUAL_SCROLL_LINE_THRESHOLD
  const lineCount = lines.length
  const highlightKey =
    !target &&
    language !== null &&
    !shouldVirtualize &&
    content.length <= MAX_HIGHLIGHT_CONTENT_CHARS
      ? `${language}\u0000${content}`
      : null
  const highlightedHtml = highlighted?.key === highlightKey ? highlighted.html : null

  // Highlight code with Shiki
  useEffect(() => {
    if (!highlightKey || !language) return
    const request = requestCodeHighlight(content, language)
    void request.promise
      .then((html) => setHighlighted({ key: highlightKey, html }))
      .catch(() => undefined)
    return request.cancel
  }, [content, highlightKey, language])

  useEffect(() => {
    if (!targetId) return
    let second = 0
    const first = requestAnimationFrame(() => {
      const element = targetElement.current
      if (!element) {
        located.current?.(false)
        return
      }
      element.scrollIntoView({ block: "center", inline: "center" })
      element.focus({ preventScroll: true })
      second = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        located.current?.(
          document.visibilityState === "visible" &&
            element.isConnected &&
            rect.height > 0 &&
            rect.width > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth
        )
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [targetId, targetLine, targetColumn, content])

  if (target) {
    const line = lines[target.line - 1]?.replace(/\r$/, "")
    const valid = line !== undefined && target.column >= 1 && target.column <= line.length + 1
    const start = Math.max(0, target.line - 41),
      end = Math.min(lines.length, target.line + 40)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <p className="shrink-0 border-b p-2">
          {filePath} · 源文本片段 {start + 1}–{end} / {lines.length}
        </p>
        <div className="min-h-0 flex-1 overflow-auto" data-native-editor-source>
          <pre className="p-4 font-mono text-sm leading-[22px]">
            {lines.slice(start, end).map((text, index) => {
              const number = start + index + 1
              return (
                <div key={number} data-native-editor-line={number}>
                  <span aria-hidden className="mr-4 inline-block w-12 text-right">
                    {number}
                  </span>
                  {number === target.line && valid ? (
                    <>
                      {line.slice(0, target.column - 1)}
                      <mark
                        ref={targetElement}
                        tabIndex={-1}
                        data-native-editor-column={target.column}
                      >
                        {line.slice(target.column - 1, target.column) || "\u200b"}
                      </mark>
                      {line.slice(target.column)}
                    </>
                  ) : (
                    text.replace(/\r$/, "") || " "
                  )}
                </div>
              )
            })}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 flex-col min-h-0 overflow-hidden">
      {/* File path header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background/50 text-xs text-muted-foreground shrink-0">
        <span className="truncate">{filePath}</span>
        <span className="text-muted-foreground/50">•</span>
        <span>{lineCount} lines</span>
        <span className="text-muted-foreground/50">•</span>
        <span className="text-muted-foreground/70">{language || "plain text"}</span>
      </div>

      {/* File content with syntax highlighting */}
      {shouldVirtualize ? (
        <VirtualList
          className="bg-background font-mono text-sm leading-[22px]"
          itemHeight={CODE_LINE_HEIGHT}
          items={lines}
          maxHeight="100%"
          overscanCount={CODE_OVERSCAN_LINES}
          renderItem={(line, index) => (
            <div className="flex min-w-max hover:bg-background-interactive">
              <span className="sticky left-0 z-10 h-[22px] w-14 shrink-0 select-none border-r border-border/60 bg-background px-2 text-right text-xs leading-[22px] text-muted-foreground/60">
                {index + 1}
              </span>
              <span className="whitespace-pre px-4 leading-[22px] text-foreground">
                {line || " "}
              </span>
            </div>
          )}
        />
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="shiki-wrapper">
            {highlightedHtml ? (
              <div
                className={`shiki-content ${shouldSoftWrap ? "shiki-content-soft-wrap" : ""}`}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            ) : (
              // Fallback plain text rendering
              <pre className="p-4 text-sm font-mono leading-relaxed whitespace-pre-wrap break-all">
                {content}
              </pre>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
