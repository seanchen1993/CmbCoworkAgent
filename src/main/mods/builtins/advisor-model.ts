import { SystemMessage, HumanMessage } from "@langchain/core/messages"
import type { AdvisorModelResult } from "./advisor"
import { ADVISOR_LIMITS } from "./advisor"
import { getAvailableModelConfigOrDefault, getModelConfigByRef } from "../../models/registry"
import { getModelInstance } from "../../agent/runtime"

/** Uses configured provider protocol without tools, conversation state, automatic retries or writes. */
export async function invokeBuiltinAdvisor(
  facts: string,
  signal: AbortSignal,
  modelRef?: string
): Promise<AdvisorModelResult> {
  const configured = modelRef ? getModelConfigByRef(modelRef) : getAvailableModelConfigOrDefault()
  if (!configured) throw Error("ADVISOR_MODEL_UNAVAILABLE")
  const model = getModelInstance(
    {
      ...configured,
      maxOutputTokens: Math.min(
        configured.maxOutputTokens ?? ADVISOR_LIMITS.outputTokens,
        ADVISOR_LIMITS.outputTokens
      ),
      enableThinking: false,
      enableThinkingEffort: false
    },
    undefined,
    1,
    "function-completion"
  )
  const stream = await model.stream(
    [
      new SystemMessage(
        "你是DevClaw的只读项目提示助手。根据有限统计和可用的宿主项目回执，用简短中文说明情况、问题和下一步。不推测文件内容，不把未知当成功，不承诺执行操作，不建议绕过审批。最多三条建议。调用统计仅覆盖保留的灵件调用；project描述当前会话所属阶段的历史检查，不证明文件现在仍有效。receiptsMatchCurrentVersion为false时不得把旧回执当当前版本通过；unavailable表示没有项目事实，不能推测。你没有工具。"
      ),
      new HumanMessage(facts)
    ],
    { signal, callbacks: [] }
  )
  let text = "",
    inputTokens: number | undefined,
    outputTokens: number | undefined
  for await (const chunk of stream) {
    signal.throwIfAborted()
    if (chunk.tool_calls?.length || chunk.tool_call_chunks?.length)
      throw Error("ADVISOR_TOOL_CALL_REJECTED")
    if (typeof chunk.content === "string") text += chunk.content
    else
      for (const block of chunk.content)
        if (block.type === "text" && typeof block.text === "string") text += block.text
    if (text.length > 6000) throw Error("ADVISOR_OUTPUT_LIMIT")
    if (chunk.usage_metadata) {
      inputTokens = chunk.usage_metadata.input_tokens
      outputTokens = chunk.usage_metadata.output_tokens
    }
  }
  return { text, inputTokens, outputTokens }
}
