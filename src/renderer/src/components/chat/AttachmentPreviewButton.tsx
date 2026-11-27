import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { DraftAttachmentImage } from "../../../../shared/file-attachment"
import { useEffect, useEffectEvent, useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"

export interface OriginalImage {
  width: number
  height: number
  regenerate?: () => void
  read(): Promise<string>
  save(): Promise<boolean>
}

/** This child mounts only while the dialog is open. The thumbnail never starts an original read. */
function OriginalImageView({ original, filename }: { original: OriginalImage; filename: string }) {
  const [url, setUrl] = useState<string | null>()
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const read = useEffectEvent(() => original.read())
  useEffect(() => {
    let current = true
    void read().then(
      (value) => {
        if (current) setUrl(value)
      },
      () => {
        if (current) setUrl(null)
      }
    )
    return () => {
      current = false
    }
  }, [attempt])
  const save = async () => {
    setSaving(true)
    try {
      await original.save()
    } catch {
      toast.error("原图保存失败，请重试")
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      {url ? (
        <img
          src={url}
          alt={filename}
          draggable={false}
          className="max-h-[78vh] max-w-full justify-self-center object-contain"
        />
      ) : url === null ? (
        <button
          type="button"
          onClick={() => {
            setUrl(undefined)
            setAttempt((value) => value + 1)
          }}
        >
          原图加载失败，点击重试
        </button>
      ) : (
        <span role="status">正在加载原图…</span>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="inline-flex items-center gap-2 justify-self-end rounded px-2 py-1 text-sm hover:bg-muted"
      >
        <Download size={16} aria-hidden="true" />
        保存原图
      </button>
    </>
  )
}

export function AttachmentPreviewButton({
  image,
  inline = false,
  original
}: {
  image: DraftAttachmentImage
  inline?: boolean
  original?: OriginalImage
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
        {original ? (
          <OriginalImageView original={original} filename={filename} />
        ) : (
          <img
            src={url}
            alt={filename}
            className="max-h-[78vh] max-w-full justify-self-center object-contain"
            draggable={false}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
