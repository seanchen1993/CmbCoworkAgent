import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState } from "react"
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
import { BotDeleteDialog } from "./BotDeleteDialog"
import { BotAvatar } from "./BotAvatar"

export function BotGroupEditor({
  group,
  bots,
  client,
  nameOnly = false,
  returnFocusTo,
  onClose,
  onSaved
}: {
  group: BotGroup | null
  bots: BotDefinition[]
  client: BotClient
  nameOnly?: boolean
  returnFocusTo?: HTMLElement | null
  onClose(): void
  onSaved(group: BotGroup): void
}) {
  const [name, setName] = useState(group?.name ?? "")
  const [members, setMembers] = useState(group?.memberIds ?? [])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(Boolean(group?.deleting))
  const lock = useRef(false)
  const trigger = useRef(returnFocusTo ?? document.activeElement)
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      onSaved(
        await client.saveGroup(
          { name, memberIds: members },
          group ? { id: group.id, version: group.version } : undefined
        )
      )
    } catch (cause) {
      setError(botErrorMessage(cause, "保存失败"))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  if (deleting && group)
    return (
      <BotDeleteDialog
        bot={group}
        kind="group"
        client={client}
        onClose={() => setDeleting(false)}
        onDeleted={onClose}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="bot-editor flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-[420px]"
        onCloseAutoFocus={(event) => {
          if (!(trigger.current instanceof HTMLElement) || !trigger.current.isConnected) return
          event.preventDefault()
          trigger.current.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle>{nameOnly ? "重命名聊天" : group ? "群聊设置" : "新建群聊"}</DialogTitle>
          <DialogDescription>
            {nameOnly
              ? "修改群聊在侧边栏和会话中的名称。"
              : "选择一起工作的 Bot。群聊使用独立会话，不带入私聊历史。"}
          </DialogDescription>
        </DialogHeader>
        <form className="min-h-0 space-y-4 overflow-y-auto overscroll-contain" onSubmit={save}>
          <label className="bot-field">
            群聊名称
            <input
              required
              autoFocus
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {!nameOnly && (
            <div className="max-h-72 overflow-y-auto space-y-1">
              {bots
                .filter((bot) => !bot.archived || group?.memberIds.includes(bot.id))
                .map((bot) => (
                  <label
                    key={bot.id}
                    className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-3 hover:bg-muted"
                  >
                    <BotAvatar color={bot.color} shape={bot.shape} size={32} />
                    <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
                    {bot.archived && (
                      <span className="shrink-0 text-xs text-muted-foreground">已归档</span>
                    )}
                    <input
                      type="checkbox"
                      checked={members.includes(bot.id)}
                      disabled={!members.includes(bot.id) && members.length >= 8}
                      onChange={(event) =>
                        setMembers((value) =>
                          event.target.checked
                            ? [...value, bot.id]
                            : value.filter((id) => id !== bot.id)
                        )
                      }
                    />
                  </label>
                ))}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {group && !nameOnly && (
              <Button
                variant="ghost"
                className="mr-auto text-destructive"
                type="button"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                删除群聊
              </Button>
            )}
            <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy || !name.trim() || !members.length}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
