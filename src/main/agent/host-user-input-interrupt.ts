import { createMiddleware } from "langchain"
import { interrupt } from "@langchain/langgraph"
import { isAIMessage } from "@langchain/core/messages"
import { requestUserInputSchema } from "../../shared/user-input-schema"
import { enterHostInputToolBoundary, prepareHostInputInterrupt } from "../services/user-input"
import { removeFreeformOptions } from "./tools/user-input-tool"
import type { HostUserInputRecord } from "../services/host-user-input-store"

export const HOST_INPUT_INTERRUPT = "host-user-input-interrupt/v1"

/** Pause before tool dispatch: mixed batches retain the ordinary non-resumable wait path. */
export function createHostUserInputInterruptMiddleware(
  inputAllowed = true,
  overriddenTools: ReadonlySet<string> = new Set()
) {
  return createMiddleware({
    name: "HostUserInputInterrupt",
    wrapToolCall: async (request, handler) => {
      const threadId = request.runtime.configurable?.thread_id
      const finish =
        typeof threadId === "string"
          ? enterHostInputToolBoundary(
              threadId,
              overriddenTools.has(request.toolCall.name) ? "custom-tool" : request.toolCall.name
            )
          : () => {}
      try {
        return await handler(request)
      } finally {
        finish()
      }
    },
    afterModel: (state, runtime) => {
      const threadId = runtime.configurable?.thread_id
      const last = state.messages.at(-1)
      if (
        !inputAllowed ||
        typeof threadId !== "string" ||
        !last ||
        !isAIMessage(last) ||
        last.tool_calls?.length !== 1
      )
        return undefined
      const call = last.tool_calls[0]
      if (
        call.name !== "request_user_input" ||
        !call.id ||
        call.args.autoResolutionMs !== undefined
      )
        return undefined
      const input = requestUserInputSchema.safeParse(call.args)
      if (!input.success) return undefined
      const record = prepareHostInputInterrupt(
        threadId,
        call.id,
        removeFreeformOptions(input.data.questions)
      )
      if (!record) return undefined
      const resumed = interrupt({
        protocol: HOST_INPUT_INTERRUPT,
        requestId: record.request.requestId,
        operationId: record.binding.operationId,
        toolCallId: call.id
      }) as unknown
      if (
        !resumed ||
        typeof resumed !== "object" ||
        (resumed as { requestId?: unknown }).requestId !== record.request.requestId ||
        record.status !== "answered" ||
        record.continuation?.claimed !== true
      )
        throw Error("HOST_USER_INPUT_RESUME_MISMATCH")
      // The original tool still executes once through its normal permission and Hook boundaries.
      return undefined
    }
  })
}

/** Inspects an actual graph checkpoint, not an executor label or a model claim. */
export function assertHostUserInputCheckpoint(value: unknown, record: HostUserInputRecord): void {
  const state = value as {
    values?: { messages?: Array<{ tool_calls?: Array<{ id?: string; name?: string }> }> }
    next?: string[]
    tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }>
    config?: { configurable?: { checkpoint_id?: unknown } }
  }
  const calls = state.values?.messages?.at(-1)?.tool_calls
  const waits = state.tasks?.flatMap((task) => task.interrupts ?? []) ?? []
  const wait = waits[0]?.value as
    | { protocol?: unknown; requestId?: unknown; operationId?: unknown; toolCallId?: unknown }
    | undefined
  if (
    !record.continuation?.priorToolsSettled ||
    !state.config?.configurable?.checkpoint_id ||
    state.next?.length !== 1 ||
    state.tasks?.length !== 1 ||
    waits.length !== 1 ||
    calls?.length !== 1 ||
    calls[0].name !== "request_user_input" ||
    calls[0].id !== record.continuation.toolCallId ||
    wait?.protocol !== HOST_INPUT_INTERRUPT ||
    wait.requestId !== record.request.requestId ||
    wait.operationId !== record.binding.operationId ||
    wait.toolCallId !== record.continuation.toolCallId
  )
    throw Error("HOST_USER_INPUT_CHECKPOINT_UNSAFE")
}
