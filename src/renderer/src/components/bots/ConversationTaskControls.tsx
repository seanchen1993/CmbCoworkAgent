import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowLeft, Link2, MoreHorizontal } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Close as PopoverClose } from "@radix-ui/react-popover"
import { useAppStore } from "@/lib/store"
import { useThreadContext } from "@/lib/thread-context"
import { useBotViewStore } from "./view-store"
import { BotExecutionDetailsToggle } from "./BotExecutionDetailsToggle"
import { BotUnlinkDialog } from "./BotUnlinkDialog"
import {
  clearUnlinkedBotWorkSelection,
  parkLinkedConversationQueue,
  prepareBotConversationLink
} from "@/lib/bot-conversation-transition"
import { threadDraftIncarnation } from "@/lib/bot-conversation-draft"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import type { BotDefinition } from "../../../../shared/bots/contracts"
import type { BotOrdinaryThreadRef } from "../../../../shared/bots/thread-history"
import { assertBotNonTeamConversation } from "../../../../shared/bots/team-policy"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

export function returnToBotTask(link: BotWorkConversationResolution, detailTab?: "computer" | "details") {
  const views = useBotViewStore.getState(),
    old = views.hosts.local
  views.update("local", {
    selectedId: link.bot.id,
    groupId: null,
    showArchived: link.bot.archived,
    detailOpen: true,
    ...(detailTab ? { detailTab } : {}),
    activeWorkIdByBot: { ...old?.activeWorkIdByBot, [link.bot.id]: link.work.id }
  })
  useAppStore.getState().setMainView("bots")
}
export function returnToBotMain(botId: string) {
  const views = useBotViewStore.getState()
  views.update("local", {
    selectedId: botId,
    groupId: null,
    activeWorkIdByBot: { ...views.hosts.local?.activeWorkIdByBot, [botId]: null }
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
    [linkTarget, setLinkTarget] = useState<BotOrdinaryThreadRef | null>(null),
    [bots, setBots] = useState<BotDefinition[]>([]),
    [botId, setBotId] = useState(""),
    [title, setTitle] = useState(""),
    [goal, setGoal] = useState(""),
    [submitted, setSubmitted] = useState(false),
    [saving, setSaving] = useState(false)
  const [unlinkTarget, setUnlinkTarget] = useState<{ link: BotWorkConversationResolution; hasOpenPages: boolean } | null>(null)
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const botError = submitted && !botId ? "请选择所属 Bot。" : null
  const titleError = submitted && !title.trim() ? "请填写任务名称。" : null
  const goalError = submitted && !goal.trim() ? "请填写任务目标，说明希望完成什么。" : null
  const current = useRef(threadId)
  current.current = threadId
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
  const unlinkInspection = useRef<(() => void) | null>(null)
  useEffect(() => {
    setLinkTarget(null)
    setUnlinkTarget(null)
    setSubmitted(false)
    operation.current = null
    return () => unlinkInspection.current?.()
  }, [threadId])
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "操作失败，请重试。")
  const begin = async () => {
    const target = threadId
    try {
      const row = await window.api.threads.get(target)
      if (current.current !== target) return
      if (!row || row.thread_id !== target) throw new Error("原会话已变化，请重新打开。")
      assertBotNonTeamConversation(row.metadata)
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
      setLinkTarget({ kind: "local_thread", threadId: target, incarnation: threadDraftIncarnation(row) })
    } catch (error) {
      fail(error)
    }
  }
  const associate = async () => {
    if (saving || !linkTarget || linkTarget.threadId !== threadId) return
    setSubmitted(true)
    if (!botId || !title.trim() || !goal.trim()) {
      const field = !botId ? "botId" : !title.trim() ? "title" : "goal"
      const control = formRef.current?.elements.namedItem(field)
      if (control instanceof HTMLElement) control.focus()
      return
    }
    const target = threadId
    const assertLive = () => {
      if (current.current !== target) throw new Error("原会话已切换，未完成关联。")
    }
    setSaving(true)
    try {
      const commitLink = await prepareBotConversationLink(context, linkTarget, assertLive)
      const input = {
        botId,
        title: title.trim(),
        goal: goal.trim(),
        conversation: linkTarget
      }
      const fingerprint = JSON.stringify(input)
      await commitLink(() => {
        if (operation.current?.fingerprint !== fingerprint)
          operation.current = { fingerprint, id: crypto.randomUUID() }
        return window.api.bots.conversations!.link({ ...input, operationId: operation.current.id })
      })
      await useAppStore.getState().loadThreads()
      if (current.current === target) {
        setLinkTarget(null)
        operation.current = null
        refresh()
      }
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  const beginUnlink = async () => {
    const isForeground = ({ mainView, currentThreadId, showCustomizeView } = useAppStore.getState()) =>
      mainView === "thread" && currentThreadId === threadId && !showCustomizeView
    if (!link || saving || unlinkInspection.current || !isForeground()) return
    const inspect = window.api.bots.conversations?.unlinkHasOpenPages
    if (!inspect) {
      fail(new Error("无法核对原任务的电脑状态。"))
      return
    }
    const finishInspection = () => {
      if (unlinkInspection.current !== finishInspection) return
      unlinkInspection.current = null
      unsubscribe()
    }
    const unsubscribe = useAppStore.subscribe(state => {
      if (!isForeground(state)) finishInspection()
    })
    unlinkInspection.current = finishInspection
    const isCurrent = () => unlinkInspection.current === finishInspection &&
      current.current === threadId && isForeground()
    setSaving(true)
    try {
      const hasOpenPages = await inspect(link.bot.id, link.work.id)
      if (isCurrent()) setUnlinkTarget({ link, hasOpenPages })
    } catch (error) {
      if (isCurrent()) fail(error)
    } finally {
      finishInspection()
      setSaving(false)
    }
  }
  const unlink = async () => {
    if (!unlinkTarget || saving) return
    const target = unlinkTarget.link
    setSaving(true)
    try {
      await parkLinkedConversationQueue(context, target)
      await window.api.bots.conversations!.unlink(target.bot.id, target.work.id, target.work.version)
      clearUnlinkedBotWorkSelection(target)
      void context.getThreadActions(threadId).syncDurableTranscript().catch(() => undefined)
      setUnlinkTarget(null)
      await useAppStore.getState().loadThreads()
      if (current.current === threadId) refresh()
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  const lifecycleAction = link?.work.state === "completed" || link?.work.dispatchStopped
    ? "continue" : "complete"
  const lifecycle = async () => {
    if (!link || saving) return
    setSaving(true)
    try {
      await window.api.bots.works!.lifecycle({
        botId: link.bot.id,
        workId: link.work.id,
        expectedVersion: link.work.version,
        operationId: crypto.randomUUID(),
        action: lifecycleAction
      })
      if (current.current === threadId) refresh()
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }
  const canOpenComputer = link?.work.conversation?.state === "bound" &&
    link.work.threadId === threadId && link.work.botId === link.bot.id &&
    !link.work.deletionPending && !link.work.deletionCommitted
  const stopWork = canOpenComputer && !link.bot.archived && !link.bot.deleting &&
    (!link.work.dispatchStopped || link.work.backgroundBusy || link.work.pendingPeers > 0 ||
      ["queued", "running", "waiting_user"].includes(link.work.executionState ?? ""))
    ? window.api.bots.works?.stop : undefined
  const stop = async () => {
    if (!link || !stopWork || saving) return
    setSaving(true)
    try {
      await stopWork(link.bot.id, link.work.id)
      if (current.current === threadId) refresh()
    } catch (error) {
      if (current.current === threadId) fail(error)
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <div data-conversation-task-controls data-linked={Boolean(link) || undefined} className="flex min-w-0 items-center gap-2 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
        {link ? (
          <>
            <button
              type="button"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`返回 ${link.bot.name} 主对话`}
              title={`返回 ${link.bot.name} 主对话`}
              onClick={() => returnToBotMain(link.bot.id)}
            >
              <ArrowLeft size={14} className="shrink-0" aria-hidden="true" />
            </button>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={link.work.title}>{link.work.title}</span>
            {(link.work.deletionPending || link.work.state === "completed") && <span className="shrink-0">{link.work.deletionPending ? "删除待完成" : "已完成"}</span>}
            <BotExecutionDetailsToggle hostId={link.bot.hostId} compact />
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" aria-label="任务选项" title="任务选项"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <MoreHorizontal size={18} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-1.5" aria-label="任务选项">
                <p className="truncate px-2 py-1.5 text-xs text-muted-foreground" title={link.workspacePath}>
                  {link.workspacePath}
                </p>
                <div className="my-1 border-t" />
                {canOpenComputer && (
                  <PopoverClose asChild>
                    <button type="button" className="w-full rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                      disabled={saving} onClick={() => returnToBotTask(link, "computer")}>打开原电脑</button>
                  </PopoverClose>
                )}
                {stopWork && (
                  <PopoverClose asChild>
                    <button type="button" className="w-full rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                      disabled={saving} title="停止当前执行和后续自动派发" onClick={() => void stop()}>停止任务</button>
                  </PopoverClose>
                )}
                <PopoverClose asChild>
                  <button type="button" className="w-full rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                    disabled={saving || link.bot.archived || link.work.deletionPending} onClick={() => void lifecycle()}>
                    {lifecycleAction === "continue" ? "继续处理" : "完成任务"}
                  </button>
                </PopoverClose>
                <PopoverClose asChild>
                  <button type="button" className="w-full rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                    disabled={saving || link.work.deletionPending} onClick={() => void beginUnlink()}>解除任务关联</button>
                </PopoverClose>
              </PopoverContent>
            </Popover>
          </>
        ) : (
          <button type="button" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted" onClick={() => void begin()}>
            <Link2 size={14} aria-hidden="true" />
            关联为 Bot 任务
          </button>
        )}
      </div>
      {unlinkTarget && (
        <BotUnlinkDialog
          link={unlinkTarget.link}
          hasOpenPages={unlinkTarget.hasOpenPages}
          confirming={saving}
          onCancel={() => setUnlinkTarget(null)}
          onConfirm={() => void unlink()}
          onReturn={tab => returnToBotTask(unlinkTarget.link, tab)}
        />
      )}
      <Dialog open={linkTarget !== null} onOpenChange={(open) => { if (!open) setLinkTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>关联为 Bot 任务</DialogTitle>
            <DialogDescription>
              原会话和设置保留。关联后继续交办，未发送草稿保留。
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
