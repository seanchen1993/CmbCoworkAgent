import { useEffect, useState } from "react"
import { ImageOff } from "lucide-react"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import {
  attachmentImages,
  type DraftAttachmentImage,
  type FileAttachment
} from "../../../../shared/file-attachment"

type ImageReader = (attachment: FileAttachment) => Promise<DraftAttachmentImage[]>

export function AttachmentImagePreview({ attachment, read }: {
  attachment: FileAttachment
  read: ImageReader
}) {
  const visual = attachmentImages(attachment).length > 0 || Boolean(attachment.botInputId &&
    (attachment.embeddedImageCount || /^image\/(png|jpeg|webp)$/.test(attachment.mimeType)))
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
    return () => { current = false }
  }, [attachment, read, visual])

  if (!visual || result?.attachment !== attachment || result.read !== read) return null
  if (!result.images.length)
    return <ImageOff className="size-4 shrink-0 text-muted-foreground" aria-label="图片预览不可用" />

  return (
    <span className="inline-flex shrink-0 gap-1">
      {result.images.map(({ filename, url }, index) => (
        <Dialog key={index}>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label={`预览图片 ${filename}`}
              title={`预览图片 ${filename}`}
              className="size-9 overflow-hidden rounded border border-border bg-background focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img src={url} alt="" className="size-full object-cover" draggable={false} />
            </button>
          </DialogTrigger>
          <DialogContent
            aria-describedby={undefined}
            className="w-[calc(100%-2rem)] max-w-5xl gap-3 rounded-lg p-4"
          >
            <DialogTitle className="truncate pr-8 text-sm font-medium">{filename}</DialogTitle>
            <img
              src={url}
              alt={filename}
              className="max-h-[78vh] max-w-full justify-self-center object-contain"
              draggable={false}
            />
          </DialogContent>
        </Dialog>
      ))}
    </span>
  )
}
