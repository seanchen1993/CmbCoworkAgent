import type { UserInputRequest } from "@/types"
import type { BotGroupMessage } from "../../../shared/bots/contracts"
import { CHAT_SEARCH_INPUT_LIMIT, createChatSearchPlan } from "../../../shared/chat-search-plan"
import { chatSearchLocationKey } from "../../../shared/chat-search-types"
import { isFreeformUserInputOption } from "../../../shared/user-input-options"
import {
  boundDurableSearchPreview,
  CHAT_SEARCH_RESULT_LIMIT,
  type DurableChatSearchPage
} from "@/components/chat/ChatSearchOverlay"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"
import { botGroupQuestionHistory } from "./bot-question-history"
import type { ChatSearchDocument, ChatSearchMatch } from "./chat-search-matches"

type PublicQuestion = {
  question: string
  options?: UserInputRequest["questions"][number]["options"]
  answer?: { text: string; additionalText?: string }
}

function* publicQuestionText(questions: readonly PublicQuestion[]): Generator<string> {
  for (const question of questions) {
    yield question.question
    for (const option of question.options ?? []) {
      if (isFreeformUserInputOption(option.label)) continue
      yield option.label
      if (option.description) yield option.description
    }
    if (question.answer) {
      yield question.answer.text
      if (question.answer.additionalText) yield question.answer.additionalText
    }
  }
}

function publicDocument(
  messageId: string,
  sortIndex: number,
  role: "user" | "assistant",
  body: string,
  questions: readonly PublicQuestion[]
): ChatSearchDocument | null {
  const plan = createChatSearchPlan(role, body, { stripThink: role === "assistant" })
  let units = plan.segments.reduce((sum, segment) => sum + segment.raw.length + 1, 0)
  const fields: string[] = []
  for (const text of publicQuestionText(questions)) {
    if (!text) continue
    const remaining = Math.max(0, CHAT_SEARCH_INPUT_LIMIT - units - 1)
    if (text.length > remaining) plan.truncated = true
    if (remaining === 0) break
    const admitted = text.slice(0, remaining)
    fields.push(admitted)
    units += admitted.length + 1
    if (admitted.length < text.length) break
  }
  if (fields.length) {
    const raw = fields.join("\n")
    // These are public controls, not offsets in the Markdown body. The existing
    // context reveal handles their locations without inventing body coordinates.
    plan.segments.push({
      kind: "summary",
      blockIndex: -1,
      start: 0,
      end: raw.length,
      sourceLength: raw.length,
      raw
    })
  }
  if (!plan.truncated && !plan.segments.some((segment) => segment.raw.trim())) return null
  return {
    messageId,
    text: "",
    textUnits: units,
    plan,
    sortIndex,
    truncated: plan.truncated,
    durableAuthoritative: true
  }
}

/** Index only the public row, never its quote, peer exchange or file transport. */
export function botGroupSearchDocument(
  message: BotGroupMessage,
  pending?: UserInputRequest
): ChatSearchDocument | null {
  let questions: readonly PublicQuestion[] = []
  if (message.question) {
    const history = botGroupQuestionHistory(message.question)
    questions = history
      ? history.questions.map(({ question, options, answer }) => ({
          question,
          ...(history.status === "ignored" ? { options } : {}),
          ...(answer ? { answer } : {})
        }))
      : pending?.requestId === message.question.request.requestId
        ? pending.questions
        : message.question.request.questions.map(({ question }) => ({ question }))
  }
  return publicDocument(
    message.id,
    message.ordinal,
    message.authorBotId === null ? "user" : "assistant",
    // The original user plan cleans attachment transport after bounded admission.
    message.authorBotId === null ? message.text : splitBotInlineReasoning(message.text).body,
    questions
  )
}

/** A live inbox card keeps the exact existing virtual-row identity. */
export function botGroupPendingSearchDocument(
  request: UserInputRequest,
  sortIndex: number
): ChatSearchDocument | null {
  return publicDocument(
    `question-${request.requestId}`,
    sortIndex,
    "assistant",
    "",
    request.questions
  )
}

/** Adapt one already-scanned 50-row history page to the original search overlay. */
export function botGroupSearchPage(
  page: readonly BotGroupMessage[],
  matches: readonly ChatSearchMatch[],
  truncated = false
): DurableChatSearchPage {
  const rows = new Map(page.map((message) => [message.id, message]))
  const grouped = new Map<string, ChatSearchMatch[]>()
  const seen = new Set<string>()
  let count = 0
  for (const match of matches) {
    if (!rows.has(match.messageId)) continue
    const key = `${match.messageId}\0${
      match.location ? chatSearchLocationKey(match.location) : match.occurrenceIndex
    }`
    if (seen.has(key)) continue
    seen.add(key)
    if (count >= CHAT_SEARCH_RESULT_LIMIT) {
      truncated = true
      break
    }
    const previous = grouped.get(match.messageId)
    if (previous) previous.push(match)
    else grouped.set(match.messageId, [match])
    count += 1
  }
  const first = page.reduce<BotGroupMessage | undefined>(
    (earliest, message) => (!earliest || message.ordinal < earliest.ordinal ? message : earliest),
    undefined
  )
  return {
    matches: [...grouped]
      .map(([id, occurrences]) => {
        const message = rows.get(id)!
        const locations = occurrences.flatMap((match) => (match.location ? [match.location] : []))
        return {
          messageId: id,
          ordinal: message.ordinal,
          role: message.authorBotId === null ? ("user" as const) : ("assistant" as const),
          createdAt: message.createdAt,
          occurrenceCount: occurrences.length,
          preview: boundDurableSearchPreview(locations[0]?.context ?? ""),
          ...(locations.length ? { locations } : {})
        }
      })
      .sort((a, b) => b.ordinal - a.ordinal),
    beforeOrdinal: first?.ordinal ?? null,
    beforeMessageId: first?.id ?? null,
    hasMore: page.length >= 50,
    scanned: page.length,
    truncated
  }
}
