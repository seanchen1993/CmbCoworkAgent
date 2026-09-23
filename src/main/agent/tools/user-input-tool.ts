import { tool } from "langchain"
import { randomUUID } from "node:crypto"
import {
  requestUserInputSchema,
  requestUserInputWithAutoResolutionSchema
} from "./user-input-schema"
import { requestUserInput, UserInputRequestRejectedError } from "../../services/user-input"
import type { RuntimeInteractionWaitHooks } from "../runtime"
import type { UserInputQuestion } from "../../types"
import type { HarnessRequestUserInputConfig } from "../../../shared/harness-board-types"

const additionalTextDescription =
  "A submitted option answer may include additionalText, an optional user-entered clarification that supplements rather than replaces the selected option; the client provides this capability automatically, so do not add it to the question options."

function isFreeformOption(label: string): boolean {
  const normalized = label.trim().toLowerCase()
  const compact = normalized.replace(/[\s\p{P}\p{S}]/gu, "")

  return (
    /^(其他|其它|other)(?:[\s:：,，、\-—_].+|[（(].+[）)])?$/iu.test(normalized) ||
    /^(不对|不是这样).*(补充|说明|填写|自定义)/u.test(compact) ||
    /^(我来)?(补充|自定义|填写).*/u.test(compact) ||
    /^(以上都不|以上均不|都不是|无上述|没有合适)/u.test(compact)
  )
}

function removeFreeformOptions(questions: UserInputQuestion[]): UserInputQuestion[] {
  return questions.map((question) => ({
    ...question,
    options: question.options.filter((option) => !isFreeformOption(option.label))
  }))
}

export interface RequestUserInputToolContext {
  threadId: string
  abortSignal?: AbortSignal
  allowDeferredRenderer?: boolean
  interactionWaitHooks?: RuntimeInteractionWaitHooks
  requestUserInputConfig?: HarnessRequestUserInputConfig
}

export function createRequestUserInputTool(context: RequestUserInputToolContext) {
  const allowAutoResolution = context.requestUserInputConfig?.allowAutoResolution !== false
  const schema = allowAutoResolution
    ? requestUserInputWithAutoResolutionSchema
    : requestUserInputSchema

  return tool(
    async (input) => {
      const waitId = randomUUID()
      let waitStarted = false
      try {
        const modelTimeout =
          "autoResolutionMs" in input && typeof input.autoResolutionMs === "number"
            ? input.autoResolutionMs
            : undefined
        const autoResolutionMs = allowAutoResolution
          ? (modelTimeout ?? context.requestUserInputConfig?.defaultTimeoutMs)
          : undefined
        const autoResolutionType = context.requestUserInputConfig
          ? context.requestUserInputConfig.autoResolutionType
          : "user_message"
        const userMessage =
          context.requestUserInputConfig?.userMessage ??
          "The user did not answer within the configured time. Do not infer or assume any option selections; continue with your best judgment."
        await context.interactionWaitHooks?.onWaitStart({
          id: waitId,
          kind: "user_input",
          threadId: context.threadId
        })
        waitStarted = true
        const response = await requestUserInput({
          threadId: context.threadId,
          questions: removeFreeformOptions(input.questions),
          autoResolutionMs,
          autoResolution: {
            type: autoResolutionType,
            message: userMessage
          },
          abortSignal: context.abortSignal,
          allowDeferredRenderer: context.allowDeferredRenderer
        })
        if (!context.abortSignal?.aborted) {
          await context.interactionWaitHooks?.onWaitEnd({
            id: waitId,
            kind: "user_input",
            threadId: context.threadId
          })
          waitStarted = false
        }
        if ("autoResolved" in response) {
          return JSON.stringify(
            {
              status: "auto_resolved",
              requestId: response.requestId,
              answers: response.answers,
              ...(response.message ? { message: response.message } : {})
            },
            null,
            2
          )
        }
        if (response.ignored) {
          return JSON.stringify(
            {
              status: "ignored",
              requestId: response.requestId,
              submittedAt: response.submittedAt,
              answers: {},
              message:
                "The user ignored this request and did not provide answers. Do not infer or assume any option selections."
            },
            null,
            2
          )
        }
        return JSON.stringify(
          {
            status: "submitted",
            requestId: response.requestId,
            submittedAt: response.submittedAt,
            answers: response.answers
          },
          null,
          2
        )
      } catch (error) {
        if (error instanceof UserInputRequestRejectedError) {
          return JSON.stringify(
            {
              status: "rejected",
              code: error.code,
              reason: error.message
            },
            null,
            2
          )
        }
        return JSON.stringify(
          {
            status: "cancelled",
            error: error instanceof Error ? error.message : String(error)
          },
          null,
          2
        )
      } finally {
        // A normal response ends the wait before returning to the model. Abort
        // cleanup deliberately does not call onWaitEnd: the owning transport is
        // already terminalizing the event and must not transition it back to
        // executing.
        if (waitStarted && !context.abortSignal?.aborted) {
          await context.interactionWaitHooks?.onWaitEnd({
            id: waitId,
            kind: "user_input",
            threadId: context.threadId
          })
        }
      }
    },
    {
      name: "request_user_input",
      description: `${
        allowAutoResolution
          ? "Request user input for one to ten short questions and wait for the response, with optional automatic resolution for non-blocking questions."
          : "Request user input for one to ten short questions and wait for the user's response."
      } ${additionalTextDescription}`,
      schema
    }
  )
}
