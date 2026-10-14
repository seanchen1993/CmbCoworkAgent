import type { ReactNode } from "react"
import type { UserInputRequest } from "@/types"
import { functionQuestionPresentation, functionSiteProps } from "../../../../shared/mods/v2/sites"
import { FunctionSite } from "./FunctionSite"

/** The original request owns all controls and answers; the engine only selects their position. */
export function FunctionQuestionSite({
  request,
  renderQuestions
}: {
  request: UserInputRequest
  renderQuestions(questions: UserInputRequest["questions"]): ReactNode
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
      expectedRequestId={request.requestId}
      renderNative={(safe) => {
        try {
          return (
            <div className="flex min-h-0 w-full min-w-0 flex-col">
              {renderQuestions(functionQuestionPresentation(request.questions, safe.questions))}
            </div>
          )
        } catch {
          return null
        }
      }}
      fallback={renderQuestions(request.questions)}
      className="contents"
    />
  )
}
