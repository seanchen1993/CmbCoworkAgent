import { PulsingDot } from "./common"
import { S } from "./styles"
import type { AnswerValue, QuestionDef } from "./types"

export function QuestionsPanel({
  questions,
  answers,
  isLoading,
  onAnswer,
  onContinue,
  onSkip,
}: {
  questions: QuestionDef[]
  answers: Record<string, AnswerValue>
  isLoading: boolean
  onAnswer: (id: string, value: AnswerValue) => void
  onContinue: () => void
  onSkip: () => void
}) {
  function isAnswered(q: QuestionDef): boolean {
    const v = answers[q.id]
    if (!v) return false
    if (Array.isArray(v)) return v.length > 0
    return v.trim().length > 0
  }

  const answeredCount = questions.filter(isAnswered).length
  const requiredQuestions = questions.filter((q) => q.required)
  const allAnswered = requiredQuestions.length > 0
    ? requiredQuestions.every(isAnswered)
    : questions.length > 0

  function toggleChip(qId: string, opt: string, multi: boolean) {
    if (!multi) {
      onAnswer(qId, opt)
      return
    }
    const current = answers[qId]
    const arr: string[] = Array.isArray(current) ? current : (current ? [current as string] : [])
    const q = questions.find((item) => item.id === qId)
    const nextRaw = arr.includes(opt) ? arr.filter((v) => v !== opt) : [...arr, opt]
    const next = q?.maxSelections ? nextRaw.slice(-q.maxSelections) : nextRaw
    onAnswer(qId, next)
  }

  function isChipSelected(qId: string, opt: string): boolean {
    const v = answers[qId]
    if (Array.isArray(v)) return v.includes(opt)
    return v === opt
  }

  if (isLoading) {
    return (
      <div style={{ ...S.canvasEmpty, flexDirection: "column", gap: 12 }}>
        <PulsingDot />
        <span style={{ fontSize: 14, color: "#8a8a8a" }}>正在生成问题...</span>
      </div>
    )
  }

  if (questions.length === 0) {
    return (
      <div style={{ ...S.canvasEmpty, flexDirection: "column", gap: 12 }}>
        <span style={{ fontSize: 14, color: "#8a8a8a" }}>没有生成可用的问题，可以跳过并直接生成。</span>
        <button
          onClick={onSkip}
          style={{ ...S.continueBtn, background: "#1a1a1a", color: "#ffffff" }}
        >
          跳过并生成
        </button>
      </div>
    )
  }

  return (
    <div style={S.questionsContainer}>
      <div style={S.questionsInner}>
        <h2 style={S.questionsTitle}>告诉我更多关于这个设计</h2>

        {questions.map((q) => {
          const answered = isAnswered(q)
          return (
            <div key={q.id} style={{ ...S.questionBlock, opacity: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <label style={S.questionLabel}>{q.label}</label>
                {q.type === "chips" && q.multi && (
                  <span style={{ fontSize: 11, color: "#8a8a8a", background: "#f0efeb", padding: "2px 7px", borderRadius: 999, fontWeight: 500 }}>
                    可多选
                  </span>
                )}
                {answered && (
                  <span style={{ fontSize: 11, color: "#4ade80", marginLeft: "auto" }}>✓</span>
                )}
              </div>
              {q.hint && <p style={S.questionHint}>{q.hint}</p>}

              {q.type === "direction-cards" && q.options ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
                  {q.options.map((opt) => {
                    const selected = isChipSelected(q.id, opt)
                    const card = q.cards?.find((item) => item.id === opt)
                    return (
                      <button
                        key={opt}
                        onClick={() => toggleChip(q.id, opt, false)}
                        style={{
                          textAlign: "left",
                          padding: 12,
                          borderRadius: 10,
                          border: selected ? "1px solid #1a1a1a" : "1px solid #d4d2cc",
                          background: selected ? "#fffdf8" : "#ffffff",
                          boxShadow: selected ? "0 4px 18px rgba(0,0,0,0.10)" : "none",
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        <div style={{ display: "flex", gap: 4, marginBottom: 9 }}>
                          {(card?.palette ?? []).slice(0, 6).map((color, index) => (
                            <span key={`${color}-${index}`} style={{
                              width: 22,
                              height: 16,
                              borderRadius: 4,
                              background: color,
                              border: "1px solid rgba(0,0,0,0.12)",
                            }} />
                          ))}
                        </div>
                        <div style={{ fontFamily: card?.displayFont, fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginBottom: 4 }}>
                          {card?.label ?? q.optionLabels?.[opt] ?? opt}
                        </div>
                        {card?.mood && <div style={{ fontSize: 12, color: "#6a6a6a", lineHeight: 1.45 }}>{card.mood}</div>}
                        {card?.references && card.references.length > 0 && (
                          <div style={{ fontSize: 10, color: "#9a9a9a", marginTop: 8 }}>
                            {card.references.slice(0, 4).join(" · ")}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              ) : q.type === "chips" && q.options ? (
                <div style={S.chipsRow}>
                  {q.options.map((opt) => {
                    const selected = isChipSelected(q.id, opt)
                    return (
                      <button
                        key={opt}
                        onClick={() => toggleChip(q.id, opt, q.multi ?? false)}
                        style={{
                          ...S.chip,
                          background: selected ? "#1a1a1a" : "#ffffff",
                          color: selected ? "#ffffff" : "#1a1a1a",
                          border: selected ? "1px solid #1a1a1a" : "1px solid #d4d2cc",
                          paddingLeft: q.multi && selected ? 10 : undefined,
                        }}
                      >
                        {q.multi && selected && <span style={{ marginRight: 5, fontSize: 11 }}>✓</span>}
                        {q.optionLabels?.[opt] ?? opt}
                      </button>
                    )
                  })}
                </div>
              ) : q.type === "textarea" ? (
                <textarea
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  placeholder="输入你的回答..."
                  rows={3}
                  style={S.questionTextarea}
                />
              ) : (
                <input
                  type="text"
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  placeholder="输入你的回答..."
                  style={S.questionInput}
                />
              )}
            </div>
          )
        })}
      </div>

      <div style={S.questionsFooter}>
        <span style={{ fontSize: 13, color: "#8a8a8a" }}>
          {allAnswered
            ? "可以生成"
            : `已回答 ${answeredCount} / ${questions.length}`}
        </span>
        <button
          onClick={onContinue}
          disabled={!allAnswered}
          style={{
            ...S.continueBtn,
            background: allAnswered ? "#1a1a1a" : "#d4d2cc",
            cursor: allAnswered ? "pointer" : "default",
          }}
        >
          继续 →
        </button>
      </div>
    </div>
  )
}
