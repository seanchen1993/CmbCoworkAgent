import { ChevronDown } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

const BOTTOM_DISTANCE_THRESHOLD = 32
const MAX_VIEWPORT_ATTACH_FRAMES = 60

interface ChatScrollToBottomButtonProps {
  getViewport: () => HTMLDivElement | null
  onScrollToBottom: () => void
  resetKey?: string
}

export function ChatScrollToBottomButton({
  getViewport,
  onScrollToBottom,
  resetKey
}: ChatScrollToBottomButtonProps): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const frameRef = useRef<number | null>(null)

  const updateVisibility = useCallback((): void => {
    if (frameRef.current !== null) return

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const viewport = getViewport()
      if (!viewport) {
        setVisible(false)
        return
      }

      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const nextVisible = distanceToBottom > BOTTOM_DISTANCE_THRESHOLD
      setVisible((current) => (current === nextVisible ? current : nextVisible))
    })
  }, [getViewport])

  useEffect(() => {
    let viewport: HTMLDivElement | null = null
    let retryFrame: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let attachAttempts = 0

    const observeContent = (): void => {
      if (!viewport || !resizeObserver) return
      resizeObserver.disconnect()
      resizeObserver.observe(viewport)

      if (visible) return

      const lastChild = viewport.lastElementChild
      const virtualSpacer = lastChild?.getAttribute("aria-hidden") === "true" ? lastChild : null
      const content = virtualSpacer ?? viewport.firstElementChild
      if (content instanceof HTMLElement) resizeObserver.observe(content)
    }

    const attach = (): void => {
      viewport = getViewport()
      if (!viewport) {
        attachAttempts += 1
        if (attachAttempts >= MAX_VIEWPORT_ATTACH_FRAMES) return
        retryFrame = requestAnimationFrame(attach)
        return
      }

      resizeObserver = new ResizeObserver(updateVisibility)
      viewport.addEventListener("scroll", updateVisibility, { passive: true })
      observeContent()
      updateVisibility()
    }

    attach()
    return () => {
      if (retryFrame !== null) cancelAnimationFrame(retryFrame)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      viewport?.removeEventListener("scroll", updateVisibility)
      resizeObserver?.disconnect()
    }
  }, [getViewport, resetKey, updateVisibility, visible])

  if (!visible) return null

  return (
    <button
      type="button"
      onClick={() => {
        onScrollToBottom()
      }}
      className="absolute bottom-full left-1/2 z-30 mb-3 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="回到会话底部"
      title="回到会话底部"
    >
      <ChevronDown className="size-4" />
    </button>
  )
}
