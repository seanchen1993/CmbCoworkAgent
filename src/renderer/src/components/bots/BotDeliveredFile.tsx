import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Download, FileText, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import type { BotFileDeliveryStatus } from "../../../../shared/bots/mock-channel"
import type { BotDeliveredFile as DeliveredFile } from "../../../../shared/bots/file-delivery"
import type { BotClient } from "../../../../shared/bots/contracts"

/** No file reads during rendering. Preview and save reuse the existing scoped file boundary. */
export function BotDeliveredFile({
  client,
  botId,
  groupId,
  imConversationId,
  threadId,
  filePath,
  attachmentPath,
  label,
  size,
  delivery
}: {
  client: BotClient
  botId: string
  groupId?: string
  imConversationId?: string
  threadId: string
  filePath: string
  attachmentPath?: string
  label?: ReactNode
  size?: number
  delivery?: BotFileDeliveryStatus
}) {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const openedPath = attachmentPath ?? filePath
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const lock = useRef(false)
  const save = async () => {
    if (lock.current) return
    lock.current = true
    setSaving(true)
    try {
      if (imConversationId) {
        if (!client.im?.exportFile) throw new Error("当前主机不支持 IM 文件导出")
        await client.im.exportFile(botId, imConversationId, openedPath)
      } else if (groupId) await client.exportGroupFile(groupId, openedPath)
      else await client.exportFile(botId, openedPath)
    } catch (cause) {
      toast.error(botErrorMessage(cause, "文件保存失败，请重试"))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return (
    <span className="bot-delivered-file" role="group" aria-label={`工作成果：${name}`}>
      <button
        type="button"
        className="bot-delivered-file-open"
        aria-label={`打开 ${name}`}
        title={filePath}
        onClick={() =>
          emitOpenResourcePreview({
            threadId,
            filePath: openedPath,
            ...(attachmentPath ? { markdownBasePath: filePath } : {}),
            workspacePathKind: "absolute"
          })
        }
      >
        <FileText size={22} strokeWidth={1.5} aria-hidden="true" />
        <span className="bot-delivered-file-label">
          <span className="bot-delivered-file-name">{name}</span>
          <span className="bot-delivered-file-description">
            {size === undefined
              ? label
              : size < 1024
                ? `${size} B`
                : size < 1024 * 1024
                  ? `${(size / 1024).toFixed(1)} KB`
                  : `${(size / (1024 * 1024)).toFixed(1)} MB`}
          </span>
          {delivery && (
            <span
              className="bot-file-delivery-status"
              data-state={delivery.state}
              title={delivery.reasonCode}
            >
              {delivery.state === "pending"
                ? "等待发送到招乎"
                : delivery.state === "sending"
                  ? delivery.progress < 100
                    ? `上传中 ${delivery.progress}%`
                    : "正在发送到招乎"
                  : delivery.state === "accepted"
                    ? "网关已接收"
                    : delivery.state === "sent"
                      ? "已送达招乎"
                      : delivery.state === "unknown"
                        ? "送达待核对 · 请查看招乎"
                        : delivery.state === "failed"
                          ? "发送失败"
                          : "接入已变化，发送已暂停"}
            </span>
          )}
        </span>
      </button>
      {delivery?.state === "failed" && client.im?.retryFile && (
        <button
          type="button"
          className="bot-delivered-file-save"
          aria-label={`重试发送 ${name}`}
          title="仅重试此文件"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true)
            try {
              await client.im!.retryFile!(botId, delivery.id)
            } catch (error) {
              toast.error(botErrorMessage(error, "重试失败，请检查招乎连接"))
            } finally {
              setRetrying(false)
            }
          }}
        >
          {retrying ? <Loader2 size={17} className="animate-spin" /> : <RotateCcw size={17} />}
        </button>
      )}
      <button
        type="button"
        className="bot-delivered-file-save"
        aria-label={`保存 ${name}`}
        title="保存到本机"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
      </button>
    </span>
  )
}

/** Fetch one bounded batch per visible tool receipt, coalescing host progress events. */
export function BotDeliveredFiles({
  files,
  callId,
  ...props
}: {
  client: BotClient
  botId: string
  groupId?: string
  imConversationId?: string
  threadId: string
  callId: string
  files: DeliveredFile[]
}) {
  const root = useRef<HTMLDivElement>(null)
  const [statuses, setStatuses] = useState<BotFileDeliveryStatus[]>([])
  useEffect(() => {
    if (!props.client.im?.fileStatuses || props.groupId) return
    let alive = true,
      visible = typeof IntersectionObserver === "undefined",
      running = false,
      dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      timer = undefined
      if (!alive || !visible) return
      if (running) {
        dirty = true
        return
      }
      running = true
      dirty = false
      try {
        const result = await props.client.im!.fileStatuses!(props.botId, props.threadId, callId)
        if (alive) setStatuses(result)
      } catch {
        /* A local file remains usable while its transport state is unavailable. */
      } finally {
        running = false
        if (dirty) refresh()
      }
    }
    const refresh = () => {
      if (alive && visible && !timer) timer = setTimeout(() => void load(), 250)
    }
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              visible = entry.isIntersecting
              if (visible) refresh()
            },
            { rootMargin: "100px" }
          )
    if (root.current) observer?.observe(root.current)
    refresh()
    const unsubscribe = props.client.subscribe(refresh)
    return () => {
      alive = false
      clearTimeout(timer)
      observer?.disconnect()
      unsubscribe()
    }
  }, [props.client, props.botId, props.threadId, props.groupId, callId])
  return (
    <div className="bot-delivered-files" ref={root}>
      {files.map((file) => (
        <BotDeliveredFile
          key={file.filePath}
          {...props}
          filePath={file.filePath}
          attachmentPath={file.attachmentPath}
          size={file.size}
          delivery={statuses.find(
            (item) =>
              item.file.attachmentPath === file.attachmentPath &&
              item.file.filePath === file.filePath
          )}
        />
      ))}
    </div>
  )
}
