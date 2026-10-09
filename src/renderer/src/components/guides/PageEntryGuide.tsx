import { useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { UiGuideConfig } from "../../../../shared/ui-guides"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog"

interface PageEntryGuideProps extends UiGuideConfig {
  active: boolean
  title: string
  imageSrc?: string
  imageAlt?: string
  children?: ReactNode
  acknowledgeLabel?: string
}

// Mount one entry only while its page is active. Closing does not remount it;
// returning to the page starts a new entry and checks the persistent budget.
export function PageEntryGuide(props: PageEntryGuideProps): React.JSX.Element | null {
  if (!props.active) return null
  return <ActivePageEntryGuide key={`${props.guideId}:${props.revision}`} {...props} />
}

function ActivePageEntryGuide({
  guideId,
  revision,
  maxShowCount,
  title,
  imageSrc,
  imageAlt,
  children,
  acknowledgeLabel = "知道了，不再提示"
}: PageEntryGuideProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [acknowledging, setAcknowledging] = useState(false)
  const countedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.api.uiGuides
      .getState({ guideId, revision, maxShowCount })
      .then((state) => {
        if (!cancelled) setOpen(state.shouldShow)
      })
      .catch((error) => console.warn("[UiGuide] Failed to read guide state:", error))
    return () => {
      cancelled = true
    }
  }, [guideId, revision, maxShowCount])

  useEffect(() => {
    if (!open || countedRef.current) return
    countedRef.current = true
    void window.api.uiGuides
      .recordDisplay({ guideId, revision, maxShowCount })
      .then((recorded) => {
        if (!recorded) setOpen(false)
      })
      .catch((error) => {
        console.warn("[UiGuide] Failed to record guide display:", error)
        setOpen(false)
      })
  }, [open, guideId, revision, maxShowCount])

  const acknowledge = async (): Promise<void> => {
    if (acknowledging) return
    setAcknowledging(true)
    try {
      await window.api.uiGuides.acknowledge({ guideId, revision, maxShowCount })
      setOpen(false)
    } catch {
      toast.error("未能保存提示确认，请重试")
    } finally {
      setAcknowledging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !acknowledging && setOpen(value)}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[calc(100vw-2rem)] max-w-4xl gap-3 p-4 pt-10"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="max-h-[calc(100vh-9rem)] min-h-0 overflow-y-auto">
          {imageSrc && (
            <img
              src={imageSrc}
              alt={imageAlt ?? title}
              className="h-auto w-full rounded-md"
              draggable={false}
            />
          )}
          {children}
        </div>
        <DialogFooter>
          <Button type="button" disabled={acknowledging} onClick={() => void acknowledge()}>
            {acknowledgeLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
