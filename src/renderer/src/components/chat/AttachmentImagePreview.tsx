import { useEffect, useState } from "react"
import { ImageOff } from "lucide-react"
import { AttachmentPreviewButton } from "./AttachmentPreviewButton"
import {
  attachmentImages,
  type DraftAttachmentImage,
  type FileAttachment
} from "../../../../shared/file-attachment"

type ImageReader = (attachment: FileAttachment) => Promise<DraftAttachmentImage[]>

export function AttachmentImagePreview({
  attachment,
  read
}: {
  attachment: FileAttachment
  read: ImageReader
}) {
  const visual =
    attachmentImages(attachment).length > 0 ||
    Boolean(
      attachment.botInputId &&
      (attachment.embeddedImageCount || /^image\/(png|jpeg|webp)$/.test(attachment.mimeType))
    )
  const [result, setResult] = useState<{
    attachment: FileAttachment
    read: ImageReader
    images: DraftAttachmentImage[]
  }>()
  useEffect(() => {
    if (!visual) return
    let current = true
    const setImages = (images: DraftAttachmentImage[]) => {
      if (current) setResult({ attachment, read, images })
    }
    void read(attachment).then(setImages, () => setImages([]))
    return () => {
      current = false
    }
  }, [attachment, read, visual])

  if (!visual || result?.attachment !== attachment || result.read !== read) return null
  if (!result.images.length)
    return (
      <ImageOff className="size-4 shrink-0 text-muted-foreground" aria-label="图片预览不可用" />
    )

  return (
    <span className="inline-flex shrink-0 gap-1">
      {result.images.map((image, index) => (
        <AttachmentPreviewButton key={index} image={image} />
      ))}
    </span>
  )
}
