import { useRef, useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { FileViewer, type TextFilePreviewAdapter } from "@/components/tabs/FileViewer"
import { useResourcePreviewRequest } from "@/lib/use-resource-preview-request"
import type { BotClient } from "../../../../shared/bots/contracts"
import { BotJsonFilePreview } from "./BotJsonFilePreview"

const botJsonFilePreview: TextFilePreviewAdapter = {
  extensions: ["json"],
  component: BotJsonFilePreview
}

/** Reuse the workbench's ordered preview requests, bound to the message's owning thread. */
export function BotMessageFilePreview({
  botId,
  groupId,
  threadId,
  name,
  client
}: {
  botId: string
  groupId?: string
  threadId: string
  name: string
  client: BotClient
}) {
  const { request, clear } = useResourcePreviewRequest(threadId)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const trigger = useRef<HTMLElement | null>(null)
  if (!request) return null
  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await client.exportFile(botId, request.filePath, groupId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文件保存失败，请重试")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) clear()
      }}
    >
      <DialogContent
        className="bot-file-preview flex flex-col gap-0 p-0"
        onOpenAutoFocus={() => {
          trigger.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          if (trigger.current?.isConnected) {
            event.preventDefault()
            trigger.current.focus()
          }
          trigger.current = null
        }}
      >
        <DialogHeader className="bot-file-preview-header space-y-0">
          <DialogTitle className="bot-file-preview-title">
            {request.filePath.split(/[\\/]/).pop()}
          </DialogTitle>
          <DialogDescription className="sr-only">{name}的工作成果</DialogDescription>
          {!request.externalPreviewGrant && (
            <button
              type="button"
              className="bot-file-preview-save"
              aria-label="保存工作成果"
              title="保存到本机"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            </button>
          )}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <FileViewer
            key={`${threadId}:${request.intentId}`}
            threadId={threadId}
            filePath={request.filePath}
            workspacePathKind={request.workspacePathKind}
            externalFullPath={request.externalPreviewGrant ? request.filePath : undefined}
            externalPreviewGrant={request.externalPreviewGrant}
            transport={client.filePreview}
            cacheNamespace={`bot:${client.hostId}:`}
            reloadToken={request.intentId}
            requestLane={`bot-message:${client.hostId}:${threadId}`}
            htmlPreviewPolicy="workspace-scripted"
            visualEditPolicy="disabled"
            textPreview={botJsonFilePreview}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
