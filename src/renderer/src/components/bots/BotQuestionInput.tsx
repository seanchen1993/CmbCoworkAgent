import { ArrowUp, ChevronLeft, ChevronRight, PencilLine, X } from "lucide-react"
import type { UserInputRequest } from "@/types"
import { userInputAnswers, type UserInputDraftAnswer } from "@/lib/user-input-answer"

/** Grok's inline question layout, using the original request dialog's state and response path. */
export function BotQuestionInput({
  request,
  activeIndex,
  draft,
  complete,
  useComposerForSingleAnswer = false,
  remainingLabel,
  onChoose,
  onAdditional,
  onEditAdditional,
  onEditCustom,
  onNavigate,
  onContinue,
  onIgnore
}: {
  request: UserInputRequest
  activeIndex: number
  draft?: UserInputDraftAnswer
  complete: boolean
  useComposerForSingleAnswer?: boolean
  remainingLabel: string | null
  onChoose(index: number): void
  onAdditional(index: number): void
  onEditAdditional(index: number, text: string): void
  onEditCustom(text: string): void
  onNavigate(index: number): void
  onContinue(): void
  onIgnore(): void
}) {
  const question = request.questions[activeIndex]
  const titleId = `${request.requestId}-question`
  const answered =
    userInputAnswers([question], draft ? { [question.id]: draft } : {}, true) !== null
  const showCustomInput =
    request.questions.length > 1 || !useComposerForSingleAnswer || draft?.type === "other"
  const singleMultiple = question.allowMultiple === true && request.questions.length === 1
  const submitLabel = singleMultiple ? "完成" : complete ? "提交回答" : "继续回答下一题"
  return (
    <div className="bot-question-history">
      <section
        className="bot-question-card bot-question-input"
        data-multiple={question.allowMultiple || undefined}
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey ||
            event.key.length !== 1 ||
            (event.target instanceof HTMLElement &&
              event.target.closest('input, textarea, select, [contenteditable="true"]'))
          )
            return
          const index = event.key.toUpperCase().charCodeAt(0) - 65
          if (index < 0 || index >= question.options.length) return
          event.preventDefault()
          onChoose(index)
        }}
      >
        <header>
          <span id={titleId}>{question.question}</span>
          <button
            type="button"
            className="bot-question-dismiss"
            aria-label={request.questions.length > 1 ? "跳过全部问题" : "跳过问题"}
            title="跳过"
            onClick={onIgnore}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {remainingLabel && <p>{remainingLabel}</p>}
        {question.allowMultiple && <p>选择所有适用项</p>}
        <div className="bot-question-options">
          {question.options.map((option, index) => {
            const selected =
              draft?.type === "options"
                ? draft.optionIndices.includes(index)
                : draft?.type === "option" && draft.optionIndex === index
            return (
              <div className="bot-question-option" data-selected={selected} key={index}>
                <button
                  type="button"
                  aria-pressed={question.allowMultiple ? selected : undefined}
                  onClick={() => onChoose(index)}
                >
                  <span className="bot-question-key" aria-hidden="true">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span>
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
                {!question.allowMultiple && (
                  <button
                    type="button"
                    className="bot-question-additional"
                    aria-label={`为${option.label}添加补充说明`}
                    title="补充说明"
                    onClick={() => onAdditional(index)}
                  >
                    <PencilLine size={14} aria-hidden="true" />
                  </button>
                )}
                {selected && draft?.type === "option" && draft.additionalTextOpen && (
                  <textarea
                    autoFocus
                    rows={1}
                    aria-label={`${option.label}的补充说明`}
                    placeholder="补充说明…"
                    value={draft.additionalText ?? ""}
                    onChange={(event) => onEditAdditional(index, event.target.value)}
                  />
                )}
              </div>
            )
          })}
        </div>
        {showCustomInput && (
          <div className="bot-question-custom">
            <textarea
              rows={1}
              aria-label="自定义回答"
              placeholder="其他，请说明…"
              value={draft?.type === "other" ? draft.text : ""}
              onFocus={() => {
                if (draft?.type !== "other") onEditCustom("")
              }}
              onChange={(event) => onEditCustom(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return
                event.preventDefault()
                event.stopPropagation()
                if (answered) onContinue()
              }}
            />
          </div>
        )}
        {(request.questions.length > 1 || answered || question.allowMultiple) && (
          <footer>
            {request.questions.length > 1 ? (
              <nav aria-label="问题导航">
                <button
                  type="button"
                  aria-label="上一题"
                  disabled={activeIndex === 0}
                  onClick={() => onNavigate(activeIndex - 1)}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <span>
                  {activeIndex + 1} / {request.questions.length}
                </span>
                <button
                  type="button"
                  aria-label="下一题"
                  disabled={activeIndex === request.questions.length - 1}
                  onClick={() => onNavigate(activeIndex + 1)}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </nav>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="bot-question-submit"
              aria-label={submitLabel}
              title={submitLabel}
              disabled={!answered && !singleMultiple}
              onClick={singleMultiple && !answered ? onIgnore : onContinue}
            >
              {question.allowMultiple ? (
                complete || request.questions.length === 1 ? (
                  "完成"
                ) : (
                  "继续"
                )
              ) : complete ? (
                <ArrowUp size={16} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} aria-hidden="true" />
              )}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}
