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
import { getModCallContext } from "../../mods/context"

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

export function removeFreeformOptions(questions: UserInputQuestion[]): UserInputQuestion[] {
  return questions.map((question) => ({
    ...question,
    options: question.options.filter((option) => !isFreeformOption(option.label))
  }))
}

export interface RequestUserInputToolContext {
  /** A native flow may treat rejected/cancelled interactions as terminal. */
  onRejected?: (reason: string) => void
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
    async (input, config) => {
      // The Runnable can be cancelled by a Mod/operation deadline before the
      // enclosing native run ends. Its real dialog must share that lifetime.
      const operation = getModCallContext()
      const operationSignal =
        operation?.toolId === "host:request_user_input" &&
        operation.identity.threadId === context.threadId
          ? operation.signal
          : undefined
      const signals = [
        ...new Set(
          [context.abortSignal, config?.signal, operationSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined
          )
        )
      ]
      const abortSignal =
        signals.length === 1 ? signals[0] : signals.length ? AbortSignal.any(signals) : undefined
      const waitId = randomUUID()
      let waitStarted = false
      try {
        abortSignal?.throwIfAborted()
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
          toolCallId: (config as { toolCall?: { id?: string }; toolCallId?: string })?.toolCall?.id ??
            (config as { toolCallId?: string })?.toolCallId,
          questions: removeFreeformOptions(input.questions),
          autoResolutionMs,
          autoResolution: {
            type: autoResolutionType,
            message: userMessage
          },
          abortSignal,
          allowDeferredRenderer: context.allowDeferredRenderer
        })
        if (!abortSignal?.aborted) {
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
        const cancellation =
          abortSignal?.aborted && abortSignal.reason instanceof Error ? abortSignal.reason : error
        context.onRejected?.(
          error instanceof UserInputRequestRejectedError
            ? "user-input-rejected"
            : "user-input-cancelled"
        )
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
            error: cancellation instanceof Error ? cancellation.message : String(cancellation),
            ...(cancellation instanceof Error &&
            "code" in cancellation &&
            typeof cancellation.code === "string"
              ? { code: cancellation.code }
              : {})
          },
          null,
          2
        )
      } finally {
        // The wait belongs to the enclosing run. An operation deadline must
        // release its wait when that run is still live; a cancelled run must
        // never be transitioned back to executing by late cleanup.
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
