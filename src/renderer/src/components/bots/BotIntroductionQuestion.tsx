import { UserInputRequestDialog } from "@/components/chat/UserInputRequestDialog"
import { Button } from "@/components/ui/button"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotEpochOperation } from "@/lib/use-bot-epoch-operation"
import { pendingIntroductionQuestionStore } from "@/lib/bot-introduction-question-pending"
import {
  BOT_INTRODUCTION_QUESTION_CAPABILITY,
  type BotIntroductionQuestion as Question,
  type BotIntroductionQuestionReply,
  type BotIntroductionQuestionReceipt
} from "../../../../shared/bot-introduction-question"
import { validateBotQuestionAnswer } from "../../../../shared/bot-questions"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

/** Uses the existing inline question, scoped operation and exact-nonce recovery.
 * No polling, waiting run or additional local question state. */
export function BotIntroductionQuestion({ question }: { question: Question }) {
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_INTRODUCTION_QUESTION_CAPABILITY) ?? false
  )
  const session = useBotEpochOperation<
    BotIntroductionQuestionReply,
    BotIntroductionQuestionReceipt
  >({
    scope: question.runId,
    pending: {
      inspect: (epoch) => pendingIntroductionQuestionStore.inspect(question.runId, epoch),
      remember: pendingIntroductionQuestionStore.remember,
      acknowledge: pendingIntroductionQuestionStore.acknowledge,
      discard: (epoch, raw) => pendingIntroductionQuestionStore.discard(question.runId, epoch, raw)
    },
    matchesInput: (input) =>
      input.runId === question.runId && input.messageId === question.messageId,
    verifies: (input, receipt) =>
      JSON.stringify(input) === JSON.stringify(receipt.input) &&
      receipt.question.runId === question.runId &&
      receipt.question.messageId === question.messageId &&
      receipt.question.botId === question.botId &&
      receipt.question.conversationId === question.conversationId &&
      receipt.question.dataEpoch === input.dataEpoch &&
      receipt.question.revision === input.revision + 1 &&
      (receipt.question.status === "skipped"
        ? receipt.send === null
        : receipt.question.status === "answered" &&
          !!receipt.send?.messageId &&
          receipt.send.runIds.length === 1),
    change: (input) => botApi.answerIntroductionQuestion(input),
    definitiveErrors: [
      "invalid_input",
      "introduction_scope",
      "stale_interaction",
      "not_found",
      "reply_unavailable",
      "nonce_conflict"
    ],
    onConfirmed: async (_receipt, live) => {
      if (!live()) return
      const state = useBotWorkspaceStore.getState()
      await state.loadMessages(question.conversationId)
      if (live()) await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
    }
  })
  const pending = question.status === "pending" && question.dataEpoch === session.epoch
  return (
    <section className="space-y-2" aria-label="开始使用 Bot">
      {pending ? (
        <UserInputRequestDialog
          request={{
            requestId: question.runId,
            threadId: question.conversationId,
            questions: question.input.questions,
            createdAt: new Date(question.createdAt).toISOString()
          }}
          layout="inline"
          variant="conversation"
          maxTextLength={2000}
          disabled={!supported || session.fieldsDisabled}
          onSubmit={(response) => {
            if (response.requestId !== question.runId || !supported) return
            void session.save(() => ({
              runId: question.runId,
              messageId: question.messageId,
              revision: question.revision,
              nonce: crypto.randomUUID(),
              dataEpoch: session.epoch,
              answer: validateBotQuestionAnswer(
                question.input,
                JSON.stringify({
                  status: response.ignored ? "cancelled" : "submitted",
                  answers: response.ignored ? {} : response.answers
                })
              )
            }))
          }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {question.status === "answered" ? "已回答" : "已略过"}
          <span className="ml-2">{question.input.questions[0].question}</span>
        </p>
      )}
      <BotPendingSaveRecovery
        record={session.record}
        dataEpoch={session.epoch}
        discard={session.discard}
        onRepaired={session.refreshRecord}
        operationLabel="回答"
      />
      {(session.pending || session.acknowledged) && (
        <Button
          size="sm"
          variant="outline"
          disabled={!supported || session.saveDisabled}
          onClick={() => void session.save()}
        >
          核对原回答
        </Button>
      )}
      {session.error && (
        <p role="alert" className="text-xs text-destructive">
          {session.error}
        </p>
      )}
    </section>
  )
}
