import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"
import { Check, Copy } from "lucide-react"
import {
  isValidElement,
  memo,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react"
import {
  buildStreamingMarkdownRenderPlan,
  getStreamingMarkdownDelayMs
} from "../../lib/streaming-markdown-schedule"

interface StreamingMarkdownProps {
  children: string
  isStreaming?: boolean
}

function getLanguageLabel(className?: string): string | null {
  const match = /language-([\w-]+)/.exec(className || "")
  return match?.[1] ?? null
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(getNodeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return getNodeText(node.props.children)
  return ""
}

function MarkdownCodeBlock({
  code,
  language,
  className,
  children
}: {
  code: string
  language: string | null
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  function handleCopy(): void {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      })
      .catch(() => {
        setCopied(false)
      })
  }

  return (
    <div className="streaming-markdown-code-block">
      <div className="streaming-markdown-code-header">
        <span className="streaming-markdown-code-language">{language || "text"}</span>
        <button
          type="button"
          className="streaming-markdown-code-copy"
          onClick={handleCopy}
          aria-label={copied ? "已复制代码" : "复制代码"}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="streaming-markdown-code-pre">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

// Hoisted to module scope so the prop identities stay stable across renders
// (recreating these every render makes react-markdown redo work and churns GC).
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]
// While streaming we skip syntax highlighting (the expensive rehype pass) and
// reuse a single empty array identity so react-markdown doesn't see a new prop.
const NO_REHYPE_PLUGINS: typeof REHYPE_PLUGINS = []

// During streaming the parent re-renders on every token. Re-parsing the full
// Markdown each time is ~O(n²) over a long answer, so the refresh interval grows
// with the accumulated text. That keeps parse work near a fixed CPU budget while
// preserving the existing 50 ms cadence for short answers. Completion still
// flushes immediately below and restores syntax highlighting.

function useThrottledStreamingText(text: string, isStreaming: boolean): string {
  const [throttled, setThrottled] = useState(text)
  const textRef = useRef(text)
  const flushedRef = useRef(text)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    textRef.current = text

    // Not streaming: the final text is returned directly below, so just drop any
    // pending flush — no state update needed.
    if (!isStreaming) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }
    // Streaming: trailing-edge throttle. If a flush is already scheduled, let it
    // pick up the latest text via textRef when it fires.
    if (timerRef.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (flushedRef.current !== textRef.current) {
        flushedRef.current = textRef.current
        startTransition(() => setThrottled(textRef.current))
      }
    }, getStreamingMarkdownDelayMs(text.length))
  }, [text, isStreaming])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  // While streaming, render the throttled snapshot. Completion exposes the latest
  // full text to the bounded render planner below without another state update.
  return isStreaming ? throttled : text
}

const MARKDOWN_COMPONENTS: Components = {
  // `node` is destructured out so it isn't spread onto the DOM element.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  table({ node: _node, children, ...props }) {
    return (
      <div className="streaming-markdown-table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  },
  pre({ children }) {
    return <>{children}</>
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  code({ node: _node, className, children, ...props }) {
    const rawCode = getNodeText(children)
    const language = getLanguageLabel(className)
    const isBlock = !!language || rawCode.includes("\n")

    if (isBlock) {
      return (
        <MarkdownCodeBlock
          code={rawCode.replace(/\n$/, "")}
          language={language}
          className={className}
        >
          {children}
        </MarkdownCodeBlock>
      )
    }

    return (
      <code className="streaming-markdown-inline-code" {...props}>
        {children}
      </code>
    )
  }
}

const MarkdownFragment = memo(function MarkdownFragment({
  text,
  isStreaming
}: {
  text: string
  isStreaming: boolean
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={isStreaming ? NO_REHYPE_PLUGINS : REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  )
})

export const StreamingMarkdown = memo(function StreamingMarkdown({
  children,
  isStreaming = false
}: StreamingMarkdownProps): React.JSX.Element {
  const text = useThrottledStreamingText(children, isStreaming)
  const [expandedText, setExpandedText] = useState<string | null>(null)
  const isExpanded = !isStreaming && expandedText === text

  // Per-token parent renders reuse this tree until the throttle fires. Extremely
  // long live answers use two bounded fragments: the stable head remains memoized
  // and only the active tail is reparsed. Completion stays bounded until the user
  // explicitly expands the full document, avoiding a large synchronous done spike.
  const rendered = useMemo(
    () => {
      const plan = buildStreamingMarkdownRenderPlan(text, isStreaming, isExpanded)
      if (plan.renderFullDocument) {
        return (
          <>
            {!isStreaming && isExpanded && (
              <button
                type="button"
                className="mb-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/70"
                onClick={() => setExpandedText(null)}
              >
                收起长内容
              </button>
            )}
            <MarkdownFragment text={plan.head} isStreaming={isStreaming} />
          </>
        )
      }

      return (
        <>
          <MarkdownFragment text={plan.head} isStreaming={isStreaming} />
          <div
            className="my-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            role="status"
          >
            {isStreaming ? "流式内容较长，已临时" : "内容较长，已"}折叠中间{
              plan.omittedCharacters.toLocaleString()
            } 个字符{isStreaming ? "。" : "以保持页面流畅。"}
            {!isStreaming && (
              <button
                type="button"
                className="ml-2 underline underline-offset-2 hover:text-foreground"
                onClick={() => setExpandedText(text)}
              >
                展开全文
              </button>
            )}
          </div>
          <MarkdownFragment text={plan.tail} isStreaming={isStreaming} />
        </>
      )
    },
    [text, isStreaming, isExpanded]
  )

  return <div className="streaming-markdown">{rendered}</div>
})
