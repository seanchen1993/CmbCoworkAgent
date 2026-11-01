import { AsyncLocalStorage } from "node:async_hooks"
import type { BaseMessage } from "@langchain/core/messages"
import { countTokensApproximately } from "langchain"

export interface FinalModelInput {
  messages: BaseMessage[]
  tools?: Exclude<Parameters<typeof countTokensApproximately>[1], null>
  model: string
  contextWindow: number
  inputBudget: number
  signal: AbortSignal
}

export interface RecoveredModelInput {
  messages: BaseMessage[]
  usageStartIndex: number
}

type Recovery = (input: FinalModelInput) => Promise<RecoveredModelInput>
// Main-process only, scoped to one graph model call. Never exposed through a Mod argument.
const recovery = new AsyncLocalStorage<{ recover: Recovery; used: boolean }>()

export function withFinalModelInputRecovery<T>(
  recover: Recovery,
  run: () => Promise<T>
): Promise<T> {
  const scope = { recover, used: false }
  return recovery.run(scope, async () => {
    try {
      return await run()
    } finally {
      // An inherited async callback cannot start recovery after its graph request settled.
      scope.used = true
    }
  })
}

export function modelInputBudgetError(input: FinalModelInput, reason: string): Error {
  const estimated = countTokensApproximately(input.messages, input.tools)
  const fixed = countTokensApproximately(
    input.messages.filter((message) => message.type === "system"),
    input.tools
  )
  return new Error(
    `MODS_MODEL_INPUT_BUDGET: ${reason}。配置窗口 ${input.contextWindow}，` +
      `可用输入 ${input.inputBudget}，当前估算 ${estimated}，固定指令和工具约 ${fixed} tokens。` +
      "请检查模型设置中的输出预留，或减少本次启用的工具和附加指令后继续；聊天和草稿仍保留。"
  )
}

/** Recover inside the already-entered Hook stack; never invoke that stack a second time. */
export async function fitFinalModelInput(
  input: FinalModelInput
): Promise<RecoveredModelInput | undefined> {
  input.signal.throwIfAborted()
  const before = countTokensApproximately(input.messages, input.tools)
  if (
    Number.isFinite(before) &&
    Number.isFinite(input.inputBudget) &&
    input.inputBudget > 0 &&
    before <= input.inputBudget
  )
    return undefined
  const fixed = input.messages.filter((message) => message.type === "system")
  if (
    !Number.isFinite(input.inputBudget) ||
    input.inputBudget <= 0 ||
    countTokensApproximately(fixed, input.tools) >= input.inputBudget
  )
    throw modelInputBudgetError(input, "固定指令或工具已经占满输入预算，压缩聊天无法解决")
  const owner = recovery.getStore()
  if (!owner || owner.used) throw modelInputBudgetError(input, "本次输入超限，不能重复压缩同一请求")
  owner.used = true
  console.info("[ModelInputBudget] Recovering before provider", {
    contextWindow: input.contextWindow,
    inputBudget: input.inputBudget,
    estimatedInput: before,
    fixedInput: countTokensApproximately(fixed, input.tools)
  })
  const recovered = await owner.recover(input)
  input.signal.throwIfAborted()
  const after = countTokensApproximately(recovered.messages, input.tools)
  if (after >= before || after > input.inputBudget || !Number.isFinite(after))
    throw modelInputBudgetError(
      { ...input, messages: recovered.messages },
      "压缩后仍无法容纳输入，已停止重复尝试"
    )
  // The callback may replace history only. Preserve every post-Hook system message exactly.
  const nextFixed = recovered.messages.filter((message) => message.type === "system")
  if (
    nextFixed.length !== fixed.length ||
    nextFixed.some((message, index) => message !== fixed[index])
  )
    throw Error("MODEL_INPUT_RECOVERY_CHANGED_SYSTEM")
  return recovered
}
