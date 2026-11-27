import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { DraftAttachmentImage } from "../../../../shared/file-attachment"

export function AttachmentPreviewButton({
  image,
  inline = false
}: {
  image: DraftAttachmentImage
  inline?: boolean
}) {
  const { filename, url } = image
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`预览图片 ${filename}`}
          title={`预览图片 ${filename}`}
          className={`overflow-hidden border border-border bg-background focus-visible:ring-2 focus-visible:ring-ring ${
            inline ? "max-w-full cursor-zoom-in rounded-lg" : "size-9 rounded"
          }`}
        >
          <img
            src={url}
            alt={inline ? filename : ""}
            className={
              inline
                ? "block h-auto max-h-60 w-56 max-w-full object-contain"
                : "size-full object-cover"
            }
            draggable={false}
          />
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
  )
}
