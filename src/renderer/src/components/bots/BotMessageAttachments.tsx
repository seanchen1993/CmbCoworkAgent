import { useMemo } from "react"
import { Download, FileText, ImageIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotMessage } from "../../../../shared/bot-types"
import type { BotPeerMessageImage } from "../../../../shared/bot-peer-images"
import {
  botMessageAttachmentPresentation,
  type BotMessageAttachment
} from "../../../../shared/bot-message-attachments"
import { botFileLabel } from "@/lib/bot-file-label"
import { BotPeerImages } from "./BotPeerImages"

/** Uploaded images use the existing visible-only gallery/parser/preview owner.
 * Generic files display scoped immutable metadata, not a new eager files list. */
export function BotMessageAttachments({
  message,
  openImage,
  openFile,
  saveFile
}: {
  message: Pick<
    BotMessage,
    "conversationId" | "attachments" | "attachmentFiles" | "images" | "peerImages"
  >
  openImage(
    id: string,
    media: BotPeerMessageImage,
    trigger: HTMLButtonElement,
    group: BotPeerMessageImage[]
  ): void
  openFile(id: string, artifact: BotMessageAttachment | undefined, trigger: HTMLButtonElement): void
  saveFile?(id: string, artifact: BotMessageAttachment | undefined): void
}) {
  const view = useMemo(() => botMessageAttachmentPresentation(message), [message])
  if (!view.imageGroups.length && !view.files.length) return null
  return (
    <div data-bot-quote-ignore>
      {view.imageGroups.map((images) => (
        <BotPeerImages
          key={images.map((image) => image.id).join(":")}
          images={images}
          label={message.images ? "消息图片" : message.peerImages ? "协作图片" : "上传图片"}
          conversationId={message.conversationId}
          open={openImage}
        />
      ))}
      {view.files.length > 0 && (
        <div className="mt-3 flex max-w-full flex-col gap-2" aria-label="消息附件">
          {view.files.map(({ id, artifact, unavailable }, index) => (
            <div
              key={id}
              className="group flex min-w-0 max-w-full items-center rounded-xl border border-border/65 bg-background text-foreground transition-colors hover:border-border hover:bg-[color-mix(in_srgb,var(--background)_94%,var(--foreground))] focus-within:ring-2 focus-within:ring-ring motion-reduce:transition-none"
            >
              <button
                type="button"
                disabled={unavailable}
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left outline-none disabled:cursor-default disabled:opacity-60"
                aria-label={
                  unavailable ? "附件已删除或不可用" : `查看附件 ${artifact?.name ?? index + 1}`
                }
                title={artifact?.name}
                onClick={(event) => openFile(id, artifact, event.currentTarget)}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                  {artifact?.mime.startsWith("image/") ? (
                    <ImageIcon size={18} strokeWidth={1.6} />
                  ) : (
                    <FileText size={18} strokeWidth={1.6} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {unavailable ? "附件已删除或不可用" : (artifact?.name ?? `附件 ${index + 1}`)}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {artifact
                      ? botFileLabel(artifact)
                      : unavailable
                        ? "无法再读取此文件"
                        : "点击预览或保存原文件"}
                  </span>
                </span>
              </button>
              {saveFile && !unavailable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mr-2 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                  aria-label={`保存 ${artifact?.name ?? `附件 ${index + 1}`}`}
                  title="保存原文件"
                  onClick={() => saveFile(id, artifact)}
                >
                  <Download size={17} strokeWidth={1.6} aria-hidden />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
