import "./BotWorkControl.css"
import { useRef, useState, type CSSProperties } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { BotClient, BotDefinition } from "../../../../shared/bots/contracts"
import type { BotWorkControlInput, BotWorkControlPending, BotWorkItem } from "../../../../shared/bots/work"
import { botErrorMessage } from "@/lib/bot-error-message"
import { BotAvatar } from "./BotAvatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export const botWorkControlColor = (color: string) => `color-mix(in srgb, ${color} 45%, white)`

/** Displays authoritative work state; a click does not optimistically claim ownership. */
export function BotWorkControl({ bot, work, client, onOpenBot, beforeChange, onControlChanged }: {
  bot: BotDefinition
  work: BotWorkItem
  client: BotClient
  onOpenBot?(botId: string): void
  beforeChange(): void
  onControlChanged?(work: BotWorkItem): void
}) {
  const [busy, setBusy] = useState(false)
  const operationPending = useRef(false)
  const controlButton = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState<BotWorkControlPending | null>(null)
  if (!client.works?.control || work.source || work.audienceKey !== "desktop" || work.deletionPending) return null
  const owned = Boolean(work.userControl), settling = work.userControl?.settling === true
  const change = async (action: BotWorkControlInput["action"], confirmed?: BotWorkControlPending) => {
    if (operationPending.current || !client.works?.control) return
    operationPending.current = true
    setBusy(true)
    try {
      beforeChange()
      if (action === "return" && !settling && !confirmed && client.works.controlPending) {
        const current = await client.works.controlPending(bot.id, work.id)
        if (current.items.length) {
          setPending(current)
          return
        }
        confirmed = current
      }
      const changed = await client.works.control({ botId: bot.id, workId: work.id,
        expectedVersion: confirmed?.version ?? work.version, operationId: crypto.randomUUID(), action,
        ...(confirmed ? { confirmedTaskIds: confirmed.items.map(item => item.taskId) } : {}) })
      onControlChanged?.(changed)
      setPending(null)
    } catch (error) {
      toast.error(botErrorMessage(error))
      // Reopen the current list after a stale confirmation; never release unseen new inputs.
      if (pending && client.works.controlPending) {
        try { setPending(await client.works.controlPending(bot.id, work.id)) } catch { setPending(null) }
      }
    } finally {
      operationPending.current = false
      setBusy(false)
    }
  }
  const withdraw = async (taskId: string) => {
    if (busy || !pending?.items.some(item => item.taskId === taskId) || !client.works?.controlPending) return
    setBusy(true)
    try {
      await client.cancel(taskId)
      setPending(await client.works.controlPending(bot.id, work.id))
    } catch (error) {
      toast.error(botErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const expand = async (taskId: string) => {
    if (busy || !pending || !client.works?.controlPending) return
    setBusy(true)
    try {
      const detail = await client.works.controlPending(bot.id, work.id, taskId)
      if (detail.version !== pending.version) {
        setPending(await client.works.controlPending(bot.id, work.id))
        throw new Error("待办已变化，请重新核对。")
      }
      setPending({ ...pending, items: pending.items.map(item => item.taskId === taskId ? detail.items[0] : item) })
    } catch (error) {
      toast.error(botErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const ownerContent = <>
    {settling ? <Loader2 size={18} className="bot-task-control-spinner" aria-hidden="true" /> :
      <BotAvatar color={bot.color} shape={bot.shape} size={24} animated={false} />}
    <span role="status">{work.userControl?.stopping ? "正在停止原任务…" : settling ? "等待原任务结算…" :
      owned ? "您拥有控制权" : <>由 <strong>{bot.name}</strong> 管理</>}</span>
  </>
  return <><div className="bot-task-control" data-control-state={settling ? "settling" : owned ? "user" : "bot"}
    style={{ "--bot-control-color": botWorkControlColor(bot.color) } as CSSProperties}>
    <div className="bot-task-control-row">
      {onOpenBot && !settling ? <button type="button" className="bot-task-control-owner"
        onClick={() => onOpenBot(bot.id)} aria-label={`返回 ${bot.name} 主对话`} title={`返回 ${bot.name} 主对话`}>
        {ownerContent}
      </button> : <span className="bot-task-control-owner">{ownerContent}</span>}
      <div className="bot-task-control-actions">
        {settling && !work.userControl?.stopping &&
          <button type="button" className="bot-task-control-secondary" disabled={busy || bot.archived || bot.deleting}
            onClick={() => void change("stop_and_take")}>停止并接管</button>}
        <button ref={controlButton} type="button" className="bot-task-control-action" disabled={busy || bot.archived || bot.deleting}
          title={owned && work.userControl?.heldInputs ? `核对 ${work.userControl.heldInputs} 条待办后归还` : undefined}
          onClick={() => void change(owned ? "return" : "take")}>{busy ? "处理中…" : settling ? "取消接管" : owned ? "归还控制权" : "获取控制权"}</button>
      </div>
    </div>
  </div>
    <Dialog open={Boolean(pending)} onOpenChange={open => { if (!open && !busy) setPending(null) }}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={event => {
        if (controlButton.current?.isConnected) {
          event.preventDefault()
          controlButton.current.focus({ preventScroll: true })
        }
      }}>
        <DialogHeader>
          <DialogTitle>归还前核对待办</DialogTitle>
          <DialogDescription>这些指令尚未执行。接管期间已取消或替代的，请先撤回。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[45vh] overflow-y-auto space-y-3">
          {pending?.items.map(item => <div key={item.taskId} className="flex items-start gap-3 rounded-lg border p-3">
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap break-words text-sm">{item.message}{item.truncated && "…"}</p>
              {item.truncated && <Button variant="link" size="sm" disabled={busy}
                onClick={() => void expand(item.taskId)}>查看完整指令</Button>}
            </div>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void withdraw(item.taskId)}>撤回</Button>
          </div>)}
          {pending?.items.length === 0 && <p className="text-sm text-muted-foreground">没有剩余待办。</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>继续接管</Button>
          <Button disabled={busy} onClick={() => pending && void change("return", pending)}>
            {busy ? "处理中…" : pending?.items.length ? `归还并继续 ${pending.items.length} 条` : "归还控制权"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
