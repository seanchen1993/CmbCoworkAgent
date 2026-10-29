import { ToolMessage } from "@langchain/core/messages"
import { Command, isCommand } from "@langchain/langgraph"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { projectModResult, replaceModProjection } from "../publication"
import { validateFunctionToolResult } from "./tool-sdk"

const CONTEXT_KEY = "functionModContext"

function mapToolMessages<T>(value: T, id: string, map: (message: ToolMessage) => ToolMessage): T {
  if (ToolMessage.isInstance(value)) return map(value) as T
  if (!isCommand(value)) return value
  const command = value as Command
  const update = command.update as Record<string, unknown> | undefined
  if (!Array.isArray(update?.messages)) return value
  return new Command({
    update: {
      ...update,
      messages: update.messages.map((message) =>
        ToolMessage.isInstance(message) && message.tool_call_id === id ? map(message) : message
      )
    },
    ...(command.graph === undefined ? {} : { graph: command.graph }),
    ...(command.goto === undefined ? {} : { goto: command.goto }),
    ...(command.resume === undefined ? {} : { resume: command.resume })
  }) as T
}

function withPresentation<T>(value: T, id: string, context?: string[], isError = false): T {
  if (!context?.length && !isError) return value
  return mapToolMessages(
    value,
    id,
    (message) =>
      new ToolMessage({
        content: message.content,
        tool_call_id: message.tool_call_id,
        id: message.id,
        name: message.name,
        status: isError ? "error" : message.status,
        artifact: message.artifact,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
        metadata: {
          ...message.metadata,
          ...(context?.length ? { [CONTEXT_KEY]: context } : {}),
          ...(isError ? { functionModReportedError: true } : {})
        }
      })
  )
}

/** Host routing and execution records never cross the VM boundary. Refs live for one ingress. */
export class FunctionToolResults<T> {
  private readonly values: T[] = []

  constructor(
    private readonly tool: string,
    private readonly id: string
  ) {}

  add(value: T): ModObject {
    const projection = projectModResult(value, this.id)
    const ref = this.values.push(value) - 1
    let failed = false
    mapToolMessages(value, this.id, (message) => {
      failed ||= message.status === "error"
      return message
    })
    return {
      result: projection.data ?? projection.text,
      text: projection.text,
      ref,
      ...(failed ? { isError: true } : {})
    }
  }

  resolve(answer: ModObject): T | ToolMessage {
    validateFunctionToolResult(answer)
    const latest = this.values.at(-1)
    if (typeof answer.deny === "string") {
      if (latest !== undefined)
        return withPresentation(
          replaceModProjection(latest, { text: answer.deny }, this.id),
          this.id,
          undefined,
          true
        )
      return new ToolMessage({
        name: this.tool,
        tool_call_id: this.id,
        content: answer.deny,
        status: "error"
      })
    }
    const context = answer.context as string[] | undefined
    if (answer.ref !== undefined) {
      if (
        typeof answer.ref !== "number" ||
        !Number.isSafeInteger(answer.ref) ||
        answer.ref < 0 ||
        answer.ref >= this.values.length
      )
        throw new ModFunctionError("MODS_TOOL_RESULT_REF")
      // Upstream refs select host messages verbatim; to replace a result, omit the ref.
      return withPresentation(this.values[answer.ref], this.id, context)
    }
    const projection = projectModResult(answer.result)
    if (latest !== undefined) {
      // A new projection cannot erase a real write, error status or LangGraph control update.
      return withPresentation(
        replaceModProjection(latest, projection, this.id),
        this.id,
        context,
        answer.isError === true
      )
    }
    return withPresentation(
      new ToolMessage({
        name: this.tool,
        tool_call_id: this.id,
        content: projection.text,
        artifact: projection.data,
        status: answer.isError === true ? "error" : "success"
      }),
      this.id,
      context
    )
  }
}

/** Only the latest tool round contributes reminders. They stay out of visible tool content. */
export function functionToolContexts(messages: readonly unknown[]): string[] {
  const result: string[] = []
  let size = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!ToolMessage.isInstance(message)) break
    const context = message.metadata?.[CONTEXT_KEY]
    if (!Array.isArray(context) || context.some((item) => typeof item !== "string")) continue
    size += context.join("\n").length
    if (size > 128000) throw new ModFunctionError("MODS_TOOL_CONTEXT_LIMIT")
    result.unshift(...context)
  }
  return result
}
