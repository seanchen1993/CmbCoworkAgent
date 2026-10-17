import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type { BotClient, BotDefinition, BotGroup } from "../../../../shared/bots/contracts"

export function BotDeleteDialog({
  bot,
  kind = "bot",
  client,
  returnFocusTo,
  onClose,
  onDeleted
}: {
  bot: BotDefinition | BotGroup
  kind?: "bot" | "group"
  client: BotClient
  returnFocusTo?: HTMLElement | null
  onClose(): void
  onDeleted(): void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const trigger = useRef(returnFocusTo ?? document.activeElement)
  const remove = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      if (kind === "group") await client.removeGroup(bot.id, bot.version)
      else await client.remove(bot.id, bot.version)
      onDeleted()
    } catch (cause) {
      setError(botErrorMessage(cause, "删除未完成，请重试"))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-[420px]"
        onCloseAutoFocus={(event) => {
          if (!(trigger.current instanceof HTMLElement) || !trigger.current.isConnected) return
          event.preventDefault()
          trigger.current.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle>删除「{bot.name}」？</DialogTitle>
          <DialogDescription>
            {kind === "group"
              ? "将删除群聊消息及成员在此群的执行记录，取消群内待办。各 Bot 的私聊、记忆和工作文件会保留。此操作无法撤销。"
              : "将删除此 Bot 的会话和记忆，取消待办与例行任务，并将它移出群聊。工作文件和群聊已有消息会保留。此操作无法撤销。"}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              void remove()
            }}
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            {busy
              ? "正在删除…"
              : bot.deleting
                ? "继续删除"
                : kind === "group"
                  ? "删除群聊"
                  : "删除 Bot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
