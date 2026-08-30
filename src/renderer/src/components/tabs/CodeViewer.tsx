import { useEffect, useState, useMemo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { VirtualList } from "@/components/ui/virtual-list"
import { requestCodeHighlight } from "./code-highlight-client"

interface CodeViewerProps {
  filePath: string
  content: string
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

export function CodeViewer({ filePath, content }: CodeViewerProps) {
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null)

  // Get file extension for syntax highlighting
  const fileName = filePath.split("/").pop() || filePath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined
  const language = useMemo(() => getLanguage(ext), [ext])
  const lines = useMemo(() => content.split("\n"), [content])
  const shouldVirtualize = lines.length > VIRTUAL_SCROLL_LINE_THRESHOLD
  const lineCount = lines.length
  const highlightKey =
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
              <div className="shiki-content" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
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
