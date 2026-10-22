import { MessageCircle } from "lucide-react"
import type { BotQuestionHistory } from "@/lib/bot-question-history"
import { botSessionDate } from "@/lib/bot-message-date"

/** A native submitted receipt is a read-only answer, never a new group instruction. */
export function BotGroupQuestionAnswer({
  history,
  previousAt,
  onQuote
}: {
  history: BotQuestionHistory
  previousAt: number
  onQuote(): void
}) {
  if (history.status !== "submitted" || history.submittedAt === undefined) return null
  const date = botSessionDate(history.submittedAt, previousAt)
  return (
    <>
      {date && <div className="bot-message-date">{date}</div>}
      <article className="bot-group-message" data-user="true" aria-label="你对 Bot 提问的回答">
        {history.questions.map((question) =>
          question.answer ? (
            <div className="bot-group-answer-line" key={question.id}>
              <div className="bot-group-bubble">
                <button
                  type="button"
                  className="bot-group-reply-preview"
                  aria-label={`跳转到问题：${question.question}`}
                  onClick={onQuote}
                >
                  <MessageCircle size={14} />
                  <span>“{question.question}”</span>
                </button>
                <div className="bot-group-answer-text">
                  {question.answer.text}
                  {question.answer.additionalText && `\n${question.answer.additionalText}`}
                </div>
              </div>
            </div>
          ) : null
        )}
        <time
          className="bot-group-message-time"
          dateTime={new Date(history.submittedAt).toISOString()}
        >
          {new Date(history.submittedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
          })}
        </time>
      </article>
    </>
  )
}
