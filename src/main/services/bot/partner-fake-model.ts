import { AIMessage, isHumanMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"

export const PARTNER_FAKE_MODEL_REF = "devclaw-partner-local-fake"
/** Deterministic development output; consumes the actual bounded Task input,
 * uses the existing graph, never contacts a provider or reads model settings. */
export class PartnerFakeRequirementModel extends FakeChatModel {
  bindTools(tools: unknown[]): this {
    if (tools.length) throw new Error("TOOL_CALL_REJECTED")
    return this
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages.filter(isHumanMessage).at(-1)
    let number = "",
      title = "",
      goal = "",
      count = 0
    try {
      const value = JSON.parse(String(last?.content))
      if (
        typeof value.taskNumber !== "string" ||
        typeof value.title !== "string" ||
        typeof value.goal !== "string" ||
        !Array.isArray(value.clarifications)
      )
        throw Error()
      number = value.taskNumber
      title = value.title
      goal = value.goal.slice(0, 1000)
      count = value.clarifications.length
    } catch {
      throw new Error("EXECUTION_FAILED")
    }
    const text = `[模拟模型返回｜非真实分析]\n# ${number} 需求说明书草稿\n主题：${title}\n需求材料：${goal}\n已收到 ${count} 条明确任务澄清。\n待确认：业务规则、权限边界、异常处理与验收标准。\n此结果只用于验证协作闭环；未读取代码、未获业务审批，不作为真实需求评估。`
    const message = new AIMessage(text)
    return { generations: [{ message, text }] }
  }
}
