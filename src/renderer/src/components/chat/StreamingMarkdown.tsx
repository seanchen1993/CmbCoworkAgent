import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown"
import { rehypeChatHighlight } from "../../lib/markdown-highlight"
import type { PluggableList } from "unified"
import remarkWindowsFileLinks from "@/lib/remark-windows-file-links"
import type { ChatSearchLocation } from "../../../../shared/chat-search-types"
import { CHAT_MARKDOWN_REMARK_PLUGINS, markChatMarkdownSearchNavigation } from "../../../../shared/markdown-visible-text"
import { ChatSearchContext } from "./ChatSearchContext"
import { Check, Copy } from "lucide-react"
import {
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode
} from "react"
import { buildStreamingMarkdownRenderPlan } from "../../lib/streaming-markdown-schedule"
import { useStreamingMarkdownText } from "../../lib/use-streaming-markdown-text"
import { stableMarkdownPrefixLength } from "../../lib/stable-markdown-prefix"
import {
  getMarkdownLanguageLabel,
  getMarkdownNodeText,
  useMarkdownFilePreviewComponents
} from "./markdown-file-preview-components"
import { isLocalFileLikeHref } from "@/lib/markdown-file-preview-links"
import { remarkCompletedMarkdownParseCache, remarkStreamingMarkdownParse,
  remarkStableMarkdownPrefixCache } from "@/lib/markdown-parse-cache"
import { remarkBotFileLinks } from "@/lib/bot-file-link-remark"
import { ChatPresentationContext } from "./chat-presentation-context"
import { BotInlineMentionsContext } from "../bots/BotInlineMentionsContext"
import { remarkBotMentions } from "@/lib/bot-mention-remark"
import { rehypeBotTranscript } from "@/lib/bot-transcript-rehype"
import { remarkBotAutolinks } from "@/lib/bot-autolink-remark"

