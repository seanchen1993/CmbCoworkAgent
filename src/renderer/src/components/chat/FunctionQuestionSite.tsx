import type { UserInputRequest } from "@/types"
import { functionSiteProps } from "../../../../shared/mods/v2/sites"
import { FunctionSite } from "./FunctionSite"

/** This slot has no submit callback. Original native controls own every answer. */
export function FunctionQuestionSite({
  request,
  onQuestions
}: {
  request: UserInputRequest
  onQuestions(questions: UserInputRequest["questions"] | null | undefined): void
}): React.JSX.Element | null {
  let facts
  try {
    facts = functionSiteProps("AskUserQuestion", {
      tool: "request_user_input",
      questions: request.questions
    })
  } catch {
    return null
  }
  return (
    <FunctionSite
      threadId={request.threadId}
      component="AskUserQuestion"
      facts={facts}
      onQuestions={onQuestions}
      fallback={null}
      className="max-h-28 shrink-0 overflow-y-auto text-xs"
    />
  )
}
