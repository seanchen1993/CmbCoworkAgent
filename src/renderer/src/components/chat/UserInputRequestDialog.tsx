import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CheckSquare,
  Square,
  MessageSquareText,
  PencilLine
} from "lucide-react"
import { FunctionFeedback } from "./FunctionFeedback"
import { FunctionQuestionSite } from "./FunctionQuestionSite"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import {
  emptyUserInputDraft,
  userInputAnswers,
  type UserInputDraft,
  type UserInputDraftAnswer as DraftAnswer
} from "@/lib/user-input-answer"
import { BotQuestionInput } from "../bots/BotQuestionInput"
import type { UserInputRequest, UserInputResponse } from "@/types"

interface UserInputRequestDialogProps {
  request: UserInputRequest | null
  onSubmit: (response: UserInputResponse) => void
  onLayoutChange?: (layout: UserInputRequestDialogLayout | null) => void
  presentation?: "workbench" | "bot"
  useComposerForSingleAnswer?: boolean
  draft?: UserInputDraft | null
  onDraftChange?: (update: (draft: UserInputDraft) => UserInputDraft) => void
}

export interface UserInputRequestDialogLayout {
  height: number
  top: number
  bottom: number
}

function formatRemainingTime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`
}

export function UserInputRequestDialog(
  props: UserInputRequestDialogProps
): React.JSX.Element | null {
  const { request, onLayoutChange } = props
  useEffect(() => {
    if (!request) onLayoutChange?.(null)
  }, [request, onLayoutChange])
  if (!request) return null
  return <ActiveUserInputRequestDialog key={request.requestId} {...props} request={request} />
}

/** Request identity resets drafts before rendering, rather than an effect clearing a previous answer. */
function ActiveUserInputRequestDialog({
  request,
  onSubmit,
  onLayoutChange,
  presentation = "workbench",
  useComposerForSingleAnswer = false,
  draft,
  onDraftChange
}: Omit<UserInputRequestDialogProps, "request"> & {
  request: UserInputRequest
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [localDraft, setLocalDraft] = useState(() => emptyUserInputDraft(request?.requestId ?? ""))
  const currentDraft = onDraftChange ? draft : localDraft
  const { answers: draftAnswers, activeIndex } =
    currentDraft?.requestId === request?.requestId && currentDraft
      ? currentDraft
      : emptyUserInputDraft(request?.requestId ?? "")
  const changeDraft = (update: (draft: UserInputDraft) => UserInputDraft): void => {
    if (!request) return
    const apply = (previous: UserInputDraft): UserInputDraft =>
      update(
        previous.requestId === request.requestId ? previous : emptyUserInputDraft(request.requestId)
      )
    if (onDraftChange) onDraftChange(apply)
    else setLocalDraft(apply)
  }
  const setDraftAnswers = (
    update:
      | Record<string, DraftAnswer>
      | ((previous: Record<string, DraftAnswer>) => Record<string, DraftAnswer>)
  ): void =>
    changeDraft((previous) => ({
      ...previous,
      answers: typeof update === "function" ? update(previous.answers) : update
    }))
  const setActiveIndex = (update: number | ((previous: number) => number)): void =>
    changeDraft((previous) => ({
      ...previous,
      activeIndex: typeof update === "function" ? update(previous.activeIndex) : update
    }))
  const [collapsed, setCollapsed] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const remainingSeconds = request.autoResolutionMs
    ? Math.max(
        0,
        Math.ceil(
          (new Date(request.createdAt).getTime() + request.autoResolutionMs - clockNow) / 1000
        )
      )
    : null

  useEffect(() => {
    if (!request.autoResolutionMs) return
    const interval = window.setInterval(() => setClockNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [request.autoResolutionMs])

  const handleIgnore = useCallback((): void => {
    if (!request) return
    onSubmit({
      requestId: request.requestId,
      answers: {},
      submittedAt: new Date().toISOString(),
      ignored: true
    })
  }, [onSubmit, request])

  useEffect(() => {
    if (!request || presentation === "bot") return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || useAppStore.getState().showCustomizeView) return
      if (event.key !== "Escape") return
      event.preventDefault()
      if (request.recoveryRequired) setCollapsed(true)
      else handleIgnore()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleIgnore, request, presentation])

  useEffect(() => {
    if (!onLayoutChange || presentation === "bot") return
    if (!request) {
      onLayoutChange(null)
      return
    }

    const node = dialogRef.current
    if (!node) {
      onLayoutChange(null)
      return
    }

    let frame: number | null = null
    const updateLayout = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        const rect = node.getBoundingClientRect()
        onLayoutChange({
          height: rect.height,
          top: rect.top,
          bottom: rect.bottom
        })
      })
    }

    updateLayout()
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateLayout)
    resizeObserver?.observe(node)
    window.addEventListener("resize", updateLayout)

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      window.removeEventListener("resize", updateLayout)
    }
  }, [activeIndex, collapsed, onLayoutChange, request, presentation])

  const canSubmit = useMemo(() => {
    if (!request) return false
    return userInputAnswers(request.questions, draftAnswers, presentation === "bot") !== null
  }, [draftAnswers, request, presentation])

  if (!request) return null
  const answeredCount = request.questions.filter((question) => {
    return userInputAnswers([question], draftAnswers, presentation === "bot") !== null
  }).length

  const updateDraft = (questionId: string, answer: DraftAnswer): void => {
    setDraftAnswers((prev) => ({ ...prev, [questionId]: answer }))
  }

  const selectOption = (questionId: string, optionIndex: number): void => {
    const current = draftAnswers[questionId]
    if (
      request.questions.some(q => q.id === questionId && (q.allowMultiple || q.multiSelect))
    ) {
      const selected = current?.type === "options" ? current.optionIndices : []
      updateDraft(questionId, {
        type: "options",
        optionIndices: selected.includes(optionIndex)
          ? selected.filter((index) => index !== optionIndex)
          : [...selected, optionIndex]
      })
      return
    }
    const answer: Extract<DraftAnswer, { type: "option" }> =
      current?.type === "option" && current.optionIndex === optionIndex
        ? current
        : { type: "option" as const, optionIndex }
    const next = { ...draftAnswers, [questionId]: answer }
    setDraftAnswers(next)
    setActiveIndex((prev) => Math.min(request.questions.length - 1, prev + 1))
    if (presentation === "bot" && !answer.additionalTextOpen) submitDraftAnswers(next)
  }

  const openAdditionalText = (questionId: string, optionIndex: number): void => {
    setDraftAnswers((prev) => {
      const current = prev[questionId]
      const additionalText =
        current?.type === "option" && current.optionIndex === optionIndex
          ? current.additionalText
          : undefined
      return {
        ...prev,
        [questionId]: {
          type: "option",
          optionIndex,
          additionalText,
          additionalTextOpen: true
        }
      }
    })
  }

  const updateAdditionalText = (
    questionId: string,
    optionIndex: number,
    additionalText: string
  ): void => {
    setDraftAnswers((prev) => ({
      ...prev,
      [questionId]: {
        type: "option",
        optionIndex,
        additionalText,
        additionalTextOpen: true
      }
    }))
  }

  function submitDraftAnswers(drafts: Readonly<Record<string, DraftAnswer>>): void {
    if (!request) return
    const answers = userInputAnswers(request.questions, drafts, presentation === "bot")
    if (!answers) return
    onSubmit({
      requestId: request.requestId,
      answers,
      submittedAt: new Date().toISOString()
    })
  }
  const handleSubmit = (): void => submitDraftAnswers(draftAnswers)

  if (presentation === "bot") {
    const activeQuestion = request.questions[Math.min(activeIndex, request.questions.length - 1)]
    if (!activeQuestion) return null
    const activeDraft = draftAnswers[activeQuestion.id]
    return (
      <BotQuestionInput
        request={request}
        activeIndex={Math.min(activeIndex, request.questions.length - 1)}
        draft={activeDraft}
        complete={canSubmit}
        useComposerForSingleAnswer={useComposerForSingleAnswer}
        remainingLabel={
          remainingSeconds === null
            ? null
            : `将在 ${formatRemainingTime(remainingSeconds)}后自动继续`
        }
        onChoose={(index) => selectOption(activeQuestion.id, index)}
        onAdditional={(index) => openAdditionalText(activeQuestion.id, index)}
        onEditAdditional={(index, value) => updateAdditionalText(activeQuestion.id, index, value)}
        onEditCustom={(text) => updateDraft(activeQuestion.id, { type: "other", text })}
        onNavigate={setActiveIndex}
        onContinue={() => {
          if (canSubmit) handleSubmit()
          else {
            const next = request.questions.findIndex(
              (question) =>
                userInputAnswers([question], draftAnswers, presentation === "bot") === null
            )
            if (next >= 0) setActiveIndex(next)
          }
        }}
        onIgnore={handleIgnore}
      />
    )
  }

  const handleAnswerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229) return
    // These answer fields live inside the chat form. Native implicit submission would
    // send that unrelated draft while this question still owns the input surface.
    event.preventDefault()
    event.stopPropagation()
    if (!event.shiftKey && !event.repeat) handleSubmit()
  }

  const renderQuestions = (shownQuestions: UserInputRequest["questions"]): React.ReactNode => {
    if (collapsed) return null
    const activeQuestion = shownQuestions[Math.min(activeIndex, request.questions.length - 1)]
    if (!activeQuestion) return null
    const activeDraft = draftAnswers[activeQuestion.id]
    return (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <section className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 rounded-sm bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                {activeQuestion.header || `Q${activeIndex + 1}`}
              </span>
              <div className="min-w-0">
                <div className="break-words text-sm font-medium leading-5">
                  {activeQuestion.question}
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {activeQuestion.multiSelect === true
                    ? "可多选 · 至少选择一项"
                    : activeQuestion.id}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div
                className="space-y-2"
                role={activeQuestion.multiSelect ? "group" : "radiogroup"}
                aria-label={activeQuestion.question}
              >
                {activeQuestion.options.map((option, optionIndex) => {
                  const selected =
                    (activeDraft?.type === "option" && activeDraft.optionIndex === optionIndex) ||
                    (activeDraft?.type === "options" &&
                      activeDraft.optionIndices.includes(optionIndex))
                  return (
                    <div
                      key={`${activeQuestion.id}-${optionIndex}`}
                      className={cn(
                        "overflow-hidden rounded-md border transition-colors",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border bg-background hover:bg-background-interactive"
                      )}
                    >
                      <button
                        type="button"
                        role={activeQuestion.multiSelect ? "checkbox" : "radio"}
                        aria-checked={selected}
                        className="flex w-full items-start gap-3 px-3 py-2 text-left"
                        onClick={() => selectOption(activeQuestion.id, optionIndex)}
                      >
                        {activeQuestion.multiSelect ? (
                          selected ? (
                            <CheckSquare className="mt-0.5 size-4 shrink-0 text-primary" />
                          ) : (
                            <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          )
                        ) : selected ? (
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                        ) : (
                          <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0">
                          <span className="block break-words text-sm font-medium">
                            {option.label}
                          </span>
                          <span className="mt-0.5 block break-words text-xs leading-5 text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                      </button>
                      {!activeQuestion.multiSelect &&
                        (selected &&
                        activeDraft?.type === "option" &&
                        activeDraft.additionalTextOpen ? (
                          <div className="flex items-center gap-2 border-t border-primary/20 px-3 py-2">
                            <PencilLine className="size-3.5 shrink-0 text-muted-foreground" />
                            <input
                              autoFocus
                              type="text"
                              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                              value={activeDraft.additionalText ?? ""}
                              aria-label={`${option.label}的补充说明`}
                              onKeyDown={handleAnswerKeyDown}
                              onChange={(event) =>
                                updateAdditionalText(
                                  activeQuestion.id,
                                  optionIndex,
                                  event.target.value
                                )
                              }
                            />
                          </div>
                        ) : (
                          <div className="px-3 pb-2 pl-10">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground/80 transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`为${option.label}添加补充说明`}
                              onClick={() => openAdditionalText(activeQuestion.id, optionIndex)}
                            >
                              <PencilLine className="size-3 shrink-0" />
                              <span>补充说明</span>
                            </button>
                          </div>
                        ))}
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 transition-colors hover:bg-background-interactive focus-within:border-primary focus-within:bg-primary/10">
                <PencilLine className="size-4 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  value={activeDraft?.type === "other" ? activeDraft.text : ""}
                  aria-label="自定义回答"
                  onKeyDown={handleAnswerKeyDown}
                  placeholder="以上都不是我想要的，我希望："
                  onFocus={() => {
                    if (activeDraft?.type !== "other") {
                      updateDraft(activeQuestion.id, { type: "other", text: "" })
                    }
                  }}
                  onChange={(event) =>
                    updateDraft(activeQuestion.id, {
                      type: "other",
                      text: event.target.value
                    })
                  }
                />
              </div>
            </div>
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
          <nav className="flex items-center gap-1" aria-label="问题导航">
            {shownQuestions.map((question, questionIndex) => (
              <Button
                key={question.id}
                type="button"
                variant={questionIndex === activeIndex ? "default" : "outline"}
                size="icon-sm"
                className="size-8"
                aria-label={`切换到第 ${questionIndex + 1} 题：${question.header}`}
                aria-current={questionIndex === activeIndex ? "step" : undefined}
                onClick={() => setActiveIndex(questionIndex)}
              >
                {questionIndex + 1}
              </Button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleIgnore}>
              跳过全部问题
            </Button>
            <Button type="button" size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              {request.recoveryRequired ? "保存答案并检查续接" : "提交"}
            </Button>
          </div>
        </div>
      </>
    )
  }

  return (
    <div
      ref={dialogRef}
      className={cn(
        "absolute z-30 flex items-stretch overflow-hidden rounded-[calc(1.5rem+1px)] border border-primary/25 bg-background shadow-[0_-12px_30px_rgba(15,23,42,0.08)] transition-[inset,min-height,max-height] duration-200",
        collapsed
          ? "-inset-x-px -top-px bottom-12"
          : "-inset-x-px bottom-12 min-h-[320px] max-h-[520px]"
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-input-dialog-title"
        className={cn(
          "flex min-h-0 w-full flex-col overflow-hidden rounded-[inherit]",
          collapsed && "h-full"
        )}
      >
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 px-4",
            collapsed ? "h-full py-0" : "border-b border-border py-3"
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MessageSquareText className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="user-input-dialog-title" className="text-sm font-semibold">
              需要用户输入
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {answeredCount}/{request.questions.length} 已选择
              {remainingSeconds !== null && (
                <> · 将在 {formatRemainingTime(remainingSeconds)}后自动继续</>
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            aria-label={collapsed ? "展开用户输入面板" : "折叠用户输入面板"}
            title={collapsed ? "展开" : "折叠"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </div>

        <div
          role="region"
          aria-label="问题内容与补充说明"
          tabIndex={0}
          data-user-input-content
          className={collapsed ? "hidden" : "min-h-0 flex-1 overflow-y-auto overscroll-contain"}
        >
          {request.recoveryRequired && (
            <p role="status" className="border-b border-border px-4 py-3 text-sm">
              此问题已保存。提交后系统会检查原任务是否能安全续接；无法确认时保留答案，并在任务记录中提示下一步。
            </p>
          )}
          <FunctionFeedback threadId={request.threadId} requestId={request.requestId} />
          <FunctionQuestionSite
            key={request.requestId}
            request={request}
            renderQuestions={renderQuestions}
          />
        </div>
      </div>
    </div>
  )
}
