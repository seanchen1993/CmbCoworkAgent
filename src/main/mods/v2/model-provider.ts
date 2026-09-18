import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  validateFunctionModelText,
  type FunctionModelReply,
  type FunctionModelRequest
} from "./model-sdk"

export async function resolveFunctionModel(name: string): Promise<ResolvedModelConfig> {
  const registry = await import("../../models/registry")
  // A miss must not silently route a plugin's data to a different model.
  const model =
    name === "default" ? registry.getDefaultModelConfig() : registry.getModelConfigByRef(name)
  if (!model?.apiKey) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
  return model
}

/** The existing provider handles protocols; no history, tools or user credentials enter the VM. */
export async function invokeFunctionModel(
  config: ResolvedModelConfig,
  request: FunctionModelRequest,
  signal: AbortSignal
): Promise<FunctionModelReply> {
  const { getModelInstance } = await import("../../agent/runtime")
  signal.throwIfAborted()
  const model = getModelInstance(
    { ...config, maxOutputTokens: request.maxTokens ?? 256 },
    undefined,
    1,
    "function-completion"
  )
  const messages = [
    new SystemMessage(
      `You are CMBDevClaw, a coding assistant.${request.system ? `\n\n${request.system}` : ""}`
    ),
    new HumanMessage(request.prompt)
  ]
  // A nested completion must not inherit the agent's stream callbacks, graph writer or trace
  // configuration. Keep the entire iterator in this scope, not just stream construction.
  // This only replaces LangChain's context; our grant/turn/call AsyncLocalStorage stays intact.
  return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
    AsyncLocalStorageProviderSingleton.runWithConfig(
      { callbacks: [], tags: [], metadata: {} },
      async () => {
        let text = ""
        let inputTokens: number | undefined
        let outputTokens: number | undefined
        // Stop an unbounded provider before assembling its full reply, even if it ignores max_tokens.
        for await (const chunk of await model.stream(messages, { signal, callbacks: [] })) {
          signal.throwIfAborted()
          if (chunk.tool_calls?.length || chunk.tool_call_chunks?.length)
            throw new ModFunctionError("MODS_MODEL_UNEXPECTED_TOOL")
          if (typeof chunk.content === "string") text += chunk.content
          else
            for (const block of chunk.content)
              if (block.type === "text" && typeof block.text === "string") text += block.text
          validateFunctionModelText(text)
          if (chunk.usage_metadata) {
            inputTokens = chunk.usage_metadata.input_tokens
            outputTokens = chunk.usage_metadata.output_tokens
          }
        }
        signal.throwIfAborted()
        return { text, inputTokens, outputTokens }
      }
    )
  )
}
