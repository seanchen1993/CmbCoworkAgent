import { ArrowUp, Loader2, Plus, X } from "lucide-react"
import { useMemo, useRef } from "react"
import type { BotDefinition, BotGroup } from "../../../../shared/bots/contracts"
import { BotChatRecipientPicker } from "./BotChatRecipientPicker"
import { BotAvatar } from "./BotAvatar"
import { botChatRecipientKey, type BotChatRecipient } from "@/lib/bot-chat-recipients"

/** A recipient is selected before the existing conversation composer takes over. */
export function BotNewChat({
  bots,
  groups,
  recipients,
  draft,
  files,
  busy,
  error,
  onDraft,
  onFiles,
  onSelect,
  onRemoveRecipient,
  onCommit,
  onSend,
  onClose
}: {
  bots: BotDefinition[]
  groups: BotGroup[]
  recipients: BotChatRecipient[]
  draft: string
  files: File[]
  busy: boolean
  error: string | null
  onDraft(value: string): void
  onFiles(files: File[]): void
  onSelect(value: string, name?: string): void
  onRemoveRecipient(id: string): void
  onCommit(): void
  onSend(): void
  onClose(): void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const selectedIds = useMemo(
    () => recipients.flatMap((recipient) => (recipient.kind === "bot" ? [recipient.id] : [])),
    [recipients]
  )
  const pendingNames = useMemo(
    () => recipients.flatMap((recipient) => (recipient.kind === "new" ? [recipient.name] : [])),
    [recipients]
  )
  const nameOf = (recipient: BotChatRecipient) =>
    recipient.kind === "new"
      ? recipient.name
      : (bots.find((bot) => bot.id === recipient.id)?.name ?? "成员已不可用")
  return (
    <section className="bot-new-chat" aria-label="新建聊天" aria-busy={busy}>
      <header className="bot-new-chat-header">
        <span className="text-muted-foreground">收件人：</span>
        <div className="bot-new-chat-recipients">
          {recipients.map((recipient) => {
            const bot =
              recipient.kind === "bot"
                ? bots.find((candidate) => candidate.id === recipient.id)
                : undefined
            const key = botChatRecipientKey(recipient)
            return (
              <span key={key} className="bot-new-chat-recipient">
                {bot && <BotAvatar color={bot.color} shape={bot.shape} size={20} />}
                {recipient.kind === "new" && (
                  <span className="bot-new-chat-pending" aria-hidden="true">
                    <Plus size={14} />
                  </span>
                )}
                <span>{nameOf(recipient)}</span>
                <button
                  type="button"
                  className="bot-icon-button"
                  aria-label={`移除 ${nameOf(recipient)}`}
                  disabled={busy}
                  onClick={() => onRemoveRecipient(key)}
                >
                  <X size={14} />
                </button>
              </span>
            )
          })}
          <BotChatRecipientPicker
            bots={bots}
            groups={groups}
            selectedIds={selectedIds}
            pendingNames={pendingNames}
            selectedCount={recipients.length}
            disabled={busy}
            onSelect={onSelect}
            onCommit={onCommit}
            onRemoveLast={() => {
              const last = recipients[recipients.length - 1]
              if (last) onRemoveRecipient(botChatRecipientKey(last))
            }}
          />
        </div>
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
          placeholder={
            recipients.length ? `发消息给 ${recipients.map(nameOf).join("和")}…` : "发消息给 Bot…"
          }
          value={draft}
          disabled={busy}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return
            event.preventDefault()
            if (!busy && recipients.length && (draft.trim() || files.length)) onSend()
          }}
          rows={1}
        />
        <button
          type="button"
          className="bot-group-send"
          aria-label="发送新聊天消息"
          disabled={busy || !recipients.length || (!draft.trim() && !files.length)}
          onClick={onSend}
        >
          <ArrowUp size={20} />
        </button>
      </div>
    </section>
  )
}
