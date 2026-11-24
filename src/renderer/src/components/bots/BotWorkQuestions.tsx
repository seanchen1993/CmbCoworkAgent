import { useEffect, useRef, useState } from "react"
import { ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { UserInputRequestDialog } from "@/components/chat/UserInputRequestDialog"
import { botErrorMessage } from "@/lib/bot-error-message"
import type { UserInputResponse } from "@/types"
import { botTaskGroupId, botTaskWorkFamily, type BotClient, type BotTask } from "../../../../shared/bots/contracts"
import type { BotWorkApproval, BotWorkInteraction, BotWorkQuestion } from "../../../../shared/bots/work"

/** Questions can be answered here. Approvals open their original conversation. */
export function BotWorkQuestions({
  client,
  botId,
  tasks,
  onOpenApproval
}: {
  client: BotClient
  botId: string
  tasks: readonly BotTask[]
  onOpenApproval?(approval: BotWorkApproval, isCurrent: () => boolean): void | Promise<void>
}) {
  const read = client.works?.pendingQuestions
  const answer = client.works?.answerQuestion
  const [questions, setQuestions] = useState<BotWorkInteraction[]>([])
  const [selected, setSelected] = useState<BotWorkQuestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [sending, setSending] = useState(false)
  const submitting = useRef(false)
  const answeredRequest = useRef<string | null>(null)
  const approvalOpening = useRef<Pick<BotWorkApproval, "taskId" | "requestId"> | null>(null)
  const questionFocus = useRef<{
    trigger: HTMLButtonElement
    conversation: HTMLElement | null
    index: number
  } | null>(null)
  const current = questions.find((item): item is BotWorkQuestion =>
    item.kind === "question" && item.request.requestId === selected?.request.requestId)

  useEffect(() => () => { approvalOpening.current = null }, [botId])

  useEffect(() => {
    if (!read || !answer || !tasks.some((task) =>
      task.state === "waiting_user" && !task.mockSource && !botTaskGroupId(task) &&
      botTaskWorkFamily(task) && (task.botId === botId || task.origin.kind === "bot")
    )) {
      setQuestions((previous) => previous.length ? [] : previous)
      setLoadError(null)
      return
    }
    let active = true
    void read(botId).then((result) => {
      if (!active) return
      setQuestions(result.filter((item) => item.kind === "approval" || item.request.requestId !== answeredRequest.current))
      setLoadError(null)
    }).catch(() => {
      if (active) setLoadError("暂时无法读取待处理事项。")
    })
    return () => { active = false }
  }, [read, answer, botId, tasks, retry])

  const submit = async (response: UserInputResponse) => {
    if (!answer || !current || loadError || current.request.requestId !== response.requestId || submitting.current) return
    submitting.current = true
    setSending(true)
    setError(null)
    try {
      await answer(botId, current.taskId, response)
      answeredRequest.current = response.requestId
      setQuestions((previous) => previous.filter((item) => item.kind === "approval" || item.request.requestId !== response.requestId))
      setSelected(null)
    } catch (cause) {
      setError(botErrorMessage(cause, "未能提交答复，请核对原任务。"))
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  const openApproval = async (approval: BotWorkApproval) => {
    const { taskId, requestId } = approval
    if (!read || !onOpenApproval ||
      (approvalOpening.current?.taskId === taskId && approvalOpening.current.requestId === requestId)) return
    const opening = { taskId, requestId }
    approvalOpening.current = opening
    const isCurrent = () => approvalOpening.current === opening
    try {
      // The parent starts its navigation guard before rechecking the original approval.
      await onOpenApproval(approval, isCurrent)
    } catch (cause) {
      if (isCurrent()) toast.error(botErrorMessage(cause, "暂时无法打开审批。"))
    } finally {
      if (isCurrent()) approvalOpening.current = null
    }
  }

  const focusOrigin = questionFocus.current
  return (
    <>
      {(questions.length > 0 || loadError) && (
        <section aria-label="待处理事项" className="bot-work-attention">
          {loadError && (
            <p role="alert" className="bot-work-attention-error">
              {loadError}
              <button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button>
            </p>
          )}
          {questions.length > 1 && <p className="bot-work-attention-count">{questions.length} 项待处理</p>}
          {questions.length > 0 && (
            <ul className="bot-work-attention-list" role="list">
              {questions.map((item, index) => {
                const status = item.kind === "approval" ? "等待批准" : item.request.questions[0]?.question || "等待答复"
                return (
                  <li key={item.kind === "approval" ? item.requestId : item.request.requestId}>
                    <button type="button" className="bot-work-attention-row" data-kind={item.kind}
                      disabled={item.kind === "approval" && !onOpenApproval}
                      onClick={(event) => {
                        if (item.kind === "approval") void openApproval(item)
                        else {
                          approvalOpening.current = null
                          const trigger = event.currentTarget
                          questionFocus.current = {
                            trigger,
                            conversation: trigger.closest<HTMLElement>(".bots-conversation"),
                            index
                          }
                          setError(null)
                          setSelected(item)
                        }
                      }}>
                      <span className="bot-work-attention-title" title={item.workTitle}>{item.workTitle}</span>
                      <span className="bot-work-attention-status" title={status}>{status}</span>
                      <span className="bot-work-attention-action">
                        查看 <ChevronRight size={14} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
      {selected && (
        <Dialog open onOpenChange={(open) => { if (!open && !sending) setSelected(null) }}>
          <DialogContent className="max-h-[85dvh] overflow-y-auto" onCloseAutoFocus={(event) => {
            if (!focusOrigin || questionFocus.current !== focusOrigin) return
            questionFocus.current = null
            const { trigger, conversation, index } = focusOrigin
            if (!conversation?.isConnected || conversation.closest("[inert]")) return
            let target: HTMLElement | null = trigger
            if (!trigger.isConnected) {
              const rows = conversation.querySelectorAll<HTMLButtonElement>(".bot-work-attention-row:not(:disabled)")
              target = rows[index] ?? rows[rows.length - 1] ??
                conversation.querySelector<HTMLButtonElement>(".bot-personal-header .bot-title-pill")
            }
            if (!target) return
            event.preventDefault()
            target.focus({ preventScroll: true })
          }}>
            <DialogTitle>{selected.workTitle}</DialogTitle>
            <DialogDescription>
              {[selected.projectName, selected.askedBy].filter(Boolean).join(" · ")} · 答复将送回原问题
            </DialogDescription>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {loadError && (
              <p role="alert" className="text-sm text-muted-foreground">
                {loadError}
                <button type="button" className="ml-2 underline" onClick={() => setRetry((value) => value + 1)}>重试</button>
              </p>
            )}
            {current ? (
              <fieldset disabled={sending || Boolean(loadError)}>
                <UserInputRequestDialog key={current.request.requestId} request={current.request}
                  presentation="bot" onSubmit={(response) => void submit(response)} />
              </fieldset>
            ) : !loadError && <p role="status">原问题已处理或已失效。</p>}
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
