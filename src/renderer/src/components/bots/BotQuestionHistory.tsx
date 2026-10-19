import { Check } from "lucide-react"
import type { BotQuestionHistory as QuestionHistory } from "@/lib/bot-question-history"

const statusLabels = {
  submitted: "已回答",
  ignored: "已忽略",
  auto_resolved: "已自动结束",
  cancelled: "已取消",
  interrupted: "已中断"
}

/** Receipts and proven stopped-turn states are display projections; pending input stays separate. */
export function BotQuestionHistory({ history }: { history: QuestionHistory }) {
  return (
    <div className="bot-question-history" data-state={history.status}>
      {history.questions.map((question) => (
        <section
          key={question.id}
          className="bot-question-card"
          role="group"
          aria-label={`${question.question}，${statusLabels[history.status]}`}
        >
          <header>
            <span>{question.question}</span>
            <span
              className={
                history.status === "ignored" && question.options?.length
                  ? "sr-only"
                  : "bot-question-status"
              }
            >
              {statusLabels[history.status]}
            </span>
          </header>
          {history.status === "ignored" && Boolean(question.options?.length) && (
            <div className="bot-question-options">
              {question.options?.map((option, index) => (
                <div className="bot-question-ignored-option" key={index}>
                  <span className="bot-question-ignored-key" aria-hidden="true">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <div>
                    <span>{option.label}</span>
                    {option.description && <p>{option.description}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {question.answer && (
            <div className="bot-question-answer">
              <div>
                <span>{question.answer.text}</span>
                {question.answer.additionalText && <p>{question.answer.additionalText}</p>}
              </div>
              {history.status === "submitted" && <Check size={16} aria-hidden="true" />}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
