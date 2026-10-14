import { countTokensApproximately } from "langchain"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { calculateModelInputBudgetTokens } from "../../../shared/model-token-budget"
import { composeModPrompt, type FunctionPromptDispatch } from "../../agent/mods-prompt-composition"
import type { ResolvedModelConfig } from "../../models/registry"
import { DEFAULT_MAX_TOKENS } from "../../storage"
import type { FunctionModelRequest } from "./model-sdk"
import type { FunctionModelForkSnapshot } from "./model-operations"
import {
  functionModelMessages,
  functionForkMessages,
  invokePreparedFunctionModel
} from "./model-provider"

/** Compose only this call's real system messages; preserve user/history roles for forks. */
export async function prepareFunctionModelPrompt(
  config: ResolvedModelConfig,
  request: FunctionModelRequest,
  snapshot: FunctionModelForkSnapshot | undefined,
  dispatch: FunctionPromptDispatch,
  signal: AbortSignal,
  assertLive: () => void,
  admit: (input: ModObject) => Promise<void>
) {
  const serialize = (messages: ReturnType<typeof functionModelMessages>) =>
    ({
      messages: messages.map((message) => ({ role: message.type, text: message.content }))
    }) as ModObject
  const original = snapshot
    ? functionForkMessages(request, snapshot)
    : functionModelMessages(request)
  assertLive()
  await admit(serialize(original))
  assertLive()
  const composed = await composeModPrompt(
    original,
    {
      model: config.model,
      promptModel: config.model,
      surfaces: ["desktop"],
      tools: [],
      outputStyle: null,
      traits: ["analysis"]
    },
    signal,
    dispatch,
    assertLive
  )
  assertLive()
  const input = serialize(composed.messages)
  const inputUpperBound =
    Buffer.byteLength(JSON.stringify(input), "utf8") + 128 * (composed.messages.length + 1)
  const estimated = countTokensApproximately(composed.messages)
  const assertBudget = (maxTokens: number) => {
    const budget = calculateModelInputBudgetTokens(
      config.maxTokens ?? DEFAULT_MAX_TOKENS,
      maxTokens
    )
    if (!Number.isFinite(estimated) || estimated > budget)
      throw new ModFunctionError("MODS_MODEL_INPUT_BUDGET")
  }
  return {
    input,
    inputUpperBound,
    assertBudget,
    invoke: async (resolved: FunctionModelRequest, active: AbortSignal) => {
      assertLive()
      active.throwIfAborted()
      assertBudget(resolved.maxTokens ?? 256)
      assertLive()
      return invokePreparedFunctionModel(config, resolved, composed.messages, active)
    }
  }
}
