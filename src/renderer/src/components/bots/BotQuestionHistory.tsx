import { Check } from "lucide-react"
import type { BotQuestionHistory as QuestionHistory } from "@/lib/bot-question-history"

const statusLabels = {
  submitted: "已回答",
  ignored: "已跳过",
  auto_resolved: "已自动结束"
}

/** Settled questions reuse the original receipt; pending input stays in the existing dialog. */
export function BotQuestionHistory({ history }: { history: QuestionHistory }) {
  return (
    <div className="bot-question-history" data-state={history.status}>
      {history.questions.map((question) => (
        <section key={question.id} className="bot-question-card" aria-label={question.question}>
          <header>
            <span>{question.question}</span>
            <span className="bot-question-status">{statusLabels[history.status]}</span>
          </header>
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
