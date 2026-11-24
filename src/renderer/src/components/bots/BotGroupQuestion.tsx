import { useThreadContext, useThreadStateSelector, type ThreadState } from "@/lib/thread-context"
import { UserInputRequestDialog } from "@/components/chat/UserInputRequestDialog"
import type { BotDefinition, BotTask } from "../../../../shared/bots/contracts"
import type { UserInputRequest } from "@/types"
import { BotAvatar } from "./BotAvatar"

const selectQuestionDraft = (state: ThreadState) => state.userInputDraft

/** Reuses the original inbox and answer channel, without opening execution details. */
export function BotGroupQuestion({
  task,
  request,
  bot,
  onOpenBot
}: {
  task: BotTask
  request: UserInputRequest
  bot: BotDefinition
  onOpenBot(bot: BotDefinition): void
}) {
  return (
    <article className="bot-group-message" aria-label={`${bot.name}的问题`}>
      <button
        className="bot-group-author bot-group-author-link"
        onClick={() => onOpenBot(bot)}
        style={{ color: bot.color }}
      >
        {bot.name}
      </button>
      <button
        className="bot-group-avatar-link"
        aria-label={`查看 ${bot.name}`}
        onClick={() => onOpenBot(bot)}
      >
        <BotAvatar color={bot.color} shape={bot.shape} size={20} animated={false} />
      </button>
      <BotGroupQuestionBody task={task} request={request} />
    </article>
  )
}

export function BotGroupQuestionBody({
  task,
  request
}: {
  task: BotTask
  request: UserInputRequest
}) {
  const context = useThreadContext()
  const draft = useThreadStateSelector(task.threadId, selectQuestionDraft)
  return (
    <UserInputRequestDialog
      key={request.requestId}
      request={request}
      presentation="bot"
      draft={draft}
      onDraftChange={(update) =>
        context.getThreadActions(task.threadId).setUserInputDraft(request.requestId, update)
      }
      useComposerForSingleAnswer
      onSubmit={(response) => {
        // A late click must never answer a replacement request or clear its card.
        if (
          response.requestId !== request.requestId ||
          context.getThreadState(task.threadId).pendingUserInput?.requestId !== request.requestId
        )
          return
        window.api.userInput.sendResponse(response)
        context.getThreadActions(task.threadId).setPendingUserInput(null)
      }}
    />
  )
}
