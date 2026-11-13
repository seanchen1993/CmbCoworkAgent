import { useState } from "react"
import { ListEnd, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** Keep the menu usable even when an uncertain send locks editing of the original payload. */
export function QueuedMessageActions({
  botState,
  onEdit,
  onDelete
}: {
  botState?: "queued" | "sending" | "unconfirmed"
  onEdit(): void
  onDelete(): void
}) {
  const [open, setOpen] = useState(false)
  const busy = botState === "sending"
  const immutable = busy || botState === "unconfirmed"
  const deleteLabel = botState ? "删除待发消息" : "删除"
  return (
    <>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        title={busy ? "正在发送，请稍候" : deleteLabel}
        aria-label={deleteLabel}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <Trash2 className="size-3.5" />
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="更多"
            aria-label="更多"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-1">
          {immutable && (
            <p className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
              {busy
                ? "正在发送，请稍候。"
                : "发送结果待确认，可重试或删除待发记录。删除不会停止已接收的任务。"}
            </p>
          )}
          <button
            type="button"
            disabled={immutable}
            onClick={() => {
              setOpen(false)
              onEdit()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-40"
          >
            <Pencil className="size-4" />
            编辑消息
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
          >
            <ListEnd className="size-4" />
            {botState ? "删除待发消息" : "关闭排队"}
          </button>
        </PopoverContent>
      </Popover>
    </>
  )
}
