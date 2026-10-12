import {
  useEffect,
  useMemo,
  useCallback,
  useState,
  useRef,
  useSyncExternalStore,
  type MouseEvent
} from "react"
import { ExternalLink, Link2 } from "lucide-react"
import { botMessagePreviewLink } from "../../lib/bot-link-preview-policy"
import type { BotLinkPreviewCache } from "../../lib/bot-link-preview-cache"
import { normalizeBotPreviewUrl } from "../../../../shared/bot-link-preview"
import { botMessageLinkHref } from "../../../../shared/bot-message-links"

interface BotLinkPreviewCardProps {
  url: string
  href?: string
  active?: boolean
  cache: BotLinkPreviewCache
  openExternal(url: string): Promise<void>
}
export function BotLinkPreviewCard(props: BotLinkPreviewCardProps) {
  const url = normalizeBotPreviewUrl(props.url),
    target = botMessageLinkHref(props.href ?? props.url)
  if (!url || !target || normalizeBotPreviewUrl(target) !== url) return null
  return <PreviewCard key={target} {...props} url={url} href={target} />
}
function PreviewCard({
  url,
  href,
  cache,
  active = true,
  openExternal
}: BotLinkPreviewCardProps & { href: string }) {
  const resource = useMemo(() => cache.resource(url), [cache, url])
  const subscribe = useCallback(
    (listener: () => void) => (active ? resource.subscribe(listener) : () => {}),
    [resource, active]
  )
  const state = useSyncExternalStore(subscribe, resource.get, resource.get)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  const opening = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const data = state.status === "ready" ? state.metadata : null
  const host = data?.hostname ?? new URL(url).hostname
  const image = data?.image
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const attempt = ++opening.current
    setFailed(false)
    void Promise.resolve()
      .then(() => openExternal(href))
      .catch(() => {
        if (mounted.current && opening.current === attempt) setFailed(true)
      })
  }
  return (
    <div className="bot-link-preview-wrap">
      <a
        className="bot-link-preview-card"
        href={href}
        onClick={click}
        aria-label={`在浏览器打开：${data?.title || host}`}
        aria-busy={state.status === "loading" || undefined}
      >
        <span className="bot-link-preview-content">
          <strong className="bot-link-preview-title">{data?.title || host}</strong>
          <span className="bot-link-preview-description">
            {data?.description ||
              (state.status === "loading"
                ? "正在加载链接预览…"
                : state.status === "unavailable" && state.reason === "proxy_unsupported"
                  ? "当前代理暂不支持预览，请在浏览器中打开"
                  : "在浏览器中查看完整内容")}
          </span>
          <span className="bot-link-preview-origin">
            <Link2 size={12} aria-hidden />
            <span>{host}</span>
            <ExternalLink size={12} aria-hidden />
          </span>
        </span>
        {image ? (
          <span className="bot-link-preview-thumbnail" aria-hidden>
            <img
              src={`data:image/jpeg;base64,${image.base64}`}
              alt=""
              width={image.width}
              height={image.height}
              loading="lazy"
              decoding="async"
            />
          </span>
        ) : null}
      </a>
      {failed ? (
        <span className="bot-link-preview-open-error" role="status">
          暂时无法打开链接，请重试。
        </span>
      ) : null}
    </div>
  )
}

/** Persisted transcript decoration; imported instructions, trials and attachments retain their own presentation. */
export function BotMessageLinkPreview({
  message,
  cache,
  active = true,
  openExternal
}: {
  message: import("../../../../shared/bot-types").BotMessage
  cache: BotLinkPreviewCache | null
  active?: boolean
  openExternal(url: string): Promise<void>
}) {
  if (
    !cache ||
    message.importedContext ||
    message.skillTrial ||
    message.attachments.length ||
    (message.sender !== "user" && message.sender !== "bot")
  )
    return null
  const link = botMessagePreviewLink(message.text)
  return link ? (
    <BotLinkPreviewCard {...link} cache={cache} active={active} openExternal={openExternal} />
  ) : null
}
