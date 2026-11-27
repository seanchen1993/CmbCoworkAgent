import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { DraftAttachmentImage } from "../../../../shared/file-attachment"
import { loadVisibleMessageImages } from "@/lib/load-visible-message-images"
import { AttachmentPreviewButton } from "./AttachmentPreviewButton"

type ImageReader = () => Promise<DraftAttachmentImage[]>

export function MessageImageGallery({ sourceKey, read }: { sourceKey: string; read: ImageReader }) {
  return <MessageImages key={sourceKey} read={read} />
}

function MessageImages({ read }: { read: ImageReader }) {
  const root = useRef<HTMLDivElement>(null)
  const [images, setImages] = useState<DraftAttachmentImage[] | null>()
  const [attempt, setAttempt] = useState(0)
  const readCurrent = useEffectEvent(read)
  useEffect(() => {
    if (!root.current) return
    return loadVisibleMessageImages(root.current, () => readCurrent(), setImages)
  }, [attempt])

  if (images?.length === 0) return null
  return (
    <div
      ref={root}
      data-testid="message-image-gallery"
      className="flex min-h-px max-w-full flex-wrap items-start gap-2"
    >
      {images?.map((image, index) => (
        <AttachmentPreviewButton key={index} inline image={image} />
      ))}
      {images === null && (
        <button
          type="button"
          className="rounded text-xs text-muted-foreground underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setImages(undefined)
            setAttempt((value) => value + 1)
          }}
        >
          图片加载失败，点击重试
        </button>
      )}
    </div>
  )
}
