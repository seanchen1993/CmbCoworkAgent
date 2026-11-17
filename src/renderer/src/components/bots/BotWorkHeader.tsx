import { botWorkStatus } from "@/lib/bot-work-status"
import { useRef, useState } from "react"
import { ArrowLeft, ArrowUpRight, Check, MoreHorizontal, RotateCcw } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { botErrorMessage } from "@/lib/bot-error-message"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../../shared/bots/work"
import type { useBotWorks } from "./use-bot-works"

/** One place for task navigation and lifecycle; the side panel remains a directory. */
export function BotWorkHeader({
  client,
  work,
  controller,
  disabled,
  onBack,
  backLabel
}: {
  client: BotClient
  work: BotWorkItem
  controller: ReturnType<typeof useBotWorks>
  disabled: boolean
  onBack(): void
  backLabel: string
}) {
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string>()
  const operation = useRef<{ fingerprint: string; id: string } | undefined>(undefined)
  const busy =
    ["running", "queued", "waiting_user"].includes(work.executionState ?? "") ||
    work.backgroundBusy ||
    work.pendingPeers > 0 ||
    work.execution?.runActive === true ||
    Boolean(work.execution && Object.values(work.execution.background).some(Boolean))
  const current = () =>
    controller.current.current.botId === work.botId &&
    controller.current.current.selectedId === work.id &&
    controller.current.current.audience ===
      (work.source && !work.source.personal ? work.source.bindingId : "desktop")
  const apply = async (open: boolean) => {
    if (saving) return
    setMenuOpen(false)
    setSaving(true)
    setError(undefined)
    try {
      if (open) {
        const result = await client.conversations!.expose(work.botId, work.id)
        await useAppStore.getState().loadThreads()
        if (current()) await useAppStore.getState().selectThread(result.threadId)
      } else {
        const action = work.state === "completed" ? "continue" : "complete"
        const fingerprint = JSON.stringify([work.id, work.version, action])
        if (operation.current?.fingerprint !== fingerprint)
          operation.current = { fingerprint, id: crypto.randomUUID() }
        await client.works!.lifecycle({
          botId: work.botId,
          workId: work.id,
          expectedVersion: work.version,
          action,
          operationId: operation.current.id
        })
        operation.current = undefined
        if (current()) await controller.refresh()
      }
    } catch (cause) {
      if (current()) setError(botErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const canChange = !disabled && !saving && !busy && work.conversation?.state !== "detached"
  return (
    <div className="bot-task-toolbar">
      <div className="bot-task-toolbar-row">
        <button className="bot-task-back" onClick={onBack} title={backLabel}>
          <ArrowLeft size={14} />
          <span>{backLabel}</span>
        </button>
        <span className="bot-task-status" role="status">
          {botWorkStatus(work)}
        </span>
        {!busy && work.executionState === "completed" && work.state !== "completed" && (
          <button
            className="bot-task-finish"
            disabled={!canChange}
            onClick={() => void apply(false)}
          >
            <Check size={14} />
            完成任务
          </button>
        )}
        {work.state === "completed" && (
          <button
            className="bot-task-finish"
            disabled={!canChange}
            onClick={() => void apply(false)}
          >
            <RotateCcw size={14} />
            继续处理
          </button>
        )}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button className="bot-icon-button" aria-label="任务更多操作">
              <MoreHorizontal size={17} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" data-bot-popup className="bot-workspace-menu rounded-xl">
            {client.conversations && (!work.source || work.source.transport === "im") && (
              <button
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent disabled:opacity-40"
                disabled={saving}
                onClick={() => void apply(true)}
              >
                <ArrowUpRight size={14} />
                在对话模式打开
              </button>
            )}
            {work.state !== "completed" && work.executionState !== "completed" && (
              <button
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent disabled:opacity-40"
                disabled={!canChange}
                onClick={() => void apply(false)}
              >
                <Check size={14} />
                完成任务
              </button>
            )}
            <hr className="my-2 border-border" />
            <p className="max-w-72 whitespace-normal text-xs font-normal text-muted-foreground">
              {work.source && !work.source.personal
                ? "回复和结果回到原群，沿用该群的记忆范围。"
                : "补充要求会继续此任务，沿用原来的工作目录。"}
            </p>
          </PopoverContent>
        </Popover>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
