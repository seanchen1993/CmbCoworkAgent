import { readBotPresentationChoice } from "../../../../shared/bot-presentation"
import { BotPeerImages } from "./BotPeerImages"
import { botApi } from "@/lib/bot-api"
import { useRef, useState } from "react"
import { UserInputRequestDialog } from "@/components/chat/UserInputRequestDialog"
import type { UserInputResponse } from "@/types"
import type { BotInteraction } from "../../../../shared/bot-types"
import {
  validateBotQuestionAnswer,
  type BotQuestions as QuestionInput
} from "../../../../shared/bot-questions"

export function BotQuestions({
  item,
  questions,
  refresh
}: {
  item: BotInteraction
  questions: QuestionInput
  refresh(): Promise<void>
}) {
  const presentation = readBotPresentationChoice(item.prompt)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const pending = useRef(false)
  const submit = async (response: UserInputResponse) => {
    if (pending.current || response.requestId !== item.id) return
    pending.current = true
    setBusy(true)
    setFailure(null)
    try {
      const answer = validateBotQuestionAnswer(
        questions,
        JSON.stringify({
          status: response.ignored ? "cancelled" : "submitted",
          answers: response.ignored ? {} : response.answers
        })
      )
      await botApi.answer({
        id: item.id,
        revision: item.revision,
        answer,
        ...(presentation ? { expectedDataEpoch: presentation.dataEpoch } : {})
      })
      await refresh()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "回答未提交，请重试")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <section aria-label="待补充信息" className="space-y-2">
      {presentation && (
        <div className="sm:[&>[data-image-scope]]:grid-cols-3">
          <BotPeerImages
            images={presentation.images}
            conversationId={presentation.conversationId}
            label="演示文稿版式样稿"
          />
        </div>
      )}
      <UserInputRequestDialog
        key={item.id}
        request={{
          requestId: item.id,
          threadId: item.runId,
          createdAt: new Date(item.createdAt).toISOString(),
          questions: questions.questions
        }}
        onSubmit={(response) => void submit(response)}
        layout="inline"
        disabled={busy}
        maxTextLength={2000}
      />
      <p className="px-1 text-xs text-muted-foreground">
        回答会发给 Bot；密码请通过专用安全输入卡片提供。
      </p>
      {failure && (
        <p role="alert" className="px-1 text-sm text-destructive">
          {failure}
        </p>
      )}
    </section>
  )
}

// Ordinary typed forms retain the same question-card entry point and answer transport.
export { BotUserForm } from "./BotUserForm"
