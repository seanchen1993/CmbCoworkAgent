import { useEffect, useRef, useState } from "react"
import { Loader2, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgePendingSkillDeletion,
  isDefiniteSkillDeletionFailure,
  readPendingSkillDeletions,
  rememberPendingSkillDeletion,
  type PendingSkillDeletion
} from "@/lib/bot-skill-deletion-pending"
import type { BotSkill } from "../../../../shared/bot-types"
import { BotDialogContent } from "./BotDialog"

export function BotSkillDeleteButton({
  skill,
  recovery,
  disabled,
  onBusyChange,
  reload
}: {
  skill?: BotSkill
  recovery?: PendingSkillDeletion
  disabled?: boolean
  onBusyChange?(busy: boolean): void
  reload(): Promise<void>
}) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(dataEpoch)
  const [pending, setPending] = useState(
    () =>
      recovery ??
      (skill
        ? (readPendingSkillDeletions(skill.botId, dataEpoch).find(
            (item) => item.input.skillId === skill.id
          ) ?? null)
        : null)
  )
  const [review, setReview] = useState<PendingSkillDeletion | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const restored = editingEpoch !== dataEpoch
  const stale = !pending && !!review && !!skill && review.input.version !== skill.version
  const remove = async () => {
    if (!review || locked.current || restored || stale) return
    locked.current = true
    setBusy(true)
    onBusyChange?.(true)
    setError(null)
    let acknowledged = false
    try {
      const request = rememberPendingSkillDeletion(review.input, review.name, editingEpoch)
      setPending(request)
      const receipt = await botApi.deleteSkill(request.input)
      acknowledged = true
      acknowledgePendingSkillDeletion(request)
      if (alive.current) {
        setConfirmed(true)
        setPending(null)
        setReview(null)
      }
      const notes = [
        receipt.affectedRoutineIds.length
          ? `已停用 ${receipt.affectedRoutineIds.length} 个相关例程。`
          : "",
        receipt.cancellingRunIds.length ? "相关任务正在停止。" : "",
        receipt.reviewRunIds.length ? "结果不明的操作仍需在对话中核对。" : "",
        receipt.retainedLibraryIds.length ? "我的技能库中的已发布副本保留。" : ""
      ]
        .filter(Boolean)
        .join(" ")
      toast.success("技能已删除", { description: notes || "历史版本和试跑记录保留。" })
      await reload()
    } catch (failure) {
      if (!acknowledged && isDefiniteSkillDeletionFailure(failure)) {
        acknowledgePendingSkillDeletion(review)
        if (alive.current) setPending(null)
      }
      const message = failure instanceof Error ? failure.message : "操作失败"
      if (alive.current) setError(acknowledged ? `技能已删除，刷新失败：${message}` : message)
    } finally {
      locked.current = false
      if (alive.current) {
        setBusy(false)
        onBusyChange?.(false)
      }
    }
  }
  const refresh = async () => {
    if (locked.current || restored) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await reload()
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "刷新失败")
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <>
      <Button
        size={confirmed || recovery || pending ? "sm" : "icon"}
        variant="ghost"
        className={
          confirmed || recovery || pending
            ? ""
            : "size-8 text-muted-foreground hover:text-destructive"
        }
        disabled={disabled || busy || restored}
        aria-label={
          confirmed
            ? "刷新技能列表"
            : pending
              ? `核对技能 ${pending.name} 的删除请求`
              : `删除技能 ${skill?.name}`
        }
        onClick={() => {
          if (confirmed) {
            void refresh()
            return
          }
          setError(null)
          setReview(
            pending ??
              (skill
                ? {
                    name: skill.name,
                    dataEpoch: editingEpoch,
                    input: {
                      nonce: crypto.randomUUID(),
                      botId: skill.botId,
                      skillId: skill.id,
                      version: skill.version
                    }
                  }
                : null)
          )
        }}
      >
        {pending || confirmed ? <RotateCcw size={14} /> : <Trash2 size={14} />}
        {confirmed ? "刷新列表" : (recovery || pending) && "核对删除"}
      </Button>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null)
        }}
      >
        <BotDialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除技能「{review?.name}」？</DialogTitle>
            <DialogDescription>
              删除此 Bot 的私有技能（当前版本 {review?.input.version}
              ），相关例程将停用，正在使用它的任务将停止。历史版本、试跑记录和已发布到我的技能库的副本保留。
            </DialogDescription>
          </DialogHeader>
          {pending && (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              上次请求尚未收到确认。重试核对使用原请求和版本，不会发起第二次删除。
            </p>
          )}
          {(restored || stale) && (
            <p role="alert" className="text-xs text-destructive">
              {restored
                ? "数据已恢复，请关闭后重新打开技能面板。"
                : "技能版本已改变，请取消并查看当前步骤后确认。"}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || restored || stale}
              onClick={() => void remove()}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? "正在删除…" : pending ? "重试核对" : "确认删除"}
            </Button>
          </div>
        </BotDialogContent>
      </Dialog>
      {error && !review && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function BotSkillDeletionRecovery({
  botId,
  activeSkillIds,
  reload
}: {
  botId: string
  activeSkillIds: string[]
  reload(): Promise<void>
}) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("private-skill-deletion") ?? false
  )
  const requests = readPendingSkillDeletions(botId, dataEpoch).filter(
    (item) => !activeSkillIds.includes(item.input.skillId)
  )
  if (!supported || !requests.length) return null
  return (
    <section
      className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-3"
      aria-label="待核对的技能删除"
    >
      <p className="text-xs text-muted-foreground">
        以下技能已不在当前列表中，核对原删除请求以确认结果。
      </p>
      {requests.map((item) => (
        <div
          key={`${dataEpoch}:${item.input.nonce}`}
          className="flex items-center justify-between gap-3"
        >
          <span className="truncate text-sm">
            {item.name}{" "}
            <span className="text-xs text-muted-foreground">· 版本 {item.input.version}</span>
          </span>
          <BotSkillDeleteButton recovery={item} reload={reload} />
        </div>
      ))}
    </section>
  )
}
