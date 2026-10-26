import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppStore } from "@/lib/store"
import { useThreadContext } from "@/lib/thread-context"
import { useBotViewStore } from "./view-store"
import { BotExecutionDetailsToggle } from "./BotExecutionDetailsToggle"
import {
  parkLinkedConversationQueue,
  parkOrdinaryConversationQueue
} from "@/lib/bot-conversation-transition"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import type { BotDefinition } from "../../../../shared/bots/contracts"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

export function returnToBotTask(link: BotWorkConversationResolution) {
  const views = useBotViewStore.getState(),
    old = views.hosts.local
  views.update("local", {
    selectedId: link.bot.id,
    groupId: null,
    showArchived: link.bot.archived,
    detailOpen: true,
    activeWorkIdByBot: { ...old?.activeWorkIdByBot, [link.bot.id]: link.work.id }
  })
  useAppStore.getState().setMainView("bots")
}
export function ConversationTaskControls({
  threadId,
  link,
  refresh
}: {
  threadId: string
  link: BotWorkConversationResolution | null
  refresh(): void
}) {
  const context = useThreadContext(),
    [open, setOpen] = useState(false),
    [bots, setBots] = useState<BotDefinition[]>([]),
    [botId, setBotId] = useState(""),
    [title, setTitle] = useState(""),
    [goal, setGoal] = useState(""),
    [submitted, setSubmitted] = useState(false),
    [saving, setSaving] = useState(false)
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const botError = submitted && !botId ? "请选择所属 Bot。" : null
  const titleError = submitted && !title.trim() ? "请填写任务名称。" : null
  const goalError = submitted && !goal.trim() ? "请填写任务目标，说明希望完成什么。" : null
  const current = useRef(threadId)
  current.current = threadId
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
  useEffect(() => {
    setOpen(false)
    setSubmitted(false)
    operation.current = null
  }, [threadId])
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "操作失败，请重试。")
  const begin = async () => {
    const target = threadId
    try {
      const snapshot = await window.api.bots.snapshot()
      if (current.current !== target) return
      const available = snapshot.bots.filter((b) => !b.archived && !b.deleting)
      if (!available.length) throw new Error("请先在 Bots 中创建一个 Bot，再关联此会话。")
      setBots(available)
      setBotId(available[0].id)
      setTitle(
        useAppStore.getState().threads.find((t) => t.thread_id === target)?.title ?? "会话任务"
      )
      setGoal("")
      setSubmitted(false)
      setOpen(true)
    } catch (error) {
      fail(error)
    }
  }
  const associate = async () => {
    if (saving) return
    setSubmitted(true)
    if (!botId || !title.trim() || !goal.trim()) {
      const field = !botId ? "botId" : !title.trim() ? "title" : "goal"
      const control = formRef.current?.elements.namedItem(field)
      if (control instanceof HTMLElement) control.focus()
      return
    }
    const target = threadId
    setSaving(true)
    try {
      await parkOrdinaryConversationQueue(context, target)
      const row = await window.api.threads.get(target)
      if (current.current !== target) return
      const token = row?.metadata?.cmb_thread_incarnation
      const input = {
        botId,
        title: title.trim(),
        goal: goal.trim(),
        conversation: {
          kind: "local_thread" as const,
          threadId: target,
          incarnation: {
            token: typeof token === "string" ? token : null,
            legacyCreatedAt: new Date(row!.created_at).getTime()
          }
        }
      }
      const fingerprint = JSON.stringify(input)
      if (operation.current?.fingerprint !== fingerprint)
        operation.current = { fingerprint, id: crypto.randomUUID() }
      await window.api.bots.conversations!.link({ ...input, operationId: operation.current.id })
      await useAppStore.getState().loadThreads()
      if (current.current === target) {
        setOpen(false)
        operation.current = null
        refresh()
      }
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  const unlink = async () => {
    if (
      !link ||
      !window.confirm(
        "解除此任务关联？原会话、消息和目录保留，不会重新执行；未发送草稿将停放，需你明确继续。"
      )
    )
      return
    setSaving(true)
    try {
      await parkLinkedConversationQueue(context, link)
      await window.api.bots.conversations!.unlink(link.bot.id, link.work.id, link.work.version)
      await useAppStore.getState().loadThreads()
      if (current.current === threadId) refresh()
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  const lifecycle = async () => {
    if (!link) return
    setSaving(true)
    try {
      await window.api.bots.works!.lifecycle({
        botId: link.bot.id,
        workId: link.work.id,
        expectedVersion: link.work.version,
        operationId: crypto.randomUUID(),
        action: link.work.state === "completed" ? "continue" : "complete"
      })
      if (current.current === threadId) refresh()
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        {link ? (
          <>
            <span className="truncate">
              {link.bot.name} · {link.work.title} ·{" "}
              {link.work.state === "completed" ? "已完成" : "进行中"}
            </span>
            <BotExecutionDetailsToggle hostId={link.bot.hostId} />
            <button
              className="rounded border px-2 py-1 hover:bg-muted"
              onClick={() => returnToBotTask(link)}
            >
              返回 Bot 任务
            </button>
            <button
              className="rounded border px-2 py-1 hover:bg-muted"
              disabled={saving || link.bot.archived}
              onClick={() => void lifecycle()}
            >
              {link.work.state === "completed" ? "继续处理" : "完成任务"}
            </button>
            <button
              className="rounded px-2 py-1 hover:bg-muted"
              disabled={saving}
              onClick={() => void unlink()}
            >
              解除任务关联
            </button>
            <span className="w-full truncate" title={link.workspacePath}>
              工作目录：{link.workspacePath}
            </span>
            <details>
              <summary className="cursor-pointer">关联说明</summary>
              <p>
                任务与对话共享消息、草稿、模型、模式和目录。Goal、Mods
                控制请先解除关联后使用，原设置和历史会保留。
              </p>
            </details>
          </>
        ) : (
          <button className="rounded px-2 py-1 hover:bg-muted" onClick={() => void begin()}>
            关联为 Bot 任务
          </button>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>关联为 Bot 任务</DialogTitle>
            <DialogDescription>
              保留这段会话的消息、模型、模式和工作目录，不会立即执行。已有待发送消息将停放，由你明确继续。
            </DialogDescription>
          </DialogHeader>
          <form
            ref={formRef}
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void associate()
            }}
          >
            <p className="text-xs text-muted-foreground">
              <span className="text-destructive">*</span> 为必填项
            </p>
            <div className="space-y-1.5">
              <label htmlFor={`${formId}-bot`}>
                所属 Bot{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <select
                id={`${formId}-bot`}
                name="botId"
                required
                aria-invalid={Boolean(botError)}
                aria-describedby={botError ? `${formId}-bot-error` : undefined}
                className="block w-full rounded border bg-background p-2 aria-invalid:border-destructive"
                value={botId}
                disabled={saving}
                onChange={(e) => setBotId(e.target.value)}
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              {botError && (
                <p id={`${formId}-bot-error`} role="alert" className="text-xs text-destructive">
                  {botError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${formId}-title`}>
                任务名称{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <input
                id={`${formId}-title`}
                name="title"
                required
                aria-invalid={Boolean(titleError)}
                aria-describedby={titleError ? `${formId}-title-error` : undefined}
                className="block w-full rounded border bg-background p-2 aria-invalid:border-destructive"
                value={title}
                disabled={saving}
                placeholder="为这项任务起个名称"
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
              />
              {titleError && (
                <p id={`${formId}-title-error`} role="alert" className="text-xs text-destructive">
                  {titleError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${formId}-goal`}>
                任务目标{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <textarea
                id={`${formId}-goal`}
                name="goal"
                required
                aria-invalid={Boolean(goalError)}
                aria-describedby={goalError ? `${formId}-goal-error` : undefined}
                className="block w-full rounded border bg-background p-2 aria-invalid:border-destructive"
                value={goal}
                disabled={saving}
                rows={3}
                placeholder="描述希望 Bot 持续完成的工作，例如：分析最近提交的改动并整理风险点"
                maxLength={30000}
                onChange={(e) => setGoal(e.target.value)}
              />
              {goalError && (
                <p id={`${formId}-goal-error`} role="alert" className="text-xs text-destructive">
                  {goalError}
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={saving}
              className="w-full rounded border px-3 py-2 hover:bg-muted disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? "正在关联…" : "关联此会话"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
