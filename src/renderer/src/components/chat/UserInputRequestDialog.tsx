import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  MessageSquareText,
  PencilLine,
  Square,
  SquareCheck,
  X,
  ArrowUp
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { UserInputAnswer, UserInputRequest, UserInputResponse } from "@/types"

type DraftAnswer =
  | { type: "multiple"; optionIndices: number[] }
  | {
      type: "option"
      optionIndex: number
      additionalText?: string
      additionalTextOpen?: boolean
    }
  | { type: "other"; text: string }

interface UserInputRequestDialogProps {
  request: UserInputRequest | null
  onSubmit: (response: UserInputResponse) => void
  onLayoutChange?: (layout: UserInputRequestDialogLayout | null) => void
  layout?: "overlay" | "inline"
  disabled?: boolean
  maxTextLength?: number
  /** One optional conversational choice; ordinary task questions retain their form. */
  variant?: "form" | "conversation"
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

export function UserInputRequestDialog(props: UserInputRequestDialogProps): React.JSX.Element {
  // A new request owns a fresh form; polling the same request preserves the user's answers.
  return <UserInputRequestBody key={props.request?.requestId ?? "none"} {...props} />
}

function UserInputRequestBody({
  request,
  onSubmit,
  onLayoutChange,
  layout = "overlay",
  disabled = false,
  maxTextLength,
  variant = "form"
}: UserInputRequestDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLFieldSetElement>(null)
  const titleId = useId()
  const [draftAnswers, setDraftAnswers] = useState<Record<string, DraftAnswer>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const remainingSeconds = request?.autoResolutionMs
    ? Math.max(
        0,
        Math.ceil(
          (new Date(request.createdAt).getTime() + request.autoResolutionMs - clockNow) / 1000
        )
      )
    : null

  useEffect(() => {
    if (!request?.autoResolutionMs) return
    const interval = window.setInterval(() => setClockNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [request?.autoResolutionMs, request?.createdAt, request?.requestId])

  const handleIgnore = useCallback((): void => {
    if (!request || disabled) return
    onSubmit({
      requestId: request.requestId,
      answers: {},
      submittedAt: new Date().toISOString(),
      ignored: true
    })
  }, [disabled, onSubmit, request])

  useEffect(() => {
    if (!request || layout === "inline") return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || useAppStore.getState().showCustomizeView) return
      if (event.key !== "Escape") return
      event.preventDefault()
      handleIgnore()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleIgnore, layout, request])

  useEffect(() => {
    if (!onLayoutChange) return
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
  }, [activeIndex, collapsed, onLayoutChange, request])

  const canSubmit = useMemo(() => {
    if (!request) return false
    return request.questions.every((question) => {
      const answer = draftAnswers[question.id]
      if (!answer) return false
      if (answer.type === "other") return answer.text.trim().length > 0
      if (answer.type === "multiple")
        return (
          answer.optionIndices.length > 0 &&
          answer.optionIndices.every((index) => question.options[index] !== undefined)
        )
      return question.options[answer.optionIndex] !== undefined
    })
  }, [draftAnswers, request])

  if (!request) return null
  const activeQuestion = request.questions[Math.min(activeIndex, request.questions.length - 1)]
  if (!activeQuestion) return null

  const activeDraft = draftAnswers[activeQuestion.id]
  const answeredCount = request.questions.filter((question) => {
    const answer = draftAnswers[question.id]
    if (!answer) return false
    if (answer.type === "other") return answer.text.trim().length > 0
    if (answer.type === "multiple")
      return (
        answer.optionIndices.length > 0 &&
        answer.optionIndices.every((index) => question.options[index] !== undefined)
      )
    return question.options[answer.optionIndex] !== undefined
  }).length

  const updateDraft = (questionId: string, answer: DraftAnswer): void => {
    setDraftAnswers((prev) => ({ ...prev, [questionId]: answer }))
  }

  const selectOption = (questionId: string, optionIndex: number): void => {
    if (request.questions.find((question) => question.id === questionId)?.multiple) {
      setDraftAnswers((prev) => {
        const current = prev[questionId]
        const selected = current?.type === "multiple" ? current.optionIndices : []
        return {
          ...prev,
          [questionId]: {
            type: "multiple",
            optionIndices: selected.includes(optionIndex)
              ? selected.filter((index) => index !== optionIndex)
              : [...selected, optionIndex].sort((a, b) => a - b)
          }
        }
      })
      return
    }
    setDraftAnswers((prev) => {
      const current = prev[questionId]
      const answer =
        current?.type === "option" && current.optionIndex === optionIndex
          ? current
          : { type: "option" as const, optionIndex }
      return { ...prev, [questionId]: answer }
    })
    setActiveIndex((prev) => Math.min(request.questions.length - 1, prev + 1))
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

  const handleSubmit = (): void => {
    if (!canSubmit || disabled) return
    const answers: Record<string, UserInputAnswer> = {}

    for (const question of request.questions) {
      const answer = draftAnswers[question.id]
      if (!answer) continue
      if (answer.type === "multiple") {
        answers[question.id] = {
          type: "multiple",
          questionId: question.id,
          optionIndices: answer.optionIndices,
          labels: answer.optionIndices.map((index) => question.options[index].label)
        }
        continue
      }
      if (answer.type === "other") {
        answers[question.id] = {
          type: "other",
          questionId: question.id,
          text: answer.text
        }
        continue
      }

      const option = question.options[answer.optionIndex]
      if (!option) continue
      const additionalText = answer.additionalText?.trim()
      answers[question.id] = {
        type: "option",
        questionId: question.id,
        optionIndex: answer.optionIndex,
        label: option.label,
        description: option.description,
        ...(additionalText ? { additionalText } : {})
      }
    }

    onSubmit({
      requestId: request.requestId,
      answers,
      submittedAt: new Date().toISOString()
    })
  }

  if (
    variant === "conversation" &&
    layout === "inline" &&
    request.questions.length === 1 &&
    !activeQuestion.multiple
  )
    return (
      <fieldset
        ref={dialogRef}
        disabled={disabled}
        aria-labelledby={titleId}
        aria-busy={disabled || undefined}
        className="min-w-0 space-y-3 rounded-2xl border border-border/60 bg-muted/30 p-4"
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="min-w-0 flex-1 break-words text-sm font-medium leading-6">
            {activeQuestion.question}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="忽略问题"
            title="忽略问题"
            onClick={handleIgnore}
            className="size-7 shrink-0 rounded-full text-muted-foreground"
          >
            <X size={14} />
          </Button>
        </div>
        {!!activeQuestion.options.length && (
          <div
            role="group"
            aria-label={activeQuestion.question}
            className="overflow-hidden rounded-xl border border-border/60 bg-background-elevated/50"
          >
            {activeQuestion.options.map((option, optionIndex) => (
              <Button
                type="button"
                variant="ghost"
                key={optionIndex}
                className="h-auto w-full justify-start gap-3 whitespace-normal rounded-none border-b border-border/60 px-3 py-2.5 text-left font-normal last:border-b-0 focus-visible:ring-inset motion-reduce:transition-none"
                onClick={() => {
                  if (disabled) return
                  onSubmit({
                    requestId: request.requestId,
                    submittedAt: new Date().toISOString(),
                    answers: {
                      [activeQuestion.id]: {
                        type: "option",
                        questionId: activeQuestion.id,
                        optionIndex,
                        label: option.label,
                        description: option.description
                      }
                    }
                  })
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground"
                >
                  {String.fromCharCode(65 + optionIndex)}
                </span>
                <span className="min-w-0 break-words">
                  <span className="block text-sm">{option.label}</span>
                  {!!option.description && (
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-background/70 pl-3 pr-1">
          <input
            type="text"
            maxLength={maxTextLength}
            aria-label="自定义回答"
            placeholder="也可以直接告诉我…"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            value={activeDraft?.type === "other" ? activeDraft.text : ""}
            onChange={(event) =>
              updateDraft(activeQuestion.id, { type: "other", text: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              handleSubmit()
            }}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="发送回答"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="rounded-full"
          >
            <ArrowUp size={15} />
          </Button>
        </div>
      </fieldset>
    )

  return (
    <fieldset
      ref={dialogRef}
      disabled={disabled}
      aria-busy={disabled || undefined}
      className={cn(
        "z-30 flex min-w-0 items-stretch overflow-hidden border border-primary/25 bg-background transition-[inset,min-height,max-height] duration-200",
        layout === "inline"
          ? "relative w-full rounded-xl shadow-sm"
          : "absolute rounded-[calc(1.5rem+1px)] shadow-[0_-12px_30px_rgba(15,23,42,0.08)]",
        layout === "inline"
          ? collapsed
            ? "h-16"
            : "min-h-[320px] max-h-[520px]"
          : collapsed
            ? "-inset-x-px -top-px bottom-12"
            : "-inset-x-px bottom-12 min-h-[320px] max-h-[520px]"
      )}
    >
      <div
        role={layout === "inline" ? "group" : "dialog"}
        aria-modal={layout === "overlay" ? true : undefined}
        aria-labelledby={titleId}
        className={cn(
          "flex min-h-0 w-full flex-col overflow-hidden rounded-[inherit]",
          collapsed && "h-full"
        )}
      >
        <div
          className={cn(
            "flex items-center gap-3 px-4",
            collapsed ? "h-full py-0" : "border-b border-border py-3"
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MessageSquareText className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-semibold">
              {layout === "inline" ? "请补充信息" : "需要用户输入"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {answeredCount}/{request.questions.length} {layout === "inline" ? "已填写" : "已选择"}
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

        {!collapsed && (
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
                      {activeQuestion.multiple && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          可多选
                        </span>
                      )}
                    </div>
                    {layout === "overlay" && (
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {activeQuestion.id}
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div
                    className="space-y-2"
                    role={activeQuestion.multiple ? "group" : "radiogroup"}
                    aria-label={activeQuestion.question}
                  >
                    {activeQuestion.options.map((option, optionIndex) => {
                      const selected =
                        activeDraft?.type === "multiple"
                          ? activeDraft.optionIndices.includes(optionIndex)
                          : activeDraft?.type === "option" &&
                            activeDraft.optionIndex === optionIndex
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
                            role={activeQuestion.multiple ? "checkbox" : "radio"}
                            aria-checked={selected}
                            className="flex w-full items-start gap-3 px-3 py-2 text-left"
                            onClick={() => selectOption(activeQuestion.id, optionIndex)}
                          >
                            {activeQuestion.multiple ? (
                              selected ? (
                                <SquareCheck className="mt-0.5 size-4 shrink-0 text-primary" />
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
                          {selected &&
                          activeDraft?.type === "option" &&
                          activeDraft.additionalTextOpen ? (
                            <div className="flex items-center gap-2 border-t border-primary/20 px-3 py-2">
                              <PencilLine className="size-3.5 shrink-0 text-muted-foreground" />
                              <input
                                autoFocus
                                type="text"
                                maxLength={maxTextLength}
                                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                                value={activeDraft.additionalText ?? ""}
                                aria-label={`${option.label}的补充说明`}
                                onChange={(event) =>
                                  updateAdditionalText(
                                    activeQuestion.id,
                                    optionIndex,
                                    event.target.value
                                  )
                                }
                              />
                            </div>
                          ) : !activeQuestion.multiple ? (
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
                          ) : null}
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 transition-colors hover:bg-background-interactive focus-within:border-primary focus-within:bg-primary/10">
                    <PencilLine className="size-4 shrink-0 text-muted-foreground" />
                    <input
                      type="text"
                      maxLength={maxTextLength}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      value={activeDraft?.type === "other" ? activeDraft.text : ""}
                      aria-label={
                        layout === "inline" ? `回答 ${activeQuestion.header}` : "自定义回答"
                      }
                      placeholder={
                        activeQuestion.options.length ? "以上都不是我想要的，我希望：" : "填写回答…"
                      }
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

            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              <nav className="flex items-center gap-1" aria-label="问题导航">
                {request.questions.map((question, questionIndex) => (
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
                  {layout === "inline" ? "取消回答" : "跳过全部问题"}
                </Button>
                <Button type="button" size="sm" onClick={handleSubmit} disabled={!canSubmit}>
                  提交
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </fieldset>
  )
}
