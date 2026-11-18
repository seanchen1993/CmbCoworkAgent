import { lazy, Suspense, useMemo, useRef, useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  FileViewer,
  type OfficeFilePreviewAdapter,
  type TextFilePreviewAdapter
} from "@/components/tabs/FileViewer"
import { useResourcePreviewRequest } from "@/lib/use-resource-preview-request"
import type { OpenResourcePreviewDetail } from "@/lib/resource-preview-events"
import { isHarnessPluginRunArtifactGrantFresh } from "@/lib/harness-plugin-run-artifacts"
import { LOCAL_BOT_HOST_ID, type BotClient } from "../../../../shared/bots/contracts"
import { BotJsonFilePreview } from "./BotJsonFilePreview"

const botJsonFilePreview: TextFilePreviewAdapter = {
  extensions: ["json"],
  component: BotJsonFilePreview,
  readBudget: { maxBytes: 1024 * 1024, maxPages: 32 }
}

const OfficePreview = lazy(() =>
  import("./BotOfficeFilePreview").then((module) => ({ default: module.BotOfficeFilePreview }))
)
const botOfficeFilePreview: OfficeFilePreviewAdapter = {
  extensions: ["docx", "xlsx"],
  component: (props) => (
    <Suspense fallback={<div className="p-6 text-muted-foreground">正在加载文档…</div>}>
      <OfficePreview {...props} />
    </Suspense>
  )
}

type BotFilePreviewProps = {
  botId: string
  groupId?: string
  imConversationId?: string
  threadId: string
  name: string
  client: BotClient
}

/** Reuse the workbench's ordered preview requests, bound to the message's owning thread. */
export function BotMessageFilePreview(props: BotFilePreviewProps) {
  const { request, clear } = useResourcePreviewRequest(props.threadId)
  return <BotFileDeliveryPreview {...props} request={request} clear={clear} />
}

/** The caller owns the dialog lifetime; threadId remains the exact read-only delivery source. */
export function BotFileDeliveryPreview({
  botId,
  groupId,
  imConversationId,
  threadId,
  name,
  client,
  ownerThreadId,
  request,
  clear
}: BotFilePreviewProps & {
  /** Cross-thread dialogs isolate cancellation by their visible owner without changing source identity. */
  ownerThreadId?: string
  request: OpenResourcePreviewDetail | null
  clear(): void
}) {
  const transport = useMemo(
    () =>
      groupId
        ? {
            ...client.filePreview,
            readFilePreview: (input: Parameters<typeof client.filePreview.readFilePreview>[0]) =>
              client.filePreview.readFilePreview({
                ...input,
                source:
                  input.source.threadId !== undefined
                    ? { ...input.source, botGroupId: groupId }
                    : input.source
              }),
            openMediaPreview: (input: Parameters<typeof client.filePreview.openMediaPreview>[0]) =>
              client.filePreview.openMediaPreview({
                ...input,
                source:
                  input.source.threadId !== undefined
                    ? { ...input.source, botGroupId: groupId }
                    : input.source
              })
          }
        : client.filePreview,
    [client, groupId]
  )
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const trigger = useRef<HTMLElement | null>(null)
  const resolveExternalPreviewGrant = useMemo(() => {
    const source = request?.botDeliverySource
    const initialGrant = request?.externalPreviewGrant
    if (
      !request || !initialGrant || source?.threadId !== threadId ||
      groupId || imConversationId || client.hostId !== LOCAL_BOT_HOST_ID || !client.authorizeDeliveredFile
    ) return undefined

    let grant = initialGrant
    let expiresAt = request.externalPreviewGrantExpiresAt
    let pending: Promise<string> | undefined
    return async () => {
      if (isHarnessPluginRunArtifactGrantFresh(grant, expiresAt)) return grant
      pending ??= client.authorizeDeliveredFile!(source).then(result => {
        if (result.filePath !== request.filePath)
          throw new Error("原交付附件路径已变化，请重新打开。")
        grant = result.grant
        expiresAt = result.expiresAt
        return grant
      }).finally(() => { pending = undefined })
      return pending
    }
  }, [client, groupId, imConversationId, request, threadId])
  if (!request) return null
  const fileName = (request.markdownBasePath ?? request.filePath).split(/[\\/]/).pop()
  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      if (request.botDeliverySource && client.exportDeliveredFile) {
        await client.exportDeliveredFile(request.botDeliverySource)
      } else if (imConversationId) {
        if (!client.im?.exportFile) throw new Error("当前主机不支持保存招乎群文件")
        await client.im.exportFile(botId, imConversationId, request.filePath, undefined, fileName)
      } else if (groupId) await client.exportGroupFile(groupId, request.filePath, fileName)
      else await client.exportFile(botId, request.filePath, undefined, undefined, fileName)
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
            {fileName}
          </DialogTitle>
          <DialogDescription className="sr-only">{name}的工作成果</DialogDescription>
          {(!request.externalPreviewGrant || (request.botDeliverySource && client.exportDeliveredFile)) && (
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
            markdownBasePath={request.markdownBasePath}
            workspacePathKind={request.workspacePathKind}
            externalFullPath={request.externalPreviewGrant ? request.filePath : undefined}
            externalPreviewGrant={request.externalPreviewGrant}
            resolveExternalPreviewGrant={resolveExternalPreviewGrant}
            botDeliveryMarkdown={request.botDeliverySource}
            botDelivery={request.botDelivery}
            transport={transport}
            cacheNamespace={`bot:${client.hostId}:`}
            reloadToken={request.intentId}
            requestLane={ownerThreadId
              ? `bot-delivery:${client.hostId}:${ownerThreadId}:${threadId}`
              : `bot-message:${client.hostId}:${threadId}`}
            htmlPreviewPolicy="workspace-scripted"
            textPreview={botJsonFilePreview}
            officePreview={botOfficeFilePreview}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
