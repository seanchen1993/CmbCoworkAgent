import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"
import { Check, Copy } from "lucide-react"
import { isValidElement, memo, useState, type ReactNode } from "react"

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

export const StreamingMarkdown = memo(function StreamingMarkdown({
  children
}: StreamingMarkdownProps): React.JSX.Element {
  return (
    <div className="streaming-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
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
        }}
      >
        {children}
      </ReactMarkdown>
      {/*{isStreaming && (*/}
      {/*  <span className="inline-block w-2 h-4 ml-0.5 bg-foreground/70 animate-pulse" />*/}
      {/*)}*/}
    </div>
  )
})
