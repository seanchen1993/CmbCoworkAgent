import { useEffect, useRef, useState } from "react"
import { ImageIcon, Loader2 } from "lucide-react"
import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { BotFilePreview } from "./BotFilePreview"
import {
  botPeerMessageImages,
  botPeerDelivery,
  type BotPeerDelivery,
  type BotPeerMessageImage
} from "../../../../shared/bot-peer-images"

export function BotPeerExchangeHeader({ delivery }: { delivery: BotPeerDelivery }) {
  const parsed = botPeerDelivery.safeParse(delivery)
  if (!parsed.success) return null
  return (
    <p className="mb-2 text-xs text-muted-foreground">
      {parsed.data.direction === "outgoing" ? "发送给" : "收到来自"} {parsed.data.peer.name} ·
      协作记录
    </p>
  )
}

type Loaded = { identity: string; urls: Record<string, string>; failed: string[] }

/** Scoped thumbnails reuse the existing cancellable parser and preview Dialog.
 * Offscreen/hidden galleries release their blobs; image bytes never enter a store. */
export function BotPeerImages({
  images,
  conversationId,
  open,
  label = "协作图片",
  presentation = "gallery",
  currentId,
  select
}: {
  images: BotPeerMessageImage[]
  conversationId: string
  label?: string
  open?: (
    id: string,
    media: BotPeerMessageImage,
    trigger: HTMLButtonElement,
    group: BotPeerMessageImage[]
  ) => void
  presentation?: "gallery" | "filmstrip"
  currentId?: string
  select?: (id: string) => void
}) {
  const safe = botPeerMessageImages.safeParse(images)
  const selected = safe.success ? safe.data : []
  const identity = JSON.stringify([conversationId, selected])
  const container = useRef<HTMLDivElement>(null)
  const previewTrigger = useRef<{ node: HTMLButtonElement; identity: string } | null>(null)
  const [onScreen, setOnScreen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [preview, setPreview] = useState<{ id: string; identity: string } | null>(null)
  const visible = useBotViewVisibility()
  const active = visible && onScreen && selected.length > 0
  const state = loaded?.identity === identity ? loaded : null
  useEffect(() => {
    if (presentation === "filmstrip")
      container.current
        ?.querySelector('[aria-current="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" })
  }, [presentation, currentId])
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active) return
    setLoaded({ identity, urls: {}, failed: [] })
    const abort = new AbortController()
    const urls: Record<string, string> = {}
    const failed: string[] = []
    let requestId: string | undefined
    const load = async () => {
      // Each gallery serializes its parser calls; only visible galleries load.
      for (const image of selected) {
        requestId = crypto.randomUUID()
        try {
          const result = await botApi.filePreview({
            id: image.id,
            conversationId,
            requestId,
            offset: 0
          })
          abort.signal.throwIfAborted()
          if (
            result.kind !== "image" ||
            result.artifact.id !== image.id ||
            result.artifact.conversationId !== conversationId ||
            result.artifact.sha256 !== image.sha256 ||
            result.artifact.name !== image.name ||
            result.artifact.size !== image.size ||
            result.artifact.mime !== image.mime ||
            result.image.base64.length > Math.ceil((1024 * 1024) / 3) * 4 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image.base64)
          )
            throw new Error("协作图片身份或预览内容不一致")
          const bytes = Uint8Array.from(atob(result.image.base64), (character) =>
            character.charCodeAt(0)
          )
          urls[image.id] = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }))
        } catch (error) {
          if (abort.signal.aborted) throw error
          failed.push(image.id)
        } finally {
          requestId = undefined
        }
        if (!abort.signal.aborted) setLoaded({ identity, urls: { ...urls }, failed: [...failed] })
      }
    }
    void load().catch(() => {})
    return () => {
      abort.abort(new Error("协作图片预览已隐藏"))
      if (requestId) void botApi.cancelFilePreview({ conversationId, requestId }).catch(() => {})
      for (const url of Object.values(urls)) URL.revokeObjectURL(url)
    }
    // identity binds the exact immutable descriptors; selected is a fresh parse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, identity, conversationId])
  if (!selected.length) return null
  return (
    <>
      <div
        ref={container}
        aria-label={label}
        data-image-scope={identity}
        className={
          presentation === "filmstrip"
            ? "flex max-w-full gap-2 overflow-x-auto px-4 py-2"
            : `mt-3 grid gap-2 ${selected.length > 1 ? "grid-cols-2" : "grid-cols-1"}`
        }
      >
        {selected.map((image, index) => (
          <button
            key={image.id}
            type="button"
            className={
              presentation === "filmstrip"
                ? "relative flex h-14 w-16 shrink-0 overflow-hidden rounded-md border border-white/20 bg-white/10 outline-none transition-colors hover:border-white/60 focus-visible:ring-2 focus-visible:ring-white aria-[current=true]:border-white aria-[current=true]:ring-1 aria-[current=true]:ring-white motion-reduce:transition-none"
                : "group relative flex min-h-24 overflow-hidden rounded-xl border border-border/60 bg-muted/30 text-left outline-none transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            }
            aria-label={
              presentation === "filmstrip"
                ? `切换图片 ${index + 1}/${selected.length} ${image.alt || image.name}`
                : `查看图片 ${image.alt || image.name}`
            }
            aria-current={
              presentation === "filmstrip" && currentId === image.id ? "true" : undefined
            }
            onClick={(event) => {
              if (presentation === "filmstrip") select?.(image.id)
              else if (open) open(image.id, image, event.currentTarget, selected)
              else {
                previewTrigger.current = { node: event.currentTarget, identity }
                setPreview({ id: image.id, identity })
              }
            }}
          >
            {active && state?.urls[image.id] ? (
              <img
                src={state.urls[image.id]}
                alt={image.alt || image.name}
                className={
                  presentation === "filmstrip"
                    ? "h-full w-full object-cover"
                    : "max-h-64 w-full object-contain"
                }
              />
            ) : (
              <span
                className={
                  presentation === "filmstrip"
                    ? "flex h-full w-full items-center justify-center text-white/60"
                    : "flex min-h-24 w-full items-center justify-center gap-2 px-3 text-xs text-muted-foreground"
                }
              >
                {active && !state?.failed.includes(image.id) ? (
                  <Loader2 className="motion-safe:animate-spin" size={16} />
                ) : (
                  <ImageIcon size={16} />
                )}
                {presentation !== "filmstrip" && (
                  <span className="truncate">{image.alt || image.name}</span>
                )}
              </span>
            )}
          </button>
        ))}
      </div>
      {presentation === "gallery" && preview?.identity === identity && (
        <BotFilePreview
          key={`${conversationId}:${identity}`}
          id={preview.id}
          conversationId={conversationId}
          media={selected.find((image) => image.id === preview.id)}
          mediaGroup={selected}
          selectMedia={(id) =>
            setPreview((current) =>
              current?.identity === identity && selected.some((image) => image.id === id)
                ? { id, identity }
                : current
            )
          }
          close={() => setPreview(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const trigger = previewTrigger.current
            if (
              trigger?.identity === identity &&
              trigger.node.isConnected &&
              container.current?.dataset.imageScope === identity &&
              container.current.contains(trigger.node)
            )
              trigger.node.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}
