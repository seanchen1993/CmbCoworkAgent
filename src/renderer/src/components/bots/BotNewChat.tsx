import { ArrowUp, Loader2, Plus, X } from "lucide-react"
import { useRef } from "react"
import type { BotDefinition, BotGroup } from "../../../../shared/bots/contracts"
import { BotChatRecipientPicker } from "./BotChatRecipientPicker"

/** A recipient is selected before the existing conversation composer takes over. */
export function BotNewChat({
  bots,
  groups,
  draft,
  files,
  busy,
  error,
  onDraft,
  onFiles,
  onSelect,
  onClose
}: {
  bots: BotDefinition[]
  groups: BotGroup[]
  draft: string
  files: File[]
  busy: boolean
  error: string | null
  onDraft(value: string): void
  onFiles(files: File[]): void
  onSelect(value: string, name?: string): void
  onClose(): void
}) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <section className="bot-new-chat" aria-label="新建聊天" aria-busy={busy}>
      <header className="bot-new-chat-header">
        <span className="text-muted-foreground">收件人：</span>
        <BotChatRecipientPicker bots={bots} groups={groups} disabled={busy} onSelect={onSelect} />
        <button
          className="bot-icon-button"
          aria-label="关闭新聊天"
          onClick={onClose}
          disabled={busy}
        >
          <X size={19} />
        </button>
      </header>
      {error && (
        <p role="alert" className="bot-notice">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center" role="status">
        {busy && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            正在准备聊天…
          </span>
        )}
      </div>
      <div
        className="bot-new-chat-draft"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          if (!busy) onFiles([...files, ...Array.from(event.dataTransfer.files)])
        }}
      >
        {files.length > 0 && (
          <div className="flex w-full flex-wrap gap-2" aria-label="新聊天附件">
            {files.map((file, index) => (
              <span
                key={`${file.name}:${index}`}
                className="inline-flex max-w-full items-center gap-2 rounded-xl bg-muted px-3 py-1.5 text-xs"
              >
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`移除附件 ${file.name}`}
                  disabled={busy}
                  onClick={() => onFiles(files.filter((_, position) => position !== index))}
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ""
            if (!busy && selected.length) onFiles([...files, ...selected])
          }}
        />
        <button
          className="bot-icon-button"
          aria-label="添加新聊天附件"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <Plus size={20} />
        </button>
        <textarea
          aria-label="新聊天草稿"
          placeholder="发消息给 Bot…"
          value={draft}
          disabled={busy}
          onChange={(event) => onDraft(event.target.value)}
          rows={1}
        />
        <button className="bot-group-send" aria-label="选择收件人后发送" disabled>
          <ArrowUp size={20} />
        </button>
      </div>
    </section>
  )
}