interface StreamingMarkdownProps {
  children: string
  isStreaming?: boolean
  threadId?: string
  searchBlockIndex?: number
  searchLocation?: ChatSearchLocation
  expansion?: { expanded: boolean; onChange(expanded: boolean): void }
  botTranscript?: boolean
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
      <div data-chat-search-ignore className="streaming-markdown-code-header">
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
const REMARK_PLUGINS = [...CHAT_MARKDOWN_REMARK_PLUGINS, remarkWindowsFileLinks, remarkStreamingMarkdownParse]
const COMPLETED_REMARK_PLUGINS = [...CHAT_MARKDOWN_REMARK_PLUGINS, remarkWindowsFileLinks, remarkCompletedMarkdownParseCache]
const STABLE_PREFIX_REMARK_PLUGINS = [...CHAT_MARKDOWN_REMARK_PLUGINS, remarkWindowsFileLinks, remarkStableMarkdownPrefixCache]
const REHYPE_PLUGINS = [rehypeChatHighlight, markChatMarkdownSearchNavigation]
// Streaming skips the expensive syntax-highlighting pass.
const STREAMING_REHYPE_PLUGINS = [markChatMarkdownSearchNavigation]
const BOT_REMARK_PLUGINS = [...REMARK_PLUGINS, remarkBotFileLinks]
const BOT_TRANSCRIPT_REHYPE_PLUGINS = [...REHYPE_PLUGINS, rehypeBotTranscript]
const BOT_STREAM_REHYPE_PLUGINS = [...STREAMING_REHYPE_PLUGINS, rehypeBotTranscript]

// react-markdown's default URL sanitizer treats a Windows drive letter and
// custom local schemes as unsafe protocols (for example, `C:/repo/a.ts` and
// `codex-file:///repo/a.ts`) and clears the href before our link component can
// resolve it. Preserve only path-like hrefs for threaded messages; all other
// URLs continue through the package's protocol allowlist.
function transformStreamingMarkdownUrl(value: string, key: string): string {
  if (key === "href" && isLocalFileLikeHref(value)) return value
  return defaultUrlTransform(value)
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
    const rawCode = getMarkdownNodeText(children)
    const language = getMarkdownLanguageLabel(className)
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

/** Original formatting without chat search, streaming or workspace file-preview hooks. */
export function StaticMarkdownFormatting({ text, components, ...options }: {
  text: string
} & Pick<ComponentProps<typeof ReactMarkdown>,
  "components" | "remarkPlugins" | "rehypePlugins" | "urlTransform">): React.JSX.Element {
  return <div className="streaming-markdown">
    <ReactMarkdown {...options} components={{ ...MARKDOWN_COMPONENTS, ...components }}>
      {text}
    </ReactMarkdown>
  </div>
}

const MarkdownFragment = memo(function MarkdownFragment({
  text,
  isStreaming,
  threadId,
  start = 0,
  stablePrefix = false,
  botTranscript = false
}: {
  text: string
  isStreaming: boolean
  threadId?: string
  botTranscript?: boolean
  start?: number
  stablePrefix?: boolean
}): React.JSX.Element {
  const botPresentation = useContext(ChatPresentationContext) === "bot"
  const inlineMentions = useContext(BotInlineMentionsContext)
  const renderCodeBlock = useMemo(
    () =>
      function RenderMarkdownCode({
        rawCode,
        language,
        className,
        children
      }: {
        rawCode: string
        language: string | null
        className?: string
        children: ReactNode
      }) {
        return (
          <MarkdownCodeBlock
            code={rawCode.replace(/\n$/, "")}
            language={language}
            className={className}
          >
            {children}
          </MarkdownCodeBlock>
        )
      },
    []
  )
  const components = useMarkdownFilePreviewComponents({
    baseComponents: MARKDOWN_COMPONENTS,
    threadId,
    renderCodeBlock
  })
  const mentionComponents = useMemo<Components>(
    () =>
      inlineMentions
        ? {
            ...components,
            span: ({ node, children, ...props }) => {
              const index = Number(node?.properties?.["data-bot-mention"])
              const mention = Number.isInteger(index) ? inlineMentions.mentions[index] : undefined
              if (!mention) return <span {...props}>{children}</span>
              return mention.botId && inlineMentions.canOpen(mention.botId) ? (
                <button
                  type="button"
                  className="bot-inline-mention"
                  onClick={() => inlineMentions.open(mention.botId!)}
                >
                  {inlineMentions.renderLabel?.(mention) ?? children}
                </button>
              ) : (
                <span className="bot-inline-mention">
                  {inlineMentions.renderLabel?.(mention) ?? children}
                </span>
              )
            }
          }
        : components,
    [components, inlineMentions]
  )
  const remarkPlugins = useMemo<PluggableList>(() => {
    const nativePlugins = isStreaming ? (stablePrefix ? STABLE_PREFIX_REMARK_PLUGINS : REMARK_PLUGINS)
      : COMPLETED_REMARK_PLUGINS
    const base = botPresentation && threadId ? BOT_REMARK_PLUGINS : nativePlugins
    const plugins = botTranscript ? [...base, remarkBotAutolinks] : base
    return inlineMentions
      ? [...plugins, [remarkBotMentions, { mentions: inlineMentions.mentions, start }]]
      : plugins
  }, [botPresentation, botTranscript, threadId, inlineMentions, start, isStreaming, stablePrefix])

  return (
    <div
      data-chat-search-text
      data-chat-search-source-start={start}
      data-chat-search-source-end={start + text.length}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={botTranscript ? (isStreaming ? BOT_STREAM_REHYPE_PLUGINS : BOT_TRANSCRIPT_REHYPE_PLUGINS)
          : isStreaming ? STREAMING_REHYPE_PLUGINS : REHYPE_PLUGINS}
        components={mentionComponents}
        urlTransform={threadId ? transformStreamingMarkdownUrl : undefined}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export const StreamingMarkdown = memo(function StreamingMarkdown({
  children,
  isStreaming = false,
  threadId,
  searchBlockIndex = 0,
  searchLocation,
  expansion,
  botTranscript = false
}: StreamingMarkdownProps): React.JSX.Element {
  const text = useStreamingMarkdownText(children, isStreaming)
  const [expandedText, setExpandedText] = useState<string | null>(null)
  const isExpanded = !isStreaming && (expansion?.expanded ?? expandedText === text)
  const changeExpansion = expansion?.onChange
  const setExpanded = useCallback((expanded: boolean) => {
    if (changeExpansion) changeExpansion(expanded)
    else setExpandedText(expanded ? text : null)
  }, [changeExpansion, text])

  // Per-token parent renders reuse this tree until the throttle fires. Extremely
  // long live answers use two bounded fragments: the stable head remains memoized
  // and only the active tail is reparsed. Completion stays bounded until the user
  // explicitly expands the full document, avoiding a large synchronous done spike.
  const rendered = useMemo(
    () => {
      const plan = buildStreamingMarkdownRenderPlan(text, isStreaming, isExpanded)
      // Only this proven leading code block is split. Everything else stays on
      // the existing full-fragment path. Completion parses the entire current
      // suffix (including reference definitions) and restores highlighting; the
      // proven independent code prefix keeps its element identity and selection.
      const prefixLength = botTranscript ? 0 : stableMarkdownPrefixLength(plan.head)
      const head = <>
        <MarkdownFragment key="head" text={prefixLength ? plan.head.slice(0, prefixLength) : plan.head}
          isStreaming={isStreaming} stablePrefix={prefixLength > 0} threadId={threadId} botTranscript={botTranscript} />
        {prefixLength > 0 && <MarkdownFragment key="suffix" text={plan.head.slice(prefixLength)}
          isStreaming={isStreaming} start={prefixLength} threadId={threadId} />}
      </>
      if (plan.renderFullDocument) {
        return (
          <>
            <ChatSearchContext location={searchLocation} />
            {!isStreaming && isExpanded && (
              <button
                data-chat-search-ignore
                type="button"
                className="mb-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/70"
                onClick={() => setExpanded(false)}
              >
                收起长内容
              </button>
            )}
            {head}
          </>
        )
      }

      return (
        <>
          {head}
          <div
            data-chat-search-ignore
            className="my-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            role="status"
          >
            {isStreaming ? "流式内容较长，已临时" : "内容较长，已"}折叠中间{
              plan.omittedCharacters.toLocaleString()
            } 个字符{isStreaming ? "。" : "以保持页面流畅。"}
            {!isStreaming && (
              <button
                type="button"
                data-chat-search-expand-markdown
                aria-expanded={false}
                className="ml-2 underline underline-offset-2 hover:text-foreground"
                onClick={() => setExpanded(true)}
              >
                展开全文
              </button>
            )}
          </div>
          <ChatSearchContext location={searchLocation} />
          <MarkdownFragment key="tail" text={plan.tail} start={text.length - plan.tail.length}
            isStreaming={isStreaming} threadId={threadId} botTranscript={botTranscript} />
        </>
      )
    },
    [text, isStreaming, isExpanded, threadId, searchLocation, setExpanded, botTranscript]
  )

  return (
    <div
      className="streaming-markdown"
      data-chat-search-block-index={searchBlockIndex}
      data-bot-transcript={botTranscript || undefined}
    >
      {rendered}
    </div>
  )
})
