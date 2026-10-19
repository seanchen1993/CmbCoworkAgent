import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState, type ReactNode } from "react"
import { Download, FileText, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import type { BotClient } from "../../../../shared/bots/contracts"

/** No file reads during rendering. Preview and save reuse the existing scoped file boundary. */
export function BotDeliveredFile({
  client,
  botId,
  groupId,
  threadId,
  filePath,
  label,
  size
}: {
  client: BotClient
  botId: string
  groupId?: string
  threadId: string
  filePath: string
  label?: ReactNode
  size?: number
}) {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const save = async () => {
    if (lock.current) return
    lock.current = true
    setSaving(true)
    try {
      await client.exportFile(botId, filePath, groupId)
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
          emitOpenResourcePreview({ threadId, filePath, workspacePathKind: "absolute" })
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
        </span>
      </button>
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
