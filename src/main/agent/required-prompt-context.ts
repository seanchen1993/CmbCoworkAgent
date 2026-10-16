import type { BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

export class RequiredPromptContextError extends ModFunctionError {
  constructor() {
    super(
      "MODS_REQUIRED_CONTEXT_CHANGED",
      "提示词处理删除或改写了本次任务必需的项目知识，已阻止模型请求。请保留原知识内容后重试。",
      true
    )
  }
}

/** Host-only byte retention for already resolved opaque project context, not semantic validation. */
export function assertRequiredPromptTexts(
  messages: readonly BaseMessage[],
  required: readonly string[]
): void {
  if (!required.length) return
  const text = messages
    .filter((message) => message.type === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => String(part.text))
            .join("")
    )
    .join("\n\n")
  if (required.some((value) => !value || !text.includes(value)))
    throw new RequiredPromptContextError()
}
