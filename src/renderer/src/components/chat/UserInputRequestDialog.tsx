import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  MessageSquareText
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { UserInputAnswer, UserInputRequest, UserInputResponse } from "@/types"

type DraftAnswer =
  | { type: "option"; optionIndex: number }
  | { type: "other"; text: string }

interface UserInputRequestDialogProps {
  request: UserInputRequest | null
  onSubmit: (response: UserInputResponse) => void
  onLayoutChange?: (layout: UserInputRequestDialogLayout | null) => void
}

export interface UserInputRequestDialogLayout {
  height: number
  top: number
  bottom: number
}

export function UserInputRequestDialog({
  request,
  onSubmit,
  onLayoutChange
}: UserInputRequestDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [draftAnswers, setDraftAnswers] = useState<Record<string, DraftAnswer>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setDraftAnswers({})
    setActiveIndex(0)
    setCollapsed(false)
  }, [request?.requestId])

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
    if (!request) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      event.preventDefault()
      handleIgnore()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleIgnore, request])

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
      if (answer.type === "other") return answer.text.length > 0
      return question.options[answer.optionIndex] !== undefined
    })
  }, [draftAnswers, request])

  if (!request) return null
  const activeQuestion = request.questions[Math.min(activeIndex, request.questions.length - 1)]
  if (!activeQuestion) return null

  const activeDraft = draftAnswers[activeQuestion.id]
  const otherSelected = activeDraft?.type === "other"
  const answeredCount = request.questions.filter((question) => {
    const answer = draftAnswers[question.id]
    if (!answer) return false
    if (answer.type === "other") return answer.text.length > 0
    return question.options[answer.optionIndex] !== undefined
  }).length

  const updateDraft = (questionId: string, answer: DraftAnswer): void => {
    setDraftAnswers((prev) => ({ ...prev, [questionId]: answer }))
  }

  const selectOption = (questionId: string, optionIndex: number): void => {
    updateDraft(questionId, { type: "option", optionIndex })
    setActiveIndex((prev) => Math.min(request.questions.length - 1, prev + 1))
  }

  const handleSubmit = (): void => {
    if (!canSubmit) return
    const answers: Record<string, UserInputAnswer> = {}

    for (const question of request.questions) {
      const answer = draftAnswers[question.id]
      if (!answer) continue
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
      answers[question.id] = {
        type: "option",
        questionId: question.id,
        optionIndex: answer.optionIndex,
        label: option.label,
        description: option.description
      }
    }

    onSubmit({
      requestId: request.requestId,
      answers,
      submittedAt: new Date().toISOString()
    })
  }

  return (
    <div
      ref={dialogRef}
      className={cn(
        "absolute z-30 flex items-stretch overflow-hidden rounded-[calc(1.5rem+1px)] border border-primary/25 bg-background shadow-[0_-12px_30px_rgba(15,23,42,0.08)] transition-[inset,min-height,max-height] duration-200",
        collapsed
          ? "-inset-px"
          : "-inset-x-px -bottom-px min-h-[320px] max-h-[520px]"
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
            "flex items-center gap-3 px-4",
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
            </p>
          </div>
          {request.questions.length > 1 && (
            <div className="shrink-0 text-xs text-muted-foreground">
              {activeIndex + 1}/{request.questions.length}
            </div>
          )}
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
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {activeQuestion.id}
                    </div>
                  </div>
                </div>

                <div className="space-y-2" role="radiogroup" aria-label={activeQuestion.question}>
                  {activeQuestion.options.map((option, optionIndex) => {
                    const selected =
                      activeDraft?.type === "option" && activeDraft.optionIndex === optionIndex
                    return (
                      <button
                        key={`${activeQuestion.id}-${optionIndex}`}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                          selected
                            ? "border-primary bg-primary/10"
                            : "border-border bg-background hover:bg-background-interactive"
                        )}
                        onClick={() => selectOption(activeQuestion.id, optionIndex)}
                      >
                        {selected ? (
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
                    )
                  })}

                  <div
                    className={cn(
                      "rounded-md border transition-colors",
                      otherSelected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background hover:bg-background-interactive"
                    )}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={otherSelected}
                      className="flex w-full items-start gap-3 px-3 py-2 text-left"
                      onClick={() =>
                        updateDraft(activeQuestion.id, {
                          type: "other",
                          text: activeDraft?.type === "other" ? activeDraft.text : ""
                        })
                      }
                    >
                      {otherSelected ? (
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                      ) : (
                        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="block min-w-0 text-sm font-medium">其他</span>
                    </button>
                    {otherSelected && (
                      <div className="px-3 pb-3 pl-10">
                        <textarea
                          className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={activeDraft.type === "other" ? activeDraft.text : ""}
                          onChange={(event) =>
                            updateDraft(activeQuestion.id, {
                              type: "other",
                              text: event.target.value
                            })
                          }
                          autoFocus
                        />
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={activeIndex === 0}
                  onClick={() => setActiveIndex((prev) => Math.max(0, prev - 1))}
                  aria-label="上一题"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={activeIndex >= request.questions.length - 1}
                  onClick={() =>
                    setActiveIndex((prev) => Math.min(request.questions.length - 1, prev + 1))
                  }
                  aria-label="下一题"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleIgnore}>
                  忽略
                </Button>
                <Button type="button" size="sm" onClick={handleSubmit} disabled={!canSubmit}>
                  提交
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
