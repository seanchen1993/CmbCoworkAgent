import { normalizeQuestionDef } from "../../../shared/managed-design-session"

/** Read only closed top-level question objects; partial JSON never reaches the UI. */
export function readCompleteDesignQuestions(text: string): unknown[] {
  let body = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, "").trim()
  const form = /<question-form\b[^>]*>/i.exec(body)
  if (form) body = body.slice(form.index + form[0].length)
  body = body.replace(/^```(?:json)?\s*/i, "").trimStart()
  const field = /"questions"\s*:\s*\[/.exec(body)
  const start = field ? field.index + field[0].length - 1 : body.startsWith("[") ? 0 : -1
  if (start < 0) return []
  const questions: unknown[] = []
  let depth = 1,
    objectStart = -1,
    inString = false,
    escaped = false
  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString && ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{" || ch === "[") {
      if (depth === 1 && ch === "{") objectStart = i
      depth++
    } else if (ch === "}" || ch === "]") {
      depth--
      if (depth === 0) break
      if (depth === 1 && ch === "}" && objectStart >= 0) {
        try {
          const question: unknown = JSON.parse(body.slice(objectStart, i + 1))
          if (normalizeQuestionDef(question)) questions.push(question)
        } catch {
          /* The final compatibility parser may repair malformed JSON. */
        }
        objectStart = -1
      }
    }
  }
  return questions
}

export class DesignQuestionStream {
  private text = ""
  private readonly seen = new Set<string>()
  readonly questions: unknown[] = []

  push(token: string): unknown[] {
    this.text += token
    const added: unknown[] = []
    for (const question of readCompleteDesignQuestions(this.text)) {
      const id = normalizeQuestionDef(question)!.id
      if (this.seen.has(id)) continue
      this.seen.add(id)
      this.questions.push(question)
      added.push(question)
    }
    return added
  }
}
