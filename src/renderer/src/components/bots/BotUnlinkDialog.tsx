import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { botErrorMessage } from "@/lib/bot-error-message"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"

export function BotUnlinkDialog({
  link, hasOpenPages, confirming, onCancel, onConfirm, onReturn
}: {
  link: BotWorkConversationResolution
  hasOpenPages: boolean
  confirming: boolean
  onCancel(): void
  onConfirm(): void
  onReturn(tab: "computer" | "details"): void
}) {
  const [taking, setTaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const takingRef = useRef(false)
  const { bot, work } = link
  const control = window.api.bots.works?.control
  const busy = taking || confirming
  const returnTo = (tab: "computer" | "details") => {
    onCancel()
    onReturn(tab)
  }
  const take = async () => {
    if (!control || confirming || takingRef.current) return
    takingRef.current = true
    setTaking(true)
    setError(null)
    try {
      await control({
        botId: bot.id, workId: work.id, expectedVersion: work.version,
        operationId: crypto.randomUUID(), action: "take"
      })
      returnTo("details")
    } catch (cause) {
      setError(botErrorMessage(cause, "获取控制权失败，请刷新任务后重试。"))
    } finally {
      takingRef.current = false
      setTaking(false)
    }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>解除任务关联</DialogTitle>
          <DialogDescription className="break-words">
            「{work.title}」的原会话、消息和目录将保留，未发送草稿会停放。
            {hasOpenPages && " 此任务的电脑仍有打开的网页。解除关联后，页面和未提交内容不会转到普通会话。"}
          </DialogDescription>
        </DialogHeader>
        {hasOpenPages && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => returnTo("computer")}>回到原电脑</Button>
            {control && !work.userControl && !bot.archived && !bot.deleting && (
              <Button variant="outline" disabled={busy} onClick={() => void take()}>
                {taking ? "处理中…" : "暂时接管任务"}
              </Button>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
          <Button disabled={busy} onClick={event => { if (event.isTrusted) onConfirm() }}>
            {confirming ? "解除中…" : "确认解除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
